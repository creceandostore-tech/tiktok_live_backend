const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

// Importación CORRECTA para la versión 2.0.0
const { TikTokLiveConnection, WebcastEvent } = require('tiktok-live-connector');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = 8080;

app.use(express.static(path.join(__dirname, 'public')));

let activeConnection = null;
let currentUsername = null;
let clients = new Set();
let gifters = new Map(); // Todos los que envían regalos
let donors = new Map(); // Donadores persistentes (100+ diamantes)

// Configuración OBLIGATORIA para que funcione
const connectionOptions = {
    processInitialData: true,
    enableExtendedGiftInfo: true,  // Necesario para obtener nombres de regalos
    requestPollingIntervalMs: 2000,
    fetchRoomInfoOnConnect: true,
    // La librería usa automáticamente el servidor de firma público
};

// Broadcast a todos los clientes frontend
function broadcastToAllClients(message) {
    const msgStr = JSON.stringify(message);
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try { client.send(msgStr); } catch (e) {}
        }
    });
}

// Actualizar y enviar lista de gifters
function broadcastGiftersList() {
    const list = Array.from(gifters.values())
        .sort((a, b) => b.totalGifts - a.totalGifts)
        .map(v => ({
            username: v.username,
            nickname: v.nickname,
            avatar: v.avatar,
            isDonor: v.isDonor || false,
            totalGifts: v.totalGifts,
            giftCount: v.giftCount || 1
        }));
    
    broadcastToAllClients({
        type: 'viewers_update',
        data: list,
        total: gifters.size,
        donors: donors.size,
        timestamp: Date.now()
    });
}

// Procesar evento de REGALO
function processGiftEvent(data) {
    try {
        // Extraer información del evento
        const uniqueId = data.uniqueId;
        const giftName = data.giftName || 'Regalo';
        const diamondCount = data.diamondCount || 1;
        const repeatEnd = data.repeatEnd;
        
        // Los regalos en racha solo se procesan al final
        if (repeatEnd !== undefined && repeatEnd !== 1) {
            console.log(`⏳ Regalo en racha: @${uniqueId} - ${giftName} (${diamondCount}💎) - esperando final...`);
            return;
        }
        
        console.log(`🎁 REGALO: @${uniqueId} - ${giftName} (${diamondCount}💎)`);
        
        const now = Date.now();
        
        // Actualizar o crear gifter
        if (!gifters.has(uniqueId)) {
            gifters.set(uniqueId, {
                username: uniqueId,
                nickname: uniqueId,
                avatar: null,
                lastGiftTime: now,
                totalGifts: diamondCount,
                giftCount: 1,
                isDonor: false
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
        
        const gifter = gifters.get(uniqueId);
        const totalGifts = gifter.totalGifts;
        
        // Verificar si se convierte en DONADOR (100+ diamantes totales)
        if (totalGifts >= 100 && !donors.has(uniqueId)) {
            donors.set(uniqueId, {
                username: uniqueId,
                nickname: uniqueId,
                avatar: null,
                totalGifts: totalGifts,
                giftCount: gifter.giftCount,
                firstGiftDate: now
            });
            
            gifter.isDonor = true;
            gifters.set(uniqueId, gifter);
            
            console.log(`🏆 NUEVO DONADOR: @${uniqueId} (${totalGifts}💎 en ${gifter.giftCount} regalos)`);
            
            // Notificar nuevo donador
            broadcastToAllClients({
                type: 'new_donor',
                data: {
                    username: uniqueId,
                    nickname: uniqueId,
                    avatar: null,
                    totalGifts: totalGifts,
                    giftCount: gifter.giftCount
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
                giftCount: gifter.giftCount,
                isDonor: gifter.isDonor
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
        // Usar la clase correcta TikTokLiveConnection (no WebcastPushConnection)
        activeConnection = new TikTokLiveConnection(currentUsername, connectionOptions);
        
        // Evento de conexión exitosa
        activeConnection.on(WebcastEvent.CONNECTED, (state) => {
            console.log(`✅ CONECTADO a @${currentUsername} - Room ID: ${state.roomId}`);
            broadcastToAllClients({
                type: 'connection_status',
                connected: true,
                username: currentUsername,
                message: `Conectado a @${currentUsername}`
            });
        });
        
        // Evento de REGALO - El más importante
        activeConnection.on(WebcastEvent.GIFT, (data) => {
            console.log(`📦 Evento GIFT recibido:`, JSON.stringify(data, null, 2));
            processGiftEvent(data);
        });
        
        // Evento de desconexión con reconexión automática
        activeConnection.on(WebcastEvent.DISCONNECTED, () => {
            console.log(`🔌 Desconectado de @${currentUsername}`);
            broadcastToAllClients({
                type: 'connection_status',
                connected: false,
                message: 'Desconectado - Reconectando...'
            });
            
            // Reconectar después de 5 segundos
            setTimeout(() => {
                if (currentUsername) {
                    console.log('🔄 Reconectando...');
                    connectToTikTok(currentUsername);
                }
            }, 5000);
        });
        
        // Evento de error
        activeConnection.on(WebcastEvent.ERROR, (err) => {
            console.error(`❌ Error: ${err.message}`);
            broadcastToAllClients({
                type: 'connection_status',
                connected: false,
                message: `Error: ${err.message}`
            });
        });
        
        // Conectar
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

// ============ API ENDPOINTS ============

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
    const totalGifts = list.reduce((sum, g) => sum + g.totalGifts, 0);
    res.json({
        gifters: list,
        total: gifters.size,
        donors: donors.size,
        totalGifts: totalGifts
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

// ============ WEBSOCKET PARA CLIENTES ============
wss.on('connection', (ws) => {
    console.log('📱 Cliente frontend conectado');
    clients.add(ws);
    
    // Enviar estado actual
    ws.send(JSON.stringify({
        type: 'connection_status',
        connected: activeConnection?.isConnected || false,
        username: currentUsername
    }));
    
    // Enviar lista actual de gifters
    const list = Array.from(gifters.values()).sort((a, b) => b.totalGifts - a.totalGifts);
    ws.send(JSON.stringify({
        type: 'viewers_update',
        data: list,
        total: gifters.size,
        donors: donors.size
    }));
    
    ws.on('close', () => {
        console.log('📱 Cliente frontend desconectado');
        clients.delete(ws);
    });
});

// ============ INICIAR SERVIDOR ============
server.listen(PORT, () => {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`🚀 SERVIDOR TIKTOK LIVE - VERSIÓN 2.0.0`);
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
