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
let lastBroadcastTime = 0;

// Configuración optimizada para plan gratis
const MAX_VIEWERS_LIMIT = 3000;
const RECONNECT_DELAY = 3000;
const BROADCAST_INTERVAL = 4000;

// Cache de avatares (limitado para ahorrar memoria)
const avatarCache = new Map();
const MAX_CACHE_SIZE = 2000;

// Función para obtener avatar de TikTok directamente (sin API externa)
function getAvatarFromUser(user) {
    try {
        // TikTok a veces envía la foto en estos campos
        if (user?.avatarThumbnail?.url) return user.avatarThumbnail.url;
        if (user?.avatarMedium?.url) return user.avatarMedium.url;
        if (user?.avatarLarge?.url) return user.avatarLarge.url;
        if (user?.profilePicture) return user.profilePicture;
        
        // Intentar construir URL manualmente
        if (user?.uniqueId) {
            // URL de avatar de TikTok por defecto
            return `https://www.tiktok.com/@${user.uniqueId}/photo`;
        }
        return null;
    } catch (e) {
        return null;
    }
}

// Función para obtener avatar desde la API pública de TikTok
async function fetchAvatarFromTikTok(uniqueId) {
    // Verificar cache primero
    if (avatarCache.has(uniqueId)) {
        return avatarCache.get(uniqueId);
    }
    
    try {
        // Usar API pública de TikTok (no requiere clave)
        const response = await fetch(`https://www.tiktok.com/@${uniqueId}?lang=en`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        
        if (response.ok) {
            const html = await response.text();
            // Buscar la URL del avatar en el HTML
            const avatarMatch = html.match(/avatar":\s*"([^"]+)"/i) || 
                               html.match(/avatarUrl":"([^"]+)"/i) ||
                               html.match(/https:\/\/p\d+\.cdn\.tiktok\.com\/[^"]+\.jpg/i);
            
            if (avatarMatch) {
                let avatarUrl = avatarMatch[1] || avatarMatch[0];
                avatarUrl = avatarUrl.replace(/\\u002f/g, '/').replace(/\\/g, '');
                if (avatarUrl.startsWith('http')) {
                    console.log(`✅ Avatar encontrado para @${uniqueId}`);
                    avatarCache.set(uniqueId, avatarUrl);
                    // Limitar cache
                    if (avatarCache.size > MAX_CACHE_SIZE) {
                        const firstKey = avatarCache.keys().next().value;
                        avatarCache.delete(firstKey);
                    }
                    return avatarUrl;
                }
            }
        }
        return null;
    } catch (error) {
        console.error(`Error fetching avatar for ${uniqueId}:`, error.message);
        return null;
    }
}

// Función principal para obtener avatar
async function getBestAvatar(uniqueId, userData) {
    // 1. Intentar del evento primero
    const eventAvatar = getAvatarFromUser(userData);
    if (eventAvatar && eventAvatar.includes('tiktok')) {
        return eventAvatar;
    }
    
    // 2. Buscar en cache
    if (avatarCache.has(uniqueId)) {
        return avatarCache.get(uniqueId);
    }
    
    // 3. Buscar en segundo plano (no bloqueante)
    fetchAvatarFromTikTok(uniqueId).then(avatar => {
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
    const now = Date.now();
    if (now - lastBroadcastTime < BROADCAST_INTERVAL) return;
    lastBroadcastTime = now;
    
    const viewerList = Array.from(viewers.values()).slice(0, 300).map(v => ({
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
        manualDisconnect: isManualDisconnect
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

async function connectToTikTok(username) {
    username = username.replace(/^@/, '').trim();
    
    if (!username) {
        console.error('❌ Username inválido');
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
    
    console.log(`🔌 Conectando a @${username}...`);
    broadcastStatus(false, `Connecting to @${username}...`);
    
    try {
        tiktokConnection = new TikTokLiveConnection(username, {
            enableExtendedGiftInfo: true,
            processInitialData: true,
            requestPollingIntervalMs: 6000,
            websocketTimeout: 60000,
            fetchChatMessages: true,
            fetchGiftMessages: true,
            fetchMemberMessages: true,
            fetchLikeMessages: false
        });
        
        setupEventHandlers(username);
        
        await tiktokConnection.connect();
        
        console.log(`✅ Conectado a @${username}`);
        broadcastStatus(true, `Connected to @${username}`, viewers.size);
        reconnectAttempts = 0;
        
        return true;
        
    } catch (err) {
        console.error(`❌ Error: ${err.message}`);
        broadcastStatus(false, `Connection failed: ${err.message}`);
        tiktokConnection = null;
        
        if (!isManualDisconnect) {
            setTimeout(() => {
                if (!isManualDisconnect && currentUsername) {
                    connectToTikTok(currentUsername);
                }
            }, RECONNECT_DELAY);
        }
        return false;
    }
}

function setupEventHandlers(username) {
    if (!tiktokConnection) return;
    
    function addOrUpdateViewer(userData) {
        try {
            const uniqueId = userData?.uniqueId;
            if (!uniqueId || uniqueId === username) return;
            
            if (viewers.size >= MAX_VIEWERS_LIMIT && !viewers.has(uniqueId)) return;
            
            const existing = viewers.get(uniqueId);
            const eventAvatar = getAvatarFromUser(userData);
            
            if (!existing) {
                viewers.set(uniqueId, {
                    username: uniqueId,
                    nickname: userData?.nickname || userData?.displayId || uniqueId,
                    avatar: eventAvatar || null,
                    joinedAt: Date.now()
                });
                broadcastViewers();
                broadcastViewerCount(viewers.size);
                
                // Buscar avatar en segundo plano si no tiene
                if (!eventAvatar) {
                    getBestAvatar(uniqueId, userData);
                }
            } else if (!existing.avatar && eventAvatar) {
                existing.avatar = eventAvatar;
                broadcastViewers();
            }
        } catch (e) {
            console.error('Error:', e.message);
        }
    }
    
    function removeViewer(uniqueId) {
        if (uniqueId && viewers.has(uniqueId)) {
            viewers.delete(uniqueId);
            console.log(`🚪 Salió: @${uniqueId} - Quedan: ${viewers.size}`);
            broadcastViewers();
            broadcastViewerCount(viewers.size);
        }
    }
    
    tiktokConnection.on(WebcastEvent.CONNECTED, () => {
        console.log(`✅ Conectado a @${username}`);
        broadcastStatus(true, `Connected to @${username}`, viewers.size);
    });
    
    tiktokConnection.on(WebcastEvent.DISCONNECTED, (reason) => {
        console.log(`🔌 Desconectado: ${reason}`);
        broadcastStatus(false, `Disconnected: ${reason || 'Connection lost'}`, viewers.size);
        
        if (!isManualDisconnect && currentUsername) {
            setTimeout(() => {
                if (!isManualDisconnect && currentUsername) {
                    connectToTikTok(currentUsername);
                }
            }, RECONNECT_DELAY);
        }
    });
    
    tiktokConnection.on(WebcastEvent.ERROR, (error) => {
        console.error(`❌ Error: ${error.message}`);
        broadcastStatus(false, `Error: ${error.message}`, viewers.size);
    });
    
    tiktokConnection.on(WebcastEvent.ROOM_USER_SEGMENT, (data) => {
        const count = data?.viewerCount || viewers.size;
        console.log(`📊 Espectadores: ${count}`);
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
        const id = data?.user?.uniqueId;
        if (id) removeViewer(id);
    });
    
    // Evento GIFT - Prioridad para obtener avatar
    tiktokConnection.on(WebcastEvent.GIFT, (data) => {
        if (data?.user) {
            const userId = data.user.uniqueId;
            console.log(`🎁 REGALO de @${userId}: ${data.giftName}`);
            
            // Prioridad máxima: obtener avatar inmediatamente
            (async () => {
                const avatar = await getBestAvatar(userId, data.user);
                if (avatar && viewers.has(userId)) {
                    viewers.get(userId).avatar = avatar;
                    broadcastViewers();
                    console.log(`🖼️ Foto obtenida para @${userId} (envió regalo)`);
                } else if (!viewers.has(userId)) {
                    addOrUpdateViewer(data.user);
                }
            })();
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
    
    ws.send(JSON.stringify({ 
        type: 'connection_status', 
        connected: tiktokConnection?.isConnected || false,
        username: currentUsername,
        viewerCount: viewers.size
    }));
    
    const viewerList = Array.from(viewers.values()).slice(0, 300).map(v => ({
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
        viewers: viewers.size
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
    console.log(`🚀 Servidor en puerto ${PORT}`);
    console.log(`⚙️ Modo gratuito - ${MAX_VIEWERS_LIMIT} espectadores máximo`);
});
