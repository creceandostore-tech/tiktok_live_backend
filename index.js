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
let donors = new Map(); // SOLO donadores (usuarios que han enviado regalos)
let currentUsername = null;
let isManualDisconnect = false;
let reconnectAttempts = 0;
let reconnectTimer = null;

const MAX_DONORS = 3000;
const INSTANT_RECONNECT_DELAY = 1000; // Reconexión inmediata (1 segundo)

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
        
        const donor = donors.get(username);
        let avatar = donor?.avatar || null;
        let nickname = donor?.nickname || username;
        
        if (!avatar) {
            const userData = await fetchUserFromTikTool(username);
            if (userData) {
                avatar = userData.avatar;
                nickname = userData.nickname;
                if (donor) {
                    donor.avatar = avatar;
                    donor.nickname = nickname;
                    broadcastDonors();
                }
            }
        }
        
        res.json({
            username: username,
            nickname: nickname,
            avatar: avatar,
            found: !!donor || !!avatar
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

function broadcastDonors() {
    const donorList = Array.from(donors.values()).slice(0, 500).map(d => ({
        username: d.username,
        nickname: d.nickname,
        avatar: d.avatar
    }));
    
    const message = JSON.stringify({ type: 'donors', data: donorList, total: donors.size });
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
        donorCount: donors.size
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
                broadcastDonors();
            }
        }, 1000);
    }
    
    // SOLO agregar donadores (usuarios que envían regalos)
    async function addDonor(userData) {
        try {
            const uniqueId = userData?.uniqueId;
            if (!uniqueId || uniqueId === username) return;
            if (donors.size >= MAX_DONORS && !donors.has(uniqueId)) return;
            
            // Si ya existe, mantener sus datos existentes
            if (donors.has(uniqueId)) {
                console.log(`♻️ Donador existente: @${uniqueId} envió otro regalo`);
                return;
            }
            
            // Nuevo donador - obtener su avatar y nombre real
            let avatar = getAvatarUrl(userData);
            let nickname = getNickname(userData);
            
            if (!avatar) {
                const userDataApi = await fetchUserFromTikTool(uniqueId);
                if (userDataApi) {
                    avatar = userDataApi.avatar;
                    nickname = userDataApi.nickname;
                }
            }
            
            donors.set(uniqueId, {
                username: uniqueId,
                nickname: nickname,
                avatar: avatar || null
            });
            
            console.log(`🎁 NUEVO DONADOR: @${uniqueId} (${nickname}) - Total: ${donors.size}`);
            pendingUpdate = true;
            scheduleBroadcast();
        } catch (e) {
            console.error(`Error al agregar donador: ${e.message}`);
        }
    }
    
    // Eliminar donador si se fue del live
    function removeDonor(uniqueId) {
        if (uniqueId && donors.has(uniqueId)) {
            donors.delete(uniqueId);
            console.log(`🚪 DONADOR ELIMINADO: @${uniqueId} (abandonó el live) - Restantes: ${donors.size}`);
            pendingUpdate = true;
            scheduleBroadcast();
        }
    }
    
    async function updateDonorAvatar(uniqueId, userData) {
        if (uniqueId && donors.has(uniqueId)) {
            const donor = donors.get(uniqueId);
            if (!donor.avatar) {
                const avatar = getAvatarUrl(userData);
                if (avatar) {
                    donor.avatar = avatar;
                    donor.nickname = getNickname(userData);
                    pendingUpdate = true;
                    scheduleBroadcast();
                    console.log(`🖼️ Avatar actualizado para @${uniqueId}`);
                } else {
                    const userDataApi = await fetchUserFromTikTool(uniqueId);
                    if (userDataApi?.avatar) {
                        donor.avatar = userDataApi.avatar;
                        donor.nickname = userDataApi.nickname;
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
        const count = data?.viewerCount || donors.size;
        console.log(`📊 Espectadores en vivo: ${count} | Donadores: ${donors.size}`);
        broadcastStatus(true, `En vivo: ${count} espectadores`);
    });
    
    // NO agregar por MEMBER o MEMBER_JOIN - SOLO por GIFT
    tiktokConnection.on(WebcastEvent.MEMBER, (data) => {
        // No hacer nada - solo donadores
    });
    
    tiktokConnection.on(WebcastEvent.MEMBER_JOIN, (data) => {
        // No hacer nada - solo donadores
    });
    
    // Eliminar donador cuando se va del live
    tiktokConnection.on(WebcastEvent.MEMBER_LEAVE, (data) => {
        if (data?.user?.uniqueId) {
            removeDonor(data.user.uniqueId);
        }
    });
    
    // SOLO GIFT agrega donadores
    tiktokConnection.on(WebcastEvent.GIFT, (data) => {
        if (data?.user) {
            console.log(`🎁 REGALO recibido de @${data.user.uniqueId} - ${data.gift?.name || 'Gift'} x${data.repeatCount || 1}`);
            addDonor(data.user);
            updateDonorAvatar(data.user.uniqueId, data.user);
        }
    });
    
    tiktokConnection.on(WebcastEvent.CHAT, (data) => {
        // Los mensajes de chat NO agregan donadores
        if (data?.user && donors.has(data.user.uniqueId)) {
            // Si es un donador existente, actualizar su info si falta avatar
            updateDonorAvatar(data.user.uniqueId, data.user);
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
        donorCount: donors.size
    }));
    
    const donorList = Array.from(donors.values()).slice(0, 500).map(d => ({
        username: d.username,
        nickname: d.nickname,
        avatar: d.avatar
    }));
    ws.send(JSON.stringify({ type: 'donors', data: donorList, total: donors.size }));
    
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
        donors.clear();
        currentUsername = null;
        broadcastDonors();
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
        donors: donors.size,
        maxDonors: MAX_DONORS
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
    console.log(`🚀 Servidor en puerto ${PORT}`);
    console.log(`⚙️ Máximo: ${MAX_DONORS} donadores`);
    console.log(`🔍 Endpoint /search/:username disponible`);
    console.log(`🎯 Modo: SOLO mostrar usuarios que envían regalos`);
});
