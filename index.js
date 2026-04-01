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
let isReconnecting = false;
let lastViewerCount = 0;
let connectionStartTime = null;
let heartbeatInterval = null;
let messageQueue = [];
let isProcessingQueue = false;

// Configuración
const MAX_VIEWERS_LIMIT = 2000; // Límite máximo de espectadores a mostrar
const RECONNECT_DELAY = 2000; // 2 segundos
const HEARTBEAT_INTERVAL = 10000; // 10 segundos

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
    // Limitar cantidad de espectadores para evitar sobrecarga
    const viewerList = Array.from(viewers.values())
        .slice(0, MAX_VIEWERS_LIMIT)
        .map(v => ({
            username: v.username,
            nickname: v.nickname,
            avatar: v.avatar
        }));
    
    const message = JSON.stringify({ type: 'viewers', data: viewerList });
    
    // Usar queue para evitar flooding
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(message);
            } catch (e) {
                console.error('Error sending to client:', e.message);
            }
        }
    });
}

function broadcastCommand(command) {
    const message = JSON.stringify({ type: 'command', command });
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(message);
            } catch (e) {}
        }
    });
}

function broadcastStatus(connected, message = '', viewerCount = null) {
    const statusMsg = JSON.stringify({ 
        type: 'connection_status', 
        connected, 
        message, 
        username: currentUsername,
        viewerCount: viewerCount || viewers.size
    });
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(statusMsg);
            } catch (e) {}
        }
    });
}

function cleanupViewers() {
    // Limpiar espectadores antiguos cada cierto tiempo para liberar memoria
    if (viewers.size > MAX_VIEWERS_LIMIT) {
        const toDelete = viewers.size - MAX_VIEWERS_LIMIT;
        const iterator = viewers.keys();
        for (let i = 0; i < toDelete; i++) {
            viewers.delete(iterator.next().value);
        }
        console.log(`🧹 Limpiados ${toDelete} espectadores antiguos. Total: ${viewers.size}`);
        broadcastViewers();
    }
}

async function reconnectToTikTok() {
    if (isReconnecting || !currentUsername) return;
    
    isReconnecting = true;
    console.log(`🔄 Reconectando a @${currentUsername}...`);
    broadcastStatus(false, `Reconnecting to @${currentUsername}...`);
    
    // Limpiar conexión anterior completamente
    if (tiktokConnection) {
        try {
            await tiktokConnection.disconnect();
        } catch (e) {}
        tiktokConnection = null;
    }
    
    // Limpiar heartbeats
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
    
    // Esperar antes de reconectar
    await new Promise(resolve => setTimeout(resolve, RECONNECT_DELAY));
    
    try {
        await connectToTikTok(currentUsername);
    } catch (err) {
        console.error('Error en reconexión:', err.message);
        // Programar otra reconexión si falla
        setTimeout(() => {
            isReconnecting = false;
            reconnectToTikTok();
        }, RECONNECT_DELAY * 2);
    } finally {
        isReconnecting = false;
    }
}

