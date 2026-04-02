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
let viewers = new Map();
let currentUsername = null;
let isManualDisconnect = false;
let reconnectTimer = null;

const MAX_VIEWERS = 3000;
const RECONNECT_DELAY = 3000;

const avatarCache = new Map();
const TIKTOOL_API_KEY = 'tk_19ccc744ea1023f55fc03ede8dd300da8519a313022ab447';

async function fetchAvatarFromTikTool(uniqueId) {
    if (avatarCache.has(uniqueId)) return avatarCache.get(uniqueId);
    
    try {
        const response = await fetch(`https://api.tik.tools/user/${uniqueId}`, {
            headers: {
                'Authorization': `Bearer ${TIKTOOL_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (response.ok) {
            const data = await response.json();
            const avatarUrl = data?.user?.avatar || data?.avatar || data?.profilePicture || null;
            if (avatarUrl && avatarUrl.startsWith('http')) {
                console.log(`✅ Avatar encontrado para @${uniqueId}`);
                avatarCache.set(uniqueId, avatarUrl);
                return avatarUrl;
            }
        }
        return null;
    } catch (error) {
        console.error(`Error fetching avatar: ${error.message}`);
        return null;
    }
}

app.get('/search/:username', async (req, res) => {
    try {
        const username = req.params.username.replace(/^@/, '').trim();
        console.log(`🔍 Buscando usuario: ${username}`);
        
        const viewer = viewers.get(username);
        let avatar = viewer?.avatar || null;
        
        if (!avatar) {
            avatar = await fetchAvatarFromTikTool(username);
            if (avatar && viewer) {
                viewer.avatar = avatar;
                broadcastViewers();
            }
        }
        
        res.json({
            username: username,
            nickname: viewer?.nickname || username,
            avatar: avatar,
            found: !!viewer || !!avatar
        });
    } catch (err) {
        res.json({ error: err.message });
    }
});

function getAvatarUrl(user) {
    try {
        if (user?.avatarThumbnail?.url) return user.avatarThumbnail.url;
        if (user?.avatarMedium?.url) return user.avatarMedium.url;
        if (user?.avatarLarge?.url) return user.avatarLarge.url;
        return null;
    } catch (e) {
        return null;
    }
}

function broadcastViewers() {
    const viewerList = Array.from(viewers.values()).slice(0, 500).map(v => ({
        username: v.username,
        nickname: v.nickname,
        avatar: v.avatar
    }));
    
    const message = JSON.stringify({ type: 'viewers', data: viewerList, total: viewers.size });
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
        viewerCount: viewers.size
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
                broadcastViewers();
            }
        }, 2000);
    }
    
    function addViewer(userData) {
        try {
            const uniqueId = userData?.uniqueId;
            if (!uniqueId || uniqueId === username) return;
            if (viewers.size >= MAX_VIEWERS && !viewers.has(uniqueId)) return;
            
            if (!viewers.has(uniqueId)) {
                const avatar = getAvatarUrl(userData);
                viewers.set(uniqueId, {
                    username: uniqueId,
                    nickname: userData?.nickname || userData?.displayId || uniqueId,
                    avatar: avatar || null
                });
                console.log(`👥 +${uniqueId} (${viewers.size})`);
                pendingUpdate = true;
                scheduleBroadcast();
            }
        } catch (e) {}
    }
    
    function removeViewer(uniqueId) {
        if (uniqueId && viewers.has(uniqueId)) {
            viewers.delete(uniqueId);
            console.log(`🚪 -${uniqueId} (${viewers.size})`);
            pendingUpdate = true;
            scheduleBroadcast();
        }
    }
    
    async function updateAvatarFromGift(uniqueId, userData) {
        if (uniqueId && viewers.has(uniqueId)) {
            const viewer = viewers.get(uniqueId);
            if (!viewer.avatar) {
                const avatar = getAvatarUrl(userData);
                if (avatar) {
                    viewer.avatar = avatar;
                    pendingUpdate = true;
                    scheduleBroadcast();
                } else {
                    const apiAvatar = await fetchAvatarFromTikTool(uniqueId);
                    if (apiAvatar) {
                        viewer.avatar = apiAvatar;
                        pendingUpdate = true;
                        scheduleBroadcast();
                        console.log(`🖼️ Foto para @${uniqueId}`);
                    }
                }
            }
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
        const count = data?.viewerCount || viewers.size;
        console.log(`📊 Espectadores: ${count}`);
        broadcastStatus(true, `Live: ${count} viewers`);
    });
    
    tiktokConnection.on(WebcastEvent.MEMBER, (data) => {
        if (data?.user) addViewer(data.user);
    });
    
    tiktokConnection.on(WebcastEvent.MEMBER_JOIN, (data) => {
        if (data?.user) addViewer(data.user);
    });
    
    tiktokConnection.on(WebcastEvent.MEMBER_LEAVE, (data) => {
        if (data?.user?.uniqueId) removeViewer(data.user.uniqueId);
    });
    
    tiktokConnection.on(WebcastEvent.GIFT, (data) => {
        if (data?.user) {
            console.log(`🎁 REGALO de @${data.user.uniqueId}`);
            addViewer(data.user);
            updateAvatarFromGift(data.user.uniqueId, data.user);
        }
    });
    
    tiktokConnection.on(WebcastEvent.CHAT, (data) => {
        if (data?.user) addViewer(data.user);
    });
}

wss.on('connection', (ws) => {
    console.log('📱 Cliente conectado');
    clients.add(ws);
    
    ws.send(JSON.stringify({ 
        type: 'connection_status', 
        connected: tiktokConnection?.isConnected || false,
        username: currentUsername,
        viewerCount: viewers.size
    }));
    
    const viewerList = Array.from(viewers.values()).slice(0, 500).map(v => ({
        username: v.username,
        nickname: v.nickname,
        avatar: v.avatar
    }));
    ws.send(JSON.stringify({ type: 'viewers', data: viewerList, total: viewers.size }));
    
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
        viewers.clear();
        currentUsername = null;
        broadcastViewers();
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
        viewers: viewers.size,
        maxViewers: MAX_VIEWERS
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
    console.log(`🚀 Servidor en puerto ${PORT}`);
    console.log(`⚙️ Máximo: ${MAX_VIEWERS} espectadores`);
    console.log(`🔍 Endpoint /search/:username disponible`);
});
