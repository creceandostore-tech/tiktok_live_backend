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
let connectionMonitor = null;
let lastHeartbeat = Date.now();
let reconnectInProgress = false;

const MAX_VIEWERS = 3000;
const MAX_RECONNECT_ATTEMPTS = Infinity;
const RECONNECT_DELAYS = [1000, 2000, 3000, 5000, 8000, 10000, 15000, 20000, 30000, 60000];
let currentDelayIndex = 0;

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

function startConnectionMonitor() {
    if (connectionMonitor) clearInterval(connectionMonitor);
    
    connectionMonitor = setInterval(() => {
        if (!isManualDisconnect && currentUsername && tiktokConnection) {
            const isConnected = tiktokConnection.isConnected;
            const timeSinceLastHeartbeat = Date.now() - lastHeartbeat;
            
            if (!isConnected || timeSinceLastHeartbeat > 30000) {
                if (!reconnectInProgress && !isReconnecting) {
                    broadcastLog(`⚠️ Monitor detectó posible desconexión. Reconectando...`, 'warning');
                    forceReconnect();
                }
            }
        }
    }, 15000);
}

async function forceReconnect() {
    if (reconnectInProgress || isManualDisconnect) return;
    
    reconnectInProgress = true;
    broadcastLog(`🔄 FORZANDO RECONEXIÓN...`, 'warning');
    
    try {
        if (tiktokConnection) {
            try {
                tiktokConnection.removeAllListeners();
                await tiktokConnection.disconnect();
            } catch(e) {}
            tiktokConnection = null;
        }
        
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        if (currentUsername && !isManualDisconnect) {
            await connectToTikTok(currentUsername);
        }
    } catch (err) {
        broadcastLog(`❌ Error en reconexión forzada: ${err.message}`, 'error');
    } finally {
        reconnectInProgress = false;
    }
}

async function scheduleReconnect() {
    if (isManualDisconnect || reconnectInProgress) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    
    if (reconnectAttempts > 20 && reconnectAttempts % 10 === 0) {
        currentDelayIndex = Math.max(0, currentDelayIndex - 1);
    }
    
    const delay = RECONNECT_DELAYS[Math.min(currentDelayIndex, RECONNECT_DELAYS.length - 1)];
    reconnectAttempts++;
    
    if (currentDelayIndex < RECONNECT_DELAYS.length - 1 && reconnectAttempts % 3 === 0) {
        currentDelayIndex++;
    }
    
    broadcastLog(`🔄 Intento ${reconnectAttempts} - Reintentando en ${delay/1000}s...`, 'warning');
    broadcastStatus(false, `Reconectando (intento ${reconnectAttempts})...`);
    
    reconnectTimer = setTimeout(async () => {
        if (!isManualDisconnect && currentUsername) {
            await connectToTikTok(currentUsername);
        }
    }, delay);
}

