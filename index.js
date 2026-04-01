const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { TikTokLiveConnection, WebcastEvent } = require('tiktok-live-connector');
const path = require('path');

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
let reconnectAttempts = 0;
let heartbeatInterval = null;

const MAX_VIEWERS_LIMIT = 5000;
const RECONNECT_DELAY = 5000;
const HEARTBEAT_INTERVAL = 20000;
const BROADCAST_INTERVAL = 3000;

function getAvatarUrl(user) {
    try {
        if (user?.avatarThumbnail?.url) return user.avatarThumbnail.url;
        if (user?.avatarMedium?.url) return user.avatarMedium.url;
        if (user?.avatarLarge?.url) return user.avatarLarge.url;
        if (user?.profilePicture) return user.profilePicture;
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

function broadcastCommand(command) {
    const message = JSON.stringify({ type: 'command', command });
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try { client.send(message); } catch (e) {}
        }
    });
}

function broadcastStatus(connected, message = '', viewerCount = null) {
    const statusMsg = JSON.stringify({ 
        type: 'connection_status', 
        connected, 
        message, 
        username: currentUsername,
        viewerCount: viewerCount || viewers.size,
        manualDisconnect: isManualDisconnect,
        maxViewers: MAX_VIEWERS_LIMIT
    });
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try { client.send(statusMsg); } catch (e) {}
        }
    });
}

function broadcastViewerCount(count) {
    const countMsg = JSON.stringify({ type: 'viewer_count', count: count, viewers: viewers.size });
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try { client.send(countMsg); } catch (e) {}
        }
    });
}

function cleanupViewers() {
    if (viewers.size > MAX_VIEWERS_LIMIT) {
        const toDelete = viewers.size - MAX_VIEWERS_LIMIT;
        const iterator = viewers.keys();
        for (let i = 0; i < toDelete; i++) viewers.delete(iterator.next().value);
        console.log(`🧹 Limpiados ${toDelete} espectadores. Total: ${viewers.size}`);
        broadcastViewers();
    }
}

async function connectToTikTok(username) {
    username = username.replace(/^@/, '').trim();
    
    if (!username) {
        console.error('❌ Por favor ingresa un username de TikTok');
        broadcastStatus(false, 'Please enter a TikTok username');
        return false;
    }
    
    currentUsername = username;
    isManualDisconnect = false;
    
    if (tiktokConnection) {
        try { 
            await tiktokConnection.disconnect(); 
        } catch (e) {}
        tiktokConnection = null;
    }
    
    if (heartbeatInterval) { 
        clearInterval(heartbeatInterval); 
        heartbeatInterval = null; 
    }
    
    console.log(`🔌 Conectando a @${username}...`);
    broadcastStatus(false, `Connecting to @${username}...`);
    
    try {
        tiktokConnection = new TikTokLiveConnection(username, {
            enableExtendedGiftInfo: true,
            processInitialData: true,
            requestPollingIntervalMs: 5000,
            websocketTimeout: 60000,
            enableWebsocketUpgrade: true,
            fetchChatMessages: true,
            fetchGiftMessages: true,
            fetchMemberMessages: true,
            fetchLikeMessages: false
        });
        
        setupEventHandlers(username);
        
        await tiktokConnection.connect();
        
        console.log(`✅ Conectado exitosamente a @${username}`);
        broadcastStatus(true, `Connected to @${username}`, viewers.size);
        reconnectAttempts = 0;
        
        heartbeatInterval = setInterval(() => {
            if (isManualDisconnect) return;
            if (tiktokConnection && tiktokConnection.isConnected) {
                try {
                    if (tiktokConnection.socket && tiktokConnection.socket.readyState === 1) {
                        tiktokConnection.socket.ping();
                    }
                } catch (e) {}
            } else if (tiktokConnection && !tiktokConnection.isConnected && !isManualDisconnect) {
                console.log('⚠️ Conexión perdida, reconectando...');
                scheduleReconnect();
            }
        }, HEARTBEAT_INTERVAL);
        
        setInterval(() => { if (!isManualDisconnect) cleanupViewers(); }, 300000);
        
        return true;
        
    } catch (err) {
        console.error(`❌ Error de conexión: ${err.message}`);
        broadcastStatus(false, `Connection failed: ${err.message}`);
        tiktokConnection = null;
        
        if (!isManualDisconnect) {
            scheduleReconnect();
        }
        return false;
    }
}

