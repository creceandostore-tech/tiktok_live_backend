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
let gifters = new Map(); // Todos los que envían regalos
let donors = new Map(); // Donadores persistentes

// Configuración básica que funciona
const config = {
    processInitialData: false,
    enableExtendedGiftInfo: true,
    enableWebsocketUpgrade: true,
    requestPollingIntervalMs: 2000
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

// Procesar regalo
function processGift(giftEvent) {
    try {
        const uniqueId = giftEvent.uniqueId;
        const giftName = giftEvent.giftName || 'Regalo';
        const diamondCount = giftEvent.diamondCount || 1;
        
        console.log(`🎁 REGALO: @${uniqueId} - ${giftName} (${diamondCount}💎)`);
        
        const now = Date.now();
        
        if (!gifters.has(uniqueId)) {
            gifters.set(uniqueId, {
                username: uniqueId,
                nickname: uniqueId,
                lastGiftTime: now,
                totalGifts: diamondCount,
                isDonor: false
            });
            console.log(`✨ NUEVO GIFTER: @${uniqueId}`);
        } else {
            const existing = gifters.get(uniqueId);
            existing.lastGiftTime = now;
            existing.totalGifts += diamondCount;
            gifters.set(uniqueId, existing);
            console.log(`🔄 ACTUALIZADO: @${uniqueId} - Total: ${existing.totalGifts}💎`);
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
                data: { username: uniqueId, totalGifts: totalGifts }
            });
        }
        
        // Notificar regalo
        broadcastToAllClients({
            type: 'new_gift',
            data: {
                username: uniqueId,
                giftName: giftName,
                diamondCount: diamondCount,
                totalGifts: totalGifts,
                isDonor: gifters.get(uniqueId).isDonor
            }
        });
        
        broadcastGiftersList();
        
    } catch (error) {
        console.error('Error en processGift:', error);
    }
}

// Limpiar inactivos cada 2 minutos
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [username, data] of gifters.entries()) {
        if (now - data.lastGiftTime > 120000) {
            gifters.delete(username);
            cleaned++;
            console.log(`🗑️ Eliminado @${username} (inactivo)`);
        }
    }
    if (cleaned > 0) {
        console.log(`🧹 Limpiados ${cleaned} gifters inactivos`);
        broadcastGiftersList();
    }
}, 120000);

// Conectar a TikTok LIVE
async function connectToTikTok(username) {
    if (activeConnection) {
        try { activeConnection.disconnect(); } catch(e) {}
        activeConnection = null;
    }
    
    currentUsername = username.replace(/^@/, '').trim();
    console.log(`\n🔌 Conectando a @${currentUsername}...`);
    
    broadcastToAllClients({
        type: 'connection_status',
        connected: false,
        message: `Conectando a @${currentUsername}...`
    });
    
    try {
        activeConnection = new WebcastPushConnection(currentUsername, config);
        
        // Evento de conexión exitosa
        activeConnection.on('connected', (state) => {
            console.log(`✅ CONECTADO a @${currentUsername} - Room ID: ${state.roomId}`);
            broadcastToAllClients({
                type: 'connection_status',
                connected: true,
                username: currentUsername,
                message: `Conectado a @${currentUsername}`
            });
        });
        
        // EVENTO DE REGALO - El importante
        activeConnection.on('gift', (data) => {
            console.log(`📦 GIFT EVENT RECEIVED:`, JSON.stringify(data, null, 2));
            processGift(data);
        });
        
        // Desconexión con reconexión automática
        activeConnection.on('disconnected', () => {
            console.log(`🔌 Desconectado de @${currentUsername}`);
            broadcastToAllClients({
                type: 'connection_status',
                connected: false,
                message: 'Desconectado - Reconectando...'
            });
            
            setTimeout(() => {
                if (currentUsername) {
                    console.log('🔄 Reconectando...');
                    connectToTikTok(currentUsername);
                }
            }, 5000);
        });
        
        // Errores
        activeConnection.on('error', (err) => {
            console.error(`❌ Error: ${err.message}`);
            broadcastToAllClients({
                type: 'connection_status',
                connected: false,
                message: `Error: ${err.message}`
            });
        });
        
        // También escuchamos chat para debug
        activeConnection.on('chat', (data) => {
            console.log(`💬 Chat: @${data.uniqueId}: ${data.comment}`);
        });
        
        // Conectar
        await activeConnection.connect();
        console.log(`🎧 Escuchando eventos...`);
        return true;
        
    } catch (err) {
        console.error(`❌ ERROR de conexión: ${err.message}`);
        broadcastToAllClients({
            type: 'connection_status',
            connected: false,
            message: `Error: ${err.message}`
        });
        
        setTimeout(() => {
            if (currentUsername) {
                connectToTikTok(currentUsername);
            }
        }, 5000);
        
        return false;
    }
}

// ============ API ENDPOINTS ============

app.get('/connect/:username', async (req, res) => {
    const username = req.params.username;
    console.log(`\n📡 CONECTANDO A: ${username}`);
    await connectToTikTok(username);
    res.json({ status: 'connecting', username });
});

app.get('/disconnect', (req, res) => {
    console.log(`\n🔌 DESCONECTANDO`);
    if (activeConnection) {
        activeConnection.disconnect();
    }
    currentUsername = null;
    res.json({ status: 'disconnected' });
});

app.get('/status', (req, res) => {
    const totalGifts = Array.from(gifters.values()).reduce((sum, g) => sum + g.totalGifts, 0);
    res.json({
        connected: activeConnection?.isConnected || false,
        username: currentUsername,
        gifters: gifters.size,
        donors: donors.size,
        totalGifts: totalGifts
    });
});

app.get('/gifters', (req, res) => {
    const list = Array.from(gifters.values()).sort((a, b) => b.totalGifts - a.totalGifts);
    res.json({ gifters: list, donors: donors.size });
});

app.get('/search/:username', (req, res) => {
    const username = req.params.username.replace(/^@/, '').trim();
    const gifter = gifters.get(username);
    res.json({
        username: username,
        found: !!gifter,
        totalGifts: gifter?.totalGifts || 0,
        isDonor: gifter?.isDonor || false
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// WebSocket
wss.on('connection', (ws) => {
    console.log('📱 Cliente conectado');
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
    
    ws.on('close', () => {
        console.log('📱 Cliente desconectado');
        clients.delete(ws);
    });
});

server.listen(PORT, () => {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`🚀 SERVIDOR TIKTOK LIVE`);
    console.log(`${'='.repeat(50)}`);
    console.log(`📡 Puerto: ${PORT}`);
    console.log(`🌐 http://localhost:${PORT}`);
    console.log(`\n✨ Conecta a un usuario EN VIVO`);
    console.log(`📌 Ejemplo: soygabrielbeato, elmattriste, ibai`);
    console.log(`🎁 Los regalos aparecerán en consola y frontend`);
    console.log(`${'='.repeat(50)}\n`);
});
