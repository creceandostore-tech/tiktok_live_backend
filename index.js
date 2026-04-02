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
let gifters = new Map(); // Todos los que envían regalos
let donors = new Map(); // Donadores persistentes
let currentUsername = null;
let isManualDisconnect = false;
let reconnectTimer = null;
let cleanupTimer = null;
let reconnectAttempts = 0;

const MAX_GIFTERS = 5000;
const CLEANUP_INTERVAL = 120000; // 2 minutos
const MAX_RECONNECT_ATTEMPTS = 999; // Intentos infinitos
const BASE_RECONNECT_DELAY = 2000;

const TIKTOOL_API_KEY = 'tk_19ccc744ea1023f55fc03ede8dd300da8519a313022ab447';

// Limpiar espectadores inactivos (los que no han enviado regalos en 2 minutos)
function startCleanupInterval() {
    if (cleanupTimer) clearInterval(cleanupTimer);
    
    cleanupTimer = setInterval(() => {
        console.log('🧹 Limpiando gifters inactivos...');
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
            console.log(`✅ Limpiados ${cleanedCount} gifters inactivos`);
            broadcastToAllClients({
                type: 'viewers_update',
                data: getGiftersList(),
                total: gifters.size,
                timestamp: Date.now()
            });
        }
    }, CLEANUP_INTERVAL);
}

// Obtener lista de gifters formateada
function getGiftersList() {
    const list = Array.from(gifters.values())
        .sort((a, b) => (b.totalGifts || 0) - (a.totalGifts || 0))
        .slice(0, 1000)
        .map(v => ({
            username: v.username,
            nickname: v.nickname,
            avatar: v.avatar,
            isDonor: v.isDonor || false,
            totalGifts: v.totalGifts || 0,
            lastGiftTime: v.lastGiftTime,
            lastGiftName: v.lastGiftName || null
        }));
    return list;
}

// Broadcast a todos los clientes
function broadcastToAllClients(message) {
    const msgStr = JSON.stringify(message);
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try { client.send(msgStr); } catch (e) {}
        }
    });
}

// Broadcast de regalo en tiempo real
function broadcastGift(giftData) {
    console.log(`📢 Broadcast regalo: @${giftData.username} - ${giftData.giftName} (${giftData.diamondCount}💎)`);
    broadcastToAllClients({
        type: 'new_gift',
        data: giftData,
        timestamp: Date.now()
    });
}

// Broadcast de donador nuevo
function broadcastNewDonor(donorData) {
    console.log(`📢 Broadcast donador: @${donorData.username}`);
    broadcastToAllClients({
        type: 'new_donor',
        data: donorData,
        timestamp: Date.now()
    });
}

// Broadcast de lista completa de gifters
function broadcastGiftersList() {
    broadcastToAllClients({
        type: 'viewers_update',
        data: getGiftersList(),
        total: gifters.size,
        timestamp: Date.now()
    });
}

function broadcastStatus(connected, message = '') {
    broadcastToAllClients({
        type: 'connection_status',
        connected,
        message,
        username: currentUsername,
        viewerCount: gifters.size,
        timestamp: Date.now()
    });
}

// Reconexión robusta e infinita
async function robustReconnect() {
    if (isManualDisconnect) return;
    if (!currentUsername) return;
    
    reconnectAttempts++;
    const delay = Math.min(BASE_RECONNECT_DELAY * Math.pow(1.3, reconnectAttempts - 1), 15000);
    
    console.log(`🔄 Intento de reconexión ${reconnectAttempts} en ${delay}ms...`);
    broadcastStatus(false, `Reconectando (intento ${reconnectAttempts})...`);
    
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(async () => {
        if (!isManualDisconnect && currentUsername) {
            const success = await connectToTikTok(currentUsername);
            if (!success) {
                robustReconnect(); // Seguir intentando
            } else {
                reconnectAttempts = 0;
            }
        }
    }, delay);
}

