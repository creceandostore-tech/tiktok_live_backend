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
let isManualDisconnect = false;
let reconnectAttempts = 0;
let heartbeatInterval = null;
let lastActivity = Date.now();

// Configuración para alta capacidad
const MAX_VIEWERS_LIMIT = 5000; // Aumentado a 5000
const RECONNECT_DELAY = 3000;
const HEARTBEAT_INTERVAL = 15000;
const MAX_RECONNECT_ATTEMPTS = Infinity; // Reintentar infinitamente

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
    const viewerList = Array.from(viewers.values())
        .slice(0, MAX_VIEWERS_LIMIT)
        .map(v => ({
            username: v.username,
            nickname: v.nickname,
            avatar: v.avatar
        }));
    
    const message = JSON.stringify({ type: 'viewers', data: viewerList });
    
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(message);
            } catch (e) {}
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
        viewerCount: viewerCount || viewers.size,
        manualDisconnect: isManualDisconnect
    });
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(statusMsg);
            } catch (e) {}
        }
    });
}

function broadcastViewerCount(count) {
    const countMsg = JSON.stringify({ 
        type: 'viewer_count', 
        count: count,
        viewers: viewers.size
    });
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(countMsg);
            } catch (e) {}
        }
    });
}

function cleanupViewers() {
    // Limpiar espectadores antiguos solo si excedemos el límite
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

async function connectToTikTok(username) {
    username = username.replace(/^@/, '');
    
    if (!username || username.trim() === '') {
        console.error('❌ Username inválido');
        return;
    }
    
    // Guardar username para reconexiones
    currentUsername = username;
    
    // Limpiar reconexión manual si existe
    isManualDisconnect = false;
    
    // Desconectar conexión anterior si existe
    if (tiktokConnection) {
        try {
            console.log('🔌 Desconectando conexión anterior...');
            await tiktokConnection.disconnect();
        } catch (e) {
            console.log('Error al desconectar:', e.message);
        }
        tiktokConnection = null;
    }
    
    // Limpiar heartbeats
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
    
    console.log(`🔌 Conectando a TikTok Live: @${username} (Modo persistente)`);
    broadcastStatus(false, `Connecting to @${username}...`);
    
    try {
        // Crear conexión con opciones optimizadas para alta carga
        tiktokConnection = new TikTokLiveConnection(username, {
            enableExtendedGiftInfo: false,
            processInitialData: true,
            requestPollingIntervalMs: 5000, // Mayor intervalo para reducir carga
            websocketTimeout: 120000, // Timeout de 2 minutos
            enableWebsocketUpgrade: true,
            fetchChatMessages: true,
            fetchGiftMessages: false,
            fetchMemberMessages: true,
            fetchLikeMessages: false,
            fetchPollMessages: false,
            fetchQuestionMessages: false
        });
        
        // Configurar eventos
        setupEventHandlers(username);
        
        // Conectar
        await tiktokConnection.connect();
        
        console.log(`✅ Conectado exitosamente a @${username}`);
        broadcastStatus(true, `Connected to @${username}`, viewers.size);
        reconnectAttempts = 0;
        lastActivity = Date.now();
        
        // Iniciar heartbeat para mantener conexión
        heartbeatInterval = setInterval(() => {
            if (isManualDisconnect) {
                return;
            }
            
            if (tiktokConnection && tiktokConnection.isConnected) {
                try {
                    if (tiktokConnection.socket && tiktokConnection.socket.readyState === 1) {
                        tiktokConnection.socket.ping();
                        console.log('💓 Heartbeat enviado - Conexión activa');
                        lastActivity = Date.now();
                    }
                } catch (e) {
                    console.log('Heartbeat error:', e.message);
                }
            } else if (tiktokConnection && !tiktokConnection.isConnected && !isManualDisconnect) {
                console.log('⚠️ Conexión detectada como inactiva, forzando reconexión...');
                reconnectToTikTok();
            }
        }, HEARTBEAT_INTERVAL);
        
        // Limpiar espectadores antiguos cada 2 minutos
        setInterval(() => {
            if (!isManualDisconnect) {
                cleanupViewers();
            }
        }, 120000);
        
    } catch (err) {
        console.error(`❌ Error de conexión: ${err.message}`);
        broadcastStatus(false, `Connection failed: ${err.message}`);
        tiktokConnection = null;
        
        // Reconectar automáticamente si no es desconexión manual
        if (!isManualDisconnect) {
            console.log(`🔄 Programando reconexión en ${RECONNECT_DELAY/1000}s...`);
            setTimeout(() => {
                reconnectToTikTok();
            }, RECONNECT_DELAY);
        }
    }
}

async function reconnectToTikTok() {
    // No reconectar si es desconexión manual
    if (isManualDisconnect) {
        console.log('🔒 Desconexión manual activa, no se reconectará');
        return;
    }
    
    if (!currentUsername) {
        console.log('❌ No hay username para reconectar');
        return;
    }
    
    reconnectAttempts++;
    console.log(`🔄 Intento de reconexión #${reconnectAttempts} para @${currentUsername}...`);
    broadcastStatus(false, `Reconnecting... (Attempt ${reconnectAttempts})`);
    
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
    
    // Esperar antes de reconectar
    await new Promise(resolve => setTimeout(resolve, RECONNECT_DELAY));
    
    try {
        await connectToTikTok(currentUsername);
    } catch (err) {
        console.error('Error en reconexión:', err.message);
        // Seguir intentando indefinidamente
        if (!isManualDisconnect) {
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
    let joinQueue = [];
    let leaveQueue = [];
    
    function throttledBroadcastViewers() {
        const now = Date.now();
        if (now - lastBroadcastTime >= 2000) { // Reducido a 2 segundos para mejor rendimiento
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
            }, 2000 - (now - lastBroadcastTime));
        }
    }
    
    function addOrUpdateViewer(userData) {
        try {
            const uniqueId = userData?.uniqueId;
            if (!uniqueId || uniqueId === username) return;
            
            // Si excede el límite, no agregar más
            if (viewers.size >= MAX_VIEWERS_LIMIT && !viewers.has(uniqueId)) {
                return;
            }
            
            const avatarUrl = getAvatarUrl(userData);
            const existing = viewers.get(uniqueId);
            
            if (!existing) {
                viewers.set(uniqueId, {
                    username: uniqueId,
                    nickname: userData?.nickname || userData?.displayId || uniqueId,
                    avatar: avatarUrl,
                    joinedAt: Date.now()
                });
                
                // Log cada 100 usuarios para no saturar consola
                if (viewers.size % 100 === 0) {
                    console.log(`👥 Espectadores actuales: ${viewers.size}`);
                }
                
                throttledBroadcastViewers();
                broadcastViewerCount(viewers.size);
            } else if (existing.avatar === null && avatarUrl) {
                existing.avatar = avatarUrl;
                throttledBroadcastViewers();
            }
        } catch (e) {
            console.error('Error al procesar usuario:', e.message);
        }
    }
    
    function removeViewer(uniqueId) {
        if (uniqueId && viewers.has(uniqueId)) {
            const viewer = viewers.get(uniqueId);
            viewers.delete(uniqueId);
            console.log(`🚪 SALIDA: @${uniqueId} abandonó - Quedan: ${viewers.size}`);
            throttledBroadcastViewers();
            broadcastViewerCount(viewers.size);
        }
    }
    
    // Evento de conexión exitosa
    tiktokConnection.on(WebcastEvent.CONNECTED, () => {
        console.log(`✅ Conexión establecida con @${username}`);
        broadcastStatus(true, `Connected to @${username}`, viewers.size);
    });
    
    // Evento de desconexión - SOLO reconectar si no es manual
    tiktokConnection.on(WebcastEvent.DISCONNECTED, (reason) => {
        console.log(`🔌 Desconectado de @${username}: ${reason || 'Razón desconocida'}`);
        broadcastStatus(false, `Disconnected: ${reason || 'Connection lost'}`, viewers.size);
        
        // NO perder los espectadores actuales, mantener la lista
        // Solo reconectar si no es desconexión manual
        if (!isManualDisconnect && currentUsername) {
            console.log('🔄 Iniciando reconexión automática...');
            setTimeout(() => {
                reconnectToTikTok();
            }, 2000);
        } else if (isManualDisconnect) {
            console.log('🔒 Desconexión manual - No se reconectará');
        }
    });
    
    // Evento de error - RECONEXIÓN AUTOMÁTICA sin perder datos
    tiktokConnection.on(WebcastEvent.ERROR, (error) => {
        console.error(`❌ Error en conexión: ${error.message || error}`);
        broadcastStatus(false, `Error: ${error.message} - Reconnecting...`, viewers.size);
        
        // Mantener la lista de espectadores actuales
        if (!isManualDisconnect && currentUsername && tiktokConnection) {
            console.log('🔄 Error detectado, reconectando automáticamente...');
            setTimeout(() => {
                reconnectToTikTok();
            }, 3000);
        }
    });
    
    // Datos de la sala
    tiktokConnection.on(WebcastEvent.ROOM_USER_SEGMENT, (data) => {
        const count = data?.viewerCount || viewers.size;
        console.log(`📊 Live - Espectadores reportados: ${count} | Nuestro registro: ${viewers.size}`);
        broadcastStatus(true, `Live: ${count} viewers`, count);
        broadcastViewerCount(count);
    });
    
    // Miembros existentes
    tiktokConnection.on(WebcastEvent.MEMBER, (data) => {
        if (data?.user) addOrUpdateViewer(data.user);
    });
    
    // USUARIO SE UNE AL LIVE
    tiktokConnection.on(WebcastEvent.MEMBER_JOIN, (data) => {
        if (data?.user) {
            console.log(`➕ ENTRADA: @${data.user.uniqueId} se unió al live`);
            addOrUpdateViewer(data.user);
        }
    });
    
    // USUARIO SALE DEL LIVE - ELIMINAR INMEDIATAMENTE
    tiktokConnection.on(WebcastEvent.MEMBER_LEAVE, (data) => {
        const uniqueId = data?.user?.uniqueId;
        if (uniqueId) {
            removeViewer(uniqueId);
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
        viewerCount: viewers.size,
        message: isConnected ? 'Connected' : isManualDisconnect ? 'Manually disconnected' : 'Disconnected'
    }));
    
    // Enviar lista de espectadores actual
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

// Endpoint para conectar
app.get('/connect/:username', async (req, res) => {
    try {
        const username = req.params.username;
        console.log(`📡 Solicitud de conexión para: ${username}`);
        isManualDisconnect = false;
        await connectToTikTok(username);
        res.json({ status: 'connected', username: username });
    } catch (err) {
        console.error('Error en /connect:', err);
        res.json({ status: 'error', error: err.message });
    }
});

// Endpoint para desconectar MANUALMENTE
app.get('/disconnect', async (req, res) => {
    try {
        console.log('🔌 Desconexión manual solicitada');
        isManualDisconnect = true;
        
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = null;
        }
        
        if (tiktokConnection) {
            await tiktokConnection.disconnect();
            tiktokConnection = null;
        }
        
        // Limpiar lista de espectadores SOLO en desconexión manual
        viewers.clear();
        currentUsername = null;
        
        broadcastViewers();
        broadcastStatus(false, 'Manually disconnected');
        
        console.log('✅ Desconectado manualmente');
        res.json({ status: 'disconnected' });
    } catch (err) {
        console.error('Error en desconexión:', err);
        res.json({ status: 'error', error: err.message });
    }
});

// Endpoint para resetear reconexión manual
app.get('/reset', (req, res) => {
    isManualDisconnect = false;
    console.log('🔄 Reset manual - Permitir reconexiones');
    res.json({ status: 'reset', manualDisconnect: false });
});

// Endpoint de estado
app.get('/status', (req, res) => {
    res.json({ 
        connected: tiktokConnection?.isConnected || false,
        username: currentUsername,
        viewers: viewers.size,
        maxViewers: MAX_VIEWERS_LIMIT,
        manualDisconnect: isManualDisconnect,
        reconnectAttempts: reconnectAttempts
    });
});

// Ruta principal
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
    console.log(`🔄 Modo persistente: Reconexión infinita hasta desconexión manual`);
});