function scheduleReconnect() {
    if (isManualDisconnect) return;
    
    reconnectAttempts++;
    console.log(`🔄 Programando reconexión #${reconnectAttempts} en ${RECONNECT_DELAY/1000}s...`);
    broadcastStatus(false, `Reconnecting in ${RECONNECT_DELAY/1000}s... (Attempt ${reconnectAttempts})`);
    
    setTimeout(async () => {
        if (!isManualDisconnect && currentUsername) {
            await connectToTikTok(currentUsername);
        }
    }, RECONNECT_DELAY);
}

function setupEventHandlers(username) {
    if (!tiktokConnection) return;
    
    let lastBroadcastTime = 0;
    let pendingBroadcast = null;
    
    function addOrUpdateViewer(userData) {
        try {
            const uniqueId = userData?.uniqueId;
            if (!uniqueId || uniqueId === username) return;
            
            if (viewers.size >= MAX_VIEWERS_LIMIT && !viewers.has(uniqueId)) return;
            
            const avatarUrl = getAvatarUrl(userData);
            const existing = viewers.get(uniqueId);
            
            if (!existing || (existing.avatar === null && avatarUrl)) {
                viewers.set(uniqueId, {
                    username: uniqueId,
                    nickname: userData?.nickname || userData?.displayId || uniqueId,
                    avatar: avatarUrl,
                    joinedAt: Date.now()
                });
                throttledBroadcastViewers();
                broadcastViewerCount(viewers.size);
            }
        } catch (e) {
            console.error('Error al procesar usuario:', e.message);
        }
    }
    
    function removeViewer(uniqueId) {
        if (uniqueId && viewers.has(uniqueId)) {
            viewers.delete(uniqueId);
            console.log(`🚪 Salió: @${uniqueId} - Quedan: ${viewers.size}`);
            throttledBroadcastViewers();
            broadcastViewerCount(viewers.size);
        }
    }
    
    function throttledBroadcastViewers() {
        const now = Date.now();
        if (now - lastBroadcastTime >= BROADCAST_INTERVAL) {
            lastBroadcastTime = now;
            broadcastViewers();
            if (pendingBroadcast) {
                clearTimeout(pendingBroadcast);
                pendingBroadcast = null;
            }
        } else if (!pendingBroadcast) {
            pendingBroadcast = setTimeout(() => {
                lastBroadcastTime = Date.now();
                broadcastViewers();
                pendingBroadcast = null;
            }, BROADCAST_INTERVAL - (now - lastBroadcastTime));
        }
    }
    
    tiktokConnection.on(WebcastEvent.CONNECTED, () => {
        console.log(`✅ Conexión establecida con @${username}`);
        broadcastStatus(true, `Connected to @${username}`, viewers.size);
    });
    
    tiktokConnection.on(WebcastEvent.DISCONNECTED, (reason) => {
        console.log(`🔌 Desconectado: ${reason || 'Razón desconocida'} - Manteniendo ${viewers.size} espectadores`);
        broadcastStatus(false, `Disconnected: ${reason || 'Connection lost'}`, viewers.size);
        
        if (!isManualDisconnect && currentUsername) {
            scheduleReconnect();
        } else if (isManualDisconnect) {
            viewers.clear();
            broadcastViewers();
        }
    });
    
    tiktokConnection.on(WebcastEvent.ERROR, (error) => {
        console.error(`❌ Error: ${error.message || error}`);
        broadcastStatus(false, `Error: ${error.message || 'Connection error'}`, viewers.size);
        
        if (!isManualDisconnect && currentUsername) {
            scheduleReconnect();
        }
    });
    
    tiktokConnection.on(WebcastEvent.ROOM_USER_SEGMENT, (data) => {
        const count = data?.viewerCount || viewers.size;
        console.log(`📊 Espectadores: ${count} | Registrados: ${viewers.size}`);
        broadcastStatus(true, `Live: ${count} viewers`, count);
        broadcastViewerCount(count);
    });
    
    tiktokConnection.on(WebcastEvent.MEMBER, (data) => {
        if (data?.user) addOrUpdateViewer(data.user);
    });
    
    tiktokConnection.on(WebcastEvent.MEMBER_JOIN, (data) => {
        if (data?.user) {
            console.log(`➕ Entró: @${data.user.uniqueId}`);
            addOrUpdateViewer(data.user);
        }
    });
    
    tiktokConnection.on(WebcastEvent.MEMBER_LEAVE, (data) => {
        const uniqueId = data?.user?.uniqueId;
        if (uniqueId) {
            removeViewer(uniqueId);
        }
    });
    
    tiktokConnection.on(WebcastEvent.GIFT, (data) => {
        if (data?.user) {
            console.log(`🎁 REGALO de @${data.user.uniqueId}: ${data.giftName || 'gift'} x${data.repeatCount || 1}`);
            addOrUpdateViewer(data.user);
        }
    });
    
    tiktokConnection.on(WebcastEvent.CHAT, (data) => {
        if (data?.user) addOrUpdateViewer(data.user);
        
        const comment = data?.comment?.trim() || '';
        if (comment.toLowerCase().startsWith('!send')) {
            console.log(`📨 Comando: ${comment}`);
            broadcastCommand(comment);
        }
    });
}

