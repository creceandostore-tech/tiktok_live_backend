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
let viewers = new Map(); // key: username, value: { username, avatar, followers }

function broadcastViewers() {
    const viewerList = Array.from(viewers.values());
    const message = JSON.stringify({ type: 'viewers', data: viewerList });
    console.log(`📢 Enviando lista de espectadores (${viewerList.length}):`, viewerList.map(v => v.username));
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

    function extractUserInfo(user) {
        return {
            username: user.uniqueId,
            avatar: user.avatarMedium || user.avatarThumb || '',
            followers: user.followerCount || 0
        };
    }

    tiktokConnection.on(WebcastEvent.MEMBER_JOIN, (data) => {
        const info = extractUserInfo(data.user);
        if (info.username && !viewers.has(info.username)) {
            viewers.set(info.username, info);
            console.log(`👥 Nuevo espectador (join): @${info.username} | seguidores: ${info.followers} | avatar: ${info.avatar ? 'si' : 'no'}`);
            broadcastViewers();
        }
    });

    tiktokConnection.on(WebcastEvent.MEMBER_LEAVE, (data) => {
        const username = data.user.uniqueId;
        if (username && viewers.has(username)) {
            viewers.delete(username);
            console.log(`🚪 Espectador salió: @${username}`);
            broadcastViewers();
        }
    });

    tiktokConnection.on(WebcastEvent.CHAT, (data) => {
        const info = extractUserInfo(data.user);
        if (info.username) {
            if (!viewers.has(info.username)) {
                viewers.set(info.username, info);
                console.log(`➕ Añadido desde chat: @${info.username} | seguidores: ${info.followers} | avatar: ${info.avatar ? 'si' : 'no'}`);
                broadcastViewers();
            } else {
                // Actualizar datos si cambian
                const existing = viewers.get(info.username);
                if (existing.followers !== info.followers || existing.avatar !== info.avatar) {
                    viewers.set(info.username, { ...existing, ...info });
                    broadcastViewers();
                }
            }
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
    ws.send(JSON.stringify({ type: 'viewers', data: Array.from(viewers.values()) }));
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
            username,
            avatar: 'https://via.placeholder.com/44?text=?',
            followers: 0
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