async function connectToTikTok(username) {
    username = username.replace(/^@/, '');
    
    if (!username || username.trim() === '') {
        console.error('❌ Username inválido');
        return;
    }
    
    // Guardar username para reconexiones
    currentUsername = username;
    connectionStartTime = Date.now();
    
    // Limpiar conexión anterior
    if (tiktokConnection) {
        try {
            await tiktokConnection.disconnect();
        } catch (e) {}
        tiktokConnection = null;
    }
    
    // Limpiar heartbeats
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
    
    console.log(`🔌 Conectando a TikTok Live: @${username}`);
    broadcastStatus(false, `Connecting to @${username}...`);
    
    try {
        // Crear nueva conexión con opciones optimizadas para alta carga
        tiktokConnection = new TikTokLiveConnection(username, {
            enableExtendedGiftInfo: false, // Deshabilitar para reducir carga
            processInitialData: true,
            requestPollingIntervalMs: 3000, // Mayor intervalo para reducir peticiones
            websocketTimeout: 90000, // Timeout más largo
            enableWebsocketUpgrade: true,
            fetchChatMessages: true,
            fetchGiftMessages: false, // Deshabilitar gifts para reducir carga
            fetchMemberMessages: true,
            fetchLikeMessages: false // Deshabilitar likes para reducir carga
        });
        
        // Configurar eventos
        setupEventHandlers(username);
        
        // Conectar
        await tiktokConnection.connect();
        
        console.log(`✅ Conectado exitosamente a @${username}`);
        broadcastStatus(true, `Connected to @${username}`, viewers.size);
        
        // Iniciar heartbeat para mantener conexión
        heartbeatInterval = setInterval(() => {
            if (tiktokConnection && tiktokConnection.isConnected) {
                // Enviar ping para mantener conexión
                try {
                    if (tiktokConnection.socket && tiktokConnection.socket.readyState === 1) {
                        tiktokConnection.socket.ping();
                        console.log('💓 Heartbeat enviado');
                    }
                } catch (e) {
                    console.log('Heartbeat error:', e.message);
                }
            } else if (tiktokConnection && !tiktokConnection.isConnected && !isReconnecting) {
                console.log('⚠️ Conexión perdida, reconectando...');
                reconnectToTikTok();
            }
        }, HEARTBEAT_INTERVAL);
        
        // Limpiar espectadores antiguos cada 5 minutos
        setInterval(() => {
            cleanupViewers();
        }, 300000);
        
    } catch (err) {
        console.error(`❌ Error de conexión: ${err.message}`);
        broadcastStatus(false, `Connection failed: ${err.message}`);
        tiktokConnection = null;
        
        // Reconectar automáticamente
        if (!isReconnecting) {
            setTimeout(() => {
                reconnectToTikTok();
            }, RECONNECT_DELAY);
        }
    }
}

