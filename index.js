const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 8080;
app.use(express.static(path.join(__dirname, 'public')));

// Tu API Key de TikTool
const TIKTOOL_API_KEY = 'tk_19ccc744ea1023f55fc03ede8dd300da8519a313022ab447';

const clients = new Set();
let currentUsername = null;
let tikToolWs = null;
let viewers = new Map();

console.log('🚀 Iniciando servidor...');

// Función para conectar a TikTool
function connectToLive(username) {
    if (tikToolWs) {
        try { tikToolWs.close(); } catch(e) {}
    }
    
    currentUsername = username;
    console.log(`🔌 Conectando a @${username}...`);
    
    const wsUrl = `wss://api.tik.tools/live/${username}?apiKey=${TIKTOOL_API_KEY}`;
    console.log(`📡 WebSocket URL: ${wsUrl}`);
    
    tikToolWs = new WebSocket(wsUrl);
    
    tikToolWs.on('open', () => {
        console.log(`✅ CONECTADO a @${username}`);
        // Enviar a todos los clientes que estamos conectados
        const msg = JSON.stringify({ type: 'connected', username: currentUsername });
        clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
    });
    
    tikToolWs.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            console.log(`📨 Mensaje: ${msg.type || 'unknown'}`);
            
            // Cuando alguien se une al live
            if (msg.type === 'member_join' && msg.data) {
                const user = msg.data;
                const id = user.uniqueId || user.username;
                if (id) {
                    const avatar = user.avatar || user.profilePicture || null;
                    viewers.set(id, {
                        username: id,
                        nickname: user.nickname || id,
                        avatar: avatar
                    });
                    console.log(`➕ JOIN: @${id} ${avatar ? '📸 CON FOTO' : '📷 SIN FOTO'}`);
                    if (avatar) console.log(`   URL: ${avatar.substring(0, 60)}...`);
                    
                    // Enviar lista actualizada a todos los clientes
                    const viewerList = Array.from(viewers.values());
                    const viewersMsg = JSON.stringify({ type: 'viewers', data: viewerList });
                    clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(viewersMsg); });
                }
            }
            
            // Lista completa de espectadores
            if (msg.type === 'viewer_list' && Array.isArray(msg.data)) {
                console.log(`📋 Lista de ${msg.data.length} espectadores recibida`);
                msg.data.forEach(user => {
                    const id = user.uniqueId || user.username;
                    if (id && !viewers.has(id)) {
                        const avatar = user.avatar || user.profilePicture || null;
                        viewers.set(id, {
                            username: id,
                            nickname: user.nickname || id,
                            avatar: avatar
                        });
                    }
                });
                
                const viewerList = Array.from(viewers.values());
                const viewersMsg = JSON.stringify({ type: 'viewers', data: viewerList });
                clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(viewersMsg); });
                console.log(`📢 Enviados ${viewerList.length} espectadores (${viewerList.filter(v => v.avatar).length} con avatar)`);
            }
            
        } catch(e) {
            console.error('Error:', e.message);
        }
    });
    
    tikToolWs.on('error', (err) => {
        console.error(`❌ Error: ${err.message}`);
        const errorMsg = JSON.stringify({ type: 'error', message: err.message });
        clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(errorMsg); });
    });
    
    tikToolWs.on('close', () => {
        console.log('🔌 Desconectado');
        const disconnectMsg = JSON.stringify({ type: 'disconnected' });
        clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(disconnectMsg); });
    });
}

// WebSocket para clientes frontend
wss.on('connection', (ws) => {
    console.log('📱 Cliente conectado');
    clients.add(ws);
    
    // Enviar estado actual
    if (currentUsername && tikToolWs && tikToolWs.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'connected', username: currentUsername }));
    }
    
    // Enviar lista actual de espectadores
    const viewerList = Array.from(viewers.values());
    ws.send(JSON.stringify({ type: 'viewers', data: viewerList }));
    
    ws.on('close', () => {
        console.log('📱 Cliente desconectado');
        clients.delete(ws);
    });
});

// Endpoint para conectar
app.get('/connect/:username', (req, res) => {
    const username = req.params.username;
    console.log(`🎯 CONEXIÓN SOLICITADA: @${username}`);
    
    if (!username || username.length < 2) {
        return res.json({ status: 'error', message: 'Username inválido' });
    }
    
    // Limpiar espectadores anteriores
    viewers.clear();
    
    // Conectar
    connectToLive(username);
    
    res.json({ status: 'connecting', username, message: `Conectando a @${username}...` });
});

// Endpoint para ver estado
app.get('/status', (req, res) => {
    const connected = tikToolWs && tikToolWs.readyState === WebSocket.OPEN;
    res.json({
        connected: connected,
        username: currentUsername,
        viewers: viewers.size,
        viewersWithAvatar: Array.from(viewers.values()).filter(v => v.avatar).length
    });
});

// Endpoint de prueba
app.get('/test/:username', (req, res) => {
    const username = req.params.username;
    console.log(`🧪 TEST: @${username}`);
    
    const testWs = new WebSocket(`wss://api.tik.tools/live/${username}?apiKey=${TIKTOOL_API_KEY}`);
    
    let timeout = setTimeout(() => {
        testWs.close();
        res.json({ status: 'timeout', message: `@${username} no responde - puede que no esté en vivo` });
    }, 8000);
    
    testWs.on('open', () => {
        clearTimeout(timeout);
        console.log(`✅ TEST EXITOSO: @${username} está en vivo`);
        testWs.close();
        res.json({ status: 'success', message: `✅ @${username} está EN VIVO y conectable` });
    });
    
    testWs.on('error', (err) => {
        clearTimeout(timeout);
        console.log(`❌ TEST FALLIDO: @${username} - ${err.message}`);
        res.json({ status: 'error', message: err.message });
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
    console.log(`🔑 API Key: ${TIKTOOL_API_KEY.substring(0, 20)}...`);
    console.log(`📡 Para conectar: https://tu-app.onrender.com/connect/@username`);
    console.log(`🧪 Para probar: https://tu-app.onrender.com/test/@username`);
});
