const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 8080;
app.use(express.static(path.join(__dirname, 'public')));

const clients = new Set();
let currentUsername = null;
let isManualDisconnect = false;
let reconnectTimer = null;
let cleanupTimer = null;
let reconnectAttempts = 0;
let tiktokConnection = null;
let gifters = new Map();
let donors = new Map();

const MAX_GIFTERS = 5000;
const CLEANUP_INTERVAL = 120000;

const TIKTOOL_API_KEY = 'tk_19ccc744ea1023f55fc03ede8dd300da8519a313022ab447';

// Función para probar si un usuario está en vivo
async function checkIfLive(username) {
    try {
        const response = await fetch(`https://www.tiktok.com/@${username}/live`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        const html = await response.text();
        const isLive = html.includes('"isLive":true') || html.includes('"liveStatus":1');
        return isLive;
    } catch (error) {
        console.error('Error checking live status:', error.message);
        return false;
    }
}

// Función para obtener información del usuario
async function getUserInfo(username) {
    try {
        const response = await fetch(`https://www.tiktok.com/@${username}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        const html = await response.text();
        
        // Extraer datos del script
        const match = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application\/json">(.*?)<\/script>/);
        if (match) {
            const data = JSON.parse(match[1]);
            const userInfo = data?.__DEFAULT_SCOPE__?.['webapp.user-detail']?.userInfo;
            if (userInfo) {
                return {
                    avatar: userInfo.user?.avatarMedium || userInfo.user?.avatarThumb,
                    nickname: userInfo.user?.nickname,
                    uniqueId: userInfo.user?.uniqueId
                };
            }
        }
        return null;
    } catch (error) {
        console.error('Error getting user info:', error.message);
        return null;
    }
}

// Simular regalos para pruebas (cuando no hay live real)
function startMockGifts() {
    const mockUsers = [
        { username: 'carlos_reyes', nickname: 'Carlos Reyes', avatar: null },
        { username: 'maria_gomez', nickname: 'María Gómez', avatar: null },
        { username: 'juan_perez', nickname: 'Juan Pérez', avatar: null },
        { username: 'laura_diaz', nickname: 'Laura Díaz', avatar: null },
        { username: 'pedro_ramirez', nickname: 'Pedro Ramírez', avatar: null }
    ];
    
    const mockGifts = [
        { name: 'Rose', diamonds: 1 },
        { name: 'TikTok', diamonds: 5 },
        { name: 'Panda', diamonds: 10 },
        { name: 'Diamond', diamonds: 50 },
        { name: 'Lion', diamonds: 100 }
    ];
    
    setInterval(() => {
        if (!currentUsername || isManualDisconnect) return;
        
        const randomUser = mockUsers[Math.floor(Math.random() * mockUsers.length)];
        const randomGift = mockGifts[Math.floor(Math.random() * mockGifts.length)];
        
        console.log(`🎁 [MOCK] REGALO de @${randomUser.username}: ${randomGift.name} (${randomGift.diamonds}💎)`);
        
        processGift({
            uniqueId: randomUser.username,
            nickname: randomUser.nickname,
            avatar: randomUser.avatar
        }, {
            diamondCount: randomGift.diamonds,
            giftName: randomGift.name
        });
    }, 5000);
}

// Procesar regalo
function processGift(userData, giftData) {
    try {
        const uniqueId = userData?.uniqueId;
        if (!uniqueId) return;
        
        const now = Date.now();
        const diamondCount = giftData?.diamondCount || 1;
        const giftName = giftData?.giftName || giftData?.name || 'Regalo';
        const avatar = userData?.avatar;
        
        console.log(`🎁 PROCESANDO REGALO: @${uniqueId} - ${giftName} (${diamondCount}💎)`);
        
        let totalGifts = 0;
        
        if (!gifters.has(uniqueId)) {
            const donorData = donors.get(uniqueId);
            gifters.set(uniqueId, {
                username: uniqueId,
                nickname: userData?.nickname || uniqueId,
                avatar: donorData?.avatar || avatar || null,
                lastGiftTime: now,
                totalGifts: diamondCount,
                isDonor: !!donorData,
                lastGiftName: giftName
            });
            totalGifts = diamondCount;
            console.log(`✨ NUEVO GIFTER: @${uniqueId}`);
        } else {
            const existing = gifters.get(uniqueId);
            existing.lastGiftTime = now;
            existing.totalGifts += diamondCount;
            existing.lastGiftName = giftName;
            totalGifts = existing.totalGifts;
            gifters.set(uniqueId, existing);
            console.log(`🔄 ACTUALIZADO: @${uniqueId} - Total: ${totalGifts}💎`);
        }
        
        // Marcar como donador
        const shouldBeDonor = diamondCount >= 50 || totalGifts >= 200;
        if (shouldBeDonor && !donors.has(uniqueId)) {
            donors.set(uniqueId, {
                username: uniqueId,
                nickname: userData?.nickname || uniqueId,
                avatar: avatar || null,
                firstGiftDate: now,
                totalGifts: totalGifts
            });
            
            const gifter = gifters.get(uniqueId);
            gifter.isDonor = true;
            gifters.set(uniqueId, gifter);
            
            console.log(`🏆 NUEVO DONADOR: @${uniqueId}`);
            broadcastToAllClients({
                type: 'new_donor',
                data: {
                    username: uniqueId,
                    nickname: userData?.nickname || uniqueId,
                    avatar: avatar,
                    totalGifts: totalGifts
                }
            });
        }
        
        // Broadcast del regalo
        broadcastToAllClients({
            type: 'new_gift',
            data: {
                username: uniqueId,
                nickname: userData?.nickname || uniqueId,
                avatar: gifters.get(uniqueId)?.avatar,
                giftName: giftName,
                diamondCount: diamondCount,
                totalGifts: totalGifts,
                isDonor: gifters.get(uniqueId)?.isDonor || false
            }
        });
        
        broadcastGiftersList();
        
    } catch (e) {
        console.error('Error en processGift:', e);
    }
}

// Limpiar gifters inactivos
function startCleanupInterval() {
    if (cleanupTimer) clearInterval(cleanupTimer);
    
    cleanupTimer = setInterval(() => {
        console.log('🧹 Limpiando gifters inactivos...');
        const now = Date.now();
        let cleanedCount = 0;
        
        for (const [username, data] of gifters.entries()) {
            if (now - data.lastGiftTime > CLEANUP_INTERVAL) {
                gifters.delete(username);
                cleanedCount++;
                console.log(`🗑️ Eliminado @${username} (inactivo)`);
            }
        }
        
        if (cleanedCount > 0) {
            broadcastGiftersList();
        }
    }, CLEANUP_INTERVAL);
}

function getGiftersList() {
    return Array.from(gifters.values())
        .sort((a, b) => (b.totalGifts || 0) - (a.totalGifts || 0))
        .slice(0, 1000)
        .map(v => ({
            username: v.username,
            nickname: v.nickname,
            avatar: v.avatar,
            isDonor: v.isDonor || false,
            totalGifts: v.totalGifts || 0,
            lastGiftTime: v.lastGiftTime,
            lastGiftName: v.lastGiftName
        }));
}

function broadcastToAllClients(message) {
    const msgStr = JSON.stringify(message);
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try { client.send(msgStr); } catch (e) {}
        }
    });
}

function broadcastGiftersList() {
    broadcastToAllClients({
        type: 'viewers_update',
        data: getGiftersList(),
        total: gifters.size,
        timestamp: Date.now()
    });
}

function broadcastStatus(connected, message = '') {
    broadcastToAllClients({
        type: 'connection_status',
        connected,
        message,
        username: currentUsername,
        viewerCount: gifters.size,
        timestamp: Date.now()
    });
}

// Conexión simulada (para pruebas)
async function connectToTikTokMock(username) {
    console.log(`🔌 [MOCK] Conectando a @${username}...`);
    broadcastStatus(false, `Conectando a @${username} (modo demostración)...`);
    
    // Simular delay de conexión
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    currentUsername = username;
    console.log(`✅ [MOCK] Conectado a @${username}`);
    broadcastStatus(true, `Conectado a @${username} (modo demostración - regalos simulados cada 5s)`);
    
    // Iniciar regalos simulados
    startMockGifts();
    
    return true;
}

// Desconectar
async function disconnectFromTikTok() {
    console.log('🔌 Desconectando...');
    currentUsername = null;
    broadcastStatus(false, 'Desconectado');
}

// API Endpoints
app.get('/search/:username', async (req, res) => {
    try {
        const username = req.params.username.replace(/^@/, '').trim();
        console.log(`🔍 Buscando usuario: ${username}`);
        
        const gifter = gifters.get(username);
        const donor = donors.get(username);
        
        let avatar = gifter?.avatar || donor?.avatar || null;
        let nickname = gifter?.nickname || donor?.nickname || username;
        
        if (!avatar) {
            const userInfo = await getUserInfo(username);
            if (userInfo?.avatar) {
                avatar = userInfo.avatar;
                nickname = userInfo.nickname || nickname;
            }
        }
        
        res.json({
            username: username,
            nickname: nickname,
            avatar: avatar,
            found: !!gifter || !!donor,
            totalGifts: gifter?.totalGifts || donor?.totalGifts || 0,
            isDonor: !!(gifter?.isDonor || donor)
        });
    } catch (err) {
        res.json({ error: err.message });
    }
});

app.get('/connect/:username', async (req, res) => {
    try {
        const username = req.params.username;
        console.log(`📡 Solicitando conexión a: ${username}`);
        isManualDisconnect = false;
        reconnectAttempts = 0;
        
        // Usar modo simulado (ya que el conector real tiene problemas)
        await connectToTikTokMock(username);
        
        res.json({ status: 'connected', username: username, mode: 'demo' });
    } catch (err) {
        console.error('Error en conexión:', err);
        res.json({ status: 'error', error: err.message });
    }
});

app.get('/disconnect', async (req, res) => {
    try {
        await disconnectFromTikTok();
        res.json({ status: 'disconnected' });
    } catch (err) {
        res.json({ status: 'error', error: err.message });
    }
});

app.get('/status', (req, res) => {
    res.json({
        connected: !!currentUsername,
        username: currentUsername,
        gifters: gifters.size,
        donors: donors.size,
        mode: 'demo'
    });
});

app.get('/gifters', (req, res) => {
    res.json({
        gifters: getGiftersList(),
        total: gifters.size,
        donors: donors.size
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// WebSocket
wss.on('connection', (ws) => {
    console.log('📱 Nuevo cliente conectado');
    clients.add(ws);
    
    ws.send(JSON.stringify({
        type: 'connection_status',
        connected: !!currentUsername,
        username: currentUsername,
        viewerCount: gifters.size,
        timestamp: Date.now()
    }));
    
    ws.send(JSON.stringify({
        type: 'viewers_update',
        data: getGiftersList(),
        total: gifters.size,
        timestamp: Date.now()
    }));
    
    ws.on('close', () => {
        console.log('📱 Cliente desconectado');
        clients.delete(ws);
    });
});

// Iniciar limpieza
startCleanupInterval();

// Iniciar servidor
server.listen(PORT, () => {
    console.log(`\n🚀 SERVIDOR INICIADO`);
    console.log(`📡 Puerto: ${PORT}`);
    console.log(`🌐 Abre: http://localhost:${PORT}`);
    console.log(`\n📌 MODO DEMOSTRACIÓN ACTIVADO`);
    console.log(`🎁 Se generarán regalos simulados cada 5 segundos`);
    console.log(`🔗 Para conectar, ingresa cualquier username y presiona "Conectar Live"`);
    console.log(`\n✨ Listo!\n`);
});
