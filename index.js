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
let currentUsername = null;

function broadcastViewers() {
    const viewerList = Array.from(viewers.values()).map(v => ({
        username: v.username,
        nickname: v.nickname,
        avatar: v.avatar || null
    }));
    
    const message = JSON.stringify({ type: 'viewers', data: viewerList });
    console.log(`📢 Enviando lista a ${clients.size} clientes:`, viewerList.slice(0, 5));
    
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

// Función para obtener el mejor avatar disponible
function getBestAvatar(userData) {
    // Prioridad de avatares
    if (userData.avatarLarge) return userData.avatarLarge;
    if (userData.avatarMedium) return userData.avatarMedium;
    if (userData.avatarThumbnail) return userData.avatarThumbnail;
    if (userData.profilePicture) return userData.profilePicture;
    if (userData.avatar) return userData.avatar;
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
        websocketTimeoutMs: 15000
    });

    function addOrUpdateViewer(userData) {
        if (!userData || !userData.uniqueId) return;
        
        const uniqueId = userData.uniqueId;
        const avatarUrl = getBestAvatar(userData);
        
        const existing = viewers.get(uniqueId);
        
        // Siempre actualizar si encontramos un avatar que no teníamos
        if (!existing || (existing.avatar === null && avatarUrl)) {
            const viewerInfo = {
                username: uniqueId,
                nickname: userData.nickname || userData.uniqueName || uniqueId,
                avatar: avatarUrl
            };
            
            viewers.set(uniqueId, viewerInfo);
            
            const action = !existing ? '➕ NUEVO' : '🔄 ACTUALIZADO';
            console.log(`${action} espectador: @${uniqueId} | Nombre: ${viewerInfo.nickname} | Avatar: ${avatarUrl ? 'SÍ ✅' : 'NO ❌'}`);
            
            // Broadcast inmediato
            broadcastViewers();
        }
    }

    // Escuchar todos los eventos posibles que pueden dar información de usuarios
    const eventsToListen = [
        WebcastEvent.MEMBER_JOIN,
        WebcastEvent.CHAT,
        WebcastEvent.GIFT,
        WebcastEvent.LIKE,
        WebcastEvent.FOLLOW,
        WebcastEvent.SHARE,
        WebcastEvent.QUESTION_NEW,
        WebcastEvent.POLL_UPDATE
    ];
    
    eventsToListen.forEach(event => {
        tiktokConnection.on(event, (data) => {
            if (data && data.user) {
                addOrUpdateViewer(data.user);
            }
        });
    });

    // Evento específico para datos iniciales del live
    tiktokConnection.on(WebcastEvent.ROOM_USER, (data) => {
        console.log(`📊 Datos iniciales recibidos: ${data.viewerCount || 0} espectadores`);
        if (data.topViewers) {
            data.topViewers.forEach(viewer => {
                addOrUpdateViewer(viewer);
            });
        }
    });

    // Manejar comandos de chat
    tiktokConnection.on(WebcastEvent.CHAT, (data) => {
        const comment = data.comment ? data.comment.trim() : '';
        if (comment.toLowerCase().startsWith('!send')) {
            console.log(`🎮 Comando detectado: ${comment}`);
            broadcastCommand(comment);
        }
    });

    // Manejar errores de conexión
    tiktokConnection.on('error', (error) => {
        console.error(`⚠️ Error en conexión TikTok: ${error.message}`);
    });

    tiktokConnection.on('disconnected', () => {
        console.log('🔴 Desconectado de TikTok Live');
    });

    try {
        await tiktokConnection.connect();
        console.log(`✅ Conectado exitosamente al live de @${username}`);
        
        // Esperar a que lleguen los datos iniciales
        setTimeout(() => {
            console.log(`📊 Estado final: ${viewers.size} espectadores registrados`);
            broadcastViewers();
        }, 5000);
        
    } catch (err) {
        console.error(`❌ Error de conexión: ${err.message}`);
        console.log('💡 Asegúrate de que:');
        console.log('   1. El usuario está haciendo live en este momento');
        console.log('   2. El nombre de usuario es correcto (sin @)');
        console.log('   3. Tienes conexión a internet estable');
        
        // Intentar reconectar automáticamente después de 15 segundos
        setTimeout(() => {
            if (!tiktokConnection?.isConnected) {
                console.log(`🔄 Reintentando conexión a @${username}...`);
                connectToTikTok(username);
            }
        }, 15000);
    }
}

wss.on('connection', (ws) => {
    console.log('📱 Cliente conectado al WebSocket');
    clients.add(ws);
    
    // Enviar lista actual inmediatamente
    const viewerList = Array.from(viewers.values()).map(v => ({
        username: v.username,
        nickname: v.nickname,
        avatar: v.avatar
    }));
    
    ws.send(JSON.stringify({ type: 'viewers', data: viewerList }));
    ws.send(JSON.stringify({ type: 'connection', status: 'connected', message: 'Conectado al servidor' }));
    
    ws.on('message', (message) => {
        console.log('Mensaje recibido del cliente:', message.toString());
    });
    
    ws.on('close', () => {
        console.log('📱 Cliente desconectado');
        clients.delete(ws);
    });
    
    ws.on('error', (error) => {
        console.error('Error en WebSocket:', error);
    });
});

app.get('/connect/:username', async (req, res) => {
    const username = req.params.username;
    console.log(`📡 Solicitud de conexión para: @${username}`);
    await connectToTikTok(username);
    res.json({ status: 'connected', username: username, timestamp: new Date().toISOString() });
});

app.get('/status', (req, res) => {
    res.json({ 
        connected: tiktokConnection?.isConnected || false, 
        viewers: viewers.size,
        currentLive: currentUsername,
        viewersList: Array.from(viewers.keys()).slice(0, 20),
        timestamp: new Date().toISOString()
    });
});

// Endpoint de prueba para agregar espectadores manualmente (para debugging)
app.get('/addtestviewer/:username', (req, res) => {
    const username = req.params.username;
    if (!viewers.has(username)) {
        viewers.set(username, {
            username: username,
            nickname: `Test_${username}`,
            avatar: `https://picsum.photos/seed/${username}/100/100` // Imagen de prueba
        });
        broadcastViewers();
        res.json({ status: 'added', username, avatar: viewers.get(username).avatar });
    } else {
        res.json({ status: 'exists', username });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
    console.log(`\n🚀 Servidor corriendo en http://localhost:${PORT}`);
    console.log(`📱 Abre esta URL en tu navegador\n`);
});
