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
let gifters = new Map(); // Solo usuarios que envían regalos
let donors = new Map(); // Donadores persistentes
let currentUsername = null;
let isManualDisconnect = false;
let reconnectTimer = null;
let cleanupTimer = null;
let reconnectAttempts = 0;

const MAX_GIFTERS = 3000;
const CLEANUP_INTERVAL = 120000; // 2 minutos
const MAX_RECONNECT_ATTEMPTS = 20;
const BASE_RECONNECT_DELAY = 3000;

const TIKTOOL_API_KEY = 'tk_19ccc744ea1023f55fc03ede8dd300da8519a313022ab447';

// Función para limpiar espectadores que no enviaron regalos cada 2 minutos
function startCleanupInterval() {
    if (cleanupTimer) clearInterval(cleanupTimer);
    
    cleanupTimer = setInterval(() => {
        console.log('🧹 Limpiando espectadores que no enviaron regalos...');
        
        const now = Date.now();
        let cleanedCount = 0;
        
        for (const [username, data] of gifters.entries()) {
            if (now - data.lastGiftTime > CLEANUP_INTERVAL) {
                gifters.delete(username);
                cleanedCount++;
                console.log(`🗑️ Eliminado @${username} (inactivo)`);
            }
        }
        
        if (cleanedCount > 0) {
            console.log(`✅ Limpiados ${cleanedCount} espectadores inactivos`);
            broadcastViewers();
        }
    }, CLEANUP_INTERVAL);
}

// Función para reconexión robusta
async function robustReconnect() {
    if (isManualDisconnect) return;
    if (!currentUsername) return;
    
    reconnectAttempts++;
    const delay = Math.min(BASE_RECONNECT_DELAY * Math.pow(1.5, reconnectAttempts - 1), 30000);
    
    console.log(`🔄 Intento de reconexión ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} en ${delay}ms...`);
    broadcastStatus(false, `Reconectando (intento ${reconnectAttempts})...`);
    
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(async () => {
        if (!isManualDisconnect && currentUsername) {
            const success = await connectToTikTok(currentUsername);
            if (!success && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                robustReconnect();
            } else if (success) {
                reconnectAttempts = 0;
            }
        }
    }, delay);
}

async function fetchAvatarFromTikTool(uniqueId) {
    if (donors.has(uniqueId)) return donors.get(uniqueId).avatar;
    
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
                return avatarUrl;
            }
        }
        return null;
    } catch (error) {
        console.error(`Error fetching avatar: ${error.message}`);
        return null;
    }
}

app.get('/search/:username', async (req, res) => {
    try {
        const username = req.params.username.replace(/^@/, '').trim();
        console.log(`🔍 Buscando usuario: ${username}`);
        
        const gifter = gifters.get(username);
        const donor = donors.get(username);
        let avatar = gifter?.avatar || donor?.avatar || null;
        
        if (!avatar) {
            avatar = await fetchAvatarFromTikTool(username);
            if (avatar && gifter) {
                gifter.avatar = avatar;
                broadcastViewers();
            }
            if (avatar && donor) {
                donor.avatar = avatar;
            }
        }
        
        res.json({
            username: username,
            nickname: gifter?.nickname || donor?.nickname || username,
            avatar: avatar,
            found: !!gifter || !!donor
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
    const gifterList = Array.from(gifters.values()).slice(0, 500).map(v => ({
        username: v.username,
        nickname: v.nickname,
        avatar: v.avatar,
        isDonor: v.isDonor || false
    }));
    
    const message = JSON.stringify({ type: 'viewers', data: gifterList, total: gifters.size });
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
        viewerCount: gifters.size
    });
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try { client.send(statusMsg); } catch (e) {}
        }
    });
}

