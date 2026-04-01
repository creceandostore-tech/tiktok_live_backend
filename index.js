const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 8080;
app.use(express.static(path.join(__dirname, 'public')));

// TU API KEY DE TIKTOOL
const TIKTOOL_API_KEY = 'tk_19ccc744ea1023f55fc03ede8dd300da8519a313022ab447';

const clients = new Set();
let currentUsername = null;
let wsConnection = null;
let viewers = new Map();
let reconnectInterval = null;

function connectToTikTool(username) {
    if (wsConnection) {
        try { wsConnection.close(); } catch(e) {}
    }
    if (reconnectInterval) {
        clearInterval(reconnectInterval);
    }
    
    currentUsername = username;
    console.log(`🔌 Conectando a TikTool Live para @${username}...`);
    
    // Usar WebSocket de TikTool con API KEY
    const wsUrl = `wss://api.tik.tools/live/${username}?apiKey=${TIKTOOL_API_KEY}`;
    wsConnection = new WebSocket(wsUrl);
    
    wsConnection.on('open', () => {
        console.log(`✅ Conectado a TikTool Live de @${username}`);
        broadcastToClients({ type: 'connected', username });
    });
    
    wsConnection.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            
            // Mostrar en logs el tipo de mensaje recibido
            if (message.type) {
                console.log(`📨 Tipo: ${message.type}`);
            }
            
            // Procesar JOIN de espectador (contiene avatar real)
            if (message.type === 'member_join' || message.type === 'viewer') {
                const user = message.data || message;
                const uniqueId = user.uniqueId || user.username;
                if (uniqueId) {
                    // Extraer avatar real de TikTok
                    let avatarUrl = null;
                    if (user.avatar) avatarUrl = user.avatar;
                    if (user.profilePicture) avatarUrl = user.profilePicture;
                    if (user.avatarThumbnail) avatarUrl = user.avatarThumbnail;
                    if (user.avatarMedium) avatarUrl = user.avatarMedium;
                    
                    // Asegurar HTTPS
                    if (avatarUrl && avatarUrl.startsWith('http://')) {
                        avatarUrl = avatarUrl.replace('http://', 'https://');
                    }
                    
                    viewers.set(uniqueId, {
                        username: uniqueId,
                        nickname: user.nickname || user.displayName || user.name || uniqueId,
                        avatar: avatarUrl || null
                    });
                    console.log(`👥 ${message.type === 'member_join' ? '➕ JOIN' : '👤 VIEWER'}: @${uniqueId} - Avatar: ${avatarUrl ? '✅ REAL' : '❌ No disponible'}`);
                    if (avatarUrl) console.log(`   📸 Avatar URL: ${avatarUrl.substring(0, 80)}...`);
                    broadcastViewers();
                }
            }
            
            // Procesar lista completa de espectadores
            if (message.type === 'viewer_list' && Array.isArray(message.data)) {
                console.log(`📋 Recibida lista de ${message.data.length} espectadores`);
                message.data.forEach(user => {
                    const uniqueId = user.uniqueId || user.username;
                    if (uniqueId) {
                        let avatarUrl = user.avatar || user.profilePicture || null;
                        if (avatarUrl && avatarUrl.startsWith('http://')) {
                            avatarUrl = avatarUrl.replace('http://', 'https://');
                        }
                        viewers.set(uniqueId, {
                            username: uniqueId,
                            nickname: user.nickname || uniqueId,
                            avatar: avatarUrl
                        });
                    }
                });
                broadcastViewers();
            }
            
            // Procesar mensajes de chat
            if (message.type === 'chat') {
                const user = message.user || (message.data && message.data.user);
                const comment = message.comment || (message.data && message.data.comment);
                if (user) {
                    const uniqueId = user.uniqueId || user.username;
                    if (uniqueId) {
                        let avatarUrl = user.avatar || user.profilePicture || null;
                        if (avatarUrl && avatarUrl.startsWith('http://')) {
                            avatarUrl = avatarUrl.replace('http://', 'https://');
                        }
                        if (!viewers.has(uniqueId)) {
                            viewers.set(uniqueId, {
                                username: uniqueId,
                                nickname: user.nickname || uniqueId,
                                avatar: avatarUrl
                            });
                            broadcastViewers();
                        }
                    }
                    if (comment && comment.toLowerCase().startsWith('!send')) {
                        broadcastCommand(comment);
                    }
                }
            }
            
            // Procesar gifts
            if (message.type === 'gift') {
                const user = message.user || (message.data && message.data.user);
                if (user) {
                    const uniqueId = user.uniqueId || user.username;
                    if (uniqueId && !viewers.has(uniqueId)) {
                        let avatarUrl = user.avatar || user.profilePicture || null;
                        if (avatarUrl && avatarUrl.startsWith('http://')) {
                            avatarUrl = avatarUrl.replace('http://', 'https://');
                        }
                        viewers.set(uniqueId, {
                            username: uniqueId,
                            nickname: user.nickname || uniqueId,
                            avatar: avatarUrl
                        });
                        broadcastViewers();
                    }
                }
            }
            
        } catch (e) {
            console.error('❌ Error procesando mensaje:', e.message);
        }
    });
    
    wsConnection.on('error', (error) => {
        console.error('❌ Error WebSocket:', error.message);
        broadcastToClients({ type: 'error', message: error.message });
    });
    
    wsConnection.on('close', () => {
        console.log('🔌 Desconectado de TikTool Live');
        broadcastToClients({ type: 'disconnected' });
        
        // Intentar reconectar cada 10 segundos
        if (reconnectInterval) clearInterval(reconnectInterval);
        reconnectInterval = setInterval(() => {
            if (currentUsername) {
                console.log('🔄 Intentando reconectar...');
                connectToTikTool(currentUsername);
            }
        }, 10000);
    });
}

