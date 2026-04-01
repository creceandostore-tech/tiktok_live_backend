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
let reconnectTimer = null;
let isManualDisconnect = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY = 5000; // 5 segundos

// Función para extraer la URL del avatar de los datos del usuario
function getAvatarUrl(user) {
    if (user.avatarThumbnail && user.avatarThumbnail.url) {
        return user.avatarThumbnail.url;
    }
    if (user.avatarMedium && user.avatarMedium.url) {
        return user.avatarMedium.url;
    }
    if (user.avatarLarge && user.avatarLarge.url) {
        return user.avatarLarge.url;
    }
    if (user.avatarThumbnail && typeof user.avatarThumbnail === 'string') {
        return user.avatarThumbnail;
    }
    if (user.avatarMedium && typeof user.avatarMedium === 'string') {
        return user.avatarMedium;
    }
    if (user.avatarLarge && typeof user.avatarLarge === 'string') {
        return user.avatarLarge;
    }
    if (user.profilePicture) {
        return user.profilePicture;
    }
    return null;
}

function broadcastViewers() {
    const viewerList = Array.from(viewers.values()).map(v => ({
        username: v.username,
        nickname: v.nickname,
        avatar: v.avatar
    }));
    const message = JSON.stringify({ type: 'viewers', data: viewerList });
    console.log(`📢 Enviando lista a ${clients.size} clientes: ${viewerList.length} espectadores`);
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(message);
    });
}

function broadcastCommand(command) {
    const message = JSON.stringify({ type: 'command', command });
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(message);
    });
}

function broadcastConnectionStatus(connected, message = '') {
    const statusMessage = JSON.stringify({ type: 'connection_status', connected, message });
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(statusMessage);
    });
}

function scheduleReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    
    if (isManualDisconnect) {
        console.log('🔒 Desconexión manual, no se reconectará automáticamente');
        return;
    }
    
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.log(`❌ Máximos intentos de reconexión (${MAX_RECONNECT_ATTEMPTS}) alcanzados`);
        broadcastConnectionStatus(false, 'Max reconnection attempts reached');
        return;
    }
    
    reconnectAttempts++;
    console.log(`🔄 Programando reconexión en ${RECONNECT_DELAY/1000}s (intento ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
    broadcastConnectionStatus(false, `Reconnecting in ${RECONNECT_DELAY/1000}s (attempt ${reconnectAttempts})`);
    
    reconnectTimer = setTimeout(async () => {
        if (currentUsername && !isManualDisconnect) {
            console.log(`🔄 Intentando reconectar a @${currentUsername}...`);
            await connectToTikTok(currentUsername);
        }
    }, RECONNECT_DELAY);
}

async function connectToTikTok(username) {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    
    if (tiktokConnection) {
        try {
            isManualDisconnect = true;
            await tiktokConnection.disconnect();
            await new Promise(resolve => setTimeout(resolve, 1000));
        } catch(e) { 
            console.log('Disconnect error:', e.message); 
        }
        isManualDisconnect = false;
    }
    
    currentUsername = username;
    viewers.clear();
    
    console.log(`🔌 Conectando a @${username}...`);
    broadcastConnectionStatus(false, `Connecting to @${username}...`);
    
    tiktokConnection = new TikTokLiveConnection(username, {
        enableExtendedGiftInfo: true,
        processInitialData: true,
        requestPollingIntervalMs: 3000, // Aumentado para reducir carga
        websocketTimeout: 30000, // Timeout de 30 segundos
        enableWebsocketUpgrade: true,
        fetchChatMessages: true,
        fetchGiftMessages: true,
        fetchMemberMessages: true,
        fetchLikeMessages: true
    });

    function addOrUpdateViewer(userData) {
        const uniqueId = userData.uniqueId;
        if (!uniqueId || uniqueId === username) return;
        
        const avatarUrl = getAvatarUrl(userData);
        const existing = viewers.get(uniqueId);
        
        if (!existing || (existing.avatar === null && avatarUrl)) {
            viewers.set(uniqueId, {
                username: uniqueId,
                nickname: userData.nickname || userData.displayId || uniqueId,
                avatar: avatarUrl
            });
            console.log(`👥 ${existing ? 'Actualizado' : 'Nuevo'}: @${uniqueId}`);
        }
    }

    // Manejo de eventos con mejor control de errores
    tiktokConnection.on(WebcastEvent.CONNECTED, () => {
        console.log(`✅ Conectado exitosamente al live de @${username}`);
        broadcastConnectionStatus(true, `Connected to @${username}`);
        reconnectAttempts = 0; // Resetear contador en conexión exitosa
        
        // Solicitar lista de espectadores
        setTimeout(() => {
            broadcastViewers();
        }, 2000);
    });

    tiktokConnection.on(WebcastEvent.DISCONNECTED, (reason) => {
        console.log(`🔌 Desconectado de @${username}: ${reason || 'No reason provided'}`);
        broadcastConnectionStatus(false, `Disconnected: ${reason || 'Unknown reason'}`);
        
        if (!isManualDisconnect) {
            scheduleReconnect();
        }
    });

    tiktokConnection.on(WebcastEvent.ERROR, (error) => {
        console.error(`❌ Error en conexión TikTok: ${error.message || error}`);
        broadcastConnectionStatus(false, `Error: ${error.message || 'Connection error'}`);
        
        if (!isManualDisconnect && tiktokConnection) {
            // No reconectar inmediatamente en error, esperar un poco
            setTimeout(() => {
                if (!isManualDisconnect && currentUsername) {
                    scheduleReconnect();
                }
            }, 2000);
        }
    });

    // Procesar datos iniciales del live
    tiktokConnection.on(WebcastEvent.ROOM_USER_SEGMENT, (data) => {
        console.log(`📊 Datos del live recibidos - Espectadores: ${data.viewerCount || '?'}`);
        if (data.viewerCount) {
            broadcastConnectionStatus(true, `Live: ${data.viewerCount} viewers`);
        }
    });

    tiktokConnection.on(WebcastEvent.MEMBER, (data) => {
        if (data.user) addOrUpdateViewer(data.user);
    });

    tiktokConnection.on(WebcastEvent.MEMBER_JOIN, (data) => {
        console.log(`➕ JOIN: @${data.user?.uniqueId}`);
        if (data.user) {
            addOrUpdateViewer(data.user);
            broadcastViewers();
        }
    });

    tiktokConnection.on(WebcastEvent.MEMBER_LEAVE, (data) => {
        const uniqueId = data.user?.uniqueId;
        if (uniqueId && viewers.has(uniqueId)) {
            viewers.delete(uniqueId);
            console.log(`🚪 LEAVE: @${uniqueId}`);
            broadcastViewers();
        }
    });

    tiktokConnection.on(WebcastEvent.CHAT, (data) => {
        if (data.user) addOrUpdateViewer(data.user);
        
        const comment = data.comment?.trim() || '';
        if (comment.toLowerCase().startsWith('!send')) {
            console.log(`📨 Comando detectado: ${comment}`);
            broadcastCommand(comment);
        }
    });

    // Mantener conexión activa con ping/pong
    let pingInterval = setInterval(() => {
        if (tiktokConnection && tiktokConnection.socket && tiktokConnection.socket.readyState === 1) {
            try {
                tiktokConnection.socket.ping();
            } catch(e) {
                console.log('Ping error:', e.message);
            }
        }
    }, 15000);
    
    tiktokConnection.on(WebcastEvent.DISCONNECTED, () => {
        clearInterval(pingInterval);
    });

    try {
        await tiktokConnection.connect();
    } catch (err) {
        console.error(`❌ Error de conexión inicial: ${err.message}`);
        broadcastConnectionStatus(false, `Connection failed: ${err.message}`);
        
        if (!isManualDisconnect) {
            scheduleReconnect();
        }
        throw err;
    }
}

wss.on('connection', (ws) => {
    console.log('📱 Cliente frontend conectado');
    clients.add(ws);
    
    // Enviar estado actual de conexión
    const isConnected = tiktokConnection && tiktokConnection.isConnected;
    ws.send(JSON.stringify({ 
        type: 'connection_status', 
        connected: isConnected,
        username: currentUsername
    }));
    
    // Enviar lista actual al nuevo cliente
    const viewerList = Array.from(viewers.values()).map(v => ({
        username: v.username,
        nickname: v.nickname,
        avatar: v.avatar
    }));
    ws.send(JSON.stringify({ type: 'viewers', data: viewerList }));
    
    ws.on('close', () => {
        console.log('📱 Cliente frontend desconectado');
        clients.delete(ws);
    });
});

app.get('/connect/:username', async (req, res) => {
    try {
        await connectToTikTok(req.params.username);
        res.json({ status: 'connected', username: req.params.username });
    } catch (err) {
        res.json({ status: 'error', error: err.message });
    }
});

app.get('/disconnect', async (req, res) => {
    try {
        isManualDisconnect = true;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        if (tiktokConnection) {
            await tiktokConnection.disconnect();
        }
        currentUsername = null;
        viewers.clear();
        broadcastViewers();
        broadcastConnectionStatus(false, 'Disconnected manually');
        res.json({ status: 'disconnected' });
    } catch (err) {
        res.json({ status: 'error', error: err.message });
    } finally {
        isManualDisconnect = false;
    }
});

app.get('/status', (req, res) => {
    res.json({ 
        connected: tiktokConnection?.isConnected || false, 
        viewers: viewers.size,
        username: currentUsername,
        reconnectAttempts: reconnectAttempts
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Manejo de cierre graceful
process.on('SIGTERM', async () => {
    console.log('🛑 Recibido SIGTERM, cerrando conexiones...');
    isManualDisconnect = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (tiktokConnection) {
        await tiktokConnection.disconnect();
    }
    server.close(() => process.exit(0));
});

server.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));
