const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { TikTokLiveConnection, WebcastEvent } = require('tiktok-live-connector');
const path = require('path');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 8080;
app.use(express.static(path.join(__dirname, 'public')));

const clients = new Set();
let tiktokConnection = null;
let viewers = new Map();
let currentUsername = null;

const imageCache = new Map();

app.get('/proxy-image', async (req, res) => {
    const imageUrl = req.query.url;
    if (!imageUrl) {
        return res.status(400).send('No URL provided');
    }
    
    try {
        if (imageCache.has(imageUrl)) {
            const cached = imageCache.get(imageUrl);
            res.set('Content-Type', cached.contentType);
            return res.send(cached.data);
        }
        
        const response = await axios.get(imageUrl, {
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://www.tiktok.com/'
            }
        });
        
        const contentType = response.headers['content-type'];
        
        if (imageCache.size > 100) {
            const firstKey = imageCache.keys().next().value;
            imageCache.delete(firstKey);
        }
        
        imageCache.set(imageUrl, {
            data: response.data,
            contentType: contentType
        });
        
        res.set('Content-Type', contentType);
        res.set('Cache-Control', 'public, max-age=86400');
        res.send(response.data);
        
    } catch (error) {
        console.error('Error proxy image:', error.message);
        res.status(404).send('Image not found');
    }
});

function broadcastViewers() {
    const viewerList = Array.from(viewers.values()).map(v => ({
        username: v.username,
        nickname: v.nickname,
        avatar: v.avatar ? `/proxy-image?url=${encodeURIComponent(v.avatar)}` : null
    }));
    
    const message = JSON.stringify({ type: 'viewers', data: viewerList });
    console.log(`📢 Enviando lista a ${clients.size} clientes`);
    
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

function broadcastCommand(command) {
    const message = JSON.stringify({ type: 'command', command });
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(message);
    });
}

function getBestAvatar(userData) {
    const avatarFields = [
        'avatarLarge',
        'avatarMedium', 
        'avatarThumbnail',
        'profilePicture',
        'avatar',
        'picture',
        'photo'
    ];
    
    for (const field of avatarFields) {
        if (userData[field] && typeof userData[field] === 'string') {
            let url = userData[field];
            if (url.startsWith('//')) {
                url = 'https:' + url;
            }
            if (url.startsWith('http')) {
                return url;
            }
        }
    }
    
    if (userData.uniqueId) {
        return `https://ui-avatars.com/api/?background=fe2c55&color=fff&bold=true&size=100&name=${encodeURIComponent(userData.nickname || userData.uniqueId)}`;
    }
    
    return null;
}

