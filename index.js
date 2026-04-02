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

// Configuración CORRECTA para TikTok Live
const connectionConfig = {
    processInitialData: true,
    enableWebsocketUpgrade: true,
    requestPollingIntervalMs: 2000,
    requestOptions: {
        timeout: 15000,
    },
    websocketOptions: {
        timeout: 15000,
    },
    sessionId: undefined,
    signProviderOptions: {
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
        donors: donors.size,
        timestamp: Date.now()
    });
}

// Función principal para procesar regalos
function processGift(giftEvent) {
    try {
        // Extraer información del regalo
        const uniqueId = giftEvent.uniqueId;
        const giftName = giftEvent.giftName || giftEvent.gift?.name || 'Regalo';
        const diamondCount = giftEvent.diamondCount || giftEvent.gift?.diamondCount || 1;
        const repeatEnd = giftEvent.repeatEnd;
        
        // IMPORTANTE: Solo procesar al final de una racha de regalos
        if (repeatEnd !== undefined && repeatEnd !== 1) {
            console.log(`⏳ Regalo en racha: @${uniqueId} - ${giftName} (${diamondCount}💎) - esperando final...`);
            return;
        }
        
        console.log(`🎁 REGALO DETECTADO: @${uniqueId} - ${giftName} (${diamondCount}💎)`);
        
        const now = Date.now();
        
        // Actualizar o crear gifter
        if (!gifters.has(uniqueId)) {
            gifters.set(uniqueId, {
                username: uniqueId,
                nickname: uniqueId,
                avatar: null,
                lastGiftTime: now,
                totalGifts: diamondCount,
                isDonor: false,
                giftCount: 1
            });
            console.log(`✨ NUEVO GIFTER: @${uniqueId}`);
        } else {
            const existing = gifters.get(uniqueId);
            existing.lastGiftTime = now;
            existing.totalGifts += diamondCount;
            existing.giftCount = (existing.giftCount || 0) + 1;
            gifters.set(uniqueId, existing);
            console.log(`🔄 ACTUALIZADO: @${uniqueId} - Total: ${existing.totalGifts}💎 (${existing.giftCount} regalos)`);
        }
        
        const totalGifts = gifters.get(uniqueId).totalGifts;
        const giftCount = gifters.get(uniqueId).giftCount;
        
        // Verificar si se convierte en DONADOR (100+ diamantes totales)
        if (totalGifts >= 100 && !donors.has(uniqueId)) {
            donors.set(uniqueId, {
                username: uniqueId,
                nickname: uniqueId,
                avatar: null,
                totalGifts: totalGifts,
                giftCount: giftCount,
                firstGiftDate: now
            });
            
            // Marcar como donador en gifters
            const gifter = gifters.get(uniqueId);
            gifter.isDonor = true;
            gifters.set(uniqueId, gifter);
            
            console.log(`🏆 NUEVO DONADOR PERMANENTE: @${uniqueId} (${totalGifts}💎 en ${giftCount} regalos)`);
            
            // Notificar al frontend
            broadcastToAllClients({
                type: 'new_donor',
                data: {
                    username: uniqueId,
                    nickname: uniqueId,
                    avatar: null,
                    totalGifts: totalGifts,
                    giftCount: giftCount
                }
            });
        }
        
        // Notificar regalo en tiempo real
        broadcastToAllClients({
            type: 'new_gift',
            data: {
                username: uniqueId,
                nickname: uniqueId,
                avatar: null,
                giftName: giftName,
                diamondCount: diamondCount,
                totalGifts: totalGifts,
                giftCount: giftCount,
                isDonor: gifters.get(uniqueId).isDonor
            }
        });
        
        // Actualizar lista completa
        broadcastGiftersList();
        
    } catch (error) {
        console.error('Error procesando regalo:', error);
    }
}

