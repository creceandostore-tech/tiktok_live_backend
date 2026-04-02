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
let donors = new Map(); // Solo donadores (los que envían regalos)
let currentUsername = null;
let isManualDisconnect = false;
let reconnectTimer = null;

const MAX_DONORS = 5000;
const RECONNECT_DELAY = 3000;

const avatarCache = new Map();
const TIKTOOL_API_KEY = 'tk_19ccc744ea1023f55fc03ede8dd300da8519a313022ab447';

async function fetchUserInfo(uniqueId) {
    try {
        const response = await fetch(`https://api.tik.tools/user/${uniqueId}`, {
            headers: {
                'Authorization': `Bearer ${TIKTOOL_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (response.ok) {
            const data = await response.json();
            return {
                nickname: data?.user?.nickname || data?.nickname || uniqueId,
                avatar: data?.user?.avatar || data?.avatar || null
            };
        }
        return { nickname: uniqueId, avatar: null };
    } catch (error) {
        console.error(`Error fetching user info: ${error.message}`);
        return { nickname: uniqueId, avatar: null };
    }
}

app.get('/search/:username', async (req, res) => {
    try {
        const username = req.params.username.replace(/^@/, '').trim();
        console.log(`🔍 Buscando usuario: ${username}`);
        
        const donor = donors.get(username);
        let avatar = donor?.avatar || null;
        let nickname = donor?.nickname || username;
        
        if (!avatar) {
            const userInfo = await fetchUserInfo(username);
            avatar = userInfo.avatar;
            nickname = userInfo.nickname;
        }
        
        res.json({
            username: username,
            nickname: nickname,
            avatar: avatar,
            found: !!donor
        });
    } catch (err) {
        res.json({ error: err.message });
    }
});

function broadcastDonors() {
    const donorList = Array.from(donors.values())
        .slice(0, 500)
        .map(v => ({
            username: v.username,
            nickname: v.nickname,
            avatar: v.avatar,
            lastGift: v.lastGift
        }));
    
    const message = JSON.stringify({ type: 'donors', data: donorList, total: donorList.length });
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try { client.send(message); } catch (e) {}
        }
    });
    console.log(`📢 Donadores actuales: ${donorList.length}`);
}

function broadcastGift(username, nickname, giftName, giftCount, avatar) {
    const message = JSON.stringify({ 
        type: 'gift', 
        username: username,
        nickname: nickname,
        giftName: giftName,
        giftCount: giftCount,
        avatar: avatar
    });
    console.log(`🎁 Notificación: @${username} (${nickname}) - ${giftName} x${giftCount}`);
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try { client.send(message); } catch (e) {}
        }
    });
}

function broadcastStatus(connected, message = '') {
    const statusMsg = JSON.stringify({ 
        type: 'connection_status', 
        connected, 
        message, 
        username: currentUsername,
        donorCount: donors.size
    });
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try { client.send(statusMsg); } catch (e) {}
        }
    });
}

function scheduleReconnect() {
    if (isManualDisconnect) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    
    console.log(`🔄 Programando reconexión en ${RECONNECT_DELAY/1000}s...`);
    broadcastStatus(false, `Reconnecting in ${RECONNECT_DELAY/1000}s...`);
    
    reconnectTimer = setTimeout(async () => {
        if (!isManualDisconnect && currentUsername) {
            await connectToTikTok(currentUsername);
        }
    }, RECONNECT_DELAY);
}

async function connectToTikTok(username) {
    username = username.replace(/^@/, '').trim();
    if (!username) return false;
    
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (tiktokConnection) {
        try { await tiktokConnection.disconnect(); } catch (e) {}
        tiktokConnection = null;
    }
    
    currentUsername = username;
    console.log(`🔌 Conectando a @${username}...`);
    broadcastStatus(false, `Connecting to @${username}...`);
    
    try {
        tiktokConnection = new TikTokLiveConnection(username, {
            enableExtendedGiftInfo: true,
            processInitialData: true,
            requestPollingIntervalMs: 5000,
            websocketTimeout: 90000,
            fetchChatMessages: true,
            fetchGiftMessages: true,
            fetchMemberMessages: true,
            fetchLikeMessages: false
        });
        
        setupEventHandlers(username);
        await tiktokConnection.connect();
        
        console.log(`✅ Conectado a @${username}`);
        broadcastStatus(true, `Connected to @${username}`);
        return true;
    } catch (err) {
        console.error(`❌ Error: ${err.message}`);
        broadcastStatus(false, `Error: ${err.message}`);
        tiktokConnection = null;
        if (!isManualDisconnect) scheduleReconnect();
        return false;
    }
}

// Limpiar donadores inactivos cada 1 minuto
setInterval(() => {
    if (!tiktokConnection || !tiktokConnection.isConnected) return;
    
    const now = Date.now();
    let removedCount = 0;
    
    donors.forEach((donor, uniqueId) => {
        if (now - donor.lastSeen > 70000) {
            donors.delete(uniqueId);
            removedCount++;
        }
    });
    
    if (removedCount > 0) {
        console.log(`🧹 Limpiados ${removedCount} donadores inactivos. Donadores restantes: ${donors.size}`);
        broadcastDonors();
    }
}, 60000);

function setupEventHandlers(username) {
    if (!tiktokConnection) return;
    
    let broadcastTimeout = null;
    let pendingUpdate = false;
    
    function scheduleBroadcast() {
        if (broadcastTimeout) return;
        broadcastTimeout = setTimeout(() => {
            broadcastTimeout = null;
            if (pendingUpdate) {
                pendingUpdate = false;
                broadcastDonors();
            }
        }, 2000);
    }
    
    async function addDonor(uniqueId, userData, giftName, giftCount) {
        try {
            const now = Date.now();
            const existing = donors.get(uniqueId);
            
            // Obtener avatar del evento
            let avatar = null;
            if (userData?.avatarThumbnail?.url) avatar = userData.avatarThumbnail.url;
            else if (userData?.avatarMedium?.url) avatar = userData.avatarMedium.url;
            else if (userData?.avatarLarge?.url) avatar = userData.avatarLarge.url;
            
            // Obtener nombre real
            let nickname = userData?.nickname || userData?.displayId || uniqueId;
            
            // Si no tiene avatar o nickname, buscar en API
            if (!avatar || nickname === uniqueId) {
                const userInfo = await fetchUserInfo(uniqueId);
                if (!avatar && userInfo.avatar) avatar = userInfo.avatar;
                if (nickname === uniqueId && userInfo.nickname !== uniqueId) nickname = userInfo.nickname;
            }
            
            donors.set(uniqueId, {
                username: uniqueId,
                nickname: nickname,
                avatar: avatar,
                lastGift: `${giftName} x${giftCount}`,
                lastSeen: now
            });
            
            console.log(`✅ Donador registrado: @${uniqueId} (${nickname}) - ${giftName} x${giftCount}`);
            pendingUpdate = true;
            scheduleBroadcast();
            
            // Enviar notificación al frontend
            broadcastGift(uniqueId, nickname, giftName, giftCount, avatar);
            
        } catch (e) {
            console.error(`Error adding donor: ${e.message}`);
        }
    }
    
    function updateDonorActivity(uniqueId) {
        if (donors.has(uniqueId)) {
            donors.get(uniqueId).lastSeen = Date.now();
        }
    }
    
    tiktokConnection.on(WebcastEvent.CONNECTED, () => {
        console.log(`✅ Conexión establecida`);
        broadcastStatus(true, `Connected`);
    });
    
    tiktokConnection.on(WebcastEvent.DISCONNECTED, (reason) => {
        console.log(`🔌 Desconectado`);
        broadcastStatus(false, `Disconnected`);
        if (!isManualDisconnect && currentUsername) scheduleReconnect();
    });
    
    tiktokConnection.on(WebcastEvent.ERROR, (error) => {
        console.error(`❌ Error: ${error.message}`);
        broadcastStatus(false, `Error: ${error.message}`);
    });
    
    tiktokConnection.on(WebcastEvent.ROOM_USER_SEGMENT, (data) => {
        const count = data?.viewerCount || 0;
        console.log(`📊 Espectadores en live: ${count} | Donadores registrados: ${donors.size}`);
        broadcastStatus(true, `Live: ${count} viewers`);
    });
    
    // EVENTO DE REGALO - Registrar donador
    tiktokConnection.on(WebcastEvent.GIFT, async (data) => {
        if (data?.user) {
            const userId = data.user.uniqueId;
            const giftName = data.giftName || 'Gift';
            const repeatCount = data.repeatCount || 1;
            const diamondCount = data.diamondCount || 0;
            console.log(`🎁 REGALO RECIBIDO - Usuario: @${userId} | Gift: ${giftName} | Cantidad: ${repeatCount} | Diamantes: ${diamondCount}`);
            
            // Registrar donador
            await addDonor(userId, data.user, giftName, repeatCount);
        }
    });
    
    tiktokConnection.on(WebcastEvent.CHAT, (data) => {
        if (data?.user?.uniqueId) {
            updateDonorActivity(data.user.uniqueId);
        }
    });
}

wss.on('connection', (ws) => {
    console.log('📱 Cliente conectado');
    clients.add(ws);
    
    ws.send(JSON.stringify({ 
        type: 'connection_status', 
        connected: tiktokConnection?.isConnected || false,
        username: currentUsername,
        donorCount: donors.size
    }));
    
    // Enviar lista de donadores actuales
    const donorList = Array.from(donors.values()).slice(0, 500).map(v => ({
        username: v.username,
        nickname: v.nickname,
        avatar: v.avatar,
        lastGift: v.lastGift
    }));
    ws.send(JSON.stringify({ type: 'donors', data: donorList, total: donorList.length }));
    
    ws.on('close', () => {
        console.log('📱 Cliente desconectado');
        clients.delete(ws);
    });
});

app.get('/connect/:username', async (req, res) => {
    try {
        const username = req.params.username;
        console.log(`📡 Conectar a: ${username}`);
        isManualDisconnect = false;
        await connectToTikTok(username);
        res.json({ status: 'connected', username: username });
    } catch (err) {
        res.json({ status: 'error', error: err.message });
    }
});

app.get('/disconnect', async (req, res) => {
    try {
        console.log('🔌 Desconexión manual');
        isManualDisconnect = true;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        if (tiktokConnection) await tiktokConnection.disconnect();
        tiktokConnection = null;
        donors.clear();
        currentUsername = null;
        broadcastDonors();
        broadcastStatus(false, 'Disconnected');
        res.json({ status: 'disconnected' });
    } catch (err) {
        res.json({ status: 'error', error: err.message });
    }
});

app.get('/status', (req, res) => {
    res.json({ 
        connected: tiktokConnection?.isConnected || false,
        username: currentUsername,
        donors: donors.size
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
    console.log(`🚀 Servidor en puerto ${PORT}`);
    console.log(`🎁 Modo: Solo donadores visibles`);
    console.log(`🧹 Limpieza automática cada 60 segundos`);
});
