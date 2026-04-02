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
let gifters = new Map(); // Todos los que envían regalos
let donors = new Map(); // Donadores persistentes

const MAX_GIFTERS = 5000;
const CLEANUP_INTERVAL = 120000; // 2 minutos

// Configuración de EulerStream
const EULER_API_KEY = '2c5a970dd2bb1a859a1'; // Tu API Key
const EULER_WS_URL = 'wss://events.eulerstream.com';

// WebSocket de EulerStream
let eulerWs = null;

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
        timestamp: Date.now()
    });
}

// Procesar regalo recibido de EulerStream
function processGift(giftData) {
    try {
        // Extraer datos del regalo según el formato de EulerStream
        const uniqueId = giftData.uniqueId || giftData.user?.uniqueId;
        const nickname = giftData.nickname || giftData.user?.nickname || uniqueId;
        const giftName = giftData.giftName || giftData.gift?.name || 'Regalo';
        const diamondCount = giftData.diamondCount || giftData.gift?.diamondCount || 1;
        const avatar = giftData.profilePicture || giftData.user?.profilePicture || null;
        const timestamp = giftData.timestamp || Date.now();
        
        if (!uniqueId) {
            console.log('⚠️ Regalo sin uniqueId:', giftData);
            return;
        }
        
        console.log(`🎁 REGALO DETECTADO: @${uniqueId} - ${giftName} (${diamondCount}💎)`);
        
        const now = Date.now();
        let totalGifts = 0;
        let isNewDonor = false;
        
        // Actualizar o crear gifter
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
                firstGiftTime: timestamp
            });
            totalGifts = diamondCount;
            console.log(`✨ NUEVO GIFTER: @${uniqueId} (${gifters.size} total)`);
        } else {
            const existing = gifters.get(uniqueId);
            existing.lastGiftTime = now;
            existing.totalGifts += diamondCount;
            existing.lastGiftName = giftName;
            totalGifts = existing.totalGifts;
            
            // Actualizar avatar si no tiene
            if (!existing.avatar && avatar) {
                existing.avatar = avatar;
            }
            
            gifters.set(uniqueId, existing);
            console.log(`🔄 REGALO ACUMULADO: @${uniqueId} - Total: ${totalGifts}💎`);
        }
        
        // Verificar si se convierte en donador (más de 100 diamantes acumulados o regalo de 50+)
        const shouldBeDonor = diamondCount >= 50 || totalGifts >= 100;
        if (shouldBeDonor && !donors.has(uniqueId)) {
            const gifter = gifters.get(uniqueId);
            donors.set(uniqueId, {
                username: uniqueId,
                nickname: nickname,
                avatar: gifter?.avatar || avatar,
                firstGiftDate: gifter?.firstGiftTime || now,
                totalGifts: totalGifts
            });
            
            gifter.isDonor = true;
            gifters.set(uniqueId, gifter);
            isNewDonor = true;
            
            console.log(`🏆 NUEVO DONADOR PERMANENTE: @${uniqueId} (Total: ${totalGifts}💎)`);
            
            // Broadcast de nuevo donador
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
        
        // Broadcast del regalo en tiempo real
        broadcastToAllClients({
            type: 'new_gift',
            data: {
                username: uniqueId,
                nickname: nickname,
                avatar: gifters.get(uniqueId)?.avatar,
                giftName: giftName,
                diamondCount: diamondCount,
                totalGifts: totalGifts,
                isDonor: gifters.get(uniqueId)?.isDonor || false,
                timestamp: timestamp
            }
        });
        
        // Actualizar lista completa periódicamente
        setTimeout(() => broadcastGiftersList(), 100);
        
    } catch (error) {
        console.error('Error procesando regalo:', error);
    }
}

