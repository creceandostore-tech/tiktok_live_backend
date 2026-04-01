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

function getAvatarUrl(user) {
    try {
        if (user?.avatarThumbnail?.url) return user.avatarThumbnail.url;
        if (user?.avatarMedium?.url) return user.avatarMedium.url;
        if (user?.avatarLarge?.url) return user.avatarLarge.url;
        if (user?.profilePicture) return user.profilePicture;
        return null;
    } catch (e) {
        return null;
    }
}

function broadcastViewers() {
    const viewerList = Array.from(viewers.values()).map(v => ({
        username: v.username,
        nickname: v.nickname,
        avatar: v.avatar
    }));
    const message = JSON.stringify({ type: 'viewers', data: viewerList });
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

function broadcastStatus(connected, message = '') {
    const statusMsg = JSON.stringify({ type: 'connection_status', connected, message, username: currentUsername });
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(statusMsg);
    });
}

async function connectToTikTok(username) {
    // Limpiar username (quitar @ si existe)
    username = username.replace(/^@/, '');
    
    if (!username || username.trim() === '') {
        console.error('❌ Username inválido');
        broadcastStatus(false, 'Invalid username');
        return;
    }
    
    // Limpiar reconexión pendiente
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    
    // Desconectar conexión anterior
    if (tiktokConnection) {
        try {
            console.log('🔌 Desconectando conexión anterior...');
            isManualDisconnect = true;
            await tiktokConnection.disconnect();
            await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (e) {
            console.log('Error al desconectar:', e.message);
        }
        isManualDisconnect = false;
        tiktokConnection = null;
    }
    
    currentUsername = username;
    viewers.clear();
    
    console.log(`🔌 Conectando a TikTok Live: @${username}`);
    broadcastStatus(false, `Connecting to @${username}...`);
    
    try {
        // Crear nueva conexión con opciones optimizadas
        tiktokConnection = new TikTokLiveConnection(username, {
            enableExtendedGiftInfo: true,
            processInitialData: true,
            requestPollingIntervalMs: 2000,
            websocketTimeout: 60000,
            enableWebsocketUpgrade: true,
            fetchChatMessages: true,
            fetchGiftMessages: true,
            fetchMemberMessages: true,
            fetchLikeMessages: true
        });
        
        // Configurar eventos ANTES de conectar
        setupEventHandlers(username);
        
        // Intentar conectar
        console.log('🚀 Estableciendo conexión...');
        await tiktokConnection.connect();
        
        console.log(`✅ Conectado exitosamente a @${username}`);
        broadcastStatus(true, `Connected to @${username}`);
        
        // Actualizar espectadores después de un momento
        setTimeout(() => {
            if (tiktokConnection && tiktokConnection.isConnected) {
                broadcastViewers();
            }
        }, 3000);
        
    } catch (err) {
        console.error(`❌ Error de conexión: ${err.message}`);
        broadcastStatus(false, `Connection failed: ${err.message}`);
        tiktokConnection = null;
        currentUsername = null;
        
        // Reintentar solo si no es desconexión manual
        if (!isManualDisconnect) {
            console.log(`🔄 Reintentando en 5 segundos...`);
            reconnectTimer = setTimeout(() => {
                if (!isManualDisconnect && currentUsername) {
                    connectToTikTok(username);
                }
            }, 5000);
        }
    }
}

function setupEventHandlers(username) {
    if (!tiktokConnection) return;
    
    function addOrUpdateViewer(userData) {
        try {
            const uniqueId = userData?.uniqueId;
            if (!uniqueId || uniqueId === username) return;
            
            const avatarUrl = getAvatarUrl(userData);
            const existing = viewers.get(uniqueId);
            
            if (!existing || (existing.avatar === null && avatarUrl)) {
                viewers.set(uniqueId, {
                    username: uniqueId,
                    nickname: userData?.nickname || userData?.displayId || uniqueId,
                    avatar: avatarUrl
                });
                console.log(`👥 ${existing ? 'Actualizado' : 'Nuevo'}: @${uniqueId}`);
                broadcastViewers();
            }
        } catch (e) {
            console.error('Error al procesar usuario:', e.message);
        }
    }
    
    // Evento de conexión exitosa
    tiktokConnection.on(WebcastEvent.CONNECTED, () => {
        console.log(`✅ Conexión establecida con @${username}`);
        broadcastStatus(true, `Connected to @${username}`);
    });
    
    // Evento de desconexión
    tiktokConnection.on(WebcastEvent.DISCONNECTED, (reason) => {
        console.log(`🔌 Desconectado: ${reason || 'No reason'}`);
        broadcastStatus(false, `Disconnected: ${reason || 'Connection lost'}`);
        
        if (!isManualDisconnect && currentUsername) {
            console.log('🔄 Programando reconexión...');
            reconnectTimer = setTimeout(() => {
                if (!isManualDisconnect && currentUsername) {
                    connectToTikTok(currentUsername);
                }
            }, 5000);
        }
    });
    
    // Evento de error
    tiktokConnection.on(WebcastEvent.ERROR, (error) => {
        console.error(`❌ Error: ${error.message || error}`);
        broadcastStatus(false, `Error: ${error.message || 'Connection error'}`);
    });
    
    // Datos de la sala
    tiktokConnection.on(WebcastEvent.ROOM_USER_SEGMENT, (data) => {
        console.log(`📊 Datos del live - Viewers: ${data?.viewerCount || '?'}`);
        if (data?.viewerCount) {
            broadcastStatus(true, `Live: ${data.viewerCount} viewers`);
        }
    });
    
    // Miembros
    tiktokConnection.on(WebcastEvent.MEMBER, (data) => {
        if (data?.user) addOrUpdateViewer(data.user);
    });
    
    // Usuario se une
    tiktokConnection.on(WebcastEvent.MEMBER_JOIN, (data) => {
        console.log(`➕ JOIN: @${data?.user?.uniqueId}`);
        if (data?.user) {
            addOrUpdateViewer(data.user);
        }
    });
    
    // Usuario se va
    tiktokConnection.on(WebcastEvent.MEMBER_LEAVE, (data) => {
        const uniqueId = data?.user?.uniqueId;
        if (uniqueId && viewers.has(uniqueId)) {
            viewers.delete(uniqueId);
            console.log(`🚪 LEAVE: @${uniqueId}`);
            broadcastViewers();
        }
    });
    
    // Mensajes de chat
    tiktokConnection.on(WebcastEvent.CHAT, (data) => {
        if (data?.user) addOrUpdateViewer(data.user);
        
        const comment = data?.comment?.trim() || '';
        if (comment.toLowerCase().startsWith('!send')) {
            console.log(`📨 Comando detectado: ${comment}`);
            broadcastCommand(comment);
        }
    });
}

// WebSocket para clientes frontend
wss.on('connection', (ws) => {
    console.log('📱 Cliente conectado');
    clients.add(ws);
    
    // Enviar estado actual
    const isConnected = tiktokConnection && tiktokConnection.isConnected;
    ws.send(JSON.stringify({ 
        type: 'connection_status', 
        connected: isConnected,
        username: currentUsername,
        message: isConnected ? 'Connected' : 'Disconnected'
    }));
    
    // Enviar lista de espectadores
    const viewerList = Array.from(viewers.values()).map(v => ({
        username: v.username,
        nickname: v.nickname,
        avatar: v.avatar
    }));
    ws.send(JSON.stringify({ type: 'viewers', data: viewerList }));
    
    ws.on('close', () => {
        console.log('📱 Cliente desconectado');
        clients.delete(ws);
    });
    
    ws.on('error', (err) => {
        console.error('WebSocket error:', err.message);
    });
});

// Endpoint para conectar
app.get('/connect/:username', async (req, res) => {
    try {
        const username = req.params.username;
        console.log(`📡 Solicitud de conexión para: ${username}`);
        await connectToTikTok(username);
        res.json({ status: 'connected', username: username });
    } catch (err) {
        console.error('Error en /connect:', err);
        res.json({ status: 'error', error: err.message });
    }
});

// Endpoint para desconectar
app.get('/disconnect', async (req, res) => {
    try {
        isManualDisconnect = true;
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        if (tiktokConnection) {
            await tiktokConnection.disconnect();
            tiktokConnection = null;
        }
        currentUsername = null;
        viewers.clear();
        broadcastViewers();
        broadcastStatus(false, 'Disconnected');
        res.json({ status: 'disconnected' });
    } catch (err) {
        res.json({ status: 'error', error: err.message });
    } finally {
        isManualDisconnect = false;
    }
});

// Endpoint de estado
app.get('/status', (req, res) => {
    res.json({ 
        connected: tiktokConnection?.isConnected || false,
        username: currentUsername,
        viewers: viewers.size,
        hasConnection: !!tiktokConnection
    });
});

// Ruta principal
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Manejo de cierre
process.on('SIGTERM', async () => {
    console.log('🛑 Cerrando servidor...');
    isManualDisconnect = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (tiktokConnection) {
        try {
            await tiktokConnection.disconnect();
        } catch (e) {}
    }
    server.close(() => process.exit(0));
});

server.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
    console.log(`📡 WebSocket disponible en ws://localhost:${PORT}`);
});
