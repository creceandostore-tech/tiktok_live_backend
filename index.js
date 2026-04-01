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
let reconnectTimer = null;

const MAX_VIEWERS = 3000;
const RECONNECT_DELAY = 3000;

// Cache de avatares
const avatarCache = new Map();

// Tu API Key de TikTool
const TIKTOOL_API_KEY = 'tk_19ccc744ea1023f55fc03ede8dd300da8519a313022ab447';

// Función para obtener avatar de múltiples fuentes
async function fetchAvatarFromMultipleSources(uniqueId) {
    // Verificar cache primero
    if (avatarCache.has(uniqueId)) {
        return avatarCache.get(uniqueId);
    }
    
    console.log(`🔍 Buscando avatar para @${uniqueId}...`);
    
    // Fuente 1: TikTool API (tu API key)
    try {
        const response = await fetch(`https://api.tik.tools/user/${uniqueId}`, {
            headers: {
                'Authorization': `Bearer ${TIKTOOL_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (response.ok) {
            const data = await response.json();
            const avatarUrl = data?.user?.avatar || 
                             data?.avatar || 
                             data?.profilePicture || 
                             data?.user?.profilePicture ||
                             null;
            
            if (avatarUrl && avatarUrl.startsWith('http')) {
                console.log(`✅ Avatar encontrado en TikTool para @${uniqueId}`);
                avatarCache.set(uniqueId, avatarUrl);
                return avatarUrl;
            }
        }
    } catch (e) {
        console.log(`TikTool error para @${uniqueId}: ${e.message}`);
    }
    
    // Fuente 2: URL directa de TikTok
    try {
        // Intentar construir URL de avatar de TikTok
        const tiktokAvatarUrl = `https://www.tiktok.com/@${uniqueId}/photo`;
        // Verificar si existe (hacemos un fetch rápido)
        const checkResponse = await fetch(tiktokAvatarUrl, { method: 'HEAD' });
        if (checkResponse.ok) {
            console.log(`✅ Avatar encontrado en TikTok para @${uniqueId}`);
            avatarCache.set(uniqueId, tiktokAvatarUrl);
            return tiktokAvatarUrl;
        }
    } catch (e) {
        console.log(`TikTok direct error para @${uniqueId}: ${e.message}`);
    }
    
    // Fuente 3: Servicio público de avatares
    try {
        const publicAvatarUrl = `https://pfp.danbooru.one/${uniqueId}.jpg`;
        const checkResponse = await fetch(publicAvatarUrl, { method: 'HEAD' });
        if (checkResponse.ok) {
            console.log(`✅ Avatar encontrado en servicio público para @${uniqueId}`);
            avatarCache.set(uniqueId, publicAvatarUrl);
            return publicAvatarUrl;
        }
    } catch (e) {
        console.log(`Public service error para @${uniqueId}: ${e.message}`);
    }
    
    console.log(`⚠️ No se encontró avatar para @${uniqueId}`);
    avatarCache.set(uniqueId, null);
    return null;
}

// Función para obtener avatar de los datos del evento
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

// Función principal para obtener avatar
async function getBestAvatar(uniqueId, userData) {
    // 1. Intentar del evento primero (más rápido)
    const eventAvatar = getAvatarFromEvent(userData);
    if (eventAvatar && eventAvatar.startsWith('http')) {
        console.log(`📸 Avatar del evento para @${uniqueId}`);
        avatarCache.set(uniqueId, eventAvatar);
        return eventAvatar;
    }
    
    // 2. Buscar en cache
    if (avatarCache.has(uniqueId)) {
        return avatarCache.get(uniqueId);
    }
    
    // 3. Buscar en múltiples fuentes externas (en segundo plano)
    fetchAvatarFromMultipleSources(uniqueId).then(avatar => {
        if (avatar && viewers.has(uniqueId)) {
            const viewer = viewers.get(uniqueId);
            if (!viewer.avatar) {
                viewer.avatar = avatar;
                broadcastViewers();
                console.log(`🖼️ Avatar actualizado para @${uniqueId}`);
            }
        }
    });
    
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
        viewerCount: viewerCount || viewers.size
    });
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try { client.send(statusMsg); } catch (e) {}
        }
    });
}

function broadcastViewerCount(count) {
    const countMsg = JSON.stringify({ type: 'viewer_count', count: count });
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try { client.send(countMsg); } catch (e) {}
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
            console.log(`🔄 Reconectando a @${currentUsername}...`);
            await connectToTikTok(currentUsername);
        }
    }, RECONNECT_DELAY);
}

