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
const donorCache = new Map();
const TIKTOOL_API_KEY = 'tk_19ccc744ea1023f55fc03ede8dd300da8519a313022ab447';

function broadcastLog(message, type = 'info') {
    const logMsg = JSON.stringify({
        type: 'console_log',
        timestamp: new Date().toISOString(),
        message: message,
        logType: type
    });
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try { client.send(logMsg); } catch (e) {}
        }
    });
    console.log(message);
}

async function fetchAvatarFromTikTool(uniqueId) {
    if (avatarCache.has(uniqueId)) return avatarCache.get(uniqueId);
    
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
                avatarCache.set(uniqueId, avatarUrl);
                return avatarUrl;
            }
        }
    } catch (error) {}
    
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
            avatarCache.set(uniqueId, match[1]);
            return match[1];
        }
    } catch (error) {}
    
    return null;
}

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
        userData?.avatar
    ];
    
    for (const url of avatarUrls) {
        if (url && typeof url === 'string' && url.startsWith('http')) {
            return url;
        }
    }
    return null;
}

async function saveDonorData(uniqueId, userData, giftData) {
    let avatar = avatarCache.get(uniqueId);
    if (!avatar) {
        avatar = extractAvatarFromUserData(userData);
        if (!avatar) {
            avatar = await fetchAvatarFromTikTool(uniqueId);
        }
        if (avatar) avatarCache.set(uniqueId, avatar);
    }
    
    const existingDonor = donorCache.get(uniqueId);
    const donorInfo = {
        username: uniqueId,
        nickname: userData?.nickname || userData?.displayId || uniqueId,
        avatar: avatar || null,
        totalGifts: (existingDonor?.totalGifts || 0) + 1,
        lastGift: {
            name: giftData?.name || 'Regalo',
            diamondCount: giftData?.diamondCount || 1,
            repeatCount: giftData?.repeatCount || 1,
            timestamp: new Date().toISOString()
        },
        firstSeen: existingDonor?.firstSeen || new Date().toISOString(),
        lastSeen: new Date().toISOString()
    };
    
    donorCache.set(uniqueId, donorInfo);
    return donorInfo;
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
    if (isManualDisconnect || isReconnecting || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    
    const delay = RECONNECT_DELAYS[Math.min(reconnectAttempts, RECONNECT_DELAYS.length - 1)];
    reconnectAttempts++;
    
    broadcastLog(`🔄 Intento ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} - Reintentando en ${delay/1000}s...`, 'warning');
    broadcastStatus(false, `Reconnecting in ${delay/1000}s...`);
    
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
    broadcastLog(`🔌 Conectando a @${username}...`, 'info');
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
        broadcastLog(`✅ Conectado exitosamente a @${username}`, 'success');
        broadcastStatus(true, `Connected to @${username}`);
        return true;
    } catch (err) {
        broadcastLog(`❌ Error conectando a @${username}: ${err.message}`, 'error');
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
                broadcastLog(`👥 Nuevo espectador: @${uniqueId} (Total: ${viewers.size})`, 'info');
                pendingUpdate = true;
                scheduleBroadcast();
            }
        } catch (e) {}
    }
    
    function removeViewer(uniqueId) {
        if (uniqueId && viewers.has(uniqueId)) {
            viewers.delete(uniqueId);
            broadcastLog(`🚪 Espectador salió: @${uniqueId} (Total: ${viewers.size})`, 'info');
            pendingUpdate = true;
            scheduleBroadcast();
        }
    }
    
    tiktokConnection.on(WebcastEvent.CONNECTED, () => {
        broadcastLog(`✅ Conexión WebSocket establecida`, 'success');
        reconnectAttempts = 0;
        broadcastStatus(true, `Connected`);
    });
    
    tiktokConnection.on(WebcastEvent.DISCONNECTED, (reason) => {
        broadcastLog(`🔌 Desconectado: ${reason || 'Razón desconocida'}`, 'warning');
        broadcastStatus(false, `Disconnected`);
        if (!isManualDisconnect && currentUsername) scheduleReconnect();
    });
    
    tiktokConnection.on(WebcastEvent.ERROR, (error) => {
        broadcastLog(`❌ Error: ${error.message}`, 'error');
        broadcastStatus(false, `Error: ${error.message}`);
        if (!isManualDisconnect && currentUsername) scheduleReconnect();
    });
    
    tiktokConnection.on(WebcastEvent.ROOM_USER_SEGMENT, (data) => {
        const count = data?.viewerCount || viewers.size;
        broadcastLog(`📊 Espectadores en vivo: ${count}`, 'info');
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
            
            broadcastLog(`🎁 REGALO de @${uniqueId}: ${giftName} x${repeatCount} (${totalDiamonds}💎)`, 'success');
            
            const donorData = await saveDonorData(uniqueId, data.user, {
                name: giftName,
                diamondCount: diamondCount,
                repeatCount: repeatCount
            });
            
            if (!viewers.has(uniqueId)) {
                viewers.set(uniqueId, {
                    username: uniqueId,
                    nickname: donorData.nickname,
                    avatar: donorData.avatar
                });
                pendingUpdate = true;
                scheduleBroadcast();
            }
            
            broadcastGiftNotification({
                username: uniqueId,
                nickname: donorData.nickname,
                avatar: donorData.avatar,
                giftName: giftName,
                diamondCount: totalDiamonds,
                repeatCount: repeatCount,
                totalGifts: donorData.totalGifts
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
        let avatar = avatarCache.get(username);
        let donorData = donorCache.get(username);
        
        if (!avatar) {
            avatar = await fetchAvatarFromTikTool(username);
        }
        
        res.json({
            username: username,
            nickname: donorData?.nickname || viewers.get(username)?.nickname || username,
            avatar: avatar,
            found: viewers.has(username) || !!avatar,
            totalGifts: donorData?.totalGifts || 0,
            lastGift: donorData?.lastGift || null
        });
    } catch (err) {
        res.json({ error: err.message });
    }
});

wss.on('connection', (ws) => {
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
    
    const donorsList = Array.from(donorCache.values()).sort((a, b) => b.totalGifts - a.totalGifts);
    ws.send(JSON.stringify({ type: 'donors_list', data: donorsList, total: donorsList.length }));
    
    ws.on('close', () => {
        clients.delete(ws);
    });
});

app.get('/connect/:username', async (req, res) => {
    try {
        const username = req.params.username;
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
        maxViewers: MAX_VIEWERS,
        donors: donorCache.size
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
    console.log(`\n🚀 Servidor iniciado en puerto ${PORT}`);
    console.log(`👥 Máximo espectadores: ${MAX_VIEWERS}`);
    console.log(`========================================\n`);
});
