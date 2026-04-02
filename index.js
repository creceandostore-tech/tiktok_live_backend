const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fetch = require('node-fetch');
const { WebcastPushConnection } = require('tiktok-live-connector');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = 8080;

app.use(express.static(path.join(__dirname, 'public')));

let activeConnection = null;
let currentUsername = null;
let clients = new Set();
let gifters = new Map();
let donors = new Map();
let reconnectTimer = null;
let reconnectAttempts = 0;
let heartbeatInterval = null;
let isManualDisconnect = false;

// Cache de perfiles para evitar muchas peticiones
const profileCache = new Map();
const CACHE_DURATION = 3600000; // 1 hora

// Configuración optimizada
const config = {
    processInitialData: false,
    enableExtendedGiftInfo: true,
    enableWebsocketUpgrade: true,
    requestPollingIntervalMs: 2000,
    websocketTimeout: 60000,
    requestOptions: {
        timeout: 15000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
    }
};

// Función para obtener perfil REAL de TikTok
async function getTikTokProfile(username) {
    // Verificar caché
    if (profileCache.has(username)) {
        const cached = profileCache.get(username);
        if (Date.now() - cached.timestamp < CACHE_DURATION) {
            console.log(`📦 Usando caché para @${username}`);
            return cached.data;
        }
    }
    
    try {
        console.log(`🔍 Buscando perfil real de @${username}...`);
        
        // Método 1: API pública de TikTok
        const response = await fetch(`https://www.tiktok.com/@${username}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'es-ES,es;q=0.8,en-US;q=0.5,en;q=0.3',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive'
            }
        });
        
        const html = await response.text();
        
        // Buscar datos en el script de TikTok
        let avatarUrl = null;
        let nickname = username;
        
        // Método 1: Buscar en el script de datos
        const scriptMatch = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application\/json">(.*?)<\/script>/s);
        if (scriptMatch) {
            try {
                const data = JSON.parse(scriptMatch[1]);
                const userInfo = data?.__DEFAULT_SCOPE__?.['seo.abtest'] || 
                                data?.['webapp.user-detail']?.userInfo ||
                                data?.__DEFAULT_SCOPE__?.['webapp.user-detail']?.userInfo;
                
                if (userInfo?.user) {
                    nickname = userInfo.user.nickname || username;
                    avatarUrl = userInfo.user.avatarMedium || userInfo.user.avatarThumb || null;
                }
            } catch(e) {}
        }
        
        // Método 2: Buscar avatar en el HTML
        if (!avatarUrl) {
            const avatarMatch = html.match(/avatar":\{"uri":"(https:[^"]+)"/);
            if (avatarMatch) avatarUrl = avatarMatch[1];
        }
        
        // Método 3: Buscar en meta tags
        if (!avatarUrl) {
            const ogImageMatch = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/);
            if (ogImageMatch && ogImageMatch[1].includes('tiktok')) avatarUrl = ogImageMatch[1];
        }
        
        // Si encontramos avatar, lo guardamos en caché
        if (avatarUrl) {
            console.log(`✅ Perfil encontrado: @${username} - ${nickname}`);
            const profileData = {
                username: username,
                nickname: nickname,
                avatar: avatarUrl,
                timestamp: Date.now()
            };
            
            profileCache.set(username, { data: profileData, timestamp: Date.now() });
            return profileData;
        }
        
        console.log(`⚠️ No se encontró avatar para @${username}`);
        return {
            username: username,
            nickname: username,
            avatar: null
        };
        
    } catch (error) {
        console.error(`❌ Error obteniendo perfil de @${username}:`, error.message);
        return {
            username: username,
            nickname: username,
            avatar: null
        };
    }
}

// Función para actualizar perfil de un gifter
async function updateGifterProfile(username) {
    if (gifters.has(username)) {
        const gifter = gifters.get(username);
        
        // Solo actualizar si no tiene nickname o avatar
        if (!gifter.nickname || gifter.nickname === username || !gifter.avatar) {
            const profile = await getTikTokProfile(username);
            
            if (profile.nickname && profile.nickname !== username) {
                gifter.nickname = profile.nickname;
                console.log(`📝 Nickname actualizado: @${username} -> ${profile.nickname}`);
            }
            
            if (profile.avatar) {
                gifter.avatar = profile.avatar;
                console.log(`🖼️ Avatar actualizado para @${username}`);
            }
            
            gifters.set(username, gifter);
            broadcastGiftersList();
        }
    }
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
    const list = Array.from(gifters.values())
        .sort((a, b) => b.totalGifts - a.totalGifts)
        .map(v => ({
            username: v.username,
            nickname: v.nickname || v.username,
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

async function processGift(giftEvent) {
    try {
        const uniqueId = giftEvent.uniqueId;
        const giftName = giftEvent.giftName || 'Regalo';
        const diamondCount = giftEvent.diamondCount || 1;
        
        console.log(`🎁 REGALO: @${uniqueId} - ${giftName} (${diamondCount}💎)`);
        
        const now = Date.now();
        
        if (!gifters.has(uniqueId)) {
            // Obtener perfil real del nuevo gifter
            const profile = await getTikTokProfile(uniqueId);
            
            gifters.set(uniqueId, {
                username: uniqueId,
                nickname: profile.nickname || uniqueId,
                avatar: profile.avatar,
                lastGiftTime: now,
                totalGifts: diamondCount,
                isDonor: false
            });
            console.log(`✨ NUEVO GIFTER: @${uniqueId} (${profile.nickname || uniqueId})`);
        } else {
            const existing = gifters.get(uniqueId);
            existing.lastGiftTime = now;
            existing.totalGifts += diamondCount;
            gifters.set(uniqueId, existing);
            console.log(`🔄 ACTUALIZADO: @${uniqueId} - Total: ${existing.totalGifts}💎`);
            
            // Actualizar perfil si es necesario
            if (!existing.avatar || existing.nickname === uniqueId) {
                await updateGifterProfile(uniqueId);
            }
        }
        
        const totalGifts = gifters.get(uniqueId).totalGifts;
        
        if (totalGifts >= 100 && !donors.has(uniqueId)) {
            donors.set(uniqueId, {
                username: uniqueId,
                nickname: gifters.get(uniqueId).nickname || uniqueId,
                avatar: gifters.get(uniqueId).avatar,
                totalGifts: totalGifts
            });
            
            const gifter = gifters.get(uniqueId);
            gifter.isDonor = true;
            gifters.set(uniqueId, gifter);
            
            console.log(`🏆 DONADOR: @${uniqueId} (${totalGifts}💎)`);
            
            broadcastToAllClients({
                type: 'new_donor',
                data: {
                    username: uniqueId,
                    nickname: gifter.nickname || uniqueId,
                    avatar: gifter.avatar,
                    totalGifts: totalGifts
                }
            });
        }
        
        const gifter = gifters.get(uniqueId);
        
        broadcastToAllClients({
            type: 'new_gift',
            data: {
                username: uniqueId,
                nickname: gifter.nickname || uniqueId,
                avatar: gifter.avatar,
                giftName: giftName,
                diamondCount: diamondCount,
                totalGifts: totalGifts,
                isDonor: gifter.isDonor
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

// Heartbeat para mantener conexión activa
function startHeartbeat() {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    
    heartbeatInterval = setInterval(() => {
        if (activeConnection && activeConnection.isConnected) {
            console.log('💓 Heartbeat - conexión activa');
            try {
                activeConnection.getRoomInfo().catch(() => {});
            } catch(e) {}
        } else if (activeConnection && !activeConnection.isConnected && currentUsername && !isManualDisconnect) {
            console.log('⚠️ Heartbeat detectó desconexión, reconectando...');
            reconnectToTikTok();
        }
    }, 15000);
}

async function reconnectToTikTok() {
    if (isManualDisconnect) return;
    if (!currentUsername) return;
    
    reconnectAttempts++;
    const delay = Math.min(5000 * Math.pow(1.5, reconnectAttempts - 1), 60000);
    
    console.log(`🔄 Intento de reconexión ${reconnectAttempts} en ${Math.round(delay/1000)}s...`);
    
    broadcastToAllClients({
        type: 'connection_status',
        connected: false,
        message: `Reconectando (intento ${reconnectAttempts})...`
    });
    
    if (reconnectTimer) clearTimeout(reconnectTimer);
    
    reconnectTimer = setTimeout(async () => {
        if (!isManualDisconnect && currentUsername) {
            try {
                await connectToTikTok(currentUsername);
            } catch (err) {
                console.error(`❌ Error en reconexión: ${err.message}`);
                reconnectToTikTok();
            }
        }
    }, delay);
}

async function connectToTikTok(username) {
    if (activeConnection) {
        try { 
            activeConnection.disconnect(); 
        } catch(e) {}
        activeConnection = null;
    }
    
    currentUsername = username.replace(/^@/, '').trim();
    console.log(`\n🔌 Conectando a @${currentUsername}... (Intento ${reconnectAttempts + 1})`);
    
    broadcastToAllClients({
        type: 'connection_status',
        connected: false,
        message: `Conectando a @${currentUsername}...`
    });
    
    try {
        activeConnection = new WebcastPushConnection(currentUsername, config);
        
        activeConnection.on('connected', (state) => {
            console.log(`✅ CONECTADO a @${currentUsername} - Room ID: ${state.roomId}`);
            reconnectAttempts = 0;
            isManualDisconnect = false;
            
            broadcastToAllClients({
                type: 'connection_status',
                connected: true,
                username: currentUsername,
                message: `Conectado a @${currentUsername}`
            });
            
            startHeartbeat();
        });
        
        activeConnection.on('gift', async (data) => {
            console.log(`📦 GIFT: ${data.uniqueId} - ${data.giftName} (${data.diamondCount}💎)`);
            await processGift(data);
        });
        
        activeConnection.on('disconnected', () => {
            console.log(`🔌 Desconectado de @${currentUsername}`);
            
            if (!isManualDisconnect) {
                broadcastToAllClients({
                    type: 'connection_status',
                    connected: false,
                    message: 'Desconectado - Reconectando...'
                });
                reconnectToTikTok();
            }
        });
        
        activeConnection.on('error', (err) => {
            console.error(`❌ Error: ${err.message}`);
            
            if (!isManualDisconnect && err.message !== 'User offline') {
                broadcastToAllClients({
                    type: 'connection_status',
                    connected: false,
                    message: `Error: ${err.message} - Reconectando...`
                });
                reconnectToTikTok();
            } else if (err.message === 'User offline') {
                broadcastToAllClients({
                    type: 'connection_status',
                    connected: false,
                    message: `@${currentUsername} no está en vivo - Esperando...`
                });
                setTimeout(() => {
                    if (!isManualDisconnect && currentUsername) {
                        connectToTikTok(currentUsername);
                    }
                }, 30000);
            }
        });
        
        activeConnection.on('chat', (data) => {
            console.log(`💬 @${data.uniqueId}: ${data.comment}`);
        });
        
        activeConnection.on('member', (data) => {
            console.log(`👤 + ${data.uniqueId}`);
        });
        
        await activeConnection.connect();
        console.log(`🎧 Escuchando eventos...`);
        return true;
        
    } catch (err) {
        console.error(`❌ ERROR de conexión: ${err.message}`);
        
        if (!isManualDisconnect) {
            broadcastToAllClients({
                type: 'connection_status',
                connected: false,
                message: `Error: ${err.message} - Reconectando en 5s...`
            });
            
            setTimeout(() => {
                if (!isManualDisconnect && currentUsername) {
                    connectToTikTok(currentUsername);
                }
            }, 5000);
        }
        
        return false;
    }
}

// ============ API ENDPOINTS ============

app.get('/connect/:username', async (req, res) => {
    const username = req.params.username;
    console.log(`\n📡 CONECTANDO A: ${username}`);
    
    isManualDisconnect = false;
    reconnectAttempts = 0;
    
    if (reconnectTimer) clearTimeout(reconnectTimer);
    
    await connectToTikTok(username);
    res.json({ status: 'connecting', username });
});

app.get('/disconnect', (req, res) => {
    console.log(`\n🔌 DESCONECTANDO MANUALMENTE`);
    isManualDisconnect = true;
    
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    
    if (activeConnection) {
        activeConnection.disconnect();
    }
    
    currentUsername = null;
    reconnectAttempts = 0;
    
    broadcastToAllClients({
        type: 'connection_status',
        connected: false,
        message: 'Desconectado manualmente'
    });
    
    res.json({ status: 'disconnected' });
});

app.get('/status', (req, res) => {
    const totalGifts = Array.from(gifters.values()).reduce((sum, g) => sum + g.totalGifts, 0);
    res.json({
        connected: activeConnection?.isConnected || false,
        username: currentUsername,
        gifters: gifters.size,
        donors: donors.size,
        totalGifts: totalGifts,
        reconnectAttempts: reconnectAttempts
    });
});

app.get('/gifters', (req, res) => {
    const list = Array.from(gifters.values()).sort((a, b) => b.totalGifts - a.totalGifts);
    res.json({ gifters: list, donors: donors.size });
});

app.get('/search/:username', async (req, res) => {
    const username = req.params.username.replace(/^@/, '').trim();
    const gifter = gifters.get(username);
    
    if (gifter && (gifter.nickname !== username || gifter.avatar)) {
        res.json({
            username: username,
            nickname: gifter.nickname || username,
            avatar: gifter.avatar,
            found: true,
            totalGifts: gifter.totalGifts || 0,
            isDonor: gifter.isDonor || false
        });
    } else {
        // Buscar perfil en TikTok
        const profile = await getTikTokProfile(username);
        res.json({
            username: username,
            nickname: profile.nickname || username,
            avatar: profile.avatar,
            found: !!profile.avatar,
            totalGifts: gifter?.totalGifts || 0,
            isDonor: gifter?.isDonor || false
        });
    }
});

app.get('/profile/:username', async (req, res) => {
    const username = req.params.username.replace(/^@/, '').trim();
    const profile = await getTikTokProfile(username);
    res.json(profile);
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
        data: Array.from(gifters.values()).map(v => ({
            username: v.username,
            nickname: v.nickname || v.username,
            avatar: v.avatar,
            isDonor: v.isDonor || false,
            totalGifts: v.totalGifts
        })),
        total: gifters.size,
        donors: donors.size
    }));
    
    ws.on('close', () => {
        console.log('📱 Cliente desconectado');
        clients.delete(ws);
    });
});

// Iniciar servidor
server.listen(PORT, () => {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`🚀 SERVIDOR TIKTOK LIVE - CON PERFILES REALES`);
    console.log(`${'='.repeat(50)}`);
    console.log(`📡 Puerto: ${PORT}`);
    console.log(`🌐 http://localhost:${PORT}`);
    console.log(`\n✨ PERFILES REALES DE TIKTOK`);
    console.log(`📸 Se muestran fotos de perfil y nombres reales`);
    console.log(`💾 Caché de perfiles: 1 hora`);
    console.log(`🔄 Reconexión automática infinita`);
    console.log(`🎁 Los regalos aparecen con foto y nombre real`);
    console.log(`${'='.repeat(50)}\n`);
});
