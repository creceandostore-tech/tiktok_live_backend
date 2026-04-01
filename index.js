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

// Tu API Key de TikTool
const TIKTOOL_API_KEY = 'tk_19ccc744ea1023f55fc03ede8dd300da8519a313022ab447';
const TIKTOOL_API_URL = 'https://api.tik.tools';

const clients = new Set();
let tiktokConnection = null;
let viewers = new Map();
let currentUsername = null;
let isManualDisconnect = false;
let reconnectAttempts = 0;
let heartbeatInterval = null;

const MAX_VIEWERS_LIMIT = 5000;
const RECONNECT_DELAY = 3000;
const HEARTBEAT_INTERVAL = 20000;
const BROADCAST_INTERVAL = 3000;

// Cache de avatares
const avatarCache = new Map();
const pendingAvatarRequests = new Map();

// Función para obtener avatar de TikTool API
async function fetchUserAvatar(uniqueId) {
    if (avatarCache.has(uniqueId)) {
        return avatarCache.get(uniqueId);
    }
    
    if (pendingAvatarRequests.has(uniqueId)) {
        return pendingAvatarRequests.get(uniqueId);
    }
    
    const promise = (async () => {
        try {
            console.log(`🔍 Buscando avatar para @${uniqueId}...`);
            const response = await fetch(`${TIKTOOL_API_URL}/user/${uniqueId}`, {
                headers: {
                    'Authorization': `Bearer ${TIKTOOL_API_KEY}`,
                    'Content-Type': 'application/json'
                }
            });
            
            if (response.ok) {
                const data = await response.json();
                // Probar diferentes rutas donde puede estar el avatar
                const avatarUrl = data?.user?.avatar || 
                                 data?.avatar || 
                                 data?.profilePicture || 
                                 data?.user?.profilePicture ||
                                 data?.user?.avatarThumbnail ||
                                 null;
                
                if (avatarUrl && avatarUrl.startsWith('http')) {
                    console.log(`✅ Avatar encontrado para @${uniqueId}: ${avatarUrl.substring(0, 50)}...`);
                    avatarCache.set(uniqueId, avatarUrl);
                    // Limitar tamaño del cache
                    if (avatarCache.size > 10000) {
                        const firstKey = avatarCache.keys().next().value;
                        avatarCache.delete(firstKey);
                    }
                    return avatarUrl;
                } else {
                    console.log(`⚠️ No se encontró avatar para @${uniqueId}`);
                    avatarCache.set(uniqueId, null);
                    return null;
                }
            } else {
                console.log(`❌ Error ${response.status} al buscar avatar para @${uniqueId}`);
                return null;
            }
        } catch (error) {
            console.error(`❌ Error fetching avatar for ${uniqueId}:`, error.message);
            return null;
        } finally {
            pendingAvatarRequests.delete(uniqueId);
        }
    })();
    
    pendingAvatarRequests.set(uniqueId, promise);
    return promise;
}

// Obtener avatar de los datos del evento (más rápido)
function getAvatarFromEvent(user) {
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

// Obtener el mejor avatar disponible
async function getBestAvatar(uniqueId, userData) {
    // 1. Intentar del evento primero (más rápido)
    const eventAvatar = getAvatarFromEvent(userData);
    if (eventAvatar && eventAvatar.startsWith('http')) {
        console.log(`📸 Avatar del evento para @${uniqueId}`);
        return eventAvatar;
    }
    
    // 2. Buscar en cache
    if (avatarCache.has(uniqueId)) {
        const cached = avatarCache.get(uniqueId);
        if (cached) {
            console.log(`💾 Avatar en cache para @${uniqueId}`);
            return cached;
        }
    }
    
    // 3. Buscar en API de TikTool (asíncrono)
    console.log(`🌐 Buscando avatar en API para @${uniqueId}...`);
    const apiAvatar = await fetchUserAvatar(uniqueId);
    if (apiAvatar) {
        return apiAvatar;
    }
    
    return null;
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
    const countMsg = JSON.stringify({ type: 'viewer_count', count: count, viewers: viewers.size, maxViewers: MAX_VIEWERS_LIMIT });
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
    
    const memUsage = process.memoryUsage();
    const usedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
    if (Math.random() < 0.05) {
        console.log(`📊 Memoria: ${usedMB}MB | Espectadores: ${viewers.size}`);
    }
}

async function connectToTikTok(username) {
    username = username.replace(/^@/, '');
    if (!username || username.trim() === '') {
        console.error('❌ Username inválido');
        return;
    }
    
    currentUsername = username;
    isManualDisconnect = false;
    
    if (tiktokConnection) {
        try { await tiktokConnection.disconnect(); } catch (e) {}
        tiktokConnection = null;
    }
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
    
    console.log(`🔌 Conectando a @${username} (Máx ${MAX_VIEWERS_LIMIT} espectadores)`);
    broadcastStatus(false, `Connecting to @${username}...`);
    
    try {
        tiktokConnection = new TikTokLiveConnection(username, {
            enableExtendedGiftInfo: true,
            processInitialData: true,
            requestPollingIntervalMs: 6000,
            websocketTimeout: 180000,
            enableWebsocketUpgrade: true,
            fetchChatMessages: true,
            fetchGiftMessages: true,
            fetchMemberMessages: true,
            fetchLikeMessages: false,
            fetchPollMessages: false,
            fetchQuestionMessages: false
        });
        
        setupEventHandlers(username);
        await tiktokConnection.connect();
        
        console.log(`✅ Conectado a @${username}`);
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
                console.log('⚠️ Conexión inactiva, reconectando...');
                reconnectToTikTok();
            }
        }, HEARTBEAT_INTERVAL);
        
        setInterval(() => { if (!isManualDisconnect) cleanupViewers(); }, 300000);
        
    } catch (err) {
        console.error(`❌ Error: ${err.message}`);
        broadcastStatus(false, `Connection failed: ${err.message}`);
        tiktokConnection = null;
        if (!isManualDisconnect) setTimeout(() => reconnectToTikTok(), RECONNECT_DELAY);
    }
}