// Conectar a EulerStream
async function connectToEulerStream(username) {
    if (eulerWs && eulerWs.readyState === WebSocket.OPEN) {
        console.log('⚠️ Ya hay una conexión activa, cerrando...');
        eulerWs.close();
    }
    
    currentUsername = username.replace(/^@/, '').trim();
    console.log(`🔌 Conectando a EulerStream para @${currentUsername}...`);
    broadcastStatus(false, `Conectando a @${currentUsername}...`);
    
    try {
        // Construir URL de WebSocket de EulerStream
        const wsUrl = `${EULER_WS_URL}/?apiKey=${EULER_API_KEY}&username=${currentUsername}`;
        eulerWs = new WebSocket(wsUrl);
        
        eulerWs.on('open', () => {
            console.log(`✅ Conectado a EulerStream - Monitoreando @${currentUsername}`);
            activeConnection = true;
            reconnectAttempts = 0;
            broadcastStatus(true, `Conectado a @${currentUsername} - Detectando regalos en tiempo real`);
        });
        
        eulerWs.on('message', (data) => {
            try {
                const parsed = JSON.parse(data.toString());
                console.log('📨 Evento recibido:', parsed.type || 'unknown');
                
                // Procesar diferentes tipos de eventos
                if (parsed.type === 'gift' || parsed.event === 'gift') {
                    processGift(parsed.data || parsed);
                } else if (parsed.type === 'member' || parsed.event === 'member') {
                    // Usuario que se une - no procesamos regalos
                    console.log(`👤 Usuario unido: ${parsed.data?.uniqueId || parsed.uniqueId}`);
                } else if (parsed.type === 'chat' || parsed.event === 'chat') {
                    // Mensaje de chat - no procesamos
                    console.log(`💬 Chat de: ${parsed.data?.uniqueId || parsed.uniqueId}`);
                } else {
                    // Otros eventos
                    if (parsed.data?.gift || parsed.gift) {
                        processGift(parsed.data || parsed);
                    }
                }
            } catch (err) {
                console.error('Error parseando mensaje:', err.message);
            }
        });
        
        eulerWs.on('error', (error) => {
            console.error(`❌ Error en EulerStream: ${error.message}`);
            broadcastStatus(false, `Error: ${error.message}`);
            activeConnection = false;
            
            if (!isManualDisconnect && currentUsername) {
                scheduleReconnect();
            }
        });
        
        eulerWs.on('close', (code, reason) => {
            console.log(`🔌 Conexión cerrada: ${code} - ${reason || 'sin razón'}`);
            activeConnection = false;
            broadcastStatus(false, `Desconectado - ${reason || 'reconectando...'}`);
            
            if (!isManualDisconnect && currentUsername) {
                scheduleReconnect();
            }
        });
        
        return true;
        
    } catch (error) {
        console.error(`❌ Error conectando a EulerStream: ${error.message}`);
        broadcastStatus(false, `Error de conexión: ${error.message}`);
        return false;
    }
}

function scheduleReconnect() {
    if (isManualDisconnect) return;
    
    reconnectAttempts++;
    const delay = Math.min(3000 * Math.pow(1.5, reconnectAttempts - 1), 30000);
    
    console.log(`🔄 Reconectando en ${delay/1000}s... (Intento ${reconnectAttempts})`);
    broadcastStatus(false, `Reconectando en ${delay/1000}s...`);
    
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(async () => {
        if (!isManualDisconnect && currentUsername) {
            await connectToEulerStream(currentUsername);
        }
    }, delay);
}

async function disconnectFromEulerStream() {
    isManualDisconnect = true;
    
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    
    if (eulerWs) {
        eulerWs.close();
        eulerWs = null;
    }
    
    activeConnection = false;
    currentUsername = null;
    
    console.log('🔌 Desconectado manualmente');
    broadcastStatus(false, 'Desconectado manualmente');
}