// Limpieza de inactivos cada 2 minutos
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [username, data] of gifters.entries()) {
        if (now - data.lastGiftTime > 120000) { // 2 minutos sin regalos
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

async function connectToTikTok(username) {
    if (activeConnection) {
        try { 
            activeConnection.disconnect(); 
        } catch(e) {}
        activeConnection = null;
    }
    
    currentUsername = username.replace(/^@/, '').trim();
    console.log(`\n🔌 Conectando a @${currentUsername}...`);
    broadcastToAllClients({ 
        type: 'connection_status', 
        connected: false, 
        message: `Conectando a @${currentUsername}...` 
    });
    
    activeConnection = new WebcastPushConnection(currentUsername, connectionConfig);
    
    // Evento de conexión exitosa
    activeConnection.on('connected', () => {
        console.log(`✅ CONECTADO a @${currentUsername}`);
        broadcastToAllClients({ 
            type: 'connection_status', 
            connected: true, 
            username: currentUsername,
            message: `Conectado a @${currentUsername}`
        });
    });
    
    // Evento de desconexión
    activeConnection.on('disconnected', () => {
        console.log(`🔌 Desconectado de @${currentUsername}`);
        broadcastToAllClients({ 
            type: 'connection_status', 
            connected: false, 
            message: 'Desconectado - Reconectando...' 
        });
        
        // Reconexión automática
        setTimeout(() => {
            if (currentUsername && !activeConnection?.isConnected) {
                console.log('🔄 Reconectando...');
                connectToTikTok(currentUsername);
            }
        }, 5000);
    });
    
    // EVENTO DE REGALO - El más importante
    activeConnection.on('gift', (data) => {
        console.log(`📦 Evento gift recibido:`, JSON.stringify(data, null, 2));
        processGift(data);
    });
    
    // Eventos adicionales para debug
    activeConnection.on('member', (data) => {
        console.log(`👤 Miembro: @${data.uniqueId}`);
    });
    
    activeConnection.on('chat', (data) => {
        // Solo para debug, no procesamos chats
        if (data.comment && data.comment.length < 50) {
            console.log(`💬 Chat: @${data.uniqueId}: ${data.comment}`);
        }
    });
    
    activeConnection.on('roomUser', (data) => {
        console.log(`📊 Espectadores en sala: ${data.viewerCount || 'desconocido'}`);
    });
    
    try {
        await activeConnection.connect();
        console.log(`🎧 Escuchando eventos de @${currentUsername}...`);
        return true;
    } catch (err) {
        console.error(`❌ ERROR de conexión: ${err.message}`);
        broadcastToAllClients({ 
            type: 'connection_status', 
            connected: false, 
            message: `Error: ${err.message}` 
        });
        
        // Reconectar después de error
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
    console.log(`\n📡 CONEXIÓN SOLICITADA: ${username}`);
    await connectToTikTok(username);
    res.json({ status: 'connecting', username });
});

app.get('/disconnect', (req, res) => {
    console.log(`\n🔌 DESCONEXIÓN MANUAL`);
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
        donors: donors.size,
        totalGifts: Array.from(gifters.values()).reduce((sum, g) => sum + g.totalGifts, 0)
    });
});

app.get('/gifters', (req, res) => {
    const list = Array.from(gifters.values())
        .sort((a, b) => b.totalGifts - a.totalGifts);
    res.json({ 
        gifters: list, 
        total: gifters.size,
        donors: donors.size,
        totalGifts: list.reduce((sum, g) => sum + g.totalGifts, 0)
    });
});

app.get('/search/:username', (req, res) => {
    const username = req.params.username.replace(/^@/, '').trim();
    const gifter = gifters.get(username);
    const donor = donors.get(username);
    
    res.json({
        username: username,
        nickname: gifter?.nickname || donor?.nickname || username,
        avatar: null,
        found: !!gifter || !!donor,
        totalGifts: gifter?.totalGifts || donor?.totalGifts || 0,
        isDonor: !!(gifter?.isDonor || donor)
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// WebSocket para clientes
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
    
    ws.on('close', () => {
        console.log('📱 Cliente frontend desconectado');
        clients.delete(ws);
    });
});

server.listen(PORT, () => {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`🚀 SERVIDOR TIKTOK LIVE - DETECTOR DE REGALOS`);
    console.log(`${'='.repeat(50)}`);
    console.log(`📡 Puerto: ${PORT}`);
    console.log(`🌐 Abre: http://localhost:${PORT}`);
    console.log(`\n✨ CONFIGURACIÓN CORRECTA`);
    console.log(`📌 Conecta a un usuario que esté EN VIVO en TikTok`);
    console.log(`🎁 Los regalos aparecerán en tiempo real`);
    console.log(`🏆 Donadores: usuarios con 100+ diamantes acumulados`);
    console.log(`🧹 Limpieza de inactivos: cada 2 minutos`);
    console.log(`${'='.repeat(50)}\n`);
});
