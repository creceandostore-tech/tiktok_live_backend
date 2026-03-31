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
let viewers = new Set(); // solo nombres de usuario

function broadcastViewers() {
    const viewerList = Array.from(viewers);
    const message = JSON.stringify({ type: 'viewers', data: viewerList });
    console.log(`📢 Enviando lista de espectadores (${viewerList.length}):`, viewerList);
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

    tiktokConnection.on(WebcastEvent.MEMBER_JOIN, (data) => {
        const uniqueId = data.user.uniqueId;
        if (uniqueId && !viewers.has(uniqueId)) {
            viewers.add(uniqueId);
            console.log(`👥 Nuevo espectador (join): @${uniqueId}`);
            broadcastViewers();
        }
    });

    tiktokConnection.on(WebcastEvent.MEMBER_LEAVE, (data) => {
        const uniqueId = data.user.uniqueId;
        if (uniqueId && viewers.has(uniqueId)) {
            viewers.delete(uniqueId);
            console.log(`🚪 Espectador salió: @${uniqueId}`);
            broadcastViewers();
        }
    });

    tiktokConnection.on(WebcastEvent.CHAT, (data) => {
        const uniqueId = data.user.uniqueId;
        if (uniqueId && !viewers.has(uniqueId)) {
            viewers.add(uniqueId);
            console.log(`➕ Añadido desde chat: @${uniqueId}`);
            broadcastViewers();
        }

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
    ws.send(JSON.stringify({ type: 'viewers', data: Array.from(viewers) }));
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
        viewers.add(username);
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
