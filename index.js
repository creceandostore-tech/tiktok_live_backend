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
let isReconnecting = false;
let heartbeatInterval = null;

const MAX_VIEWERS_LIMIT = 2000;
const RECONNECT_DELAY = 2000;
const HEARTBEAT_INTERVAL = 10000;

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
    const viewerList = Array.from(viewers.values())
        .slice(0, MAX_VIEWERS_LIMIT)
        .map(v => ({
            username: v.username,
            nickname: v.nickname,
            avatar: v.avatar
        }));
    
    const message = JSON.stringify({ type: 'viewers', data: viewerList });
    
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(message);
            } catch (e) {
                console.error('Error sending to client:', e.message);
            }
        }
    });
}

function broadcastCommand(command) {
    const message = JSON.stringify({ type: 'command', command });
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(message);
            } catch (e) {}
        }
    });
}

function broadcastStatus(connected, message = '', viewerCount = null) {
    const statusMsg = JSON.stringify({ 
        type: 'connection_status', 
        connected, 
        message, 
        username: currentUsername,
        viewerCount: viewerCount || viewers.size
    });
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(statusMsg);
            } catch (e) {}
        }
    });
}

function broadcastViewerCount(count) {
    const countMsg = JSON.stringify({ 
        type: 'viewer_count', 
        count: count,
        viewers: viewers.size
    });
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(countMsg);
            } catch (e) {}
        }
    });
}

async function reconnectToTikTok() {
    if (isReconnecting || !currentUsername) return;
    
    isReconnecting = true;
    console.log(`🔄 Reconectando a @${currentUsername}...`);
    broadcastStatus(false, `Reconnecting to @${currentUsername}...`);
    
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
    
    await new Promise(resolve => setTimeout(resolve, RECONNECT_DELAY));
    
    try {
        await connectToTikTok(currentUsername);
    } catch (err) {
        console.error('Error en reconexión:', err.message);
        setTimeout(() => {
            isReconnecting = false;
            reconnectToTikTok();
        }, RECONNECT_DELAY * 2);
    } finally {
        isReconnecting = false;
    }
}

async function connectToTikTok(username) {
    username = username.replace(/^@/, '');
    
    if (!username || username.trim() === '') {
        console.error('❌ Username inválido');
        return;
    }
    
    currentUsername = username;
    
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
    
    console.log(`🔌 Conectando a TikTok Live: @${username}`);
    broadcastStatus(false, `Connecting to @${username}...`);
    
    try {
        tiktokConnection = new TikTokLiveConnection(username, {
            enableExtendedGiftInfo: false,
            processInitialData: true,
            requestPollingIntervalMs: 3000,
            websocketTimeout: 90000,
            enableWebsocketUpgrade: true,
            fetchChatMessages: true,
            fetchGiftMessages: false,
            fetchMemberMessages: true,
            fetchLikeMessages: false
        });
        
        setupEventHandlers(username);
        
        await tiktokConnection.connect();
        
        console.log(`✅ Conectado exitosamente a @${username}`);
        broadcastStatus(true, `Connected to @${username}`, viewers.size);
        
        heartbeatInterval = setInterval(() => {
            if (tiktokConnection && tiktokConnection.isConnected) {
                try {
                    if (tiktokConnection.socket && tiktokConnection.socket.readyState === 1) {
                        tiktokConnection.socket.ping();
                    }
                } catch (e) {
                    console.log('Heartbeat error:', e.message);
                }
            } else if (tiktokConnection && !tiktokConnection.isConnected && !isReconnecting) {
                console.log('⚠️ Conexión perdida, reconectando...');
                reconnectToTikTok();
            }
        }, HEARTBEAT_INTERVAL);
        
    } catch (err) {
        console.error(`❌ Error de conexión: ${err.message}`);
        broadcastStatus(false, `Connection failed: ${err.message}`);
        tiktokConnection = null;
        
        if (!isReconnecting) {
            setTimeout(() => {
                reconnectToTikTok();
            }, RECONNECT_DELAY);
        }
    }
}

