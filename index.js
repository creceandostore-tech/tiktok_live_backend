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

function broadcastViewers() {
    const viewerList = Array.from(viewers.values()).map(v => ({
        username: v.username,
        nickname: v.nickname,
        avatar: v.avatar
    }));
    const message = JSON.stringify({ type: 'viewers', data: viewerList });
    console.log(`📢 Enviando a ${clients.size} clientes: ${viewerList.length} espectadores`);
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
    
    console.log(`🔌 Conectando a @${username}...`);
    
    tiktokConnection = new TikTokLiveConnection(username, {
        enableExtendedGiftInfo: true,
        processInitialData: true,
        requestPollingIntervalMs: 2000
    });

    function addOrUpdateViewer(userData) {
        const uniqueId = userData.uniqueId;
        if (!uniqueId) return;
        
        const existing = viewers.get(uniqueId);
        if (!existing) {
            viewers.set(uniqueId, {
                username: uniqueId,
                nickname: userData.nickname || uniqueId,
                avatar: null
            });
            console.log(`➕ Nuevo espectador: @${uniqueId}`);
            broadcastViewers();
        }
    }

    tiktokConnection.on(WebcastEvent.MEMBER_JOIN, (data) => {
        console.log(`➕ JOIN: @${data.user?.uniqueId}`);
        if (data.user) addOrUpdateViewer(data.user);
    });

    tiktokConnection.on(WebcastEvent.MEMBER_LEAVE, (data) => {
        const uniqueId = data.user?.uniqueId;
        if (uniqueId && viewers.has(uniqueId)) {
            viewers.delete(uniqueId);
            console.log(`🚪 LEAVE: @${uniqueId}`);
            broadcastViewers();
        }
    });

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
        setTimeout(() => broadcastViewers(), 3000);
    } catch (err) {
        console.error(`❌ Error de conexión: ${err.message}`);
    }
}

wss.on('connection', (ws) => {
    console.log('📱 Cliente conectado');
    clients.add(ws);
    
    const viewerList = Array.from(viewers.values()).map(v => ({
        username: v.username,
        nickname: v.nickname,
        avatar: v.avatar
    }));
    ws.send(JSON.stringify({ type: 'viewers', data: viewerList }));
    
    ws.on('close', () => {
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

server.listen(PORT, () => console.log(`🚀 Servidor en puerto ${PORT}`));