async function reconnectToTikTok() {
    if (isManualDisconnect || !currentUsername) return;
    reconnectAttempts++;
    console.log(`🔄 Reconexión #${reconnectAttempts} - Manteniendo ${viewers.size} espectadores`);
    broadcastStatus(false, `Reconnecting... (Attempt ${reconnectAttempts}) - ${viewers.size} viewers`);
    
    if (tiktokConnection) { try { await tiktokConnection.disconnect(); } catch (e) {} tiktokConnection = null; }
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
    
    await new Promise(resolve => setTimeout(resolve, RECONNECT_DELAY));
    try { await connectToTikTok(currentUsername); } catch (err) {
        if (!isManualDisconnect) setTimeout(() => reconnectToTikTok(), RECONNECT_DELAY);
    }
}

function setupEventHandlers(username) {
    if (!tiktokConnection) return;
    
    let lastBroadcastTime = 0;
    let pendingBroadcast = null;
    let pendingUpdates = [];
    let processing = false;
    
    function processUpdates() {
        if (processing || pendingUpdates.length === 0) return;
        processing = true;
        
        const batch = pendingUpdates.splice(0, 200);
        let changed = false;
        
        batch.forEach(async update => {
            if (update.type === 'add' && !viewers.has(update.id) && viewers.size < MAX_VIEWERS_LIMIT) {
                let avatar = null;
                
                // Intentar obtener avatar inmediatamente
                avatar = await getBestAvatar(update.id, update.userData);
                
                viewers.set(update.id, {
                    username: update.id,
                    nickname: update.userData?.nickname || update.userData?.displayId || update.id,
                    avatar: avatar,
                    joinedAt: Date.now()
                });
                changed = true;
                
                // Si no se encontró avatar, buscar en segundo plano
                if (!avatar) {
                    fetchUserAvatar(update.id).then(av => {
                        if (av && viewers.has(update.id)) {
                            viewers.get(update.id).avatar = av;
                            throttledBroadcastViewers();
                        }
                    });
                }
            } else if (update.type === 'remove' && viewers.has(update.id)) {
                viewers.delete(update.id);
                changed = true;
            } else if (update.type === 'update_avatar' && viewers.has(update.id)) {
                const viewer = viewers.get(update.id);
                if (viewer && !viewer.avatar && update.avatar) {
                    viewer.avatar = update.avatar;
                    changed = true;
                }
            }
        });
        
        if (changed) { throttledBroadcastViewers(); broadcastViewerCount(viewers.size); }
        processing = false;
        if (pendingUpdates.length > 0) setTimeout(processUpdates, 100);
    }
    
    function queueUpdate(type, id, nickname = null, userData = null) {
        pendingUpdates.push({ type, id, nickname, userData });
        processUpdates();
    }
    
    function queueAvatarUpdate(id, avatar) {
        pendingUpdates.push({ type: 'update_avatar', id, avatar });
        processUpdates();
    }
    
    function throttledBroadcastViewers() {
        const now = Date.now();
        if (now - lastBroadcastTime >= BROADCAST_INTERVAL) {
            lastBroadcastTime = now;
            broadcastViewers();
            if (pendingBroadcast) { clearTimeout(pendingBroadcast); pendingBroadcast = null; }
        } else if (!pendingBroadcast) {
            pendingBroadcast = setTimeout(() => {
                lastBroadcastTime = Date.now();
                broadcastViewers();
                pendingBroadcast = null;
            }, BROADCAST_INTERVAL - (now - lastBroadcastTime));
        }
    }
    
    tiktokConnection.on(WebcastEvent.CONNECTED, () => {
        console.log(`✅ Reconectado - Espectadores: ${viewers.size}`);
        broadcastStatus(true, `Connected`, viewers.size);
    });
    
    tiktokConnection.on(WebcastEvent.DISCONNECTED, (reason) => {
        console.log(`🔌 Desconectado: ${reason} - Manteniendo ${viewers.size} espectadores`);
        broadcastStatus(false, `Disconnected - Preserving ${viewers.size} viewers`, viewers.size);
        if (!isManualDisconnect && currentUsername) setTimeout(() => reconnectToTikTok(), 2000);
        else if (isManualDisconnect) { viewers.clear(); broadcastViewers(); }
    });
    
    tiktokConnection.on(WebcastEvent.ERROR, (error) => {
        console.error(`❌ Error: ${error.message}`);
        broadcastStatus(false, `Error - Reconnecting...`, viewers.size);
        if (!isManualDisconnect && currentUsername) setTimeout(() => reconnectToTikTok(), 3000);
    });
    
    tiktokConnection.on(WebcastEvent.ROOM_USER_SEGMENT, (data) => {
        const count = data?.viewerCount || viewers.size;
        console.log(`📊 Espectadores: ${count} | Registrados: ${viewers.size}/${MAX_VIEWERS_LIMIT}`);
        broadcastStatus(true, `Live: ${count} viewers`, count);
        broadcastViewerCount(count);
    });
    
    tiktokConnection.on(WebcastEvent.GIFT, (data) => {
        if (data?.user?.uniqueId && data.user.uniqueId !== username) {
            const userId = data.user.uniqueId;
            console.log(`🎁 REGALO RECIBIDO de @${userId} - ${data.giftName || 'gift'} x${data.repeatCount || 1}`);
            queueUpdate('add', userId, data.user.nickname || userId, data.user);
            // Prioridad para obtener avatar de quien envía regalos
            getBestAvatar(userId, data.user).then(avatar => {
                if (avatar) queueAvatarUpdate(userId, avatar);
            });
        }
    });
    
    tiktokConnection.on(WebcastEvent.MEMBER, (data) => {
        if (data?.user?.uniqueId && data.user.uniqueId !== username) {
            queueUpdate('add', data.user.uniqueId, data.user.nickname, data.user);
        }
    });
    
    tiktokConnection.on(WebcastEvent.MEMBER_JOIN, (data) => {
        if (data?.user?.uniqueId && data.user.uniqueId !== username) {
            console.log(`➕ +${data.user.uniqueId}`);
            queueUpdate('add', data.user.uniqueId, data.user.nickname, data.user);
        }
    });
    
    tiktokConnection.on(WebcastEvent.MEMBER_LEAVE, (data) => {
        const id = data?.user?.uniqueId;
        if (id && id !== username) { console.log(`🚪 -${id}`); queueUpdate('remove', id); }
    });
    
    tiktokConnection.on(WebcastEvent.CHAT, (data) => {
        if (data?.user?.uniqueId && data.user.uniqueId !== username) {
            queueUpdate('add', data.user.uniqueId, data.user.nickname, data.user);
        }
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
    
    ws.send(JSON.stringify({ 
        type: 'connection_status', 
        connected: tiktokConnection?.isConnected || false,
        username: currentUsername,
        viewerCount: viewers.size,
        maxViewers: MAX_VIEWERS_LIMIT,
        message: tiktokConnection?.isConnected ? 'Connected' : 'Disconnected'
    }));
    
    const viewerList = Array.from(viewers.values()).slice(0, 500).map(v => ({
        username: v.username, 
        nickname: v.nickname, 
        avatar: v.avatar
    }));
    ws.send(JSON.stringify({ type: 'viewers', data: viewerList, total: viewers.size }));
    
    ws.on('close', () => { console.log('📱 Cliente desconectado'); clients.delete(ws); });
});

app.get('/connect/:username', async (req, res) => {
    try {
        const username = req.params.username;
        console.log(`📡 Conectar a: ${username}`);
        isManualDisconnect = false;
        await connectToTikTok(username);
        res.json({ status: 'connected', username: username, maxViewers: MAX_VIEWERS_LIMIT });
    } catch (err) {
        res.json({ status: 'error', error: err.message });
    }
});

app.get('/disconnect', async (req, res) => {
    try {
        console.log('🔌 Desconexión manual');
        isManualDisconnect = true;
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        if (tiktokConnection) await tiktokConnection.disconnect();
        tiktokConnection = null;
        viewers.clear();
        currentUsername = null;
        broadcastViewers();
        broadcastStatus(false, 'Manually disconnected');
        res.json({ status: 'disconnected' });
    } catch (err) {
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
    console.log(`   🖼️ Fotos reales vía TikTool API`);
    console.log(`   🔄 Reconexión infinita hasta desconexión manual`);
});
