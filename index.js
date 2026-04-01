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
let viewers = new Map(); // key: uniqueId, value: { username, nickname, avatar, avatarLarge, avatarMedium }

function broadcastViewers() {
    const viewerList = Array.from(viewers.values()).map(v => ({
        username: v.username,
        nickname: v.nickname,
        avatar: v.avatar || v.avatarMedium || v.avatarLarge || null
    }));
    const message = JSON.stringify({ type: 'viewers', data: viewerList });
    console.log(`📢 Enviando lista de espectadores a ${clients.size} clientes`);
    console.log(`👥 Espectadores con avatar: ${viewerList.filter(v => v.avatar).map(v => v.username).join(', ')}`);
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
        try { await tiktokConnection.disconnect(); } catch(e) { console.log('Error al desconectar:', e.message); }
    }
    viewers.clear();
    
    console.log(`🔌 Conectando a @${username}...`);
    
    tiktokConnection = new TikTokLiveConnection(username, {
        enableExtendedGiftInfo: true,
        processInitialData: true,
        enableWebsocketUpgrade: true,
        requestPollingIntervalMs: 2000,
        clientLanguage: 'es',
        sessionId: null
    });

    function extractBestAvatar(userData) {
        // Intentar obtener la mejor URL de avatar disponible
        let avatarUrl = null;
        
        // Prioridad: avatarLarge > avatarMedium > avatarThumbnail
        if (userData.avatarLarge && userData.avatarLarge !== '') {
            avatarUrl = userData.avatarLarge;
            console.log(`   📸 Avatar Large encontrado para ${userData.uniqueId}: ${avatarUrl.substring(0, 50)}...`);
        } else if (userData.avatarMedium && userData.avatarMedium !== '') {
            avatarUrl = userData.avatarMedium;
            console.log(`   📸 Avatar Medium encontrado para ${userData.uniqueId}: ${avatarUrl.substring(0, 50)}...`);
        } else if (userData.avatarThumbnail && userData.avatarThumbnail !== '') {
            avatarUrl = userData.avatarThumbnail;
            console.log(`   📸 Avatar Thumbnail encontrado para ${userData.uniqueId}: ${avatarUrl.substring(0, 50)}...`);
        } else if (userData.avatar && userData.avatar !== '') {
            avatarUrl = userData.avatar;
            console.log(`   📸 Avatar encontrado para ${userData.uniqueId}: ${avatarUrl.substring(0, 50)}...`);
        }
        
        // Si la URL es relativa, completarla
        if (avatarUrl && avatarUrl.startsWith('/')) {
            avatarUrl = 'https://www.tiktok.com' + avatarUrl;
        }
        
        return avatarUrl;
    }

    function addOrUpdateViewer(userData) {
        const uniqueId = userData.uniqueId;
        if (!uniqueId) return;
        
        const avatarUrl = extractBestAvatar(userData);
        
        const viewerInfo = {
            username: uniqueId,
            nickname: userData.nickname || userData.uniqueId,
            avatar: avatarUrl,
            avatarLarge: userData.avatarLarge || null,
            avatarMedium: userData.avatarMedium || null
        };
        
        const existing = viewers.get(uniqueId);
        if (!existing) {
            viewers.set(uniqueId, viewerInfo);
            console.log(`➕ NUEVO ESPECTADOR: @${uniqueId} (${viewerInfo.nickname})`);
            if (avatarUrl) {
                console.log(`   ✅ AVATAR REAL: ${avatarUrl}`);
            } else {
                console.log(`   ⚠️ No se pudo obtener avatar para @${uniqueId}`);
            }
            broadcastViewers();
        } else if (existing.avatar !== avatarUrl && avatarUrl) {
            // Actualizar si tenemos una mejor URL de avatar
            viewers.set(uniqueId, { ...existing, ...viewerInfo });
            console.log(`🔄 Actualizando avatar para @${uniqueId}: ${avatarUrl}`);
            broadcastViewers();
        }
    }

    // Evento de unión al live
    tiktokConnection.on(WebcastEvent.MEMBER_JOIN, (data) => {
        console.log(`👋 USUARIO SE UNIÓ: @${data.user.uniqueId}`);
        console.log(`   Datos completos del usuario:`, JSON.stringify(data.user, null, 2));
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
        console.log(`💬 CHAT de @${data.user.uniqueId}: ${data.comment}`);
        addOrUpdateViewer(data.user);

        const comment = data.comment.trim();
        if (comment.toLowerCase().startsWith('!send')) {
            broadcastCommand(comment);
        }
    });

    // Evento de regalos - también puede contener datos del usuario
    tiktokConnection.on(WebcastEvent.GIFT, (data) => {
        console.log(`🎁 REGALO de @${data.user.uniqueId}: ${data.giftName} x${data.repeatCount || 1}`);
        addOrUpdateViewer(data.user);
    });

    // Evento de datos de la sala - captura espectadores existentes
    tiktokConnection.on(WebcastEvent.ROOM_USER, (data) => {
        console.log(`📊 DATOS DE SALA: ${data.viewerCount || 0} espectadores en total`);
        if (data.topViewers && data.topViewers.length) {
            console.log(`   Top viewers: ${data.topViewers.map(v => v.user?.uniqueId).join(', ')}`);
            data.topViewers.forEach(viewer => {
                if (viewer.user) addOrUpdateViewer(viewer.user);
            });
        }
    });

    // Evento de like
    tiktokConnection.on(WebcastEvent.LIKE, (data) => {
        console.log(`❤️ LIKE de @${data.user.uniqueId} (${data.likeCount || 1} likes)`);
        addOrUpdateViewer(data.user);
    });

    // Evento de follow
    tiktokConnection.on(WebcastEvent.FOLLOW, (data) => {
        console.log(`➕ FOLLOW de @${data.user.uniqueId}`);
        addOrUpdateViewer(data.user);
    });

    // Evento de share
    tiktokConnection.on(WebcastEvent.SHARE, (data) => {
        console.log(`📤 SHARE de @${data.user.uniqueId}`);
        addOrUpdateViewer(data.user);
    });

    try {
        await tiktokConnection.connect();
        console.log(`✅ CONECTADO EXITOSAMENTE al live de @${username}`);
        
        // Esperar un momento para recibir datos iniciales
        setTimeout(() => {
            console.log(`📊 Estado actual: ${viewers.size} espectadores registrados`);
            broadcastViewers();
        }, 3000);
        
    } catch (err) {
        console.error(`❌ ERROR al conectar: ${err.message}`);
    }
}

wss.on('connection', (ws) => {
    console.log('📱 Cliente frontend conectado');
    clients.add(ws);
    
    // Enviar la lista actual inmediatamente
    const viewerList = Array.from(viewers.values()).map(v => ({
        username: v.username,
        nickname: v.nickname,
        avatar: v.avatar || v.avatarMedium || v.avatarLarge || null
    }));
    ws.send(JSON.stringify({ type: 'viewers', data: viewerList }));
    
    ws.on('close', () => {
        console.log('📱 Cliente frontend desconectado');
        clients.delete(ws);
    });
});

app.get('/connect/:username', async (req, res) => {
    await connectToTikTok(req.params.username);
    res.json({ status: 'connected', username: req.params.username });
});

app.get('/status', (req, res) => {
    const viewerList = Array.from(viewers.values()).map(v => ({
        username: v.username,
        nickname: v.nickname,
        hasAvatar: !!v.avatar
    }));
    res.json({ 
        connected: tiktokConnection?.isConnected || false, 
        viewers: viewers.size,
        viewersWithAvatar: viewerList.filter(v => v.hasAvatar).length,
        viewersList: viewerList
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));
