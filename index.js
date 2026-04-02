const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 8080;
app.use(express.static(path.join(__dirname, 'public')));

const clients = new Set();
let currentUsername = null;
let isManualDisconnect = false;
let reconnectTimer = null;
let cleanupTimer = null;
let reconnectAttempts = 0;
let activeConnection = false;
let gifters = new Map();
let donors = new Map();
let pollInterval = null;

const MAX_GIFTERS = 5000;
const CLEANUP_INTERVAL = 120000;

// Configuración de EulerStream - URL CORRECTA
const EULER_API_KEY = '2c5a970dd2bb1a859a1';
const EULER_API_URL = 'https://eulerstream.com/api';

// Webhook secret para verificar alerts
const WEBHOOK_SECRET = '2c5a970dd2bb1a859a1';

// Función para limpiar gifters inactivos
function startCleanupInterval() {
    if (cleanupTimer) clearInterval(cleanupTimer);
    
    cleanupTimer = setInterval(() => {
        console.log('🧹 Limpiando gifters inactivos...');
        const now = Date.now();
        let cleanedCount = 0;
        
        for (const [username, data] of gifters.entries()) {
            if (now - data.lastGiftTime > CLEANUP_INTERVAL) {
                gifters.delete(username);
                cleanedCount++;
                console.log(`🗑️ Eliminado @${username} (inactivo)`);
            }
        }
        
        if (cleanedCount > 0) {
            console.log(`✅ Limpiados ${cleanedCount} gifters inactivos`);
            broadcastGiftersList();
        }
    }, CLEANUP_INTERVAL);
}

function getGiftersList() {
    return Array.from(gifters.values())
        .sort((a, b) => (b.totalGifts || 0) - (a.totalGifts || 0))
        .slice(0, 1000)
        .map(v => ({
            username: v.username,
            nickname: v.nickname,
            avatar: v.avatar,
            isDonor: v.isDonor || false,
            totalGifts: v.totalGifts || 0,
            lastGiftTime: v.lastGiftTime,
            lastGiftName: v.lastGiftName
        }));
}

function broadcastToAllClients(message) {
    const msgStr = JSON.stringify(message);
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try { client.send(msgStr); } catch (e) {}
        }
    });
}

function broadcastGiftersList() {
    broadcastToAllClients({
        type: 'viewers_update',
        data: getGiftersList(),
        total: gifters.size,
        donors: donors.size,
        timestamp: Date.now()
    });
}

function broadcastStatus(connected, message = '') {
    broadcastToAllClients({
        type: 'connection_status',
        connected,
        message,
        username: currentUsername,
        viewerCount: gifters.size,
        donorsCount: donors.size,
        timestamp: Date.now()
    });
}

// Procesar regalo
function processGift(giftData) {
    try {
        const uniqueId = giftData.uniqueId || giftData.username || giftData.from;
        const nickname = giftData.nickname || giftData.displayName || uniqueId;
        const giftName = giftData.giftName || giftData.gift || 'Regalo';
        const diamondCount = parseInt(giftData.diamondCount || giftData.diamonds || giftData.value || 1);
        const avatar = giftData.profilePicture || giftData.avatar || null;
        
        if (!uniqueId) {
            console.log('⚠️ Regalo sin identificador:', giftData);
            return;
        }
        
        console.log(`🎁 REGALO: @${uniqueId} - ${giftName} (${diamondCount}💎)`);
        
        const now = Date.now();
        let totalGifts = 0;
        
        if (!gifters.has(uniqueId)) {
            const donorData = donors.get(uniqueId);
            gifters.set(uniqueId, {
                username: uniqueId,
                nickname: nickname,
                avatar: donorData?.avatar || avatar,
                lastGiftTime: now,
                totalGifts: diamondCount,
                isDonor: !!donorData,
                lastGiftName: giftName,
                firstGiftTime: now
            });
            totalGifts = diamondCount;
            console.log(`✨ NUEVO GIFTER: @${uniqueId}`);
        } else {
            const existing = gifters.get(uniqueId);
            existing.lastGiftTime = now;
            existing.totalGifts += diamondCount;
            existing.lastGiftName = giftName;
            if (!existing.avatar && avatar) existing.avatar = avatar;
            totalGifts = existing.totalGifts;
            gifters.set(uniqueId, existing);
            console.log(`🔄 ACTUALIZADO: @${uniqueId} - Total: ${totalGifts}💎`);
        }
        
        // Verificar donador (100+ diamantes totales o regalo de 50+)
        const shouldBeDonor = diamondCount >= 50 || totalGifts >= 100;
        if (shouldBeDonor && !donors.has(uniqueId)) {
            const gifter = gifters.get(uniqueId);
            donors.set(uniqueId, {
                username: uniqueId,
                nickname: nickname,
                avatar: gifter?.avatar || avatar,
                firstGiftDate: now,
                totalGifts: totalGifts
            });
            gifter.isDonor = true;
            gifters.set(uniqueId, gifter);
            
            console.log(`🏆 DONADOR: @${uniqueId} (${totalGifts}💎)`);
            
            broadcastToAllClients({
                type: 'new_donor',
                data: {
                    username: uniqueId,
                    nickname: nickname,
                    avatar: gifter?.avatar || avatar,
                    totalGifts: totalGifts
                }
            });
        }
        
        // Broadcast del regalo
        broadcastToAllClients({
            type: 'new_gift',
            data: {
                username: uniqueId,
                nickname: nickname,
                avatar: gifters.get(uniqueId)?.avatar,
                giftName: giftName,
                diamondCount: diamondCount,
                totalGifts: totalGifts,
                isDonor: gifters.get(uniqueId)?.isDonor || false
            }
        });
        
        broadcastGiftersList();
        
    } catch (error) {
        console.error('Error procesando regalo:', error);
    }
}

