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
let activeUsers = new Map(); // Usuarios que han enviado regalos
let currentUsername = null;
let isManualDisconnect = false;
let reconnectAttempts = 0;
let reconnectTimer = null;

const MAX_USERS = 3000;
const INSTANT_RECONNECT_DELAY = 1000;

const avatarCache = new Map();
const TIKTOOL_API_KEY = 'tk_19ccc744ea1023f55fc03ede8dd300da8519a313022ab447';

async function fetchUserFromTikTool(uniqueId) {
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
            const userData = data?.user || data;
            const avatarUrl = userData?.avatar || userData?.avatarThumbnail?.url || userData?.profilePicture || null;
            const nickname = userData?.nickname || userData?.displayName || userData?.uniqueId || uniqueId;
            
            if (avatarUrl && avatarUrl.startsWith('http')) {
                console.log(`✅ Datos obtenidos para @${uniqueId}: ${nickname}`);
                avatarCache.set(uniqueId, { avatar: avatarUrl, nickname: nickname });
                return { avatar: avatarUrl, nickname: nickname };
            }
        }
        return null;
    } catch (error) {
        console.error(`Error fetching user data: ${error.message}`);
        return null;
    }
}

app.get('/search/:username', async (req, res) => {
    try {
        const username = req.params.username.replace(/^@/, '').trim();
        console.log(`🔍 Buscando usuario: ${username}`);
        
        const user = activeUsers.get(username);
        let avatar = user?.avatar || null;
        let nickname = user?.nickname || username;
        
        if (!avatar) {
            const userData = await fetchUserFromTikTool(username);
            if (userData) {
                avatar = userData.avatar;
                nickname = userData.nickname;
                if (user) {
                    user.avatar = avatar;
                    user.nickname = nickname;
                    broadcastUsers();
                }
            }
        }
        
        res.json({
            username: username,
            nickname: nickname,
            avatar: avatar,
            found: !!user || !!avatar
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
        if (user?.avatarUrl) return user.avatarUrl;
        return null;
    } catch (e) {
        return null;
    }
}

function getNickname(user) {
    try {
        return user?.nickname || user?.displayId || user?.uniqueId || 'Usuario';
    } catch (e) {
        return 'Usuario';
    }
}

function broadcastUsers() {
    const userList = Array.from(activeUsers.values()).slice(0, 500).map(u => ({
        username: u.username,
        nickname: u.nickname,
        avatar: u.avatar
    }));
    
    const message = JSON.stringify({ type: 'users', data: userList, total: activeUsers.size });
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
        userCount: activeUsers.size
    });
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try { client.send(statusMsg); } catch (e) {}
        }
    });
}

