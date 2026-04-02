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
let reconnectAttempts = 0;
let isReconnecting = false;

const MAX_VIEWERS = 3000;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAYS = [3000, 5000, 10000, 20000, 30000];

const avatarCache = new Map();
const TIKTOOL_API_KEY = 'tk_19ccc744ea1023f55fc03ede8dd300da8519a313022ab447';

// Múltiples métodos para obtener avatar
async function fetchAvatarFromTikTool(uniqueId) {
    if (avatarCache.has(uniqueId)) return avatarCache.get(uniqueId);
    
    // Método 1: TikTools API
    try {
        const response = await fetch(`https://api.tik.tools/user/${uniqueId}`, {
            headers: {
                'Authorization': `Bearer ${TIKTOOL_API_KEY}`,
                'Content-Type': 'application/json'
            },
            timeout: 5000
        });
        
        if (response.ok) {
            const data = await response.json();
            const avatarUrl = data?.user?.avatar || data?.avatar || data?.profilePicture || null;
            if (avatarUrl && avatarUrl.startsWith('http')) {
                console.log(`✅ Avatar encontrado para @${uniqueId} (TikTools)`);
                avatarCache.set(uniqueId, avatarUrl);
                return avatarUrl;
            }
        }
    } catch (error) {
        console.log(`TikTools falló para @${uniqueId}: ${error.message}`);
    }
    
    // Método 2: API directa de TikTok
    try {
        const response = await fetch(`https://www.tiktok.com/@${uniqueId}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 5000
        });
        const html = await response.text();
        const match = html.match(/avatar":\s*"([^"]+)"/i);
        if (match && match[1]) {
            console.log(`✅ Avatar encontrado para @${uniqueId} (HTML)`);
            avatarCache.set(uniqueId, match[1]);
            return match[1];
        }
    } catch (error) {
        console.log(`Método HTML falló para @${uniqueId}: ${error.message}`);
    }
    
    return null;
}

// Función para extraer avatar de datos de usuario de TikTok
function extractAvatarFromUserData(userData) {
    if (!userData) return null;
    
    const avatarUrls = [
        userData?.avatarThumbnail?.urlList?.[0],
        userData?.avatarMedium?.urlList?.[0],
        userData?.avatarLarge?.urlList?.[0],
        userData?.avatarThumbnail?.url,
        userData?.avatarMedium?.url,
        userData?.avatarLarge?.url,
        userData?.profilePicture,
        userData?.avatar,
        userData?.profilePictureUrl
    ];
    
    for (const url of avatarUrls) {
        if (url && typeof url === 'string' && url.startsWith('http')) {
            return url;
        }
    }
    return null;
}

// Función para guardar avatar inmediatamente
async function saveAvatarImmediately(uniqueId, userData) {
    if (avatarCache.has(uniqueId)) return avatarCache.get(uniqueId);
    
    let avatar = extractAvatarFromUserData(userData);
    if (avatar) {
        avatarCache.set(uniqueId, avatar);
        console.log(`📸 Avatar guardado para @${uniqueId} desde evento`);
        return avatar;
    }
    
    avatar = await fetchAvatarFromTikTool(uniqueId);
    if (avatar) {
        avatarCache.set(uniqueId, avatar);
    }
    return avatar;
}

function broadcastGiftNotification(giftData) {
    const message = JSON.stringify({
        type: 'gift_notification',
        data: giftData
    });
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try { client.send(message); } catch (e) {}
        }
    });
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

async function scheduleReconnect() {
    if (isManualDisconnect) return;
    if (isReconnecting) return;
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.log(`❌ Máximos intentos de reconexión (${MAX_RECONNECT_ATTEMPTS}) alcanzados`);
        broadcastStatus(false, `Failed to reconnect after ${MAX_RECONNECT_ATTEMPTS} attempts`);
        return;
    }
    
    if (reconnectTimer) clearTimeout(reconnectTimer);
    
    const delay = RECONNECT_DELAYS[Math.min(reconnectAttempts, RECONNECT_DELAYS.length - 1)];
    reconnectAttempts++;
    
    console.log(`🔄 Intento ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} - Reintentando en ${delay/1000}s...`);
    broadcastStatus(false, `Reconnecting in ${delay/1000}s (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
    
    reconnectTimer = setTimeout(async () => {
        if (!isManualDisconnect && currentUsername) {
            await connectToTikTok(currentUsername);
        }
    }, delay);
}

async function connectToTikTok(username) {
    username = username.replace(/^@/, '').trim();
    if (!username) return false;
    
    isReconnecting = true;
    
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (tiktokConnection) {
        try { 
            tiktokConnection.removeAllListeners();
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
            requestPollingIntervalMs: 3000,
            websocketTimeout: 120000,
            fetchChatMessages: true,
            fetchGiftMessages: true,
            fetchMemberMessages: true,
            fetchLikeMessages: false
        });
        
        setupEventHandlers(username);
        await tiktokConnection.connect();
        
        reconnectAttempts = 0;
        isReconnecting = false;
        console.log(`✅ Conectado a @${username}`);
        broadcastStatus(true, `Connected to @${username}`);
        return true;
    } catch (err) {
        console.error(`❌ Error: ${err.message}`);
        broadcastStatus(false, `Error: ${err.message}`);
        tiktokConnection = null;
        isReconnecting = false;
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
    
    async function addViewer(userData) {
        try {
            const uniqueId = userData?.uniqueId;
            if (!uniqueId || uniqueId === username) return;
            if (viewers.size >= MAX_VIEWERS && !viewers.has(uniqueId)) return;
            
            if (!viewers.has(uniqueId)) {
                let avatar = avatarCache.get(uniqueId);
                if (!avatar) {
                    avatar = extractAvatarFromUserData(userData);
                    if (avatar) avatarCache.set(uniqueId, avatar);
                }
                
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
    
    tiktokConnection.on(WebcastEvent.CONNECTED, () => {
        console.log(`✅ Conexión establecida`);
        reconnectAttempts = 0;
        broadcastStatus(true, `Connected`);
    });
    
    tiktokConnection.on(WebcastEvent.DISCONNECTED, (reason) => {
        console.log(`🔌 Desconectado: ${reason}`);
        broadcastStatus(false, `Disconnected`);
        if (!isManualDisconnect && currentUsername) scheduleReconnect();
    });
    
    tiktokConnection.on(WebcastEvent.ERROR, (error) => {
        console.error(`❌ Error: ${error.message}`);
        broadcastStatus(false, `Error: ${error.message}`);
        if (!isManualDisconnect && currentUsername) scheduleReconnect();
    });
    
    tiktokConnection.on(WebcastEvent.ROOM_USER_SEGMENT, (data) => {
        const count = data?.viewerCount || viewers.size;
        console.log(`📊 Espectadores: ${count}`);
        broadcastStatus(true, `Live: ${count} viewers`);
    });
    
    tiktokConnection.on(WebcastEvent.MEMBER, async (data) => {
        if (data?.user) await addViewer(data.user);
    });
    
    tiktokConnection.on(WebcastEvent.MEMBER_JOIN, async (data) => {
        if (data?.user) await addViewer(data.user);
    });
    
    tiktokConnection.on(WebcastEvent.MEMBER_LEAVE, (data) => {
        if (data?.user?.uniqueId) removeViewer(data.user.uniqueId);
    });
    
    tiktokConnection.on(WebcastEvent.GIFT, async (data) => {
        if (data?.user) {
            const uniqueId = data.user.uniqueId;
            const giftName = data.gift?.name || 'Regalo';
            const diamondCount = data.gift?.diamondCount || data.gift?.diamonds || 1;
            const repeatCount = data.repeatCount || 1;
            const totalDiamonds = diamondCount * repeatCount;
            
            console.log(`🎁 REGALO de @${uniqueId}: ${giftName} x${repeatCount} (${totalDiamonds}💎)`);
            
            // Guardar avatar inmediatamente
            let avatar = avatarCache.get(uniqueId);
            if (!avatar) {
                avatar = await saveAvatarImmediately(uniqueId, data.user);
            }
            
            // Agregar o actualizar viewer
            if (!viewers.has(uniqueId)) {
                viewers.set(uniqueId, {
                    username: uniqueId,
                    nickname: data.user?.nickname || uniqueId,
                    avatar: avatar || null
                });
                pendingUpdate = true;
                scheduleBroadcast();
            } else if (avatar && !viewers.get(uniqueId).avatar) {
                viewers.get(uniqueId).avatar = avatar;
                pendingUpdate = true;
                scheduleBroadcast();
            }
            
            // Enviar notificación de regalo
            broadcastGiftNotification({
                username: uniqueId,
                nickname: data.user?.nickname || uniqueId,
                avatar: avatar,
                giftName: giftName,
                diamondCount: totalDiamonds,
                repeatCount: repeatCount
            });
        }
    });
    
    tiktokConnection.on(WebcastEvent.CHAT, async (data) => {
        if (data?.user) await addViewer(data.user);
    });
}

app.get('/search/:username', async (req, res) => {
    try {
        const username = req.params.username.replace(/^@/, '').trim();
        console.log(`🔍 Buscando usuario: ${username}`);
        
        let avatar = avatarCache.get(username);
        
        if (!avatar) {
            const viewer = viewers.get(username);
            avatar = viewer?.avatar || null;
        }
        
        if (!avatar) {
            avatar = await fetchAvatarFromTikTool(username);
        }
        
        if (avatar) {
            avatarCache.set(username, avatar);
            const viewer = viewers.get(username);
            if (viewer) {
                viewer.avatar = avatar;
                broadcastViewers();
            }
        }
        
        res.json({
            username: username,
            nickname: viewers.get(username)?.nickname || username,
            avatar: avatar,
            found: viewers.has(username) || !!avatar
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
        reconnectAttempts = 0;
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
        isReconnecting = false;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        if (tiktokConnection) {
            tiktokConnection.removeAllListeners();
            await tiktokConnection.disconnect();
        }
        tiktokConnection = null;
        viewers.clear();
        currentUsername = null;
        reconnectAttempts = 0;
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