// Polling a EulerStream API (alternativa a WebSocket)
async function pollEulerStream() {
    if (!currentUsername || isManualDisconnect) return;
    
    try {
        const response = await fetch(`${EULER_API_URL}/alerts?apiKey=${EULER_API_KEY}&username=${currentUsername}`, {
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        if (response.ok) {
            const data = await response.json();
            if (data.alerts && data.alerts.length > 0) {
                for (const alert of data.alerts) {
                    if (alert.type === 'gift') {
                        processGift(alert);
                    }
                }
            }
        }
    } catch (error) {
        console.error('Error polling EulerStream:', error.message);
    }
}

// Webhook endpoint para recibir alerts de EulerStream
app.post('/webhook', express.json(), (req, res) => {
    try {
        const webhookSecret = req.headers['x-webhook-secret'];
        
        // Verificar secreto
        if (webhookSecret !== WEBHOOK_SECRET) {
            console.log('⚠️ Webhook secret inválido');
            return res.status(401).json({ error: 'Invalid secret' });
        }
        
        const data = req.body;
        console.log('📨 Webhook recibido:', data.type || 'unknown');
        
        if (data.type === 'gift' || data.event === 'gift') {
            processGift(data);
        } else if (data.gift) {
            processGift(data);
        }
        
        res.json({ status: 'ok' });
    } catch (error) {
        console.error('Error en webhook:', error);
        res.status(500).json({ error: error.message });
    }
});

// Conectar usando REST API (más confiable)
async function connectToTikTok(username) {
    currentUsername = username.replace(/^@/, '').trim();
    console.log(`🔌 Conectando a @${currentUsername}...`);
    broadcastStatus(false, `Conectando a @${currentUsername}...`);
    
    try {
        // Probar conexión con EulerStream
        const testResponse = await fetch(`${EULER_API_URL}/test?apiKey=${EULER_API_KEY}&username=${currentUsername}`);
        
        if (testResponse.ok) {
            activeConnection = true;
            reconnectAttempts = 0;
            
            // Iniciar polling cada 2 segundos
            if (pollInterval) clearInterval(pollInterval);
            pollInterval = setInterval(() => pollEulerStream(), 2000);
            
            console.log(`✅ Conectado a @${currentUsername} - Monitoreando regalos`);
            broadcastStatus(true, `Conectado a @${currentUsername} - Detectando regalos en tiempo real`);
            
            // Mensaje de prueba
            setTimeout(() => {
                broadcastToAllClients({
                    type: 'test',
                    message: 'Conexión establecida correctamente. Esperando regalos...'
                });
            }, 1000);
            
            return true;
        } else {
            throw new Error('No se pudo conectar a EulerStream');
        }
        
    } catch (error) {
        console.error(`❌ Error conectando: ${error.message}`);
        broadcastStatus(false, `Error: ${error.message}`);
        activeConnection = false;
        return false;
    }
}

async function disconnectFromTikTok() {
    isManualDisconnect = true;
    
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    
    if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
    }
    
    activeConnection = false;
    currentUsername = null;
    
    console.log('🔌 Desconectado manualmente');
    broadcastStatus(false, 'Desconectado manualmente');
}

function scheduleReconnect() {
    if (isManualDisconnect) return;
    
    reconnectAttempts++;
    const delay = Math.min(5000 * Math.pow(1.5, reconnectAttempts - 1), 30000);
    
    console.log(`🔄 Reconectando en ${delay/1000}s... (Intento ${reconnectAttempts})`);
    broadcastStatus(false, `Reconectando en ${delay/1000}s...`);
    
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(async () => {
        if (!isManualDisconnect && currentUsername) {
            await connectToTikTok(currentUsername);
        }
    }, delay);
}

// Obtener avatar del usuario
async function fetchUserAvatar(username) {
    try {
        const response = await fetch(`https://www.tiktok.com/@${username}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        const html = await response.text();
        
        const avatarMatch = html.match(/avatar":\{"uri":"(https:[^"]+)"/);
        if (avatarMatch) return avatarMatch[1];
        
        const imgMatch = html.match(/<img[^>]+class="[^"]*avatar[^"]*"[^>]+src="([^"]+)"/i);
        if (imgMatch) return imgMatch[1];
        
        return null;
    } catch (error) {
        console.error(`Error obteniendo avatar:`, error.message);
        return null;
    }
}

// API Endpoints
app.get('/search/:username', async (req, res) => {
    try {
        const username = req.params.username.replace(/^@/, '').trim();
        console.log(`🔍 Buscando: ${username}`);
        
        const gifter = gifters.get(username);
        const donor = donors.get(username);
        
        let avatar = gifter?.avatar || donor?.avatar || null;
        let nickname = gifter?.nickname || donor?.nickname || username;
        
        if (!avatar) {
            avatar = await fetchUserAvatar(username);
        }
        
        res.json({
            username: username,
            nickname: nickname,
            avatar: avatar,
            found: !!gifter || !!donor,
            totalGifts: gifter?.totalGifts || donor?.totalGifts || 0,
            isDonor: !!(gifter?.isDonor || donor)
        });
    } catch (err) {
        res.json({ error: err.message });
    }
});

app.get('/connect/:username', async (req, res) => {
    try {
        const username = req.params.username;
        console.log(`📡 Conectando a: ${username}`);
        
        isManualDisconnect = false;
        reconnectAttempts = 0;
        
        const success = await connectToTikTok(username);
        
        if (success) {
            res.json({ status: 'connected', username: username });
        } else {
            res.json({ status: 'error', error: 'No se pudo conectar' });
        }
    } catch (err) {
        console.error('Error:', err);
        res.json({ status: 'error', error: err.message });
    }
});

app.get('/disconnect', async (req, res) => {
    try {
        await disconnectFromTikTok();
        res.json({ status: 'disconnected' });
    } catch (err) {
        res.json({ status: 'error', error: err.message });
    }
});

app.get('/status', (req, res) => {
    res.json({
        connected: activeConnection,
        username: currentUsername,
        gifters: gifters.size,
        donors: donors.size
    });
});

app.get('/gifters', (req, res) => {
    res.json({
        gifters: getGiftersList(),
        total: gifters.size,
        donors: donors.size
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// WebSocket
wss.on('connection', (ws) => {
    console.log('📱 Cliente conectado');
    clients.add(ws);
    
    ws.send(JSON.stringify({
        type: 'connection_status',
        connected: activeConnection,
        username: currentUsername,
        viewerCount: gifters.size,
        donorsCount: donors.size,
        timestamp: Date.now()
    }));
    
    ws.send(JSON.stringify({
        type: 'viewers_update',
        data: getGiftersList(),
        total: gifters.size,
        donors: donors.size,
        timestamp: Date.now()
    }));
    
    ws.on('close', () => {
        console.log('📱 Cliente desconectado');
        clients.delete(ws);
    });
});

startCleanupInterval();

server.listen(PORT, () => {
    console.log(`\n🚀 SERVIDOR TIKTOK LIVE`);
    console.log(`📡 Puerto: ${PORT}`);
    console.log(`🌐 http://localhost:${PORT}`);
    console.log(`\n⚠️ IMPORTANTE: Necesitas configurar el Webhook en EulerStream`);
    console.log(`📌 URL del webhook: http://TU_IP_PUBLICA:${PORT}/webhook`);
    console.log(`🔑 Secret: ${WEBHOOK_SECRET}`);
    console.log(`\n✨ Para probar sin webhook, usa el modo de prueba abajo\n`);
});
