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
let lastGiftTime = Date.now();

const MAX_VIEWERS = 5000;
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
        return { nickname: uniqueId, avatar: null };
    }
}

app.get('/search/:username', async (req, res) => {
    try {
        const username = req.params.username.replace(/^@/, '').trim();
        console.log(`🔍 Buscando usuario: ${username}`);
        
        const viewer = viewers.get(username);
        let avatar = viewer?.avatar || null;
        let nickname = viewer?.nickname || username;
        
        if (!avatar) {
            const userInfo = await fetchUserInfo(username);
            avatar = userInfo.avatar;
            nickname = userInfo.nickname;
            if (avatar && viewer) {
                viewer.avatar = avatar;
                viewer.nickname = nickname;
                broadcastViewers();
            }
        }
        
        res.json({
            username: username,
            nickname: nickname,
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
    // Solo enviar donadores (los que tienen prioridad o enviaron regalos)
    const donorList = Array.from(viewers.values())
        .filter(v => v.isDonor === true)
        .slice(0, 500)
        .map(v => ({
            username: v.username,
            nickname: v.nickname,
            avatar: v.avatar,
            giftName: v.lastGift || null
        }));
    
    const message = JSON.stringify({ type: 'viewers', data: donorList, total: donorList.length, allViewers: viewers.size });
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try { client.send(message); } catch (e) {}
        }
    });
}

function broadcastGift(username, nickname, giftName, avatar, giftCount = 1) {
    const message = JSON.stringify({ 
        type: 'gift', 
        username: username,
        nickname: nickname,
        giftName: giftName,
        giftCount: giftCount,
        avatar: avatar
    });
    console.log(`🎁 Enviando notificación: @${username} (${nickname}) - ${giftName} x${giftCount}`);
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

// Limpiar espectadores que no están en el live cada 1 minuto
setInterval(() => {
    if (!tiktokConnection || !tiktokConnection.isConnected) return;
    
    const now = Date.now();
    let removedCount = 0;
    
    viewers.forEach((viewer, uniqueId) => {
        // Si el usuario no ha tenido actividad en más de 70 segundos, eliminarlo
        if (now - viewer.lastSeen > 70000) {
            viewers.delete(uniqueId);
            removedCount++;
        }
    });
    
    if (removedCount > 0) {
        console.log(`🧹 Limpiados ${removedCount} espectadores inactivos. Donadores restantes: ${viewers.size}`);
        broadcastViewers();
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
                broadcastViewers();
            }
        }, 2000);
    }
    
    function addOrUpdateViewer(userData, isDonor = false, giftName = null) {
        try {
            const uniqueId = userData?.uniqueId;
            if (!uniqueId || uniqueId === username) return;
            
            const now = Date.now();
            const existing = viewers.get(uniqueId);
            
            if (!existing) {
                const avatar = getAvatarUrl(userData);
                viewers.set(uniqueId, {
                    username: uniqueId,
                    nickname: userData?.nickname || userData?.displayId || uniqueId,
                    avatar: avatar || null,
                    isDonor: isDonor,
                    lastGift: giftName,
                    lastSeen: now
                });
                console.log(`👥 Nuevo donador: @${uniqueId} (${userData?.nickname || uniqueId})`);
                pendingUpdate = true;
                scheduleBroadcast();
            } else if (isDonor) {
                existing.isDonor = true;
                existing.lastGift = giftName;
                existing.lastSeen = now;
                if (!existing.nickname || existing.nickname === existing.username) {
                    existing.nickname = userData?.nickname || existing.nickname;
                }
                pendingUpdate = true;
                scheduleBroadcast();
            } else {
                existing.lastSeen = now;
            }
        } catch (e) {}
    }
    
    async function updateDonorInfo(uniqueId, userData, giftName, giftCount) {
        const avatar = getAvatarUrl(userData);
        let nickname = userData?.nickname || userData?.displayId || uniqueId;
        
        // Si no tiene avatar, buscar en API
        let finalAvatar = avatar;
        if (!finalAvatar) {
            finalAvatar = await fetchAvatarFromTikTool(uniqueId);
        }
        
        // Buscar nombre real
        if (nickname === uniqueId) {
            const userInfo = await fetchUserInfo(uniqueId);
            nickname = userInfo.nickname;
            if (!finalAvatar && userInfo.avatar) finalAvatar = userInfo.avatar;
        }
        
        viewers.set(uniqueId, {
            username: uniqueId,
            nickname: nickname,
            avatar: finalAvatar,
            isDonor: true,
            lastGift: `${giftName} x${giftCount}`,
            lastSeen: Date.now()
        });
        
        // Enviar notificación al frontend
        broadcastGift(uniqueId, nickname, giftName, finalAvatar, giftCount);
        
        pendingUpdate = true;
        scheduleBroadcast();
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
        console.log(`📊 Espectadores en live: ${count} | Donadores registrados: ${viewers.size}`);
        broadcastStatus(true, `Live: ${count} viewers`);
    });
    
    // EVENTO DE REGALO - Solo donadores se guardan
    tiktokConnection.on(WebcastEvent.GIFT, async (data) => {
        if (data?.user) {
            const userId = data.user.uniqueId;
            const giftName = data.giftName || 'Gift';
            const repeatCount = data.repeatCount || 1;
            const diamondCount = data.diamondCount || 0;
            console.log(`🎁 REGALO de @${userId}: ${giftName} x${repeatCount} (${diamondCount} diamantes)`);
            
            // Actualizar información del donador
            await updateDonorInfo(userId, data.user, giftName, repeatCount);
        }
    });
    
    tiktokConnection.on(WebcastEvent.CHAT, (data) => {
        // Solo actualizar lastSeen, no agregar como donador
        if (data?.user?.uniqueId) {
            const existing = viewers.get(data.user.uniqueId);
            if (existing) {
                existing.lastSeen = Date.now();
            }
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
    
    // Solo enviar donadores
    const donorList = Array.from(viewers.values())
        .filter(v => v.isDonor === true)
        .slice(0, 500)
        .map(v => ({
            username: v.username,
            nickname: v.nickname,
            avatar: v.avatar,
            giftName: v.lastGift || null
        }));
    ws.send(JSON.stringify({ type: 'viewers', data: donorList, total: donorList.length, allViewers: viewers.size }));
    
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
    const donors = Array.from(viewers.values()).filter(v => v.isDonor === true).length;
    res.json({ 
        connected: tiktokConnection?.isConnected || false,
        username: currentUsername,
        donors: donors,
        totalViewers: viewers.size
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
    console.log(`🚀 Servidor en puerto ${PORT}`);
    console.log(`⚙️ Modo: Solo donadores visibles`);
    console.log(`🧹 Limpieza automática cada 60 segundos`);
});
