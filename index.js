const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { TikTokLiveConnection, WebcastEvent } = require('tiktok-live-connector');
const path = require('path');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, 'public')));

const clients = new Set();
let tiktokConnection = null;
let viewers = new Map();

// Proxy para imágenes
app.get('/avatar', async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).send('No URL');
    
    try {
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        res.set('Content-Type', response.headers['content-type']);
        res.send(response.data);
    } catch (error) {
        res.status(404).send('Error');
    }
});

function broadcastViewers() {
    const list = Array.from(viewers.values()).map(v => ({
        username: v.username,
        nickname: v.nickname,
        avatar: v.avatar ? `/avatar?url=${encodeURIComponent(v.avatar)}` : null
    }));
    
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'viewers', data: list }));
        }
    });
}

function broadcastCommand(command) {
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'command', command }));
        }
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
        if (data.user && data.user.uniqueId) {
            const userId = data.user.uniqueId;
            if (!viewers.has(userId)) {
                viewers.set(userId, {
                    username: userId,
                    nickname: data.user.nickname || userId,
                    avatar: data.user.avatarThumbnail || data.user.avatarMedium || null
                });
                broadcastViewers();
            }
        }
    });

    tiktokConnection.on(WebcastEvent.CHAT, (data) => {
        if (data.user && data.user.uniqueId) {
            const userId = data.user.uniqueId;
            if (!viewers.has(userId)) {
                viewers.set(userId, {
                    username: userId,
                    nickname: data.user.nickname || userId,
                    avatar: data.user.avatarThumbnail || data.user.avatarMedium || null
                });
                broadcastViewers();
            }
        }
        
        const comment = data.comment ? data.comment.trim() : '';
        if (comment.toLowerCase().startsWith('!send')) {
            broadcastCommand(comment);
        }
    });

    try {
        await tiktokConnection.connect();
        console.log(`✅ Conectado a @${username}`);
    } catch (err) {
        console.error(`❌ Error: ${err.message}`);
    }
}

wss.on('connection', (ws) => {
    clients.add(ws);
    
    const list = Array.from(viewers.values()).map(v => ({
        username: v.username,
        nickname: v.nickname,
        avatar: v.avatar ? `/avatar?url=${encodeURIComponent(v.avatar)}` : null
    }));
    ws.send(JSON.stringify({ type: 'viewers', data: list }));
    
    ws.on('close', () => clients.delete(ws));
});

app.get('/connect/:username', async (req, res) => {
    await connectToTikTok(req.params.username);
    res.json({ status: 'connected', username: req.params.username });
});

app.get('/status', (req, res) => {
    res.json({ 
        connected: tiktokConnection?.isConnected || false,
        viewers: viewers.size
    });
});

app.get('/addtest/:username', (req, res) => {
    const username = req.params.username;
    if (!viewers.has(username)) {
        viewers.set(username, {
            username: username,
            nickname: username,
            avatar: `https://ui-avatars.com/api/?background=fe2c55&color=fff&size=100&name=${username}`
        });
        broadcastViewers();
    }
    res.json({ status: 'ok' });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
    console.log(`🚀 Servidor en http://localhost:${PORT}`);
});