async function connectToTikTok(username) {
    username = username.replace(/^@/, '').trim();
    if (!username) return false;
    
    if (reconnectInProgress) return false;
    
    if (reconnectTimer) clearTimeout(reconnectTimer);
    
    const savedViewers = new Map(viewers);
    const savedAvatarCache = new Map(avatarCache);
    const savedDonorCache = new Map(donorCache);
    
    if (tiktokConnection) {
        try { 
            tiktokConnection.removeAllListeners();
            await tiktokConnection.disconnect(); 
        } catch (e) {}
        tiktokConnection = null;
    }
    
    currentUsername = username;
    broadcastLog(`🔌 Conectando a @${username}...`, 'info');
    broadcastStatus(false, `Conectando a @${username}...`);
    
    const connectionConfigs = [
        { enableExtendedGiftInfo: true, requestPollingIntervalMs: 3000, websocketTimeout: 120000 },
        { enableExtendedGiftInfo: true, requestPollingIntervalMs: 5000, websocketTimeout: 180000 },
        { enableExtendedGiftInfo: false, requestPollingIntervalMs: 8000, websocketTimeout: 240000 }
    ];
    
    for (let configIndex = 0; configIndex < connectionConfigs.length; configIndex++) {
        try {
            const config = connectionConfigs[configIndex];
            broadcastLog(`📡 Intentando configuración ${configIndex + 1}/${connectionConfigs.length}...`, 'info');
            
            tiktokConnection = new TikTokLiveConnection(username, {
                enableExtendedGiftInfo: config.enableExtendedGiftInfo,
                processInitialData: true,
                requestPollingIntervalMs: config.requestPollingIntervalMs,
                websocketTimeout: config.websocketTimeout,
                fetchChatMessages: true,
                fetchGiftMessages: true,
                fetchMemberMessages: true,
                fetchLikeMessages: false,
                enableWebsocketUpgrade: true,
                requestTimeoutMs: 30000
            });
            
            setupEventHandlers(username);
            await tiktokConnection.connect();
            
            viewers.clear();
            savedViewers.forEach((value, key) => {
                viewers.set(key, value);
            });
            
            reconnectAttempts = 0;
            currentDelayIndex = 0;
            lastHeartbeat = Date.now();
            broadcastLog(`✅ Conectado exitosamente a @${username} (configuración ${configIndex + 1})`, 'success');
            broadcastLog(`📊 Datos restaurados: ${viewers.size} espectadores`, 'success');
            broadcastStatus(true, `Conectado a @${username} - ${viewers.size} espectadores`);
            
            broadcastViewers();
            
            return true;
        } catch (err) {
            broadcastLog(`❌ Configuración ${configIndex + 1} falló: ${err.message}`, 'error');
            if (tiktokConnection) {
                try { tiktokConnection.removeAllListeners(); } catch(e) {}
                try { await tiktokConnection.disconnect(); } catch(e) {}
                tiktokConnection = null;
            }
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
    
    broadcastLog(`❌ Todas las configuraciones fallaron para @${username}`, 'error');
    broadcastStatus(false, `Error: No se pudo conectar`);
    tiktokConnection = null;
    if (!isManualDisconnect) scheduleReconnect();
    return false;
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
    
    const heartbeatInterval = setInterval(() => {
        lastHeartbeat = Date.now();
    }, 5000);
    
    tiktokConnection.on(WebcastEvent.CONNECTED, () => {
        broadcastLog(`✅ Conexión WebSocket establecida`, 'success');
        reconnectAttempts = 0;
        currentDelayIndex = 0;
        lastHeartbeat = Date.now();
        broadcastStatus(true, `Conectado`);
    });
    
    tiktokConnection.on(WebcastEvent.DISCONNECTED, (reason) => {
        broadcastLog(`🔌 Desconectado: ${reason || 'Razón desconocida'}`, 'warning');
        if (!isManualDisconnect && currentUsername) {
            scheduleReconnect();
        }
    });
    
    tiktokConnection.on(WebcastEvent.ERROR, (error) => {
        broadcastLog(`❌ Error: ${error.message}`, 'error');
        if (!isManualDisconnect && currentUsername && !reconnectInProgress) {
            scheduleReconnect();
        }
    });
    
    tiktokConnection.on(WebcastEvent.ROOM_USER_SEGMENT, (data) => {
        const count = data?.viewerCount || viewers.size;
        broadcastLog(`📊 Espectadores en vivo: ${count}`, 'info');
        broadcastStatus(true, `Live: ${count} viewers`);
        lastHeartbeat = Date.now();
    });
    
    tiktokConnection.on(WebcastEvent.MEMBER, async (data) => {
        if (data?.user) await addViewer(data.user);
        lastHeartbeat = Date.now();
    });
    
    tiktokConnection.on(WebcastEvent.MEMBER_JOIN, async (data) => {
        if (data?.user) await addViewer(data.user);
        lastHeartbeat = Date.now();
    });
    
    tiktokConnection.on(WebcastEvent.MEMBER_LEAVE, (data) => {
        if (data?.user?.uniqueId) removeViewer(data.user.uniqueId);
        lastHeartbeat = Date.now();
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
        lastHeartbeat = Date.now();
    });
    
    tiktokConnection.on(WebcastEvent.CHAT, async (data) => {
        if (data?.user) await addViewer(data.user);
        lastHeartbeat = Date.now();
    });
    
    const originalDisconnect = tiktokConnection.disconnect;
    tiktokConnection.disconnect = async function() {
        clearInterval(heartbeatInterval);
        return originalDisconnect.apply(this, arguments);
    };
}

// RESET COMPLETO - Limpia espectadores, donadores y caché de avatares
function fullReset() {
    broadcastLog(`🧹 REALIZANDO RESET COMPLETO...`, 'warning');
    viewers.clear();
    donorCache.clear();
    avatarCache.clear();
    broadcastLog(`✅ Espectadores eliminados: 0`, 'success');
    broadcastLog(`✅ Donadores eliminados: 0`, 'success');
    broadcastLog(`✅ Caché de avatares eliminada`, 'success');
    broadcastViewers();
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

app.get('/donors', (req, res) => {
    const donorsList = Array.from(donorCache.values()).sort((a, b) => b.totalGifts - a.totalGifts);
    res.json({ donors: donorsList, total: donorsList.length });
});

wss.on('connection', (ws) => {
    broadcastLog(`📱 Nuevo cliente conectado`, 'success');
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
        broadcastLog(`📱 Cliente desconectado`, 'info');
        clients.delete(ws);
    });
});

app.get('/connect/:username', async (req, res) => {
    try {
        const username = req.params.username;
        broadcastLog(`📡 Solicitud de conexión a: @${username}`, 'info');
        isManualDisconnect = false;
        reconnectAttempts = 0;
        currentDelayIndex = 0;
        await connectToTikTok(username);
        startConnectionMonitor();
        res.json({ status: 'connected', username: username });
    } catch (err) {
        broadcastLog(`❌ Error en conexión: ${err.message}`, 'error');
        res.json({ status: 'error', error: err.message });
    }
});

app.get('/disconnect', async (req, res) => {
    try {
        broadcastLog(`🔌 DESCONEXIÓN MANUAL - Reseteando todos los datos...`, 'warning');
        isManualDisconnect = true;
        reconnectInProgress = false;
        
        if (reconnectTimer) clearTimeout(reconnectTimer);
        if (connectionMonitor) clearInterval(connectionMonitor);
        
        if (tiktokConnection) {
            tiktokConnection.removeAllListeners();
            await tiktokConnection.disconnect();
        }
        
        tiktokConnection = null;
        currentUsername = null;
        reconnectAttempts = 0;
        currentDelayIndex = 0;
        
        // RESET COMPLETO: Limpia espectadores, donadores y caché
        fullReset();
        
        broadcastStatus(false, 'Desconectado manualmente - Live finalizado');
        broadcastLog(`✅ Desconectado y datos limpiados correctamente`, 'success');
        broadcastLog(`💡 Ya puedes conectar un nuevo live`, 'info');
        
        res.json({ status: 'disconnected', reset: true });
    } catch (err) {
        broadcastLog(`❌ Error en desconexión: ${err.message}`, 'error');
        res.json({ status: 'error', error: err.message });
    }
});

app.get('/reset', (req, res) => {
    if (!isManualDisconnect && tiktokConnection?.isConnected) {
        broadcastLog(`⚠️ No se puede resetear mientras hay un live activo. Desconecta primero.`, 'warning');
        res.json({ status: 'error', message: 'Desconecta el live primero' });
    } else {
        fullReset();
        res.json({ status: 'reset', message: 'Todos los datos han sido limpiados' });
    }
});

app.get('/status', (req, res) => {
    res.json({ 
        connected: tiktokConnection?.isConnected || false,
        username: currentUsername,
        viewers: viewers.size,
        maxViewers: MAX_VIEWERS,
        donors: donorCache.size,
        reconnectAttempts: reconnectAttempts
    });
});

app.get('/force-reconnect', async (req, res) => {
    if (isManualDisconnect) {
        broadcastLog(`⚠️ No se puede reconectar porque hay una desconexión manual activa`, 'warning');
        res.json({ status: 'error', message: 'Desconexión manual activa' });
    } else {
        broadcastLog(`🔄 Forzando reconexión manual...`, 'warning');
        await forceReconnect();
        res.json({ status: 'reconnecting', username: currentUsername });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
    console.log(`\n🚀 ========== SERVIDOR INICIADO ==========`);
    console.log(`📡 Puerto: ${PORT}`);
    console.log(`👥 Máximo espectadores: ${MAX_VIEWERS}`);
    console.log(`🔄 Reconexión automática: ACTIVADA (intentos infinitos)`);
    console.log(`🧹 Al desconectar: RESET COMPLETO de datos`);
    console.log(`📊 Endpoint /search/:username disponible`);
    console.log(`📊 Endpoint /donors disponible`);
    console.log(`🔄 Endpoint /force-reconnect disponible`);
    console.log(`🧹 Endpoint /reset disponible`);
    console.log(`========================================\n`);
});