function setupEventHandlers(username) {
    if (!tiktokConnection) return;
    
    let lastBroadcastTime = 0;
    let pendingBroadcast = null;
    
    function throttledBroadcastViewers() {
        const now = Date.now();
        if (now - lastBroadcastTime >= 1000) { // Máximo 1 broadcast por segundo
            lastBroadcastTime = now;
            broadcastViewers();
            if (pendingBroadcast) {
                clearTimeout(pendingBroadcast);
                pendingBroadcast = null;
            }
        } else if (!pendingBroadcast) {
            pendingBroadcast = setTimeout(() => {
                lastBroadcastTime = Date.now();
                broadcastViewers();
                pendingBroadcast = null;
            }, 1000 - (now - lastBroadcastTime));
        }
    }
    
    function addOrUpdateViewer(userData) {
        try {
            const uniqueId = userData?.uniqueId;
            if (!uniqueId || uniqueId === username) return;
            
            // Limitar cantidad de espectadores para rendimiento
            if (viewers.size >= MAX_VIEWERS_LIMIT && !viewers.has(uniqueId)) {
                return;
            }
            
            const avatarUrl = getAvatarUrl(userData);
            const existing = viewers.get(uniqueId);
            
            if (!existing || (existing.avatar === null && avatarUrl)) {
                viewers.set(uniqueId, {
                    username: uniqueId,
                    nickname: userData?.nickname || userData?.displayId || uniqueId,
                    avatar: avatarUrl,
                    lastSeen: Date.now()
                });
                
                // Solo log cada 10 usuarios para no saturar
                if (viewers.size % 10 === 0) {
                    console.log(`👥 Espectadores: ${viewers.size}`);
                }
                
                throttledBroadcastViewers();
            } else if (existing) {
                existing.lastSeen = Date.now();
            }
        } catch (e) {
            console.error('Error al procesar usuario:', e.message);
        }
    }
    
    // Evento de conexión exitosa
    tiktokConnection.on(WebcastEvent.CONNECTED, () => {
        console.log(`✅ Conexión establecida con @${username}`);
        broadcastStatus(true, `Connected to @${username}`, viewers.size);
        isReconnecting = false;
    });
    
    // Evento de desconexión - RECONEXIÓN INMEDIATA
    tiktokConnection.on(WebcastEvent.DISCONNECTED, (reason) => {
        console.log(`🔌 Desconectado: ${reason || 'No reason'} - Reconectando...`);
        broadcastStatus(false, `Disconnected - Reconnecting...`, viewers.size);
        
        // Reconexión inmediata
        if (!isReconnecting && currentUsername) {
            setTimeout(() => {
                reconnectToTikTok();
            }, 500);
        }
    });
    
    // Evento de error - RECONEXIÓN INMEDIATA
    tiktokConnection.on(WebcastEvent.ERROR, (error) => {
        console.error(`❌ Error: ${error.message || error}`);
        broadcastStatus(false, `Error: ${error.message} - Reconnecting...`, viewers.size);
        
        // Reconexión inmediata en caso de error
        if (!isReconnecting && currentUsername && tiktokConnection) {
            setTimeout(() => {
                reconnectToTikTok();
            }, 1000);
        }
    });
    
    // Datos de la sala - actualizar contador
    tiktokConnection.on(WebcastEvent.ROOM_USER_SEGMENT, (data) => {
        const count = data?.viewerCount || viewers.size;
        console.log(`📊 Live - Espectadores: ${count}`);
        broadcastStatus(true, `Live: ${count} viewers`, count);
        
        // Actualizar contador en el frontend
        const statusMsg = JSON.stringify({ 
            type: 'viewer_count', 
            count: count,
            viewers: viewers.size
        });
        clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                try {
                    client.send(statusMsg);
                } catch (e) {}
            }
        });
    });
    
    // Miembros
    tiktokConnection.on(WebcastEvent.MEMBER, (data) => {
        if (data?.user) addOrUpdateViewer(data.user);
    });
    
    // Usuario se une - actualización inmediata
    tiktokConnection.on(WebcastEvent.MEMBER_JOIN, (data) => {
        if (data?.user) {
            addOrUpdateViewer(data.user);
            // Log cada 50 joins para no saturar
            if (viewers.size % 50 === 0) {
                console.log(`➕ Nuevo espectador: @${data.user.uniqueId} - Total: ${viewers.size}`);
            }
        }
    });
    
    // Usuario se va - eliminar inmediatamente
    tiktokConnection.on(WebcastEvent.MEMBER_LEAVE, (data) => {
        const uniqueId = data?.user?.uniqueId;
        if (uniqueId && viewers.has(uniqueId)) {
            viewers.delete(uniqueId);
            console.log(`🚪 Salida: @${uniqueId} - Quedan: ${viewers.size}`);
            throttledBroadcastViewers();
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

// WebSocket para clientes
wss.on('connection', (ws) => {
    console.log('📱 Cliente conectado');
    clients.add(ws);
    
    // Enviar estado actual
    const isConnected = tiktokConnection && tiktokConnection.isConnected;
    ws.send(JSON.stringify({ 
        type: 'connection_status', 
        connected: isConnected,
        username: currentUsername,
        viewerCount: viewers.size,
        message: isConnected ? 'Connected' : 'Disconnected'
    }));
    
    // Enviar lista de espectadores
    const viewerList = Array.from(viewers.values())
        .slice(0, MAX_VIEWERS_LIMIT)
        .map(v => ({
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

// Endpoints
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

app.get('/disconnect', async (req, res) => {
    try {
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = null;
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
    }
});

app.get('/status', (req, res) => {
    res.json({ 
        connected: tiktokConnection?.isConnected || false,
        username: currentUsername,
        viewers: viewers.size,
        uptime: connectionStartTime ? Math.floor((Date.now() - connectionStartTime) / 1000) : 0
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Manejo de cierre graceful
process.on('SIGTERM', async () => {
    console.log('🛑 Cerrando servidor...');
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (tiktokConnection) {
        try {
            await tiktokConnection.disconnect();
        } catch (e) {}
    }
    server.close(() => process.exit(0));
});

server.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
    console.log(`⚙️ Configuración: Max viewers: ${MAX_VIEWERS_LIMIT}, Reconnect delay: ${RECONNECT_DELAY}ms`);
});
