const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 8080;
app.use(express.static(path.join(__dirname, 'public')));

// TU API KEY DE TIKTOOL - NO LA COMPARTAS
const TIKTOOL_API_KEY = 'tk_19ccc744ea1023f55fc03ede8dd300da8519a313022ab447';

const clients = new Set();
let currentUsername = null;
let tikToolWs = null;
let viewers = new Map();
let reconnectTimer = null;

function connectToLive(username) {
    // Cerrar conexión anterior si existe
    if (tikToolWs) {
        try { tikToolWs.close(); } catch(e) {}
    }
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
    }
    
    currentUsername = username;
    console.log(`🔌 Conectando a @${username} con TikTool API...`);
    
    const wsUrl = `wss://api.tik.tools/live/${username}?apiKey=${TIKTOOL_API_KEY}`;
    console.log(`📡 URL: ${wsUrl}`);
    
    tikToolWs = new WebSocket(wsUrl);
    
    tikToolWs.on('open', () => {
        console.log(`✅ CONECTADO EXITOSAMENTE a @${username}`);
        broadcastToClients({ type: 'connected', username: currentUsername });
        // Limpiar espectadores anteriores al conectar
        viewers.clear();
        broadcastViewers();
    });
    
    tikToolWs.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            console.log(`📨 Tipo: ${msg.type || 'desconocido'}`);
            
            // Espectador que se une al live
            if (msg.type === 'member_join' && msg.data) {
                const user = msg.data;
                const uniqueId = user.uniqueId || user.username;
                if (uniqueId) {
                    const avatar = user.avatar || user.profilePicture || user.avatarThumbnail || null;
                    viewers.set(uniqueId, {
                        username: uniqueId,
                        nickname: user.nickname || user.displayName || uniqueId,
                        avatar: avatar
                    });
                    console.log(`➕ JOIN: @${uniqueId} - Avatar: ${avatar ? '✅' : '❌'}`);
                    if (avatar) console.log(`   📸 URL: ${avatar.substring(0, 80)}...`);
                    broadcastViewers();
                }
            }
            
            // Lista completa de espectadores actuales
            if (msg.type === 'viewer_list' && Array.isArray(msg.data)) {
                console.log(`📋 Recibida lista de ${msg.data.length} espectadores`);
                msg.data.forEach(user => {
                    const uniqueId = user.uniqueId || user.username;
                    if (uniqueId) {
                        const avatar = user.avatar || user.profilePicture || null;
                        if (!viewers.has(uniqueId)) {
                            viewers.set(uniqueId, {
                                username: uniqueId,
                                nickname: user.nickname || uniqueId,
                                avatar: avatar
                            });
                        }
                    }
                });
                broadcastViewers();
            }
            
            // Mensajes de chat
            if (msg.type === 'chat' && msg.data) {
                const user = msg.data.user;
                const comment = msg.data.comment;
                if (user && comment && comment.toLowerCase().startsWith('!send')) {
                    console.log(`📨 Comando detectado: ${comment}`);
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
            
            // Gifts (regalos)
            if (msg.type === 'gift' && msg.data) {
                const user = msg.data.user;
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
            
            // Likes
            if (msg.type === 'like' && msg.data) {
                const user = msg.data.user;
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
            console.error('❌ Error procesando mensaje:', e.message);
        }
    });
    
    tikToolWs.on('error', (error) => {
        console.error(`❌ Error WebSocket: ${error.message}`);
        broadcastToClients({ type: 'error', message: error.message });
    });
    
    tikToolWs.on('close', (code, reason) => {
        console.log(`🔌 Desconectado. Código: ${code}, Razón: ${reason || 'no especificada'}`);
        broadcastToClients({ type: 'disconnected' });
        
        // Intentar reconectar después de 10 segundos
        reconnectTimer = setTimeout(() => {
            if (currentUsername) {
                console.log('🔄 Intentando reconectar...');
                connectToLive(currentUsername);
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

// WebSocket para clientes frontend
wss.on('connection', (ws) => {
    console.log('📱 Cliente frontend conectado');
    clients.add(ws);
    
    // Enviar estado actual
    if (currentUsername && tikToolWs && tikToolWs.readyState === WebSocket.OPEN) {
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

// Endpoint para conectar a un live
app.get('/connect/:username', (req, res) => {
    const username = req.params.username;
    console.log(`🎯 SOLICITUD DE CONEXIÓN para @${username}`);
    
    if (!username || username.length < 2) {
        return res.json({ status: 'error', message: 'Username inválido' });
    }
    
    viewers.clear();
    connectToLive(username);
    
    res.json({ status: 'connecting', username, message: `Conectando a @${username}...` });
});

// Endpoint para ver estado de la conexión
app.get('/status', (req, res) => {
    const connected = tikToolWs && tikToolWs.readyState === WebSocket.OPEN;
    const viewersWithAvatar = Array.from(viewers.values()).filter(v => v.avatar).length;
    
    res.json({
        connected: connected,
        username: currentUsername,
        viewers: viewers.size,
        viewersWithAvatar: viewersWithAvatar,
        viewersList: Array.from(viewers.keys())
    });
});

// Endpoint para probar conexión (diagnóstico)
app.get('/test/:username', async (req, res) => {
    const username = req.params.username;
    console.log(`🧪 TEST para @${username}`);
    
    // Probar conexión rápida
    const testWs = new WebSocket(`wss://api.tik.tools/live/${username}?apiKey=${TIKTOOL_API_KEY}`);
    
    let timeout = setTimeout(() => {
        testWs.close();
        res.json({ 
            status: 'timeout', 
            message: `@${username} no responde - puede que no esté en vivo`,
            username 
        });
    }, 8000);
    
    testWs.on('open', () => {
        clearTimeout(timeout);
        console.log(`✅ TEST EXITOSO: @${username} está en vivo`);
        testWs.close();
        res.json({ 
            status: 'success', 
            message: `@${username} está EN VIVO y conectable`,
            username,
            live: true
        });
    });
    
    testWs.on('error', (err) => {
        clearTimeout(timeout);
        console.log(`❌ TEST FALLIDO: @${username} - ${err.message}`);
        res.json({ 
            status: 'error', 
            message: err.message,
            username,
            live: false
        });
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
    console.log(`🔑 Usando API Key de TikTool`);
    console.log(`📡 Para conectar: https://tu-app.onrender.com/connect/@username`);
    console.log(`🧪 Para probar: https://tu-app.onrender.com/test/@username`);
});
