const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { TikTokLiveConnection, WebcastEvent } = require('tiktok-live-connector');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 8080;
app.use(express.static(path.join(__dirname, 'public')));

const clients = new Set();
let tiktokConnection = null;
let donors = new Map();
let currentUsername = null;
let isManualDisconnect = false;
let reconnectTimer = null;
let reconnectAttempts = 0;

const RECONNECT_DELAY = 3000;
const MAX_RECONNECT_ATTEMPTS = Infinity; // Infinitos intentos

const avatarCache = new Map();
const TIKTOOL_API_KEY = 'tk_19ccc744ea1023f55fc03ede8dd300da8519a313022ab447';

async function fetchUserInfo(uniqueId) {
    if (avatarCache.has(uniqueId)) return avatarCache.get(uniqueId);
    
    try {
        const response = await fetch(`https://api.tik.tools/user/${uniqueId}`, {
            headers: { 'Authorization': `Bearer ${TIKTOOL_API_KEY}`, 'Content-Type': 'application/json' }
        });
        
        if (response.ok) {
            const data = await response.json();
            const result = {
                nickname: data?.user?.nickname || data?.nickname || uniqueId,
                avatar: data?.user?.avatar || data?.avatar || null
            };
            avatarCache.set(uniqueId, result);
            return result;
        }
        return { nickname: uniqueId, avatar: null };
    } catch (error) {
        return { nickname: uniqueId, avatar: null };
    }
}

app.get('/search/:username', async (req, res) => {
    try {
        const username = req.params.username.replace(/^@/, '').trim();
        const donor = donors.get(username);
        res.json({
            username: username,
            nickname: donor?.nickname || username,
            avatar: donor?.avatar || null,
            found: !!donor
        });
    } catch (err) {
        res.json({ error: err.message });
    }
});

function broadcastDonors() {
    const donorList = Array.from(donors.values()).map(v => ({
        username: v.username, nickname: v.nickname, avatar: v.avatar, lastGift: v.lastGift
    }));
    const message = JSON.stringify({ type: 'donors', data: donorList, total: donorList.length });
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) try { client.send(message); } catch(e) {}
    });
}

function broadcastGift(username, nickname, giftName, giftCount, avatar) {
    const message = JSON.stringify({ type: 'gift', username, nickname, giftName, giftCount, avatar });
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) try { client.send(message); } catch(e) {}
    });
}

function broadcastStatus(connected, message = '') {
    const statusMsg = JSON.stringify({ type: 'connection_status', connected, message, username: currentUsername, donorCount: donors.size });
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) try { client.send(statusMsg); } catch(e) {}
    });
}

function scheduleReconnect() {
    if (isManualDisconnect) {
        console.log('🔒 Desconexión manual, no se reconectará');
        return;
    }
    if (reconnectTimer) clearTimeout(reconnectTimer);
    
    reconnectAttempts++;
    console.log(`🔄 Intento de reconexión #${reconnectAttempts} en ${RECONNECT_DELAY/1000}s...`);
    broadcastStatus(false, `Reconectando... Intento ${reconnectAttempts}`);
    
    reconnectTimer = setTimeout(async () => {
        if (!isManualDisconnect && currentUsername) {
            console.log(`🔄 Reconectando a @${currentUsername}...`);
            await connectToTikTok(currentUsername);
        }
    }, RECONNECT_DELAY);
}

async function connectToTikTok(username) {
    username = username.replace(/^@/, '').trim();
    if (!username) return false;
    
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (tiktokConnection) {
        try { await tiktokConnection.disconnect(); } catch(e) {}
        tiktokConnection = null;
    }
    
    currentUsername = username;
    console.log(`🔌 Conectando a @${username}...`);
    broadcastStatus(false, `Conectando a @${username}...`);
    
    try {
        tiktokConnection = new TikTokLiveConnection(username, {
            enableExtendedGiftInfo: true,
            processInitialData: true,
            requestPollingIntervalMs: 3000,
            websocketTimeout: 120000, // Timeout más largo
            enableWebsocketUpgrade: true,
            fetchChatMessages: true,
            fetchGiftMessages: true,
            fetchMemberMessages: true,
            fetchLikeMessages: false
        });
        
        setupEventHandlers(username);
        await tiktokConnection.connect();
        
        console.log(`✅ Conectado permanentemente a @${username}`);
        broadcastStatus(true, `Conectado a @${username}`);
        reconnectAttempts = 0;
        return true;
    } catch (err) {
        console.error(`❌ Error de conexión: ${err.message}`);
        broadcastStatus(false, `Error: ${err.message}`);
        tiktokConnection = null;
        scheduleReconnect();
        return false;
    }
}

