const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 8080;
app.use(express.static(path.join(__dirname, 'public')));

const TIKTOOL_API_KEY = 'tk_19ccc744ea1023f55fc03ede8dd300da8519a313022ab447';

const clients = new Set();
let currentUsername = null;
let tiktoolWs = null;
let viewers = new Map();
let reconnectTimer = null;

// Función para conectar a TikTool
function connectToTikTool(username) {
    if (tiktoolWs) {
        try { tiktoolWs.close(); } catch(e) {}
    }
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
    }
    
    currentUsername = username;
    console.log(`🔌 Conectando a @${username} con TikTool API...`);
    
    // URL correcta de TikTool WebSocket
    const wsUrl = `wss://api.tik.tools/live/${username}?apiKey=${TIKTOOL_API_KEY}`;
    console.log(`📡 Conectando a: ${wsUrl}`);
    
    tiktoolWs = new WebSocket(wsUrl);
    
    tiktoolWs.on('open', () => {
        console.log(`✅ CONECTADO a @${username}`);
        broadcastToClients({ type: 'connected', username });
        // Limpiar espectadores anteriores
        viewers.clear();
        broadcastViewers();
    });
    
    tiktoolWs.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            console.log(`📨 Tipo: ${msg.type || 'unknown'}`);
            
            // Espectador que se une
            if (msg.type === 'member_join' && msg.data) {
                const user = msg.data;
                const uniqueId = user.uniqueId || user.username;
                if (uniqueId) {
                    const avatar = user.avatar || user.profilePicture || null;
                    viewers.set(uniqueId, {
                        username: uniqueId,
                        nickname: user.nickname || uniqueId,
                        avatar: avatar
                    });
                    console.log(`➕ JOIN: @${uniqueId} - Avatar: ${avatar ? '✅' : '❌'}`);
                    if (avatar) console.log(`   📸 ${avatar.substring(0, 60)}...`);
                    broadcastViewers();
                }
            }
            
            // Lista de espectadores
            if (msg.type === 'viewer_list' && Array.isArray(msg.data)) {
                console.log(`📋 Lista de ${msg.data.length} espectadores`);
                msg.data.forEach(user => {
                    const uniqueId = user.uniqueId || user.username;
                    if (uniqueId) {
                        const avatar = user.avatar || user.profilePicture || null;
                        viewers.set(uniqueId, {
                            username: uniqueId,
                            nickname: user.nickname || uniqueId,
                            avatar: avatar
                        });
                    }
                });
                broadcastViewers();
            }
            
            // Chat
            if (msg.type === 'chat' && msg.data) {
                const user = msg.data.user;
                const comment = msg.data.comment;
                if (user && comment && comment.toLowerCase().startsWith('!send')) {
                    broadcastCommand(comment);
                }
                if (user) {
                    const uniqueId = user.uniqueId || user.username;
                    if (uniqueId && !viewers.has(uniqueId)) {
                        const avatar = user.avatar || null;
                        viewers.set(uniqueId, {
                            username: uniqueId,
                            nickname: user.nickname || uniqueId,
                            avatar: avatar
                        });
                        broadcastViewers();
                    }
                }
            }
            
        } catch (e) {
            console.error('Error parsing message:', e.message);
        }
    });
    
    tiktoolWs.on('error', (error) => {
        console.error(`❌ WebSocket error: ${error.message}`);
        broadcastToClients({ type: 'error', message: error.message });
    });
    
    tiktoolWs.on('close', (code, reason) => {
        console.log(`🔌 Desconectado. Code: ${code}, Reason: ${reason || 'unknown'}`);
        broadcastToClients({ type: 'disconnected' });
        
        // Reconectar después de 5 segundos
        reconnectTimer = setTimeout(() => {
            if (currentUsername) {
                console.log('🔄 Reconectando...');
                connectToTikTool(currentUsername);
            }
        }, 5000);
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
    console.log(`📢 Enviando ${viewerList.length} espectadores (${withAvatar} con avatar)`);
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

// WebSocket para frontend
wss.on('connection', (ws) => {
    console.log('📱 Frontend conectado');
    clients.add(ws);
    
    if (currentUsername && tiktoolWs && tiktoolWs.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'connected', username: currentUsername }));
    }
    
    const viewerList = Array.from(viewers.values()).map(v => ({
        username: v.username,
        nickname: v.nickname,
        avatar: v.avatar
    }));
    ws.send(JSON.stringify({ type: 'viewers', data: viewerList }));
    
    ws.on('close', () => {
        clients.delete(ws);
    });
});

// Endpoint para conectar
app.get('/connect/:username', (req, res) => {
    const username = req.params.username;
    console.log(`📡 Conexión solicitada para @${username}`);
    
    viewers.clear();
    connectToTikTool(username);
    
    res.json({ status: 'connecting', username, message: 'Conectando a TikTok Live...' });
});

// Endpoint para ver estado
app.get('/status', (req, res) => {
    const connected = tiktoolWs && tiktoolWs.readyState === WebSocket.OPEN;
    res.json({
        connected: connected,
        username: currentUsername,
        viewers: viewers.size,
        viewersWithAvatar: Array.from(viewers.values()).filter(v => v.avatar).length
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
    console.log(`🚀 Servidor en puerto ${PORT}`);
    console.log(`🔑 API Key: ${TIKTOOL_API_KEY.substring(0, 20)}...`);
});
