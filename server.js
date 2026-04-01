/**
 * OUTBREAK — Multiplayer Game Server (fixed)
 * Run with:  node server.js
 * Requires:  npm install express socket.io
 */
 
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
 
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
});
 
const PORT = process.env.PORT || 3000;
 
// ── Static files ──────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
 
app.get('/', (req, res) => {
    const htmlPath = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(htmlPath)) {
        res.sendFile(htmlPath);
    } else {
        res.send(`<h2>Outbreak Server Running</h2><p>Place your game HTML as <strong>public/index.html</strong>.</p>`);
    }
});
 
// ── Room management ───────────────────────────────
const rooms = {};
 
setInterval(() => {
    const now = Date.now();
    Object.keys(rooms).forEach(code => {
        const room = rooms[code];
        if (room.players.length === 0 && (now - room.created) > 10 * 60 * 1000) {
            delete rooms[code];
        }
    });
}, 60_000);
 
function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do { code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
    while (rooms[code]);
    return code;
}
 
function getRoomForSocket(socketId) {
    return Object.values(rooms).find(r => r.players.some(p => p.socketId === socketId)) || null;
}
 
function getPlayerInRoom(room, socketId) {
    return room.players.find(p => p.socketId === socketId) || null;
}
 
function broadcastLobbyUpdate(room) {
    io.to(room.code).emit('lobby:update', {
        players: room.players.map(p => ({ name: p.name, playerIdx: p.playerIdx, isHost: p.isHost })),
        count: room.players.length
    });
}
 
function broadcastToRoom(room, event, data, excludeSocketId = null) {
    room.players.forEach(p => {
        if (p.socketId !== excludeSocketId) {
            io.to(p.socketId).emit(event, data);
        }
    });
}
 
