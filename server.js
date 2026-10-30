const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const rooms = new Map();

// 4 位邀请码（去掉了易混淆的 0/O、1/I）
function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < 4; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

function clearRoomTimer(room) {
  if (room.disconnectTimer) {
    clearTimeout(room.disconnectTimer);
    room.disconnectTimer = null;
  }
}

// 重新计算断线倒计时（两人都掉线 1 分钟，单人掉线 5 分钟）
function refreshDisconnectTimer(room, roomId) {
  clearRoomTimer(room);
  const bothDisconnected = room.players.every(p => p.id === null || p.disconnected);
  const timeoutMs = bothDisconnected ? 60000 : 300000;
  room.disconnectTimer = setTimeout(() => {
    if (rooms.get(roomId)) rooms.delete(roomId);
  }, timeoutMs);
}

io.on('connection', (socket) => {

  // ========== 创建房间 ==========
  socket.on('createRoom', () => {
    const roomId = generateRoomId();
    const room = {
      players: [
        { id: socket.id, role: 'player1', guess: null, action: null, disconnected: false },
        { id: null, role: 'player2', guess: null, action: null, disconnected: false }
      ],
      round: 1,
      history: [],
      phase: 'waiting', // waiting | guessing | result | finished
      disconnectTimer: null,
    };
    rooms.set(roomId, room);
    socket.join(roomId);
    socket.emit('roomCreated', { roomId, role: 'player1' });
  });

  // ========== 加入房间 ==========
  socket.on('joinRoom', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return socket.emit('error', '房间不存在');
    if (room.players[1].id) return socket.emit('error', '房间已满');

    room.players[1].id = socket.id;
    room.players[1].disconnected = false;
    socket.join(roomId);
    clearRoomTimer(room);

    room.phase = 'guessing';
    io.to(roomId).emit('gameStart', {
      round: room.round,
      previousWords: null,
    });
  });

  // ========== 重连（刷新后凭身份回房） ==========
  socket.on('rejoin', ({ roomId, role }) => {
    const room = rooms.get(roomId);
    if (!room) return socket.emit('error', '房间已关闭');

    const idx = role === 'player1' ? 0 : 1;
    const player = room.players[idx];
    player.id = socket.id;
    player.disconnected = false;
    socket.join(roomId);
    clearRoomTimer(room);

    const opp = room.players[1 - idx];
    const lastRound = room.history[room.history.length - 1] || null;

    socket.emit('rejoined', {
      role,
      round: room.round,
      phase: room.phase,
      history: room.history,
      myGuess: player.guess,
      opponentSubmitted: opp.guess !== null,
      myAction: player.action,
      opponentAction: opp.action,
      previousWords: room.history.length > 0
        ? { player1: lastRound.player1, player2: lastRound.player2 }
        : null,
    });

    if (opp.id) io.to(opp.id).emit('opponentReconnected');
  });

  // ========== 提交猜测 ==========
  socket.on('submitGuess', ({ roomId, guess }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase !== 'guessing') return;

    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx === -1 || room.players[idx].guess !== null) return;

    room.players[idx].guess = guess.trim().slice(0, 30);
    socket.emit('guessConfirmed', room.players[idx].guess);

    const opp = room.players[1 - idx];
    if (opp.id) io.to(opp.id).emit('opponentSubmitted');

    // 双方都已提交
    if (room.players[0].guess !== null && room.players[1].guess !== null) {
      room.phase = 'result';
      const p1 = room.players[0];
      const p2 = room.players[1];
      room.history.push({ round: room.round, player1: p1.guess, player2: p2.guess });

      io.to(roomId).emit('roundResult', {
        round: room.round,
        player1: p1.guess,
        player2: p2.guess,
        history: room.history,
      });
    }
  });

  // ========== 结果后的选择（下一轮 / 认为同义） ==========
  socket.on('resultAction', ({ roomId, action }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase !== 'result') return;

    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx === -1 || room.players[idx].action !== null) return;

    room.players[idx].action = action;
    socket.emit('actionConfirmed', action);

    const opp = room.players[1 - idx];
    if (opp.id) io.to(opp.id).emit('opponentAction', { action });

    // 双方都已选择
    if (room.players[0].action !== null && room.players[1].action !== null) {
      const bothSame = room.players[0].action === 'same' && room.players[1].action === 'same';

      if (bothSame) {
        room.phase = 'finished';
        io.to(roomId).emit('victory', {
          roomId,
          words: { player1: room.players[0].guess, player2: room.players[1].guess },
          history: room.history,
        });
      } else {
        // 进入下一轮
        room.round += 1;
        room.players[0].guess = null;
        room.players[1].guess = null;
        room.players[0].action = null;
        room.players[1].action = null;
        room.phase = 'guessing';

        const last = room.history[room.history.length - 1];
        io.to(roomId).emit('newRound', {
          round: room.round,
          previousWords: { player1: last.player1, player2: last.player2 },
          history: room.history,
        });
      }
    }
  });

  // ========== 再来一局 ==========
  socket.on('playAgain', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    room.round = 1;
    room.history = [];
    room.players[0].guess = null;
    room.players[1].guess = null;
    room.players[0].action = null;
    room.players[1].action = null;
    room.phase = 'guessing';

    io.to(roomId).emit('gameRestart', { round: 1, previousWords: null });
  });

  // ========== 断线 ==========
  socket.on('disconnect', () => {
    for (const [roomId, room] of rooms.entries()) {
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        room.players[idx].disconnected = true;
        refreshDisconnectTimer(room, roomId);
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 服务器运行在 [http://localhost](http://localhost):${PORT}`);
});