async function connectToTikTok(username) {
    username = username.replace(/^@/, '').trim();
    
    if (!username) {
        console.error('❌ Username inválido');
        return false;
    }
    
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    
    if (tiktokConnection) {
        try { 
            await tiktokConnection.disconnect(); 
        } catch (e) {}
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
        
        if (!isManualDisconnect) {
            scheduleReconnect();
        }
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
            
            const existing = viewers.get(uniqueId);
            
            if (!existing) {
                viewers.set(uniqueId, {
                    username: uniqueId,
                    nickname: userData?.nickname || userData?.displayId || uniqueId,
                    avatar: null
                });
                console.log(`👥 +${uniqueId} (${viewers.size})`);
                pendingUpdate = true;
                scheduleBroadcast();
            }
        } catch (e) {
            console.error('Error:', e.message);
        }
    }
    
    function removeViewer(uniqueId) {
        if (uniqueId && viewers.has(uniqueId)) {
            viewers.delete(uniqueId);
            console.log(`🚪 -${uniqueId} (${viewers.size})`);
            pendingUpdate = true;
            scheduleBroadcast();
        }
    }
    
    async function updateAvatar(uniqueId, userData) {
        if (uniqueId && viewers.has(uniqueId)) {
            const viewer = viewers.get(uniqueId);
            if (!viewer.avatar) {
                const avatar = await getBestAvatar(uniqueId, userData);
                if (avatar) {
                    viewer.avatar = avatar;
                    console.log(`🖼️ Foto cargada para @${uniqueId}`);
                    pendingUpdate = true;
                    scheduleBroadcast();
                }
            }
        }
    }
    
    tiktokConnection.on(WebcastEvent.CONNECTED, () => {
        console.log(`✅ Conexión establecida`);
        broadcastStatus(true, `Connected`);
    });
    
    tiktokConnection.on(WebcastEvent.DISCONNECTED, (reason) => {
        console.log(`🔌 Desconectado: ${reason || 'No reason'}`);
        broadcastStatus(false, `Disconnected: ${reason || 'Connection lost'}`);
        
        if (!isManualDisconnect && currentUsername) {
            scheduleReconnect();
        }
    });
    
    tiktokConnection.on(WebcastEvent.ERROR, (error) => {
        console.error(`❌ Error: ${error.message}`);
        broadcastStatus(false, `Error: ${error.message}`);
    });
    
    tiktokConnection.on(WebcastEvent.ROOM_USER_SEGMENT, (data) => {
        const count = data?.viewerCount || viewers.size;
        console.log(`📊 Espectadores: ${count}`);
        broadcastStatus(true, `Live: ${count} viewers`);
        broadcastViewerCount(count);
    });
    
    tiktokConnection.on(WebcastEvent.MEMBER, (data) => {
        if (data?.user) addViewer(data.user);
    });
    
    tiktokConnection.on(WebcastEvent.MEMBER_JOIN, (data) => {
        if (data?.user) addViewer(data.user);
    });
    
    tiktokConnection.on(WebcastEvent.MEMBER_LEAVE, (data) => {
        const id = data?.user?.uniqueId;
        if (id) removeViewer(id);
    });
    
    // QUIENES ENVÍAN REGALOS - OBTIENEN FOTO INMEDIATAMENTE
    tiktokConnection.on(WebcastEvent.GIFT, (data) => {
        if (data?.user) {
            const userId = data.user.uniqueId;
            console.log(`🎁 REGALO de @${userId}: ${data.giftName || 'gift'} x${data.repeatCount || 1}`);
            
            // Agregar a la lista si no existe
            addViewer(data.user);
            
            // Buscar y actualizar avatar inmediatamente
            updateAvatar(userId, data.user);
        }
    });
    
    tiktokConnection.on(WebcastEvent.CHAT, (data) => {
        if (data?.user) addViewer(data.user);
        
        const comment = data?.comment?.trim() || '';
        if (comment.toLowerCase().startsWith('!send')) {
            console.log(`📨 Comando: ${comment}`);
            broadcastCommand(comment);
        }
    });
}

// Endpoint para buscar usuario específico y obtener su foto
app.get('/search/:username', async (req, res) => {
    try {
        const username = req.params.username.replace(/^@/, '').trim();
        console.log(`🔍 Buscando usuario: ${username}`);
        
        // Buscar avatar en múltiples fuentes
        const avatar = await fetchAvatarFromMultipleSources(username);
        
        // Buscar en espectadores actuales
        const viewer = viewers.get(username);
        
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
        
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        
        if (tiktokConnection) {
            await tiktokConnection.disconnect();
            tiktokConnection = null;
        }
        
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
    console.log(`⚙️ Configuración:`);
    console.log(`   📊 Máximo: ${MAX_VIEWERS} espectadores`);
    console.log(`   🎁 Fotos para quienes envían regalos`);
    console.log(`   🔍 Búsqueda manual de usuarios`);
    console.log(`   🔄 Reconexión automática cada ${RECONNECT_DELAY/1000}s`);
});
