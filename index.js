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
let gifters = new Map();
let donors = new Map();
let pollInterval = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let cleanupTimer = null;

const MAX_GIFTERS = 5000;
const CLEANUP_INTERVAL = 120000;

// Configuración de EulerStream
const EULER_API_KEY = '2c5a970dd2bb1a859a1';
const EULER_API_URL = 'https://eulerstream.com/api';

// Función para limpiar gifters inactivos
function startCleanupInterval() {
    if (cleanupTimer) clearInterval(cleanupTimer);
    
    cleanupTimer = setInterval(() => {
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
        const uniqueId = giftData.uniqueId || giftData.username;
        const nickname = giftData.nickname || uniqueId;
        const giftName = giftData.giftName || giftData.gift || 'Regalo';
        const diamondCount = parseInt(giftData.diamondCount || giftData.diamonds || 1);
        const avatar = giftData.profilePicture || null;
        
        if (!uniqueId) return;
        
        console.log(`🎁 REGALO: @${uniqueId} - ${giftName} (${diamondCount}💎)`);
        
        const now = Date.now();
        
        if (!gifters.has(uniqueId)) {
            gifters.set(uniqueId, {
                username: uniqueId,
                nickname: nickname,
                avatar: avatar,
                lastGiftTime: now,
                totalGifts: diamondCount,
                isDonor: false,
                lastGiftName: giftName
            });
        } else {
            const existing = gifters.get(uniqueId);
            existing.lastGiftTime = now;
            existing.totalGifts += diamondCount;
            existing.lastGiftName = giftName;
            if (!existing.avatar && avatar) existing.avatar = avatar;
            gifters.set(uniqueId, existing);
        }
        
        const totalGifts = gifters.get(uniqueId).totalGifts;
        
        // Verificar donador (100+ diamantes totales o regalo de 50+)
        if ((diamondCount >= 50 || totalGifts >= 100) && !donors.has(uniqueId)) {
            donors.set(uniqueId, {
                username: uniqueId,
                nickname: nickname,
                avatar: avatar,
                totalGifts: totalGifts
            });
            
            const gifter = gifters.get(uniqueId);
            gifter.isDonor = true;
            gifters.set(uniqueId, gifter);
            
            console.log(`🏆 DONADOR: @${uniqueId} (${totalGifts}💎)`);
            
            broadcastToAllClients({
                type: 'new_donor',
                data: { username: uniqueId, nickname, avatar, totalGifts }
            });
        }
        
        broadcastToAllClients({
            type: 'new_gift',
            data: {
                username: uniqueId,
                nickname,
                avatar: gifters.get(uniqueId)?.avatar,
                giftName,
                diamondCount,
                totalGifts,
                isDonor: gifters.get(uniqueId)?.isDonor || false
            }
        });
        
        broadcastGiftersList();
        
    } catch (error) {
        console.error('Error procesando regalo:', error);
    }
}

// Polling a EulerStream (más confiable que WebSocket)
async function pollEulerStream() {
    if (!currentUsername || isManualDisconnect) return;
    
    try {
        // Endpoint correcto de EulerStream
        const response = await fetch(`${EULER_API_URL}/stream/${currentUsername}/events`, {
            headers: {
                'Authorization': `Bearer ${EULER_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (response.ok) {
            const data = await response.json();
            if (data.events && data.events.length > 0) {
                for (const event of data.events) {
                    if (event.type === 'gift') {
                        processGift(event);
                    }
                }
            }
        }
    } catch (error) {
        console.error('Error polling EulerStream:', error.message);
    }
}

// Webhook endpoint para recibir eventos
app.post('/webhook/eulerstream', express.json(), (req, res) => {
    const secret = req.headers['x-webhook-secret'];
    
    if (secret !== EULER_API_KEY) {
        return res.status(401).json({ error: 'Invalid secret' });
    }
    
    const data = req.body;
    console.log('📨 Webhook recibido:', data.type);
    
    if (data.type === 'gift') {
        processGift(data);
    }
    
    res.json({ status: 'ok' });
});

// Conexión a TikTok vía EulerStream
async function connectToTikTok(username) {
    currentUsername = username.replace(/^@/, '').trim();
    console.log(`🔌 Conectando a @${currentUsername}...`);
    broadcastStatus(false, `Conectando a @${currentUsername}...`);
    
    try {
        // Verificar si el usuario está en vivo
        const statusResponse = await fetch(`${EULER_API_URL}/stream/${currentUsername}/status`, {
            headers: { 'Authorization': `Bearer ${EULER_API_KEY}` }
        });
        
        if (!statusResponse.ok) {
            throw new Error('Usuario no está en vivo o no existe');
        }
        
        const status = await statusResponse.json();
        
        if (status.isLive) {
            // Iniciar polling cada 2 segundos
            if (pollInterval) clearInterval(pollInterval);
            pollInterval = setInterval(() => pollEulerStream(), 2000);
            
            console.log(`✅ Conectado a @${currentUsername} - Live ID: ${status.roomId}`);
            broadcastStatus(true, `Conectado a @${currentUsername} - Detectando regalos`);
            return true;
        } else {
            throw new Error('El usuario no está en vivo actualmente');
        }
        
    } catch (error) {
        console.error(`❌ Error: ${error.message}`);
        broadcastStatus(false, `Error: ${error.message}`);
        return false;
    }
}

function scheduleReconnect() {
    if (isManualDisconnect) return;
    
    reconnectAttempts++;
    const delay = Math.min(5000 * Math.pow(1.3, reconnectAttempts - 1), 30000);
    
    console.log(`🔄 Reconectando en ${delay/1000}s... (Intento ${reconnectAttempts})`);
    broadcastStatus(false, `Reconectando en ${delay/1000}s...`);
    
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(async () => {
        if (!isManualDisconnect && currentUsername) {
            const success = await connectToTikTok(currentUsername);
            if (!success) scheduleReconnect();
            else reconnectAttempts = 0;
        }
    }, delay);
}

async function disconnectFromTikTok() {
    isManualDisconnect = true;
    
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (pollInterval) clearInterval(pollInterval);
    
    currentUsername = null;
    console.log('🔌 Desconectado manualmente');
    broadcastStatus(false, 'Desconectado manualmente');
}

// API Endpoints
app.get('/search/:username', async (req, res) => {
    const username = req.params.username.replace(/^@/, '').trim();
    const gifter = gifters.get(username);
    const donor = donors.get(username);
    
    res.json({
        username: username,
        nickname: gifter?.nickname || donor?.nickname || username,
        avatar: gifter?.avatar || donor?.avatar || null,
        found: !!gifter || !!donor,
        totalGifts: gifter?.totalGifts || donor?.totalGifts || 0,
        isDonor: !!(gifter?.isDonor || donor)
    });
});

app.get('/connect/:username', async (req, res) => {
    const username = req.params.username;
    console.log(`📡 Conectando a: ${username}`);
    
    isManualDisconnect = false;
    reconnectAttempts = 0;
    
    const success = await connectToTikTok(username);
    
    if (success) {
        res.json({ status: 'connected', username });
    } else {
        scheduleReconnect();
        res.json({ status: 'error', error: 'No se pudo conectar' });
    }
});

app.get('/disconnect', async (req, res) => {
    await disconnectFromTikTok();
    res.json({ status: 'disconnected' });
});

app.get('/status', (req, res) => {
    res.json({
        connected: !!currentUsername && !!pollInterval,
        username: currentUsername,
        gifters: gifters.size,
        donors: donors.size
    });
});

app.get('/gifters', (req, res) => {
    res.json({ gifters: getGiftersList(), total: gifters.size, donors: donors.size });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// WebSocket
wss.on('connection', (ws) => {
    clients.add(ws);
    
    ws.send(JSON.stringify({
        type: 'connection_status',
        connected: !!currentUsername && !!pollInterval,
        username: currentUsername,
        viewerCount: gifters.size,
        donorsCount: donors.size
    }));
    
    ws.send(JSON.stringify({
        type: 'viewers_update',
        data: getGiftersList(),
        total: gifters.size,
        donors: donors.size
    }));
    
    ws.on('close', () => clients.delete(ws));
});

startCleanupInterval();

server.listen(PORT, () => {
    console.log(`\n🚀 SERVIDOR TIKTOK LIVE`);
    console.log(`📡 Puerto: ${PORT}`);
    console.log(`🌐 http://localhost:${PORT}`);
    console.log(`🔑 API Key EulerStream configurada`);
    console.log(`\n✨ Para conectar, ingresa un username y presiona "Conectar Live"`);
    console.log(`📌 Asegúrate que el usuario esté EN VIVO en TikTok\n`);
});
