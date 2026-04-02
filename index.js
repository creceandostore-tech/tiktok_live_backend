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
let donors = new Map();
let currentUsername = null;
let isManualDisconnect = false;

function broadcastDonors() {
    const donorList = Array.from(donors.values()).map(v => ({
        username: v.username,
        nickname: v.nickname,
        avatar: v.avatar,
        lastGift: v.lastGift
    }));
    const message = JSON.stringify({ type: 'donors', data: donorList, total: donorList.length });
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try { client.send(message); } catch(e) {}
        }
    });
    console.log(`📢 Donadores: ${donorList.length}`);
}

function broadcastGift(username, nickname, giftName, giftCount, avatar) {
    const message = JSON.stringify({ 
        type: 'gift', 
        username, 
        nickname, 
        giftName, 
        giftCount, 
        avatar 
    });
    console.log(`🎁 Enviando gift: ${username} - ${giftName} x${giftCount}`);
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try { client.send(message); } catch(e) {}
        }
    });
}

function broadcastStatus(connected, message = '') {
    const statusMsg = JSON.stringify({ 
        type: 'connection_status', 
        connected, 
        message, 
        username: currentUsername,
        donorCount: donors.size
    });
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try { client.send(statusMsg); } catch(e) {}
        }
    });
}

async function connectToTikTok(username) {
    username = username.replace(/^@/, '').trim();
    if (!username) return false;
    
    if (tiktokConnection) {
        try { await tiktokConnection.disconnect(); } catch(e) {}
        tiktokConnection = null;
    }
    
    currentUsername = username;
    console.log(`🔌 Conectando a @${username}...`);
    broadcastStatus(false, `Conectando a @${username}...`);
    
    try {
        tiktokConnection = new TikTokLiveConnection(username, {
            enableExtendedGiftInfo: true,
            processInitialData: true,
            requestPollingIntervalMs: 2000,
            websocketTimeout: 60000,
            fetchChatMessages: true,
            fetchGiftMessages: true,
            fetchMemberMessages: true,
            fetchLikeMessages: false
        });
        
        setupEventHandlers(username);
        await tiktokConnection.connect();
        
        console.log(`✅ Conectado a @${username}`);
        broadcastStatus(true, `Conectado a @${username}`);
        return true;
    } catch (err) {
        console.error(`❌ Error: ${err.message}`);
        broadcastStatus(false, `Error: ${err.message}`);
        tiktokConnection = null;
        return false;
    }
}

function setupEventHandlers(username) {
    if (!tiktokConnection) return;
    
    function addDonor(uniqueId, userData, giftName, giftCount) {
        try {
            let avatar = null;
            if (userData?.avatarThumbnail?.url) avatar = userData.avatarThumbnail.url;
            else if (userData?.avatarMedium?.url) avatar = userData.avatarMedium.url;
            else if (userData?.avatarLarge?.url) avatar = userData.avatarLarge.url;
            
            let nickname = userData?.nickname || userData?.displayId || uniqueId;
            
            donors.set(uniqueId, {
                username: uniqueId,
                nickname: nickname,
                avatar: avatar,
                lastGift: `${giftName} x${giftCount}`,
                lastSeen: Date.now()
            });
            
            console.log(`✅ DONADOR: @${uniqueId} (${nickname}) - ${giftName} x${giftCount}`);
            broadcastDonors();
            broadcastGift(uniqueId, nickname, giftName, giftCount, avatar);
            
        } catch(e) {
            console.error(`Error: ${e.message}`);
        }
    }
    
    // Evento principal de regalos
    tiktokConnection.on(WebcastEvent.GIFT, (data) => {
        if (data && data.user) {
            const userId = data.user.uniqueId;
            const giftName = data.giftName || 'Gift';
            const repeatCount = data.repeatCount || 1;
            console.log(`🎁 REGALO: @${userId} - ${giftName} x${repeatCount}`);
            addDonor(userId, data.user, giftName, repeatCount);
        }
    });
    
    tiktokConnection.on(WebcastEvent.CONNECTED, () => {
        console.log(`✅ Conectado`);
        broadcastStatus(true, `Conectado`);
    });
    
    tiktokConnection.on(WebcastEvent.DISCONNECTED, (reason) => {
        console.log(`🔌 Desconectado: ${reason}`);
        broadcastStatus(false, `Desconectado`);
        if (!isManualDisconnect) {
            setTimeout(() => connectToTikTok(currentUsername), 3000);
        }
    });
    
    tiktokConnection.on(WebcastEvent.ERROR, (error) => {
        console.error(`❌ Error: ${error.message}`);
    });
    
    tiktokConnection.on(WebcastEvent.ROOM_USER_SEGMENT, (data) => {
        console.log(`📊 Espectadores: ${data?.viewerCount || 0} | Donadores: ${donors.size}`);
    });
}

app.get('/search/:username', async (req, res) => {
    try {
        const username = req.params.username.replace(/^@/, '').trim();
        const donor = donors.get(username);
        res.json({
            username: username,
            nickname: donor?.nickname || username,
            avatar: donor?.avatar || null,
            found: !!donor
        });
    } catch (err) {
        res.json({ error: err.message });
    }
});

wss.on('connection', (ws) => {
    console.log('📱 Cliente conectado');
    clients.add(ws);
    
    ws.send(JSON.stringify({ 
        type: 'connection_status', 
        connected: tiktokConnection?.isConnected || false,
        username: currentUsername,
        donorCount: donors.size
    }));
    
    const donorList = Array.from(donors.values()).map(v => ({
        username: v.username,
        nickname: v.nickname,
        avatar: v.avatar,
        lastGift: v.lastGift
    }));
    ws.send(JSON.stringify({ type: 'donors', data: donorList, total: donorList.length }));
    
    ws.on('close', () => {
        console.log('📱 Cliente desconectado');
        clients.delete(ws);
    });
});

app.get('/connect/:username', async (req, res) => {
    try {
        const username = req.params.username;
        console.log(`📡 Conectar a: ${username}`);
        isManualDisconnect = false;
        await connectToTikTok(username);
        res.json({ status: 'connected', username: username });
    } catch (err) {
        res.json({ status: 'error', error: err.message });
    }
});

app.get('/disconnect', async (req, res) => {
    try {
        console.log('🔌 Desconexión manual');
        isManualDisconnect = true;
        if (tiktokConnection) await tiktokConnection.disconnect();
        tiktokConnection = null;
        donors.clear();
        currentUsername = null;
        broadcastDonors();
        broadcastStatus(false, 'Desconectado');
        res.json({ status: 'disconnected' });
    } catch (err) {
        res.json({ status: 'error', error: err.message });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
    console.log(`🚀 Servidor en puerto ${PORT}`);
    console.log(`🎁 Esperando regalos...`);
});
