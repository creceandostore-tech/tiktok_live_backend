const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { TikTokLive, WebcastEvent } = require('tiktok-live-connector');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 8080;
app.use(express.static(path.join(__dirname, 'public')));

const clients = new Set();
let tiktokConnection = null;
let viewers = new Map(); // uniqueId -> { username, nickname, avatar }
let reconnectTimer = null;

// ========== UTILIDADES ==========
function broadcastViewers() {
    const viewerList = Array.from(viewers.values()).map(v => ({
        username: v.username,
        nickname: v.nickname,
        avatar: v.avatar || null
    }));
    const message = JSON.stringify({ type: 'viewers', data: viewerList });
    console.log(`📢 Enviando lista de espectadores a ${clients.size} clientes:`, viewerList.map(v => v.username));
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

function normalizeAvatarUrl(url) {
    if (!url) return null;
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    if (url.startsWith('/')) return `https://www.tiktok.com${url}`;
    return `https://www.tiktok.com/${url}`;
}

function addOrUpdateViewer(userData) {
    const uniqueId = userData.uniqueId;
    if (!uniqueId) return;

    // Log para debug (opcional, puedes comentarlo después)
    console.log(`📦 Datos del usuario ${uniqueId}:`, JSON.stringify(userData, null, 2));

    let avatarUrl = null;
    if (userData.avatarThumbnail) avatarUrl = userData.avatarThumbnail;
    else if (userData.avatarMedium) avatarUrl = userData.avatarMedium;
    else if (userData.avatarLarge) avatarUrl = userData.avatarLarge;
    else if (userData.profilePicture) avatarUrl = userData.profilePicture;
    else if (userData.avatar) avatarUrl = userData.avatar;

    if (avatarUrl) {
        avatarUrl = normalizeAvatarUrl(avatarUrl);
        console.log(`🖼️ Avatar de ${uniqueId}: ${avatarUrl}`);
    } else {
        console.log(`⚠️ No se encontró avatar para ${uniqueId}`);
    }

    const nickname = userData.nickname || userData.uniqueId;
    const existing = viewers.get(uniqueId);
    if (!existing || (existing.avatar === null && avatarUrl)) {
        viewers.set(uniqueId, {
            username: uniqueId,
            nickname: nickname,
            avatar: avatarUrl
        });
        console.log(`👥 Espectador actualizado/agregado: @${uniqueId} (${nickname})`);
        broadcastViewers();
    }
}

// ========== CONEXIÓN A TIKTOK ==========
async function connectToTikTok(username) {
    if (tiktokConnection) {
        try {
            await tiktokConnection.disconnect();
            console.log('🔌 Conexión anterior cerrada');
        } catch (e) {}
    }
    if (reconnectTimer) clearTimeout(reconnectTimer);
    viewers.clear();

    console.log(`🔄 Intentando conectar al live de @${username}...`);

    try {
        tiktokConnection = new TikTokLive(username, {
            enableExtendedGiftInfo: true,
            processInitialData: true,
            requestOptions: { timeout: 10000 }
        });

        tiktokConnection.on(WebcastEvent.Connected, () => {
            console.log(`✅ CONECTADO al live de @${username}`);
            broadcastViewers();
        });

        tiktokConnection.on(WebcastEvent.Error, (err) => {
            console.error(`❌ Error de TikTok:`, err.message || err);
        });

        tiktokConnection.on(WebcastEvent.Chat, (data) => {
            console.log(`💬 [${data.user.uniqueId}]: ${data.comment}`);
            addOrUpdateViewer(data.user);
            const comment = data.comment.trim();
            if (comment.toLowerCase().startsWith('!send')) {
                broadcastCommand(comment);
            }
        });

        tiktokConnection.on(WebcastEvent.MemberJoin, (data) => {
            console.log(`👋 Miembro unido: ${data.user.uniqueId}`);
            addOrUpdateViewer(data.user);
        });

        tiktokConnection.on(WebcastEvent.MemberLeave, (data) => {
            const uniqueId = data.user.uniqueId;
            if (uniqueId && viewers.has(uniqueId)) {
                viewers.delete(uniqueId);
                console.log(`🚪 Espectador salió: @${uniqueId}`);
                broadcastViewers();
            }
        });

        await tiktokConnection.connect();
        console.log(`🔄 Conectando a @${username}... (esperando eventos)`);

    } catch (err) {
        console.error(`❌ Error fatal al conectar a TikTok:`, err.message);
        reconnectTimer = setTimeout(() => {
            console.log(`🔄 Reintentando conexión a @${username}...`);
            connectToTikTok(username);
        }, 10000);
    }
}

// ========== WEBSOCKET ==========
wss.on('connection', (ws) => {
    console.log('📱 Cliente frontend conectado');
    clients.add(ws);
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

// ========== ENDPOINTS ==========
app.get('/connect/:username', async (req, res) => {
    await connectToTikTok(req.params.username);
    res.json({ status: 'connecting', username: req.params.username });
});

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
        connected: tiktokConnection ? true : false,
        viewers: viewers.size
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`));
