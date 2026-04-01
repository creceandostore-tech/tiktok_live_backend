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
let viewers = new Map(); // key: uniqueId, value: { username, nickname, avatar }

// Función para enviar lista de espectadores a todos los clientes
function broadcastViewers() {
    const viewerList = Array.from(viewers.values()).map(v => ({
        username: v.username,
        nickname: v.nickname,
        avatar: v.avatar || null
    }));
    
    const message = JSON.stringify({ type: 'viewers', data: viewerList });
    console.log(`📢 Enviando lista de espectadores a ${clients.size} clientes:`, viewerList.map(v => v.username));
    
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

function broadcastCommand(command) {
    const message = JSON.stringify({ type: 'command', command });
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(message);
    });
}

async function connectToTikTok(username) {
    if (tiktokConnection) {
        try { 
            await tiktokConnection.disconnect(); 
        } catch(e) {
            console.log('Error al desconectar:', e.message);
        }
    }
    
    viewers.clear();
    
    tiktokConnection = new TikTokLiveConnection(username, {
        enableExtendedGiftInfo: true,
        processInitialData: true
    });

    // Helper para añadir o actualizar espectador con sus datos completos
    function addOrUpdateViewer(userData) {
        const uniqueId = userData.uniqueId;
        if (!uniqueId) return;
        
        // Extraer la mejor URL de avatar disponible
        let avatarUrl = null;
        if (userData.avatarThumbnail) avatarUrl = userData.avatarThumbnail;
        if (userData.avatarMedium) avatarUrl = userData.avatarMedium;
        if (userData.avatarLarge) avatarUrl = userData.avatarLarge;
        
        const existing = viewers.get(uniqueId);
        
        // Actualizar si no existe o si no tenía avatar y ahora tenemos uno
        if (!existing || (existing.avatar === null && avatarUrl)) {
            viewers.set(uniqueId, {
                username: uniqueId,
                nickname: userData.nickname || uniqueId,
                avatar: avatarUrl
            });
            
            const action = existing ? 'actualizado' : 'nuevo';
            console.log(`👥 Espectador ${action}: @${uniqueId} (${userData.nickname || ''}) ${avatarUrl ? 'con avatar ✓' : 'sin avatar'}`);
            broadcastViewers();
        }
    }

    // Evento de unión al live
    tiktokConnection.on(WebcastEvent.MEMBER_JOIN, (data) => {
        console.log(`🎉 Nuevo espectador se unió: @${data.user.uniqueId}`);
        addOrUpdateViewer(data.user);
    });

    // Evento de salida
    tiktokConnection.on(WebcastEvent.MEMBER_LEAVE, (data) => {
        const uniqueId = data.user.uniqueId;
        if (uniqueId && viewers.has(uniqueId)) {
            viewers.delete(uniqueId);
            console.log(`🚪 Espectador salió: @${uniqueId}`);
            broadcastViewers();
        }
    });

    // Evento de chat
    tiktokConnection.on(WebcastEvent.CHAT, (data) => {
        addOrUpdateViewer(data.user);

        const comment = data.comment.trim();
        if (comment.toLowerCase().startsWith('!send')) {
            broadcastCommand(comment);
        }
    });

    // Evento de regalo (también puede proporcionar información del usuario)
    tiktokConnection.on(WebcastEvent.GIFT, (data) => {
        addOrUpdateViewer(data.user);
        console.log(`🎁 Regalo de @${data.user.uniqueId}: ${data.gift.name}`);
    });

    // Evento de like
    tiktokConnection.on(WebcastEvent.LIKE, (data) => {
        addOrUpdateViewer(data.user);
    });

    // Evento de seguimiento
    tiktokConnection.on(WebcastEvent.FOLLOW, (data) => {
        addOrUpdateViewer(data.user);
        console.log(`❤️ Nuevo seguidor: @${data.user.uniqueId}`);
    });

    // Evento de compartir
    tiktokConnection.on(WebcastEvent.SHARE, (data) => {
        addOrUpdateViewer(data.user);
    });

    try {
        await tiktokConnection.connect();
        console.log(`✅ Conectado al live de @${username}`);
        
        // Esperar un momento para que se procesen los datos iniciales
        setTimeout(() => {
            broadcastViewers();
            console.log(`📊 Estado actual: ${viewers.size} espectadores registrados`);
        }, 3000);
        
    } catch (err) {
        console.error(`❌ Error de conexión: ${err.message}`);
        // Intentar reconectar después de 10 segundos en caso de error
        setTimeout(() => {
            if (!tiktokConnection?.isConnected) {
                console.log(`🔄 Intentando reconectar a @${username}...`);
                connectToTikTok(username);
            }
        }, 10000);
    }
}

wss.on('connection', (ws) => {
    console.log('📱 Cliente frontend conectado');
    clients.add(ws);
    
    // Enviar la lista actual inmediatamente al nuevo cliente
    const viewerList = Array.from(viewers.values()).map(v => ({
        username: v.username,
        nickname: v.nickname,
        avatar: v.avatar
    }));
    
    ws.send(JSON.stringify({ type: 'viewers', data: viewerList }));
    
    // Enviar mensaje de confirmación de conexión
    ws.send(JSON.stringify({ type: 'connection', status: 'connected' }));
    
    ws.on('close', () => {
        console.log('📱 Cliente frontend desconectado');
        clients.delete(ws);
    });
    
    ws.on('error', (error) => {
        console.error('Error en WebSocket:', error);
    });
});

app.get('/connect/:username', async (req, res) => {
    await connectToTikTok(req.params.username);
    res.json({ status: 'connected', username: req.params.username });
});

// Endpoint para agregar espectador manualmente (para pruebas)
app.get('/addviewer/:username', (req, res) => {
    const username = req.params.username;
    if (username && !viewers.has(username)) {
        viewers.set(username, {
            username: username,
            nickname: username,
            avatar: null
        });
        broadcastViewers();
        res.json({ status: 'added', username });
    } else {
        res.json({ status: 'already exists or invalid', username });
    }
});

app.get('/status', (req, res) => {
    res.json({ 
        connected: tiktokConnection?.isConnected || false, 
        viewers: viewers.size,
        viewersList: Array.from(viewers.keys())
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
    console.log(`📱 Accede en: http://localhost:${PORT}`);
});