async function fetchAvatarFromTikTool(uniqueId) {
    if (donors.has(uniqueId) && donors.get(uniqueId).avatar) {
        return donors.get(uniqueId).avatar;
    }
    
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
                broadcastGiftersList();
            }
            if (avatar && donor) {
                donor.avatar = avatar;
            }
        }
        
        res.json({
            username: username,
            nickname: gifter?.nickname || donor?.nickname || username,
            avatar: avatar,
            found: !!gifter || !!donor,
            totalGifts: gifter?.totalGifts || donor?.totalGifts || 0,
            isDonor: !!(gifter?.isDonor || donor)
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
            requestPollingIntervalMs: 1000, // Máxima velocidad
            websocketTimeout: 120000,
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
        console.error(`❌ Error de conexión: ${err.message}`);
        broadcastStatus(false, `Error: ${err.message}`);
        tiktokConnection = null;
        return false;
    }
}

function setupEventHandlers(username) {
    if (!tiktokConnection) return;
    
    // Procesar regalo inmediatamente
    function processGift(userData, giftData) {
        try {
            const uniqueId = userData?.uniqueId;
            if (!uniqueId || uniqueId === username) return;
            
            const now = Date.now();
            const diamondCount = giftData?.diamondCount || 1;
            const giftName = giftData?.giftName || giftData?.name || 'Regalo';
            const avatar = getAvatarUrl(userData);
            
            console.log(`🎁 REGALO DETECTADO: @${uniqueId} - ${giftName} (${diamondCount}💎)`);
            
            let isNewGifter = false;
            let totalGifts = 0;
            let isNewDonor = false;
            
            // Actualizar o crear gifter
            if (!gifters.has(uniqueId)) {
                const donorData = donors.get(uniqueId);
                gifters.set(uniqueId, {
                    username: uniqueId,
                    nickname: userData?.nickname || userData?.displayId || uniqueId,
                    avatar: donorData?.avatar || avatar || null,
                    lastGiftTime: now,
                    totalGifts: diamondCount,
                    isDonor: !!donorData,
                    lastGiftName: giftName
                });
                isNewGifter = true;
                totalGifts = diamondCount;
                console.log(`✨ NUEVO GIFTER: @${uniqueId} (${gifters.size} total)`);
            } else {
                const existing = gifters.get(uniqueId);
                existing.lastGiftTime = now;
                existing.totalGifts = (existing.totalGifts || 0) + diamondCount;
                existing.lastGiftName = giftName;
                totalGifts = existing.totalGifts;
                gifters.set(uniqueId, existing);
                console.log(`🔄 REGALO ACUMULADO: @${uniqueId} - Total: ${totalGifts}💎`);
            }
            
            // Marcar como donador (regalos de 50+ diamantes o acumulado > 200)
            const shouldBeDonor = diamondCount >= 50 || totalGifts >= 200;
            if (shouldBeDonor && !donors.has(uniqueId)) {
                donors.set(uniqueId, {
                    username: uniqueId,
                    nickname: userData?.nickname || uniqueId,
                    avatar: avatar || null,
                    firstGiftDate: now,
                    totalGifts: totalGifts
                });
                isNewDonor = true;
                
                // Actualizar flag en gifter
                const gifter = gifters.get(uniqueId);
                gifter.isDonor = true;
                gifters.set(uniqueId, gifter);
                
                console.log(`🏆 NUEVO DONADOR: @${uniqueId} (Total: ${totalGifts}💎)`);
                broadcastNewDonor({
                    username: uniqueId,
                    nickname: userData?.nickname || uniqueId,
                    avatar: avatar,
                    totalGifts: totalGifts
                });
            }
            
            // Broadcast del regalo en tiempo real
            broadcastGift({
                username: uniqueId,
                nickname: userData?.nickname || uniqueId,
                avatar: gifters.get(uniqueId)?.avatar,
                giftName: giftName,
                diamondCount: diamondCount,
                totalGifts: totalGifts,
                isDonor: gifters.get(uniqueId)?.isDonor || false,
                isNewGifter: isNewGifter
            });
            
            // Actualizar lista completa periódicamente (no en cada regalo para evitar spam)
            if (isNewGifter || isNewDonor || gifters.size % 5 === 0) {
                setTimeout(() => broadcastGiftersList(), 50);
            }
            
            // Buscar avatar si no tiene
            if (!gifters.get(uniqueId)?.avatar) {
                setTimeout(async () => {
                    const apiAvatar = await fetchAvatarFromTikTool(uniqueId);
                    if (apiAvatar && gifters.has(uniqueId)) {
                        const g = gifters.get(uniqueId);
                        g.avatar = apiAvatar;
                        gifters.set(uniqueId, g);
                        broadcastGiftersList();
                    }
                }, 100);
            }
            
        } catch (e) {
            console.error('Error en processGift:', e);
        }
    }
    
    // Evento de regalo - EL MÁS IMPORTANTE
    tiktokConnection.on(WebcastEvent.GIFT, (data) => {
        if (data?.user && data?.gift) {
            processGift(data.user, {
                diamondCount: data.gift.diamondCount,
                giftName: data.gift.name,
                giftId: data.gift.id
            });
        }
    });
    
    // Evento de conexión
    tiktokConnection.on(WebcastEvent.CONNECTED, () => {
        console.log(`✅ Conexión establecida con @${username}`);
        broadcastStatus(true, `Conectado a @${username}`);
    });
    
    // Evento de desconexión
    tiktokConnection.on(WebcastEvent.DISCONNECTED, (reason) => {
        console.log(`🔌 Desconectado: ${reason || 'razón desconocida'}`);
        broadcastStatus(false, `Desconectado - reconectando...`);
        if (!isManualDisconnect && currentUsername) {
            robustReconnect();
        }
    });
    
    // Evento de error
    tiktokConnection.on(WebcastEvent.ERROR, (error) => {
        console.error(`❌ Error en conexión: ${error.message}`);
        if (!isManualDisconnect && currentUsername) {
            robustReconnect();
        }
    });
    
    // Heartbeat cada 10 segundos para mantener conexión activa
    const heartbeatInterval = setInterval(() => {
        if (tiktokConnection && tiktokConnection.isConnected) {
            console.log('💓 Heartbeat - conexión activa');
        } else if (!isManualDisconnect && currentUsername && !tiktokConnection?.isConnected) {
            console.log('⚠️ Heartbeat: conexión perdida, reconectando...');
            clearInterval(heartbeatInterval);
            robustReconnect();
        }
    }, 10000);
}