function broadcastViewers() {
    const viewerList = Array.from(viewers.values()).map(v => ({
        username: v.username,
        nickname: v.nickname,
        avatar: v.avatar
    }));
    broadcastToClients({ type: 'viewers', data: viewerList });
    const withAvatar = viewerList.filter(v => v.avatar).length;
    console.log(`📢 Enviando ${viewerList.length} espectadores (${withAvatar} con avatar real)`);
}

function broadcastCommand(command) {
    broadcastToClients({ type: 'command', command });
}

function broadcastToClients(message) {
    const msgStr = JSON.stringify(message);
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(msgStr);
        }
    });
}

// WebSocket para los clientes frontend
wss.on('connection', (ws) => {
    console.log('📱 Cliente frontend conectado');
    clients.add(ws);
    
    // Enviar estado actual
    if (currentUsername && wsConnection && wsConnection.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'connected', username: currentUsername }));
    }
    
    // Enviar lista actual de espectadores
    const viewerList = Array.from(viewers.values()).map(v => ({
        username: v.username,
        nickname: v.nickname,
        avatar: v.avatar
    }));
    ws.send(JSON.stringify({ type: 'viewers', data: viewerList }));
    
    ws.on('close', () => {
        console.log('📱 Cliente frontend desconectado');
        clients.delete(ws);
    });
});

// Endpoints HTTP
app.get('/connect/:username', (req, res) => {
    const username = req.params.username;
    
    // Limpiar espectadores anteriores
    viewers.clear();
    
    // Conectar a TikTool Live
    connectToTikTool(username);
    
    res.json({ status: 'connecting', username, message: 'Conectando a TikTok Live...' });
});

app.get('/status', (req, res) => {
    const connected = wsConnection && wsConnection.readyState === WebSocket.OPEN;
    const viewersWithAvatars = Array.from(viewers.values()).filter(v => v.avatar).length;
    res.json({
        connected: connected,
        username: currentUsername,
        viewers: viewers.size,
        viewersWithAvatars: viewersWithAvatars,
        viewersList: Array.from(viewers.values()).map(v => ({
            username: v.username,
            hasAvatar: !!v.avatar
        }))
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
    console.log(`📡 Conéctate a un live: https://tu-app.onrender.com/connect/@username`);
    console.log(`🔑 Usando API Key de TikTool`);
});