wss.on('connection', (ws) => {
    console.log('📱 Cliente conectado');
    clients.add(ws);
    
    const isConnected = tiktokConnection && tiktokConnection.isConnected;
    ws.send(JSON.stringify({ 
        type: 'connection_status', 
        connected: isConnected,
        username: currentUsername,
        viewerCount: viewers.size,
        maxViewers: MAX_VIEWERS_LIMIT,
        message: isConnected ? 'Connected' : 'Disconnected'
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
    
    ws.on('error', (err) => {
        console.error('WebSocket error:', err.message);
    });
});

app.get('/connect/:username', async (req, res) => {
    try {
        const username = req.params.username;
        console.log(`📡 Solicitud de conexión para: ${username}`);
        
        isManualDisconnect = false;
        
        const success = await connectToTikTok(username);
        
        if (success) {
            res.json({ status: 'connected', username: username });
        } else {
            res.json({ status: 'error', error: 'Could not connect to TikTok live. Make sure the user is currently live.' });
        }
    } catch (err) {
        console.error('Error en /connect:', err);
        res.json({ status: 'error', error: err.message });
    }
});

app.get('/disconnect', async (req, res) => {
    try {
        console.log('🔌 Desconexión manual');
        isManualDisconnect = true;
        
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = null;
        }
        
        if (tiktokConnection) {
            await tiktokConnection.disconnect();
            tiktokConnection = null;
        }
        
        viewers.clear();
        currentUsername = null;
        reconnectAttempts = 0;
        
        broadcastViewers();
        broadcastStatus(false, 'Manually disconnected');
        res.json({ status: 'disconnected' });
    } catch (err) {
        console.error('Error en desconexión:', err);
        res.json({ status: 'error', error: err.message });
    }
});

app.get('/status', (req, res) => {
    const mem = process.memoryUsage();
    res.json({ 
        connected: tiktokConnection?.isConnected || false,
        username: currentUsername,
        viewers: viewers.size,
        maxViewers: MAX_VIEWERS_LIMIT,
        reconnectAttempts: reconnectAttempts,
        memory: `${Math.round(mem.heapUsed / 1024 / 1024)}MB`
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
    console.log(`⚙️ Configuración:`);
    console.log(`   📊 Máximo espectadores: ${MAX_VIEWERS_LIMIT}`);
    console.log(`   🔄 Reconexión automática cada ${RECONNECT_DELAY/1000}s`);
    console.log(`   💓 Heartbeat cada ${HEARTBEAT_INTERVAL/1000}s`);
    console.log(`   📝 Para conectar: escribe el username de TikTok en el input y haz clic en Connect`);
});