wss.on('connection', (ws) => {
    console.log('📱 Nuevo cliente conectado');
    clients.add(ws);
    
    // Enviar estado actual inmediatamente
    ws.send(JSON.stringify({
        type: 'connection_status',
        connected: tiktokConnection?.isConnected || false,
        username: currentUsername,
        viewerCount: gifters.size,
        timestamp: Date.now()
    }));
    
    // Enviar lista completa de gifters
    ws.send(JSON.stringify({
        type: 'viewers_update',
        data: getGiftersList(),
        total: gifters.size,
        timestamp: Date.now()
    }));
    
    ws.on('close', () => {
        console.log('📱 Cliente desconectado');
        clients.delete(ws);
    });
});

app.get('/connect/:username', async (req, res) => {
    try {
        const username = req.params.username;
        console.log(`📡 Solicitando conexión a: ${username}`);
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
        console.log('🔌 Desconexión manual solicitada');
        isManualDisconnect = true;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        if (tiktokConnection) {
            tiktokConnection.removeAllListeners();
            await tiktokConnection.disconnect();
        }
        tiktokConnection = null;
        currentUsername = null;
        broadcastGiftersList();
        broadcastStatus(false, 'Desconectado manualmente');
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

app.get('/gifters', (req, res) => {
    res.json({
        gifters: getGiftersList(),
        total: gifters.size,
        donors: donors.size
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Iniciar limpieza automática
startCleanupInterval();

server.listen(PORT, () => {
    console.log(`\n🚀 SERVIDOR INICIADO`);
    console.log(`📡 Puerto: ${PORT}`);
    console.log(`🎁 Detectando TODOS los gifters en tiempo real`);
    console.log(`🧹 Limpieza de inactivos: cada ${CLEANUP_INTERVAL/1000}s`);
    console.log(`🔄 Reconexión automática: INFINITA`);
    console.log(`💓 Heartbeat: cada 10s`);
    console.log(`\n✨ Listo para conectar con TikTok Live!\n`);
});
