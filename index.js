const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 8080;
app.use(express.static(path.join(__dirname, 'public')));

const clients = new Set();
let currentUsername = null;
let wsConnection = null;
let viewers = new Map();
let reconnectInterval = null;

// Función para conectar a TikTool Live WebSocket
function connectToTikTool(username) {
    if (wsConnection) {
        wsConnection.close();
    }
    if (reconnectInterval) {
        clearInterval(reconnectInterval);
    }
    
    currentUsername = username;
    console.log(`🔌 Conectando a TikTool Live para @${username}...`);
    
    // Usar WebSocket de TikTool (sin API key para pruebas, con límite)
    const wsUrl = `wss://api.tik.tools/live/${username}`;
    wsConnection = new WebSocket(wsUrl);
    
    wsConnection.on('open', () => {
        console.log(`✅ Conectado a TikTool Live de @${username}`);
        broadcastToClients({ type: 'connected', username });
    });
    
    wsConnection.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            console.log('📨 Mensaje recibido:', JSON.stringify(message).substring(0, 200));
            
            // Procesar diferentes tipos de mensajes
            if (message.type === 'viewer' || message.type === 'member_join') {
                const user = message.data || message;
                const uniqueId = user.uniqueId || user.username;
                if (uniqueId) {
                    const avatar = user.avatar || user.profilePicture || null;
                    viewers.set(uniqueId, {
                        username: uniqueId,
                        nickname: user.nickname || user.displayName || uniqueId,
                        avatar: avatar
                    });
                    console.log(`👥 Espectador: @${uniqueId} - Avatar: ${avatar ? '✅' : '❌'}`);
                    broadcastViewers();
                }
            }
            
            // Mensaje de chat
            if (message.type === 'chat') {
                const user = message.data?.user || message.user;
                const comment = message.data?.comment || message.comment;
                if (user && comment && comment.toLowerCase().startsWith('!send')) {
                    broadcastCommand(comment);
                }
                if (user) {
                    const uniqueId = user.uniqueId || user.username;
                    if (uniqueId && !viewers.has(uniqueId)) {
                        viewers.set(uniqueId, {
                            username: uniqueId,
                            nickname: user.nickname || uniqueId,
                            avatar: user.avatar || null
                        });
                        broadcastViewers();
                    }
                }
            }
            
            // Lista de espectadores actuales
            if (message.type === 'viewer_list' && message.data) {
                message.data.forEach(user => {
                    const uniqueId = user.uniqueId || user.username;
                    if (uniqueId) {
                        viewers.set(uniqueId, {
                            username: uniqueId,
                            nickname: user.nickname || uniqueId,
                            avatar: user.avatar || user.profilePicture || null
                        });
                    }
                });
                broadcastViewers();
            }
            
            // Gifts
            if (message.type === 'gift') {
                const user = message.data?.user || message.user;
                if (user) {
                    const uniqueId = user.uniqueId || user.username;
                    if (uniqueId && !viewers.has(uniqueId)) {
                        viewers.set(uniqueId, {
                            username: uniqueId,
                            nickname: user.nickname || uniqueId,
                            avatar: user.avatar || null
                        });
                        broadcastViewers();
                    }
                }
            }
            
        } catch (e) {
            console.error('Error procesando mensaje:', e);
        }
    });
    
    wsConnection.on('error', (error) => {
        console.error('❌ Error WebSocket:', error.message);
    });
    
    wsConnection.on('close', () => {
        console.log('🔌 Desconectado de TikTool Live');
        broadcastToClients({ type: 'disconnected' });
        
        // Intentar reconectar cada 10 segundos
        reconnectInterval = setInterval(() => {
            console.log('🔄 Intentando reconectar...');
            connectToTikTool(currentUsername);
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
    console.log(`📢 Enviando ${viewerList.length} espectadores (con avatar: ${viewerList.filter(v => v.avatar).length})`);
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
    if (currentUsername) {
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
    
    res.json({ status: 'connecting', username });
});

app.get('/status', (req, res) => {
    res.json({
        connected: wsConnection && wsConnection.readyState === WebSocket.OPEN,
        username: currentUsername,
        viewers: viewers.size,
        viewersList: Array.from(viewers.keys())
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
    console.log(`📡 Conéctate a un live: https://tu-app.onrender.com/connect/@username`);
});