// ── Socket.IO ─────────────────────────────────────
io.on('connection', socket => {
    console.log(`[connect]  ${socket.id}`);
 
    // LOBBY
    socket.on('room:create', ({ hostName }) => {
        const code = generateRoomCode();
        rooms[code] = {
            code,
            hostSocketId: socket.id,
            players: [{ socketId: socket.id, name: hostName || 'Host', playerIdx: 0, isHost: true }],
            gameStarted: false,
            gameState: null,
            created: Date.now()
        };
        socket.join(code);
        socket.emit('room:created', { code, yourIdx: 0 });
        broadcastLobbyUpdate(rooms[code]);
        console.log(`[room]     Created ${code} by ${hostName}`);
    });
 
    socket.on('room:join', ({ code, name }) => {
        const room = rooms[code];
        if (!room) { socket.emit('room:error', { message: 'Room not found.' }); return; }
        if (room.gameStarted) { socket.emit('room:error', { message: 'Game already in progress.' }); return; }
        if (room.players.length >= 6) { socket.emit('room:error', { message: 'Room is full (max 6).' }); return; }
 
        const playerIdx = room.players.length;
        room.players.push({ socketId: socket.id, name: name || `Player ${playerIdx + 1}`, playerIdx, isHost: false });
        socket.join(code);
        socket.emit('room:joined', {
            code, yourIdx: playerIdx,
            players: room.players.map(p => ({ name: p.name, playerIdx: p.playerIdx, isHost: p.isHost }))
        });
        broadcastLobbyUpdate(room);
        console.log(`[room]     ${name} joined ${code} as player ${playerIdx}`);
    });
 
    socket.on('room:update-name', ({ name }) => {
        const room = getRoomForSocket(socket.id); if (!room) return;
        const player = getPlayerInRoom(room, socket.id); if (!player) return;
        player.name = name;
        broadcastLobbyUpdate(room);
    });
 
    // GAME START — host emits this; server relays role-reveal to ALL players (incl. host)
    socket.on('game:start', ({ pathogenIdx, players, turnQueue }) => {
        const room = getRoomForSocket(socket.id);
        if (!room || room.hostSocketId !== socket.id) return;
        if (room.players.length < 3) { socket.emit('room:error', { message: 'Need at least 3 players.' }); return; }
 
        room.gameStarted = true;
 
        // Send each player their own role-reveal (including host)
        room.players.forEach(p => {
            io.to(p.socketId).emit('game:role-reveal', {
                pathogenIdx, players, turnQueue, yourIdx: p.playerIdx
            });
        });
        console.log(`[game]     Started room ${room.code}, pathogen=player${pathogenIdx}`);
    });
 
    // PUBLIC STATE SYNC (host → guests)
    socket.on('game:public-update', ({ state }) => {
        const room = getRoomForSocket(socket.id);
        if (!room || room.hostSocketId !== socket.id) return;
        room.gameState = state;
        broadcastToRoom(room, 'game:public-update', { state }, socket.id);
    });
 
    // TURN DELIVERY (host → specific player by playerIdx)
    socket.on('game:send-turn', ({ toPlayerIdx, privateState, isPathogen, round }) => {
        const room = getRoomForSocket(socket.id);
        if (!room || room.hostSocketId !== socket.id) return;
        const target = room.players.find(p => p.playerIdx === toPlayerIdx);
        if (!target) return;
        io.to(target.socketId).emit('game:your-turn', { privateState, isPathogen, round, toPlayerIdx });
        console.log(`[turn]     Room ${room.code}: turn → player${toPlayerIdx} (${target.name})`);
    });
 
    // TURN RESULT (any player → host)
    socket.on('game:turn-result', (data) => {
        const room = getRoomForSocket(socket.id); if (!room) return;
        io.to(room.hostSocketId).emit('game:turn-result', { ...data, fromSocketId: socket.id });
    });
 
    // CURE ATTEMPT (guest → host)
    socket.on('game:cure-attempt', ({ playerIdx, formula }) => {
        const room = getRoomForSocket(socket.id); if (!room) return;
        io.to(room.hostSocketId).emit('game:cure-attempt', { playerIdx, formula, fromSocketId: socket.id });
    });
 
    // CURE RESULT (host → specific player)
    socket.on('game:cure-result', ({ toPlayerIdx, pct, won, breakdown }) => {
        const room = getRoomForSocket(socket.id); if (!room) return;
        const target = room.players.find(p => p.playerIdx === toPlayerIdx);
        if (target) io.to(target.socketId).emit('game:cure-result', { pct, won, breakdown });
    });
 
    // PATHOGEN TYPE (guest pathogen → host)
    socket.on('game:pathogen-type', ({ pathogenType, activeProps, mutations }) => {
        const room = getRoomForSocket(socket.id); if (!room) return;
        io.to(room.hostSocketId).emit('game:pathogen-type', { pathogenType, activeProps, mutations });
    });
 
    // GAME OVER (host → all guests)
    socket.on('game:over', ({ winner, winnerIdx, pct }) => {
        const room = getRoomForSocket(socket.id); if (!room) return;
        broadcastToRoom(room, 'game:over', { winner, winnerIdx, pct }, socket.id);
        room.gameStarted = false;
        console.log(`[game]     Room ${room.code}: over — ${winner} wins`);
    });
 
    // TOAST RELAY
    socket.on('game:toast', ({ message, type, toPlayerIdx }) => {
        const room = getRoomForSocket(socket.id); if (!room) return;
        if (toPlayerIdx !== undefined) {
            const target = room.players.find(p => p.playerIdx === toPlayerIdx);
            if (target) io.to(target.socketId).emit('game:toast', { message, type });
        } else {
            broadcastToRoom(room, 'game:toast', { message, type }, socket.id);
        }
    });
 
    // DISCONNECT
    socket.on('disconnect', () => {
        console.log(`[disconnect] ${socket.id}`);
        const room = getRoomForSocket(socket.id); if (!room) return;
        const player = getPlayerInRoom(room, socket.id); if (!player) return;
 
        room.players = room.players.filter(p => p.socketId !== socket.id);
        socket.leave(room.code);
        if (room.players.length === 0) return;
 
        if (room.hostSocketId === socket.id) {
            const newHost = room.players[0];
            newHost.isHost = true;
            room.hostSocketId = newHost.socketId;
            io.to(newHost.socketId).emit('room:promoted-to-host', {
                message: 'Previous host disconnected. You are now the host.'
            });
        }
 
        room.players.forEach((p, i) => { p.playerIdx = i; });
        broadcastLobbyUpdate(room);
 
        if (room.gameStarted) {
            broadcastToRoom(room, 'game:player-disconnected', { name: player.name, playerIdx: player.playerIdx });
        }
        console.log(`[room]     ${player.name} left ${room.code} (${room.players.length} remaining)`);
    });
});
 
// Status endpoint
app.get('/status', (req, res) => {
    res.json({
        rooms: Object.values(rooms).map(r => ({
            code: r.code, players: r.players.map(p => p.name), started: r.gameStarted
        })),
        total: Object.keys(rooms).length
    });
});
 
server.listen(PORT, () => {
    console.log(`\n  OUTBREAK server running at http://localhost:${PORT}\n`);
});