function setupEventHandlers(username) {
    if (!tiktokConnection) return;
    
    let lastBroadcastTime = 0;
    let pendingBroadcast = null;
    
    function throttledBroadcastViewers() {
        const now = Date.now();
        if (now - lastBroadcastTime >= 1000) {
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
            }, 1000 - (now - lastBroadcastTime));
        }
    }
    
    function addOrUpdateViewer(userData) {
        try {
            const uniqueId = userData?.uniqueId;
            if (!uniqueId || uniqueId === username) return;
            
            if (viewers.size >= MAX_VIEWERS_LIMIT && !viewers.has(uniqueId)) {
                return;
            }
            
            const avatarUrl = getAvatarUrl(userData);
            const existing = viewers.get(uniqueId);
            
            if (!existing || (existing.avatar === null && avatarUrl)) {
                viewers.set(uniqueId, {
                    username: uniqueId,
                    nickname: userData?.nickname || userData?.displayId || uniqueId,
                    avatar: avatarUrl,
                    lastSeen: Date.now()
                });
                
                if (viewers.size % 10 === 0) {
                    console.log(`👥 Espectadores: ${viewers.size}`);
                }
                
                throttledBroadcastViewers();
                broadcastViewerCount(viewers.size);
            } else if (existing) {
                existing.lastSeen = Date.now();
            }
        } catch (e) {
            console.error('Error al procesar usuario:', e.message);
        }
    }
    
    function removeViewer(uniqueId) {
        if (uniqueId && viewers.has(uniqueId)) {
            viewers.delete(uniqueId);
            console.log(`🚪 Espectador salió: @${uniqueId} - Quedan: ${viewers.size}`);
            throttledBroadcastViewers();
            broadcastViewerCount(viewers.size);
        }
    }
    
    tiktokConnection.on(WebcastEvent.CONNECTED, () => {
        console.log(`✅ Conexión establecida con @${username}`);
        broadcastStatus(true, `Connected to @${username}`, viewers.size);
        isReconnecting = false;
    });
    
    tiktokConnection.on(WebcastEvent.DISCONNECTED, (reason) => {
        console.log(`🔌 Desconectado: ${reason || 'No reason'} - Reconectando...`);
        broadcastStatus(false, `Disconnected - Reconnecting...`, viewers.size);
        
        if (!isReconnecting && currentUsername) {
            setTimeout(() => {
                reconnectToTikTok();
            }, 500);
        }
    });
    
    tiktokConnection.on(WebcastEvent.ERROR, (error) => {
        console.error(`❌ Error: ${error.message || error}`);
        broadcastStatus(false, `Error: ${error.message} - Reconnecting...`, viewers.size);
        
        if (!isReconnecting && currentUsername && tiktokConnection) {
            setTimeout(() => {
                reconnectToTikTok();
            }, 1000);
        }
    });
    
    tiktokConnection.on(WebcastEvent.ROOM_USER_SEGMENT, (data) => {
        const count = data?.viewerCount || viewers.size;
        console.log(`📊 Live - Espectadores: ${count}`);
        broadcastStatus(true, `Live: ${count} viewers`, count);
        broadcastViewerCount(count);
    });
    
    tiktokConnection.on(WebcastEvent.MEMBER, (data) => {
        if (data?.user) addOrUpdateViewer(data.user);
    });
    
    // USUARIO SE UNE AL LIVE
    tiktokConnection.on(WebcastEvent.MEMBER_JOIN, (data) => {
        if (data?.user) {
            console.log(`➕ NUEVO ESPECTADOR: @${data.user.uniqueId} se unió al live`);
            addOrUpdateViewer(data.user);
        }
    });
    
    // USUARIO SALE DEL LIVE - ESTE ES EL EVENTO IMPORTANTE
    tiktokConnection.on(WebcastEvent.MEMBER_LEAVE, (data) => {
        const uniqueId = data?.user?.uniqueId;
        if (uniqueId) {
            console.log(`🚪 SALIDA DETECTADA: @${uniqueId} abandonó el live`);
            removeViewer(uniqueId);
        }
    });
    
    tiktokConnection.on(WebcastEvent.CHAT, (data) => {
        if (data?.user) addOrUpdateViewer(data.user);
        
        const comment = data?.comment?.trim() || '';
        if (comment.toLowerCase().startsWith('!send')) {
            console.log(`📨 Comando detectado: ${comment}`);
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
        message: isConnected ? 'Connected' : 'Disconnected'
    }));
    
    const viewerList = Array.from(viewers.values())
        .slice(0, MAX_VIEWERS_LIMIT)
        .map(v => ({
            username: v.username,
            nickname: v.nickname,
            avatar: v.avatar
        }));
    ws.send(JSON.stringify({ type: 'viewers', data: viewerList }));
    
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
        await connectToTikTok(username);
        res.json({ status: 'connected', username: username });
    } catch (err) {
        console.error('Error en /connect:', err);
        res.json({ status: 'error', error: err.message });
    }
});

app.get('/disconnect', async (req, res) => {
    try {
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = null;
        }
        if (tiktokConnection) {
            await tiktokConnection.disconnect();
            tiktokConnection = null;
        }
        currentUsername = null;
        viewers.clear();
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
        viewers: viewers.size
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

process.on('SIGTERM', async () => {
    console.log('🛑 Cerrando servidor...');
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (tiktokConnection) {
        try {
            await tiktokConnection.disconnect();
        } catch (e) {}
    }
    server.close(() => process.exit(0));
});

server.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});