// Obtener avatar del usuario
async function fetchUserAvatar(username) {
    try {
        // Usar API de EulerStream o TikTok
        const response = await fetch(`https://www.tiktok.com/@${username}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        const html = await response.text();
        
        // Buscar avatar en el HTML
        const avatarMatch = html.match(/avatar":\{"uri":"(https:[^"]+)"/);
        if (avatarMatch) {
            return avatarMatch[1];
        }
        
        const imgMatch = html.match(/<img[^>]+class="[^"]*avatar[^"]*"[^>]+src="([^"]+)"/i);
        if (imgMatch) {
            return imgMatch[1];
        }
        
        return null;
    } catch (error) {
        console.error(`Error obteniendo avatar de @${username}:`, error.message);
        return null;
    }
}

// API Endpoints
app.get('/search/:username', async (req, res) => {
    try {
        const username = req.params.username.replace(/^@/, '').trim();
        console.log(`🔍 Buscando usuario: ${username}`);
        
        const gifter = gifters.get(username);
        const donor = donors.get(username);
        
        let avatar = gifter?.avatar || donor?.avatar || null;
        let nickname = gifter?.nickname || donor?.nickname || username;
        
        if (!avatar) {
            avatar = await fetchUserAvatar(username);
            if (avatar && gifter) {
                gifter.avatar = avatar;
                gifters.set(username, gifter);
                broadcastGiftersList();
            }
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
        console.error('Error en search:', err);
        res.json({ error: err.message });
    }
});

app.get('/connect/:username', async (req, res) => {
    try {
        const username = req.params.username;
        console.log(`📡 Solicitando conexión a: ${username}`);
        
        isManualDisconnect = false;
        reconnectAttempts = 0;
        
        const success = await connectToEulerStream(username);
        
        if (success) {
            res.json({ status: 'connected', username: username, source: 'eulerstream' });
        } else {
            res.json({ status: 'error', error: 'No se pudo conectar a EulerStream' });
        }
    } catch (err) {
        console.error('Error en conexión:', err);
        res.json({ status: 'error', error: err.message });
    }
});

app.get('/disconnect', async (req, res) => {
    try {
        await disconnectFromEulerStream();
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
        donors: donors.size,
        source: 'eulerstream'
    });
});

app.get('/gifters', (req, res) => {
    res.json({
        gifters: getGiftersList(),
        total: gifters.size,
        donors: donors.size
    });
});

app.get('/donors', (req, res) => {
    const donorsList = Array.from(donors.values());
    res.json({ donors: donorsList, total: donorsList.length });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// WebSocket para clientes
wss.on('connection', (ws) => {
    console.log('📱 Cliente conectado');
    clients.add(ws);
    
    // Enviar estado actual
    ws.send(JSON.stringify({
        type: 'connection_status',
        connected: activeConnection,
        username: currentUsername,
        viewerCount: gifters.size,
        timestamp: Date.now()
    }));
    
    // Enviar lista actual de gifters
    ws.send(JSON.stringify({
        type: 'viewers_update',
        data: getGiftersList(),
        total: gifters.size,
        timestamp: Date.now()
    }));
    
    ws.on('close', () => {
        console.log('📱 Cliente desconectado');
        clients.delete(ws);
    });
});

// Iniciar limpieza automática
startCleanupInterval();

// Iniciar servidor
server.listen(PORT, () => {
    console.log(`\n🚀 SERVIDOR TIKTOK LIVE - EULERSTREAM`);
    console.log(`📡 Puerto: ${PORT}`);
    console.log(`🌐 Abre: http://localhost:${PORT}`);
    console.log(`🔑 API Key EulerStream: ${EULER_API_KEY.substring(0, 10)}...`);
    console.log(`\n✨ ESPERANDO REGALOS REALES DE TIKTOK LIVE`);
    console.log(`📌 Conecta a cualquier usuario en vivo y los regalos aparecerán en TIEMPO REAL`);
    console.log(`🏆 Donadores: usuarios con >100💎 acumulados o regalo >50💎\n`);
});
