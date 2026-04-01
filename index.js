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

// Función para extraer la URL del avatar de los datos del usuario
function getAvatarUrl(user) {
    // Prioridades de búsqueda según la estructura real de tiktok-live-connector
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
    // Intentar obtener de user.profilePicture
    if (user.profilePicture) {
        return user.profilePicture;
    }
    // URL por defecto
    return null;
}

function broadcastViewers() {
    const viewerList = Array.from(viewers.values()).map(v => ({
        username: v.username,
        nickname: v.nickname,
        avatar: v.avatar
    }));
    const message = JSON.stringify({ type: 'viewers', data: viewerList });
    console.log(`📢 Enviando lista a ${clients.size} clientes:`, viewerList.map(v => ({ username: v.username, hasAvatar: !!v.avatar })));
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

async function connectToTikTok(username) {
    if (tiktokConnection) {
        try { await tiktokConnection.disconnect(); } catch(e) { console.log('Disconnect error:', e); }
    }
    viewers.clear();
    
    tiktokConnection = new TikTokLiveConnection(username, {
        enableExtendedGiftInfo: true,
        processInitialData: true,
        requestPollingIntervalMs: 2000
    });

    function addOrUpdateViewer(userData) {
        const uniqueId = userData.uniqueId;
        if (!uniqueId || uniqueId === username) return;
        
        const avatarUrl = getAvatarUrl(userData);
        const existing = viewers.get(uniqueId);
        
        // Actualizar si es nuevo o si encontramos avatar que no teníamos
        if (!existing || (existing.avatar === null && avatarUrl)) {
            viewers.set(uniqueId, {
                username: uniqueId,
                nickname: userData.nickname || userData.displayId || uniqueId,
                avatar: avatarUrl
            });
            console.log(`👥 ${existing ? 'Actualizado' : 'Nuevo'} espectador: @${uniqueId} (${userData.nickname || ''}) - Avatar: ${avatarUrl ? '✅' : '❌'}`);
            broadcastViewers();
        }
    }

    // Procesar datos iniciales del live (incluye lista de espectadores actuales)
    tiktokConnection.on(WebcastEvent.ROOM_USER_SEGMENT, (data) => {
        console.log('📊 Datos iniciales del live recibidos');
        if (data.viewerCount) {
            console.log(`👁️ Espectadores actuales: ${data.viewerCount}`);
        }
    });

    // Miembros actuales en la sala (si los hay)
    tiktokConnection.on(WebcastEvent.MEMBER, (data) => {
        if (data.user) {
            addOrUpdateViewer(data.user);
        }
    });

    // Unión de nuevo espectador
    tiktokConnection.on(WebcastEvent.MEMBER_JOIN, (data) => {
        console.log(`➕ JOIN: @${data.user?.uniqueId}`);
        if (data.user) addOrUpdateViewer(data.user);
    });

    // Salida de espectador
    tiktokConnection.on(WebcastEvent.MEMBER_LEAVE, (data) => {
        const uniqueId = data.user?.uniqueId;
        if (uniqueId && viewers.has(uniqueId)) {
            viewers.delete(uniqueId);
            console.log(`🚪 LEAVE: @${uniqueId}`);
            broadcastViewers();
        }
    });

    // Mensajes de chat
    tiktokConnection.on(WebcastEvent.CHAT, (data) => {
        if (data.user) addOrUpdateViewer(data.user);
        
        const comment = data.comment?.trim() || '';
        if (comment.toLowerCase().startsWith('!send')) {
            console.log(`📨 Comando detectado: ${comment}`);
            broadcastCommand(comment);
        }
    });

    try {
        await tiktokConnection.connect();
        console.log(`✅ Conectado al live de @${username}`);
        
        // Esperar un momento y luego pedir la lista actual
        setTimeout(() => {
            broadcastViewers();
        }, 3000);
        
    } catch (err) {
        console.error(`❌ Error de conexión: ${err.message}`);
    }
}

wss.on('connection', (ws) => {
    console.log('📱 Cliente frontend conectado');
    clients.add(ws);
    
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

app.get('/status', (req, res) => {
    res.json({ 
        connected: tiktokConnection?.isConnected || false, 
        viewers: viewers.size 
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));