function instantReconnect() {
    if (isManualDisconnect) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    
    reconnectAttempts++;
    const delay = Math.min(INSTANT_RECONNECT_DELAY * Math.min(reconnectAttempts, 3), 5000);
    
    console.log(`🔄 Reconectando en ${delay/1000}s... (Intento ${reconnectAttempts})`);
    broadcastStatus(false, `Reconectando en ${delay/1000}s...`);
    
    reconnectTimer = setTimeout(async () => {
        if (!isManualDisconnect && currentUsername) {
            await connectToTikTok(currentUsername);
        }
    }, delay);
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
    broadcastStatus(false, `Conectando a @${username}...`);
    
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
        
        reconnectAttempts = 0;
        console.log(`✅ Conectado permanentemente a @${username}`);
        broadcastStatus(true, `Conectado a @${username}`);
        return true;
    } catch (err) {
        console.error(`❌ Error de conexión: ${err.message}`);
        broadcastStatus(false, `Error: ${err.message}`);
        tiktokConnection = null;
        if (!isManualDisconnect) instantReconnect();
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
                broadcastUsers();
            }
        }, 1000);
    }
    
    async function addActiveUser(userData) {
        try {
            const uniqueId = userData?.uniqueId;
            if (!uniqueId || uniqueId === username) return;
            if (activeUsers.size >= MAX_USERS && !activeUsers.has(uniqueId)) return;
            
            if (activeUsers.has(uniqueId)) {
                console.log(`♻️ Usuario existente: @${uniqueId} envió otro regalo`);
                return;
            }
            
            let avatar = getAvatarUrl(userData);
            let nickname = getNickname(userData);
            
            if (!avatar) {
                const userDataApi = await fetchUserFromTikTool(uniqueId);
                if (userDataApi) {
                    avatar = userDataApi.avatar;
                    nickname = userDataApi.nickname;
                }
            }
            
            activeUsers.set(uniqueId, {
                username: uniqueId,
                nickname: nickname,
                avatar: avatar || null
            });
            
            console.log(`🎁 NUEVO USUARIO ACTIVO: @${uniqueId} (${nickname}) - Total: ${activeUsers.size}`);
            pendingUpdate = true;
            scheduleBroadcast();
        } catch (e) {
            console.error(`Error al agregar usuario: ${e.message}`);
        }
    }
    
    function removeActiveUser(uniqueId) {
        if (uniqueId && activeUsers.has(uniqueId)) {
            activeUsers.delete(uniqueId);
            console.log(`🚪 USUARIO ELIMINADO: @${uniqueId} (abandonó el live) - Restantes: ${activeUsers.size}`);
            pendingUpdate = true;
            scheduleBroadcast();
        }
    }
    
    async function updateUserAvatar(uniqueId, userData) {
        if (uniqueId && activeUsers.has(uniqueId)) {
            const user = activeUsers.get(uniqueId);
            if (!user.avatar) {
                const avatar = getAvatarUrl(userData);
                if (avatar) {
                    user.avatar = avatar;
                    user.nickname = getNickname(userData);
                    pendingUpdate = true;
                    scheduleBroadcast();
                    console.log(`🖼️ Avatar actualizado para @${uniqueId}`);
                } else {
                    const userDataApi = await fetchUserFromTikTool(uniqueId);
                    if (userDataApi?.avatar) {
                        user.avatar = userDataApi.avatar;
                        user.nickname = userDataApi.nickname;
                        pendingUpdate = true;
                        scheduleBroadcast();
                        console.log(`🖼️ Avatar obtenido de API para @${uniqueId}`);
                    }
                }
            }
        }
    }
    
    tiktokConnection.on(WebcastEvent.CONNECTED, () => {
        console.log(`✅ Conexión establecida permanentemente`);
        broadcastStatus(true, `Conectado`);
        reconnectAttempts = 0;
    });
    
    tiktokConnection.on(WebcastEvent.DISCONNECTED, (reason) => {
        console.log(`🔌 Desconectado: ${reason || 'razón desconocida'}`);
        broadcastStatus(false, `Desconectado`);
        if (!isManualDisconnect && currentUsername) {
            console.log(`🔄 Iniciando reconexión inmediata...`);
            instantReconnect();
        }
    });
    
    tiktokConnection.on(WebcastEvent.ERROR, (error) => {
        console.error(`❌ Error: ${error.message}`);
        broadcastStatus(false, `Error: ${error.message}`);
        if (!isManualDisconnect && currentUsername) {
            instantReconnect();
        }
    });
    
    tiktokConnection.on(WebcastEvent.ROOM_USER_SEGMENT, (data) => {
        const count = data?.viewerCount || activeUsers.size;
        console.log(`📊 Espectadores en vivo: ${count} | Usuarios activos: ${activeUsers.size}`);
        broadcastStatus(true, `En vivo: ${count} espectadores`);
    });
    
    tiktokConnection.on(WebcastEvent.MEMBER_LEAVE, (data) => {
        if (data?.user?.uniqueId) {
            removeActiveUser(data.user.uniqueId);
        }
    });
    
    tiktokConnection.on(WebcastEvent.GIFT, (data) => {
        if (data?.user) {
            console.log(`🎁 REGALO recibido de @${data.user.uniqueId} - ${data.gift?.name || 'Gift'} x${data.repeatCount || 1}`);
            addActiveUser(data.user);
            updateUserAvatar(data.user.uniqueId, data.user);
        }
    });
    
    tiktokConnection.on(WebcastEvent.CHAT, (data) => {
        if (data?.user && activeUsers.has(data.user.uniqueId)) {
            updateUserAvatar(data.user.uniqueId, data.user);
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
        userCount: activeUsers.size
    }));
    
    const userList = Array.from(activeUsers.values()).slice(0, 500).map(u => ({
        username: u.username,
        nickname: u.nickname,
        avatar: u.avatar
    }));
    ws.send(JSON.stringify({ type: 'users', data: userList, total: activeUsers.size }));
    
    ws.on('close', () => {
        console.log('📱 Cliente desconectado');
        clients.delete(ws);
    });
});

app.get('/connect/:username', async (req, res) => {
    try {
        const username = req.params.username;
        console.log(`📡 Conectando a: ${username}`);
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
        if (reconnectTimer) clearTimeout(reconnectTimer);
        if (tiktokConnection) await tiktokConnection.disconnect();
        tiktokConnection = null;
        activeUsers.clear();
        currentUsername = null;
        broadcastUsers();
        broadcastStatus(false, 'Desconectado');
        res.json({ status: 'disconnected' });
    } catch (err) {
        res.json({ status: 'error', error: err.message });
    }
});

app.get('/status', (req, res) => {
    res.json({ 
        connected: tiktokConnection?.isConnected || false,
        username: currentUsername,
        users: activeUsers.size,
        maxUsers: MAX_USERS
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
    console.log(`🚀 Servidor en puerto ${PORT}`);
    console.log(`⚙️ Máximo: ${MAX_USERS} usuarios activos`);
    console.log(`🔍 Endpoint /search/:username disponible`);
    console.log(`🎯 Modo: Usuarios que envían regalos`);
});
