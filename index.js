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
// Cambiamos de Set a Map para guardar más info del espectador
let viewers = new Map(); // key: uniqueId, value: { username, nickname, avatar }

function broadcastViewers() {
    // Convertir el Map a un array de objetos para enviar al frontend
    const viewerList = Array.from(viewers.values()).map(v => ({
        username: v.username,
        nickname: v.nickname,
        avatar: v.avatar || null   // Si no hay avatar, será null
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

async function connectToTikTok(username) {
    if (tiktokConnection) {
        try { await tiktokConnection.disconnect(); } catch(e) {}
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
        const existing = viewers.get(uniqueId);
        // Si ya existe y no tiene avatar, podemos actualizar si ahora tenemos uno
        if (!existing || (existing.avatar === null && userData.avatarThumbnail)) {
            viewers.set(uniqueId, {
                username: uniqueId,
                nickname: userData.nickname || uniqueId,
                avatar: userData.avatarThumbnail || userData.avatarMedium || null
            });
            console.log(`👥 Espectador actualizado: @${uniqueId} (${userData.nickname || ''})`);
            broadcastViewers();
        } else if (!existing) {
            viewers.set(uniqueId, {
                username: uniqueId,
                nickname: userData.nickname || uniqueId,
                avatar: userData.avatarThumbnail || userData.avatarMedium || null
            });
            console.log(`➕ Nuevo espectador: @${uniqueId} (${userData.nickname || ''})`);
            broadcastViewers();
        }
    }

    // Evento de unión al live
    tiktokConnection.on(WebcastEvent.MEMBER_JOIN, (data) => {
        addOrUpdateViewer(data.user);
    });

    // Evento de salida (si es que existe)
    tiktokConnection.on(WebcastEvent.MEMBER_LEAVE, (data) => {
        const uniqueId = data.user.uniqueId;
        if (uniqueId && viewers.has(uniqueId)) {
            viewers.delete(uniqueId);
            console.log(`🚪 Espectador salió: @${uniqueId}`);
            broadcastViewers();
        }
    });

    // Cada mensaje en el chat también añade al que escribe como espectador
    tiktokConnection.on(WebcastEvent.CHAT, (data) => {
        addOrUpdateViewer(data.user);

        const comment = data.comment.trim();
        if (comment.toLowerCase().startsWith('!send')) {
            broadcastCommand(comment);
        }
    });

    try {
        await tiktokConnection.connect();
        console.log(`✅ Conectado al live de @${username}`);
        setTimeout(() => broadcastViewers(), 2000);
    } catch (err) {
        console.error(`❌ Error: ${err.message}`);
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
    ws.on('close', () => {
        console.log('📱 Cliente frontend desconectado');
        clients.delete(ws);
    });
});

app.get('/connect/:username', async (req, res) => {
    await connectToTikTok(req.params.username);
    res.json({ status: 'connected', username: req.params.username });
});

// Endpoint para agregar espectador manualmente (prueba) - sin avatar
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