async function connectToTikTok(username) {
    if (!username) {
        console.error('❌ Nombre de usuario no válido');
        return;
    }
    
    currentUsername = username;
    
    if (tiktokConnection) {
        try { 
            await tiktokConnection.disconnect(); 
            console.log('Desconectando conexión anterior...');
        } catch(e) {
            console.log('Error al desconectar:', e.message);
        }
    }
    
    viewers.clear();
    
    console.log(`🔌 Conectando a TikTok Live: @${username}`);
    
    tiktokConnection = new TikTokLiveConnection(username, {
        enableExtendedGiftInfo: true,
        processInitialData: true,
        requestPollingIntervalMs: 2000,
        websocketTimeoutMs: 15000,
        fetchChatMessages: true,
        fetchGiftMessages: true
    });

    function addOrUpdateViewer(userData) {
        if (!userData || !userData.uniqueId) return;
        
        const uniqueId = userData.uniqueId;
        const avatarUrl = getBestAvatar(userData);
        
        const existing = viewers.get(uniqueId);
        
        if (!existing || (existing.avatar === null && avatarUrl)) {
            const viewerInfo = {
                username: uniqueId,
                nickname: userData.nickname || userData.uniqueName || uniqueId,
                avatar: avatarUrl
            };
            
            viewers.set(uniqueId, viewerInfo);
            
            const action = !existing ? '➕ NUEVO' : '🔄 ACTUALIZADO';
            console.log(`${action} espectador: @${uniqueId} | ${viewerInfo.nickname} | Avatar: ${avatarUrl ? '✅' : '❌'}`);
            
            broadcastViewers();
        }
    }

    const eventsToListen = [
        WebcastEvent.MEMBER_JOIN,
        WebcastEvent.CHAT,
        WebcastEvent.GIFT,
        WebcastEvent.LIKE,
        WebcastEvent.FOLLOW,
        WebcastEvent.SHARE,
        WebcastEvent.QUESTION_NEW
    ];
    
    eventsToListen.forEach(event => {
        tiktokConnection.on(event, (data) => {
            if (data && data.user) {
                addOrUpdateViewer(data.user);
            }
        });
    });

    tiktokConnection.on(WebcastEvent.ROOM_USER, (data) => {
        console.log(`📊 Datos iniciales: ${data.viewerCount || 0} espectadores`);
        if (data.topViewers && Array.isArray(data.topViewers)) {
            data.topViewers.forEach(viewer => {
                addOrUpdateViewer(viewer);
            });
        }
    });

    tiktokConnection.on(WebcastEvent.CHAT, (data) => {
        const comment = data.comment ? data.comment.trim() : '';
        if (comment.toLowerCase().startsWith('!send')) {
            console.log(`🎮 Comando detectado: ${comment}`);
            broadcastCommand(comment);
        }
    });

    tiktokConnection.on('error', (error) => {
        console.error(`⚠️ Error: ${error.message}`);
    });

    tiktokConnection.on('disconnected', () => {
        console.log('🔴 Desconectado de TikTok Live');
    });

    try {
        await tiktokConnection.connect();
        console.log(`✅ Conectado a @${username}`);
        
        setTimeout(() => {
            console.log(`📊 Total: ${viewers.size} espectadores`);
            broadcastViewers();
        }, 5000);
        
    } catch (err) {
        console.error(`❌ Error: ${err.message}`);
        console.log('💡 Tips:');
        console.log('   1. El usuario debe estar en vivo');
        console.log('   2. Verifica el nombre de usuario');
        
        setTimeout(() => {
            if (!tiktokConnection?.isConnected) {
                console.log(`🔄 Reintentando...`);
                connectToTikTok(username);
            }
        }, 15000);
    }
}

wss.on('connection', (ws) => {
    console.log('📱 Cliente conectado');
    clients.add(ws);
    
    const viewerList = Array.from(viewers.values()).map(v => ({
        username: v.username,
        nickname: v.nickname,
        avatar: v.avatar ? `/proxy-image?url=${encodeURIComponent(v.avatar)}` : null
    }));
    
    ws.send(JSON.stringify({ type: 'viewers', data: viewerList }));
    ws.send(JSON.stringify({ type: 'connection', status: 'connected' }));
    
    ws.on('close', () => {
        console.log('📱 Cliente desconectado');
        clients.delete(ws);
    });
});

app.get('/connect/:username', async (req, res) => {
    const username = req.params.username;
    console.log(`📡 Conectando a: @${username}`);
    await connectToTikTok(username);
    res.json({ status: 'connected', username: username });
});

app.get('/status', (req, res) => {
    const viewersWithAvatars = Array.from(viewers.values()).filter(v => v.avatar).length;
    res.json({ 
        connected: tiktokConnection?.isConnected || false, 
        viewers: viewers.size,
        viewersWithAvatars: viewersWithAvatars,
        currentLive: currentUsername,
        timestamp: new Date().toISOString()
    });
});

app.get('/addtestviewer/:username', (req, res) => {
    const username = req.params.username;
    if (!viewers.has(username)) {
        const avatarUrl = `https://ui-avatars.com/api/?background=fe2c55&color=fff&bold=true&size=100&name=${encodeURIComponent(username)}`;
        viewers.set(username, {
            username: username,
            nickname: `Test_${username}`,
            avatar: avatarUrl
        });
        broadcastViewers();
        res.json({ status: 'added', username, avatar: avatarUrl });
    } else {
        res.json({ status: 'exists', username });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
    console.log(`\n🚀 Servidor: http://localhost:${PORT}`);
    console.log(`📱 Proxy de imágenes: http://localhost:${PORT}/proxy-image?url=URL_AQUI\n`);
});
