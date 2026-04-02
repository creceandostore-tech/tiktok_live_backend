const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { TikTokLiveConnection, WebcastEvent } = require('tiktok-live-connector');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = 8080;

app.use(express.static(path.join(__dirname, 'public')));

let activeConnection = null;
let currentUsername = null;
let clients = new Set();
let gifters = new Map();

function broadcast(data) {
    clients.forEach(c => c.readyState === WebSocket.OPEN && c.send(JSON.stringify(data)));
}

async function connectToTikTok(username) {
    if (activeConnection) {
        activeConnection.disconnect();
    }
    
    currentUsername = username;
    activeConnection = new TikTokLiveConnection(username, {
        enableExtendedGiftInfo: true,
        processInitialData: false
    });
    
    activeConnection.on(WebcastEvent.CONNECTED, () => {
        console.log(`✅ Conectado a @${username}`);
        broadcast({ type: 'connection_status', connected: true, username });
    });
    
    activeConnection.on(WebcastEvent.GIFT, (data) => {
        const uniqueId = data.user.uniqueId;
        const giftName = data.gift.name;
        const diamonds = data.gift.diamondCount;
        
        console.log(`🎁 @${uniqueId} - ${giftName} (${diamonds}💎)`);
        
        // Actualizar gifters
        if (!gifters.has(uniqueId)) {
            gifters.set(uniqueId, { username: uniqueId, totalGifts: 0 });
        }
        const gifter = gifters.get(uniqueId);
        gifter.totalGifts += diamonds;
        
        broadcast({
            type: 'new_gift',
            data: { username: uniqueId, giftName, diamondCount: diamonds, totalGifts: gifter.totalGifts }
        });
    });
    
    activeConnection.on(WebcastEvent.DISCONNECTED, () => {
        console.log('🔌 Desconectado, reconectando en 5s...');
        setTimeout(() => connectToTikTok(username), 5000);
    });
    
    try {
        await activeConnection.connect();
    } catch (err) {
        console.error('Error:', err.message);
        setTimeout(() => connectToTikTok(username), 5000);
    }
}

// API Endpoints
app.get('/connect/:username', async (req, res) => {
    await connectToTikTok(req.params.username);
    res.json({ status: 'connected' });
});

app.get('/disconnect', (req, res) => {
    if (activeConnection) activeConnection.disconnect();
    res.json({ status: 'disconnected' });
});

app.get('/gifters', (req, res) => {
    res.json(Array.from(gifters.values()));
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
});

server.listen(PORT, () => {
    console.log(`🚀 Servidor en http://localhost:${PORT}`);
});