// Limpiar donadores inactivos cada 2 minutos
setInterval(() => {
    const now = Date.now();
    let removed = 0;
    donors.forEach((donor, id) => {
        if (now - donor.lastSeen > 120000) { donors.delete(id); removed++; }
    });
    if (removed > 0) { console.log(`🧹 Limpiados ${removed} donadores inactivos`); broadcastDonors(); }
}, 120000);

// Heartbeat para mantener conexión viva
setInterval(() => {
    if (tiktokConnection && tiktokConnection.isConnected && !isManualDisconnect) {
        console.log('💓 Heartbeat - Conexión activa');
    } else if (!isManualDisconnect && currentUsername) {
        console.log('⚠️ Heartbeat detectó conexión perdida, reconectando...');
        scheduleReconnect();
    }
}, 30000);

function setupEventHandlers(username) {
    if (!tiktokConnection) return;
    
    async function addDonor(uniqueId, userData, giftName, giftCount) {
        try {
            let avatar = userData?.avatarThumbnail?.url || userData?.avatarMedium?.url || userData?.avatarLarge?.url || null;
            let nickname = userData?.nickname || userData?.displayId || uniqueId;
            
            if (!avatar || nickname === uniqueId) {
                const userInfo = await fetchUserInfo(uniqueId);
                if (!avatar && userInfo.avatar) avatar = userInfo.avatar;
                if (nickname === uniqueId && userInfo.nickname !== uniqueId) nickname = userInfo.nickname;
            }
            
            donors.set(uniqueId, {
                username: uniqueId, nickname, avatar, lastGift: `${giftName} x${giftCount}`, lastSeen: Date.now()
            });
            
            broadcastDonors();
            broadcastGift(uniqueId, nickname, giftName, giftCount, avatar);
            console.log(`✅ DONADOR: @${uniqueId} (${nickname}) - ${giftName} x${giftCount}`);
        } catch(e) { console.error(`Error: ${e.message}`); }
    }
    
    tiktokConnection.on(WebcastEvent.GIFT, async (data) => {
        if (data?.user) {
            console.log(`🎁 REGALO RECIBIDO - @${data.user.uniqueId} - ${data.giftName} x${data.repeatCount}`);
            await addDonor(data.user.uniqueId, data.user, data.giftName || 'Gift', data.repeatCount || 1);
        }
    });
    
    tiktokConnection.on(WebcastEvent.CONNECTED, () => {
        console.log(`✅ Conexión reestablecida con @${username}`);
        broadcastStatus(true, `Conectado a @${username}`);
    });
    
    tiktokConnection.on(WebcastEvent.DISCONNECTED, (reason) => {
        console.log(`🔌 Desconectado: ${reason || 'Razón desconocida'}`);
        broadcastStatus(false, `Desconectado - Reconectando...`);
        if (!isManualDisconnect) scheduleReconnect();
    });
    
    tiktokConnection.on(WebcastEvent.ERROR, (error) => {
        console.error(`❌ Error: ${error.message}`);
        if (!isManualDisconnect) scheduleReconnect();
    });
    
    tiktokConnection.on(WebcastEvent.ROOM_USER_SEGMENT, (data) => {
        console.log(`📊 Espectadores: ${data?.viewerCount || 0} | Donadores: ${donors.size}`);
    });
}

wss.on('connection', (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify({ type: 'connection_status', connected: tiktokConnection?.isConnected || false, username: currentUsername, donorCount: donors.size }));
    ws.send(JSON.stringify({ type: 'donors', data: Array.from(donors.values()), total: donors.size }));
    ws.on('close', () => clients.delete(ws));
});

app.get('/connect/:username', async (req, res) => {
    try {
        isManualDisconnect = false;
        await connectToTikTok(req.params.username);
        res.json({ status: 'connected' });
    } catch (err) {
        res.json({ status: 'error', error: err.message });
    }
});

app.get('/disconnect', async (req, res) => {
    console.log('🔌 Desconexión manual solicitada');
    isManualDisconnect = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (tiktokConnection) await tiktokConnection.disconnect();
    tiktokConnection = null;
    donors.clear();
    currentUsername = null;
    reconnectAttempts = 0;
    broadcastDonors();
    broadcastStatus(false, 'Desconectado manualmente');
    res.json({ status: 'disconnected' });
});

app.get('/status', (req, res) => res.json({ 
    connected: tiktokConnection?.isConnected || false, 
    username: currentUsername, 
    donors: donors.size,
    reconnectAttempts: reconnectAttempts
}));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

server.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
    console.log(`🔄 Modo: Reconexión infinita automática`);
    console.log(`🎁 Solo donadores visibles`);
});
