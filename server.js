/**
 * Virtual Cinema — Signaling Server
 * Pure WebRTC signaling only. No media data flows through this server.
 * Optimized for Render free tier.
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// ─── Environment ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const ROOM_PASSWORD = process.env.ROOM_PASSWORD || 'cinema123';
const MAX_USERS = 2; // Private room for two

// ─── Socket.io ────────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// ─── Static Files ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => res.json({ status: 'ok', users: roomState.users.size }));

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Room State ───────────────────────────────────────────────────────────────
const roomState = {
  users: new Map(), // socketId → { name, isStreaming }
  messages: [],     // Persist last 50 messages in memory
};

// ─── Socket.io Event Handlers ─────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[CONNECT] ${socket.id}`);

  // ── Auth ──────────────────────────────────────────────────────────────────
  socket.on('auth', ({ password, name }) => {
    if (password !== ROOM_PASSWORD) {
      socket.emit('auth:fail', { message: 'Incorrect password.' });
      return;
    }

    if (roomState.users.size >= MAX_USERS) {
      socket.emit('auth:fail', { message: 'Room is full (max 2 users).' });
      return;
    }

    const userName = (name || 'Guest').trim().slice(0, 20) || 'Guest';
    roomState.users.set(socket.id, { name: userName, isStreaming: false });

    socket.join('cinema');
    socket.emit('auth:ok', {
      userId: socket.id,
      userName,
      history: roomState.messages.slice(-50),
      peers: [...roomState.users.entries()]
        .filter(([id]) => id !== socket.id)
        .map(([id, u]) => ({ id, name: u.name, isStreaming: u.isStreaming })),
    });

    socket.to('cinema').emit('peer:joined', {
      id: socket.id,
      name: userName,
    });

    console.log(`[AUTH OK] ${userName} (${socket.id}) — Room: ${roomState.users.size}/${MAX_USERS}`);
  });

  // ── Chat ──────────────────────────────────────────────────────────────────
  socket.on('chat:message', ({ text }) => {
    const user = roomState.users.get(socket.id);
    if (!user || !text?.trim()) return;

    const msg = {
      id: `${Date.now()}-${socket.id}`,
      from: user.name,
      fromId: socket.id,
      text: text.trim().slice(0, 500),
      ts: Date.now(),
    };

    roomState.messages.push(msg);
    if (roomState.messages.length > 50) roomState.messages.shift();

    io.to('cinema').emit('chat:message', msg);
  });

  // ── WebRTC Signaling ──────────────────────────────────────────────────────
  socket.on('signal:offer', ({ to, offer }) => {
    socket.to(to).emit('signal:offer', { from: socket.id, offer });
  });

  socket.on('signal:answer', ({ to, answer }) => {
    socket.to(to).emit('signal:answer', { from: socket.id, answer });
  });

  socket.on('signal:ice', ({ to, candidate }) => {
    socket.to(to).emit('signal:ice', { from: socket.id, candidate });
  });

  // ── Streaming State ───────────────────────────────────────────────────────
  socket.on('stream:start', ({ type }) => {
    const user = roomState.users.get(socket.id);
    if (!user) return;
    user.isStreaming = true;
    socket.to('cinema').emit('stream:start', { from: socket.id, type });
    console.log(`[STREAM START] ${user.name} — ${type}`);
  });

  socket.on('stream:stop', () => {
    const user = roomState.users.get(socket.id);
    if (!user) return;
    user.isStreaming = false;
    socket.to('cinema').emit('stream:stop', { from: socket.id });
    console.log(`[STREAM STOP] ${user.name}`);
  });

  // ── Disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', (reason) => {
    const user = roomState.users.get(socket.id);
    if (user) {
      console.log(`[DISCONNECT] ${user.name} — ${reason}`);
      roomState.users.delete(socket.id);
      socket.to('cinema').emit('peer:left', { id: socket.id, name: user.name });
    }
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🎬 Virtual Cinema running on port ${PORT}`);
  console.log(`🔑 Room password: ${ROOM_PASSWORD}`);
  console.log(`👥 Max users: ${MAX_USERS}\n`);
});
