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
let viewers = new Map(); // key: uniqueId, value: { username, nickname, avatar }

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

// Helper para normalizar la URL del avatar (si es relativa, la completamos)
function normalizeAvatarUrl(url) {
    if (!url) return null;
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    // Si comienza con '/', asumimos que es relativa al dominio de TikTok
    if (url.startsWith('/')) {
        return `https://www.tiktok.com${url}`;
    }
    // Si no, añadimos el dominio directamente
    return `https://www.tiktok.com/${url}`;
}

async function connectToTikTok(username) {
    if (tiktokConnection) {
        try { await tiktokConnection.disconnect(); } catch(e) {}
    }
    viewers.clear();

    // Usar TikTokLive en lugar de TikTokLiveConnection
    tiktokConnection = new TikTokLive(username, {
        enableExtendedGiftInfo: true,
        processInitialData: true
    });

    function addOrUpdateViewer(userData) {
        const uniqueId = userData.uniqueId;
        if (!uniqueId) return;

        // Log completo del objeto userData para inspeccionar
        console.log(`📦 Datos del usuario ${uniqueId}:`, JSON.stringify(userData, null, 2));

        // Buscamos el avatar en diferentes campos comunes
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
            console.log(`👥 Espectador actualizado: @${uniqueId} (${nickname})`);
            broadcastViewers();
        } else if (!existing) {
            viewers.set(uniqueId, {
                username: uniqueId,
                nickname: nickname,
                avatar: avatarUrl
            });
            console.log(`➕ Nuevo espectador: @${uniqueId} (${nickname})`);
            broadcastViewers();
        }
    }

    // Eventos con nombres correctos (sin guiones bajos)
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

    tiktokConnection.on(WebcastEvent.Chat, (data) => {
        console.log(`💬 Chat de ${data.user.uniqueId}: ${data.comment}`);
        addOrUpdateViewer(data.user);

        const comment = data.comment.trim();
        if (comment.toLowerCase().startsWith('!send')) {
            broadcastCommand(comment);
        }
    });

    // También podemos escuchar el evento 'connected' para saber cuándo está listo
    tiktokConnection.on(WebcastEvent.Connected, () => {
        console.log(`✅ Conectado al live de @${username}`);
        setTimeout(() => broadcastViewers(), 2000);
    });

    try {
        await tiktokConnection.connect();
        console.log(`🔄 Intentando conectar a @${username}...`);
    } catch (err) {
        console.error(`❌ Error de conexión a TikTok: ${err.message}`);
        // Intentar reconectar después de 5 segundos (opcional)
        setTimeout(() => connectToTikTok(username), 5000);
    }
}

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

app.get('/connect/:username', async (req, res) => {
    await connectToTikTok(req.params.username);
    res.json({ status: 'connected', username: req.params.username });
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
    res.json({ connected: tiktokConnection?.isConnected || false, viewers: viewers.size });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
