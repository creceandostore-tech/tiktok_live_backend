const fetch = require('node-fetch');
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

// Caché de avatares para no consultar repetidamente
const avatarCache = new Map();

// Función para obtener avatar REAL de TikTok desde su API pública
async function fetchRealAvatar(username) {
    // Verificar caché primero (válido por 1 hora)
    if (avatarCache.has(username)) {
        const cached = avatarCache.get(username);
        if (Date.now() - cached.timestamp < 3600000) {
            return cached.url;
        }
    }
    
    try {
        // Método 1: Usar la API pública de TikTok
        const response = await fetch(`https://www.tiktok.com/@${username}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        
        const html = await response.text();
        
        // Buscar la URL del avatar en el HTML
        // Patrones comunes de TikTok
        const patterns = [
            /"avatarUrl":"(https:[^"]+?)"/,
            /"avatar_thumb":"(https:[^"]+?)"/,
            /"avatarMedium":"(https:[^"]+?)"/,
            /"avatar_large":"(https:[^"]+?)"/,
            /avatar":\{"url":"(https:[^"]+?)"/
        ];
        
        for (const pattern of patterns) {
            const match = html.match(pattern);
            if (match && match[1]) {
                let avatarUrl = match[1].replace(/\\u002F/g, '/').replace(/\\/g, '');
                // Asegurar HTTPS
                avatarUrl = avatarUrl.replace('http://', 'https://');
                // Guardar en caché
                avatarCache.set(username, { url: avatarUrl, timestamp: Date.now() });
                console.log(`✅ Avatar REAL obtenido para @${username}: ${avatarUrl.substring(0, 80)}...`);
                return avatarUrl;
            }
        }
        
        console.log(`⚠️ No se encontró avatar para @${username}`);
        return null;
        
    } catch (error) {
        console.error(`❌ Error obteniendo avatar para @${username}:`, error.message);
        return null;
    }
}

// También intentar extraer avatar de los datos de TikTok Live
function extractAvatarFromUserData(userData) {
    const possibleFields = [
        userData.avatarThumbnail?.url,
        userData.avatarMedium?.url,
        userData.avatarLarge?.url,
        userData.avatarThumbnail,
        userData.avatarMedium,
        userData.avatarLarge,
        userData.profilePicture,
        userData.profilePictureUrl,
        userData.profile_picture,
        userData.avatar,
        userData.avatarUrl,
        userData.picture
    ];
    
    for (const field of possibleFields) {
        if (field && typeof field === 'string' && (field.startsWith('http') || field.startsWith('https'))) {
            return field;
        }
    }
    return null;
}

function broadcastViewers() {
    const viewerList = Array.from(viewers.values()).map(v => ({
        username: v.username,
        nickname: v.nickname,
        avatar: v.avatar
    }));
    const message = JSON.stringify({ type: 'viewers', data: viewerList });
    console.log(`📢 Enviando a ${clients.size} clientes: ${viewerList.length} espectadores (con avatar: ${viewerList.filter(v => v.avatar).length})`);
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

async function addOrUpdateViewer(userData) {
    const uniqueId = userData.uniqueId;
    if (!uniqueId) return;
    
    // Primero intentar obtener avatar de los datos del live
    let avatarUrl = extractAvatarFromUserData(userData);
    
    const existing = viewers.get(uniqueId);
    
    // Si no tenemos avatar aún, intentar obtenerlo de la API de TikTok
    if (!avatarUrl && (!existing || !existing.avatar)) {
        console.log(`🔍 Buscando avatar REAL para @${uniqueId}...`);
        avatarUrl = await fetchRealAvatar(uniqueId);
        // Pequeña pausa para no sobrecargar
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    if (!existing || existing.avatar !== avatarUrl) {
        viewers.set(uniqueId, {
            username: uniqueId,
            nickname: userData.nickname || userData.displayId || uniqueId,
            avatar: avatarUrl || null
        });
        console.log(`${existing ? '🔄 Actualizado' : '➕ Nuevo'} espectador: @${uniqueId} (${userData.nickname || ''}) - Avatar: ${avatarUrl ? '✅ REAL' : '❌ No disponible'}`);
        broadcastViewers();
    }
}

async function connectToTikTok(username) {
    if (tiktokConnection) {
        try { await tiktokConnection.disconnect(); } catch(e) { console.log('Disconnect error:', e); }
    }
    viewers.clear();
    
    console.log(`🔌 Conectando al live de @${username}...`);
    
    tiktokConnection = new TikTokLiveConnection(username, {
        enableExtendedGiftInfo: true,
        processInitialData: true,
        requestPollingIntervalMs: 2000,
        enableWebsocketUpgrade: true
    });

    // Evento de datos de la sala
    tiktokConnection.on(WebcastEvent.ROOM_USER_SEGMENT, async (data) => {
        console.log('📊 ROOM_USER_SEGMENT recibido');
        if (data.topViewers) {
            for (const viewer of data.topViewers) {
                if (viewer.user) await addOrUpdateViewer(viewer.user);
            }
        }
    });

    // Miembros en la sala
    tiktokConnection.on(WebcastEvent.MEMBER, async (data) => {
        if (data.user) await addOrUpdateViewer(data.user);
    });

    // Unión de espectador
    tiktokConnection.on(WebcastEvent.MEMBER_JOIN, async (data) => {
        console.log(`➕ JOIN: @${data.user?.uniqueId}`);
        if (data.user) await addOrUpdateViewer(data.user);
    });

    // Salida de espectador
    tiktokConnection.on(WebcastEvent.MEMBER_LEAVE, (data) => {
        const uniqueId = data.user?.uniqueId;
        if (uniqueId && viewers.has(uniqueId)) {
            viewers.delete(uniqueId);
            console.log(`🚪 LEAVE: @${uniqueId}`);
            broadcastViewers();
        }
    });

    // Mensajes de chat
    tiktokConnection.on(WebcastEvent.CHAT, async (data) => {
        if (data.user) await addOrUpdateViewer(data.user);
        
        const comment = data.comment?.trim() || '';
        if (comment.toLowerCase().startsWith('!send')) {
            console.log(`📨 Comando detectado: ${comment}`);
            broadcastCommand(comment);
        }
    });

    // Gifts
    tiktokConnection.on(WebcastEvent.GIFT, async (data) => {
        if (data.user) await addOrUpdateViewer(data.user);
    });

    // Likes
    tiktokConnection.on(WebcastEvent.LIKE, async (data) => {
        if (data.user) await addOrUpdateViewer(data.user);
    });

    try {
        await tiktokConnection.connect();
        console.log(`✅ Conectado al live de @${username}`);
        
        // Solicitar lista inicial
        setTimeout(() => {
            console.log('📡 Solicitando lista de espectadores...');
            broadcastViewers();
        }, 3000);
        
        // Actualizar cada 15 segundos
        setInterval(() => {
            if (tiktokConnection?.isConnected) {
                console.log(`📊 Estado: ${viewers.size} espectadores en sala (con avatar: ${Array.from(viewers.values()).filter(v => v.avatar).length})`);
                broadcastViewers();
            }
        }, 15000);
        
    } catch (err) {
        console.error(`❌ Error de conexión: ${err.message}`);
    }
}

// Endpoint para conectar a un live
app.get('/connect/:username', async (req, res) => {
    try {
        await connectToTikTok(req.params.username);
        res.json({ status: 'connected', username: req.params.username });
    } catch (err) {
        res.json({ status: 'error', error: err.message });
    }
});

// Endpoint para obtener avatar de un usuario específico
app.get('/avatar/:username', async (req, res) => {
    const avatar = await fetchRealAvatar(req.params.username);
    res.json({ username: req.params.username, avatar });
});

// Endpoint para ver estado
app.get('/status', (req, res) => {
    const viewersList = Array.from(viewers.values()).map(v => ({
        username: v.username,
        nickname: v.nickname,
        hasAvatar: !!v.avatar
    }));
    res.json({ 
        connected: tiktokConnection?.isConnected || false, 
        viewers: viewers.size,
        viewersList
    });
});

// Endpoint para forzar actualización de avatar de un espectador
app.get('/refresh-avatar/:username', async (req, res) => {
    const username = req.params.username;
    const avatar = await fetchRealAvatar(username);
    if (viewers.has(username)) {
        const viewer = viewers.get(username);
        viewer.avatar = avatar;
        viewers.set(username, viewer);
        broadcastViewers();
        res.json({ success: true, username, avatar });
    } else {
        res.json({ success: false, error: 'User not in viewers list' });
    }
});

// Endpoint para agregar espectador manual (prueba)
app.get('/addviewer/:username', async (req, res) => {
    const username = req.params.username;
    const avatar = await fetchRealAvatar(username);
    viewers.set(username, {
        username: username,
        nickname: username,
        avatar: avatar
    });
    broadcastViewers();
    res.json({ status: 'added', username, avatar });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));