async function connectToTikTok(username) {
    username = username.replace(/^@/, '').trim();
    if (!username) return false;
    
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
    broadcastStatus(false, `Conectando a @${username}...`);
    
    try {
        tiktokConnection = new TikTokLiveConnection(username, {
            enableExtendedGiftInfo: true,
            processInitialData: true,
            requestPollingIntervalMs: 5000,
            websocketTimeout: 90000,
            fetchChatMessages: false,
            fetchGiftMessages: true,
            fetchMemberMessages: false,
            fetchLikeMessages: false
        });
        
        setupEventHandlers(username);
        await tiktokConnection.connect();
        
        console.log(`✅ Conectado a @${username}`);
        broadcastStatus(true, `Conectado a @${username}`);
        reconnectAttempts = 0;
        return true;
    } catch (err) {
        console.error(`❌ Error: ${err.message}`);
        broadcastStatus(false, `Error: ${err.message}`);
        tiktokConnection = null;
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
    
    function addGifter(userData, giftInfo = null) {
        try {
            const uniqueId = userData?.uniqueId;
            if (!uniqueId || uniqueId === username) return;
            if (gifters.size >= MAX_GIFTERS && !gifters.has(uniqueId)) return;
            
            const now = Date.now();
            const avatar = getAvatarUrl(userData);
            
            if (!gifters.has(uniqueId)) {
                const donorData = donors.get(uniqueId);
                gifters.set(uniqueId, {
                    username: uniqueId,
                    nickname: userData?.nickname || userData?.displayId || uniqueId,
                    avatar: donorData?.avatar || avatar || null,
                    lastGiftTime: now,
                    totalGifts: giftInfo?.diamondCount || 1,
                    isDonor: !!donorData
                });
                console.log(`🎁 +GIFTER @${uniqueId} (${gifters.size})`);
            } else {
                const existing = gifters.get(uniqueId);
                existing.lastGiftTime = now;
                existing.totalGifts = (existing.totalGifts || 0) + (giftInfo?.diamondCount || 1);
                gifters.set(uniqueId, existing);
                console.log(`🎁 +REGALO @${uniqueId} (Total: ${existing.totalGifts})`);
            }
            
            pendingUpdate = true;
            scheduleBroadcast();
        } catch (e) {
            console.error('Error en addGifter:', e);
        }
    }
    
    function markAsDonor(uniqueId, userData) {
        if (!donors.has(uniqueId)) {
            const avatar = getAvatarUrl(userData);
            donors.set(uniqueId, {
                username: uniqueId,
                nickname: userData?.nickname || userData?.displayId || uniqueId,
                avatar: avatar || null,
                firstGiftDate: Date.now()
            });
            console.log(`🏆 NUEVO DONADOR PERMANENTE: @${uniqueId}`);
            
            if (gifters.has(uniqueId)) {
                const gifter = gifters.get(uniqueId);
                gifter.isDonor = true;
                gifters.set(uniqueId, gifter);
            }
        }
    }
    
    async function updateAvatarFromGift(uniqueId, userData) {
        if (uniqueId && gifters.has(uniqueId)) {
            const gifter = gifters.get(uniqueId);
            if (!gifter.avatar) {
                const avatar = getAvatarUrl(userData);
                if (avatar) {
                    gifter.avatar = avatar;
                    pendingUpdate = true;
                    scheduleBroadcast();
                } else {
                    const apiAvatar = await fetchAvatarFromTikTool(uniqueId);
                    if (apiAvatar) {
                        gifter.avatar = apiAvatar;
                        pendingUpdate = true;
                        scheduleBroadcast();
                        console.log(`🖼️ Foto para @${uniqueId}`);
                    }
                }
            }
        }
    }
    
    tiktokConnection.on(WebcastEvent.CONNECTED, () => {
        console.log(`✅ Conexión establecida`);
        broadcastStatus(true, `Conectado`);
    });
    
    tiktokConnection.on(WebcastEvent.DISCONNECTED, (reason) => {
        console.log(`🔌 Desconectado: ${reason || 'razón desconocida'}`);
        broadcastStatus(false, `Desconectado`);
        if (!isManualDisconnect && currentUsername) {
            robustReconnect();
        }
    });
    
    tiktokConnection.on(WebcastEvent.ERROR, (error) => {
        console.error(`❌ Error: ${error.message}`);
        broadcastStatus(false, `Error: ${error.message}`);
        if (!isManualDisconnect && currentUsername) {
            robustReconnect();
        }
    });
    
    tiktokConnection.on(WebcastEvent.GIFT, (data) => {
        if (data?.user) {
            const giftValue = data?.gift?.diamondCount || 1;
            console.log(`🎁 REGALO de @${data.user.uniqueId} (Valor: ${giftValue} diamantes)`);
            
            if (giftValue >= 100) {
                markAsDonor(data.user.uniqueId, data.user);
            }
            
            addGifter(data.user, { diamondCount: giftValue });
            updateAvatarFromGift(data.user.uniqueId, data.user);
        }
    });
    
    // Heartbeat cada 30 segundos
    setInterval(() => {
        if (tiktokConnection && tiktokConnection.isConnected) {
            console.log('💓 Heartbeat - conexión activa');
        } else if (!isManualDisconnect && currentUsername && !tiktokConnection?.isConnected) {
            console.log('⚠️ Conexión perdida detectada, reconectando...');
            robustReconnect();
        }
    }, 30000);
}

wss.on('connection', (ws) => {
    console.log('📱 Cliente conectado');
    clients.add(ws);
    
    ws.send(JSON.stringify({ 
        type: 'connection_status', 
        connected: tiktokConnection?.isConnected || false,
        username: currentUsername,
        viewerCount: gifters.size
    }));
    
    const gifterList = Array.from(gifters.values()).slice(0, 500).map(v => ({
        username: v.username,
        nickname: v.nickname,
        avatar: v.avatar,
        isDonor: v.isDonor || false
    }));
    ws.send(JSON.stringify({ type: 'viewers', data: gifterList, total: gifters.size }));
    
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
        if (reconnectTimer) clearTimeout(reconnectTimer);
        if (cleanupTimer) clearInterval(cleanupTimer);
        if (tiktokConnection) {
            tiktokConnection.removeAllListeners();
            await tiktokConnection.disconnect();
        }
        tiktokConnection = null;
        currentUsername = null;
        broadcastViewers();
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
        gifters: gifters.size,
        donors: donors.size,
        maxGifters: MAX_GIFTERS
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

startCleanupInterval();

server.listen(PORT, () => {
    console.log(`🚀 Servidor en puerto ${PORT}`);
    console.log(`⚙️ Máximo: ${MAX_GIFTERS} gifters`);
    console.log(`🧹 Limpieza cada: ${CLEANUP_INTERVAL/1000} segundos`);
    console.log(`🔍 Endpoint /search/:username disponible`);
    console.log(`💪 Reconexión robusta activada`);
});
