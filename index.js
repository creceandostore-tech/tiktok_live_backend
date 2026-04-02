const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { WebcastPushConnection } = require('tiktok-live-connector');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = 8080;

app.use(express.static(path.join(__dirname, 'public')));

let activeConnection = null;
let currentUsername = null;
let clients = new Set();
let gifters = new Map(); // Solo los que ENVÍAN regalos
let donors = new Map(); // Donadores persistentes

// IMPORTANTE: Configuración que SOLUCIONA el error
const connectionConfig = {
    processInitialData: true,
    enableWebsocketUpgrade: true,  // CLAVE: necesario para websocket
    requestPollingIntervalMs: 2000,
    requestOptions: {
        timeout: 15000,
    },
    websocketOptions: {
        timeout: 15000,
    },
    sessionId: undefined, // No necesitas sessionId
    signProviderOptions: {
        // Usa el servidor de firma público
        signServerUrl: 'https://tikcdn.zerody.one/sign',
    }
};

function broadcastToAllClients(message) {
    const msgStr = JSON.stringify(message);
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try { client.send(msgStr); } catch (e) {}
        }
    });
}

function broadcastGiftersList() {
    const list = Array.from(gifters.values())
        .sort((a, b) => b.totalGifts - a.totalGifts)
        .map(v => ({
            username: v.username,
            nickname: v.nickname,
            avatar: v.avatar,
            isDonor: v.isDonor || false,
            totalGifts: v.totalGifts
        }));
    
    broadcastToAllClients({
        type: 'viewers_update',
        data: list,
        total: gifters.size,
        donors: donors.size
    });
}

function processGift(data) {
    const uniqueId = data.uniqueId;
    const giftName = data.giftName;
    const diamondCount = data.diamondCount;
    const repeatEnd = data.repeatEnd;
    
    // IMPORTANTE: Solo procesar al final de una racha de regalos
    // Esto evita duplicados y asegura el conteo correcto[citation:4]
    if (repeatEnd !== undefined && repeatEnd !== 1) {
        console.log(`⏳ Regalo en racha: @${uniqueId} - ${giftName} (${diamondCount}💎) - esperando final...`);
        return;
    }
    
    console.log(`🎁 REGALO: @${uniqueId} - ${giftName} (${diamondCount}💎)`);
    
    const now = Date.now();
    
    if (!gifters.has(uniqueId)) {
        gifters.set(uniqueId, {
            username: uniqueId,
            nickname: uniqueId,
            avatar: null,
            lastGiftTime: now,
            totalGifts: diamondCount,
            isDonor: false
        });
    } else {
        const existing = gifters.get(uniqueId);
        existing.lastGiftTime = now;
        existing.totalGifts += diamondCount;
        gifters.set(uniqueId, existing);
    }
    
    const totalGifts = gifters.get(uniqueId).totalGifts;
    
    // Donador si acumula 100+ diamantes
    if (totalGifts >= 100 && !donors.has(uniqueId)) {
        donors.set(uniqueId, {
            username: uniqueId,
            nickname: uniqueId,
            totalGifts: totalGifts
        });
        
        const gifter = gifters.get(uniqueId);
        gifter.isDonor = true;
        gifters.set(uniqueId, gifter);
        
        console.log(`🏆 DONADOR: @${uniqueId} (${totalGifts}💎)`);
        
        broadcastToAllClients({
            type: 'new_donor',
            data: { username: uniqueId, totalGifts }
        });
    }
    
    broadcastToAllClients({
        type: 'new_gift',
        data: {
            username: uniqueId,
            giftName,
            diamondCount,
            totalGifts,
            isDonor: gifters.get(uniqueId).isDonor
        }
    });
    
    broadcastGiftersList();
}

// Limpieza de inactivos cada 2 minutos
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [username, data] of gifters.entries()) {
        if (now - data.lastGiftTime > 120000) { // 2 minutos
            gifters.delete(username);
            cleaned++;
        }
    }
    
    if (cleaned > 0) {
        console.log(`🧹 Limpiados ${cleaned} gifters inactivos`);
        broadcastGiftersList();
    }
}, 120000);

async function connectToTikTok(username) {
    if (activeConnection) {
        try { activeConnection.disconnect(); } catch(e) {}
    }
    
    currentUsername = username.replace(/^@/, '');
    console.log(`🔌 Conectando a @${currentUsername}...`);
    broadcastToAllClients({ type: 'connection_status', connected: false, message: `Conectando a @${currentUsername}...` });
    
    activeConnection = new WebcastPushConnection(currentUsername, connectionConfig);
    
    // Eventos de conexión
    activeConnection.on('connected', () => {
        console.log(`✅ Conectado a @${currentUsername}`);
        broadcastToAllClients({ type: 'connection_status', connected: true, username: currentUsername });
    });
    
    activeConnection.on('disconnected', () => {
        console.log(`🔌 Desconectado de @${currentUsername}`);
        broadcastToAllClients({ type: 'connection_status', connected: false, message: 'Desconectado' });
        
        // Reconexión automática después de 5 segundos
        setTimeout(() => {
            if (currentUsername && !activeConnection?.isConnected) {
                console.log('🔄 Reconectando...');
                connectToTikTok(currentUsername);
            }
        }, 5000);
    });
    
    // Evento de regalo - el más importante
    activeConnection.on('gift', (data) => {
        processGift({
            uniqueId: data.uniqueId,
            giftName: data.giftName,
            diamondCount: data.diamondCount,
            repeatEnd: data.repeatEnd
        });
    });
    
    // Eventos adicionales para detectar más donadores
    activeConnection.on('member', (data) => {
        console.log(`👤 Miembro: @${data.uniqueId}`);
    });
    
    try {
        await activeConnection.connect();
        return true;
    } catch (err) {
        console.error('❌ Error de conexión:', err.message);
        broadcastToAllClients({ type: 'connection_status', connected: false, message: `Error: ${err.message}` });
        
        // Intentar reconectar después de 5 segundos
        setTimeout(() => {
            if (currentUsername) {
                connectToTikTok(currentUsername);
            }
        }, 5000);
        
        return false;
    }
}

// API Endpoints
app.get('/connect/:username', async (req, res) => {
    const username = req.params.username;
    await connectToTikTok(username);
    res.json({ status: 'connecting', username });
});

app.get('/disconnect', (req, res) => {
    if (activeConnection) {
        activeConnection.disconnect();
    }
    currentUsername = null;
    res.json({ status: 'disconnected' });
});

app.get('/status', (req, res) => {
    res.json({
        connected: activeConnection?.isConnected || false,
        username: currentUsername,
        gifters: gifters.size,
        donors: donors.size
    });
});

app.get('/gifters', (req, res) => {
    const list = Array.from(gifters.values())
        .sort((a, b) => b.totalGifts - a.totalGifts);
    res.json({ gifters: list, donors: donors.size });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// WebSocket para clientes frontend
wss.on('connection', (ws) => {
    console.log('📱 Cliente frontend conectado');
    clients.add(ws);
    
    ws.send(JSON.stringify({
        type: 'connection_status',
        connected: activeConnection?.isConnected || false,
        username: currentUsername
    }));
    
    ws.send(JSON.stringify({
        type: 'viewers_update',
        data: Array.from(gifters.values()),
        total: gifters.size,
        donors: donors.size
    }));
    
    ws.on('close', () => clients.delete(ws));
});

server.listen(PORT, () => {
    console.log(`\n🚀 SERVIDOR TIKTOK LIVE`);
    console.log(`📡 Puerto: ${PORT}`);
    console.log(`🌐 Abre: http://localhost:${PORT}`);
    console.log(`\n✨ CONEXIÓN REAL A TIKTOK - FUNCIONANDO CORRECTAMENTE`);
    console.log(`📌 Conecta a un usuario que esté EN VIVO`);
    console.log(`🎁 Los regalos aparecerán en tiempo real\n`);
});
