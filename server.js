// ─── server.js ────────────────────────────────────────────────────────────────
// Socket wiring, player management, and boot sequence.
// ──────────────────────────────────────────────────────────────────────────────

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');

const {
  MAP_WIDTH, MAP_HEIGHT, PLAYER_RADIUS, PLAYER_SPEED_LIMIT,
  PLAYER_MAX_HP, PLAYER_RESPAWN_DELAY, MAX_ENEMIES, ENEMY_AI_TICK,
  BLOCK_SIZE, BLOCK_STARTING_COUNT,
} = require('./constants');

const { ATTACK_DEFS, createAttackHandlers } = require('./attacks');
const { createEnemySystem }                 = require('./enemies');

// ─── Class Config ─────────────────────────────────────────────────────────────
const CLASS_COLORS = {
  warrior: '#e63946', ranger: '#2a9d8f', mage: '#9b5de5', rogue: '#f4a261',
};
const VALID_CLASSES = new Set(Object.keys(CLASS_COLORS));

function sanitizeName(raw) {
  const cleaned = String(raw ?? '').replace(/[^a-zA-Z0-9_\-]/g, '').slice(0, 8);
  return cleaned.length > 0 ? cleaned : 'anon';
}

// ─── Shared State ─────────────────────────────────────────────────────────────
const players     = {};
const enemies     = {};
const projectiles = {};
const aoeZones    = {};
const blocks      = {};
const damageTimers = {};
let blockIdCounter = 0;

// ─── Server Setup ─────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.static('public'));

// ─── Subsystems ───────────────────────────────────────────────────────────────
const { spawnEnemy, killEnemy, runEnemyAI, clientView } = createEnemySystem({
  enemies, players, damageTimers, io,
});

const { handlePrimary, handleChargeRelease, tickProjectiles, tickAoeZones } =
  createAttackHandlers({ players, enemies, projectiles, aoeZones, blocks, killEnemy, io });

// ─── Player Helpers ───────────────────────────────────────────────────────────
function clampToBounds(x, y, radius = PLAYER_RADIUS) {
  return {
    x: Math.max(radius, Math.min(MAP_WIDTH  - radius, x)),
    y: Math.max(radius, Math.min(MAP_HEIGHT - radius, y)),
  };
}

function distance(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function resolvePlayerCollision(a, b) {
  const d = distance(a, b);
  const minD = PLAYER_RADIUS * 2;
  if (d < minD && d > 0) {
    const ov = (minD - d) / 2;
    const nx = (b.x - a.x) / d, ny = (b.y - a.y) / d;
    a.x -= nx * ov; a.y -= ny * ov;
    b.x += nx * ov; b.y += ny * ov;
    Object.assign(a, clampToBounds(a.x, a.y));
    Object.assign(b, clampToBounds(b.x, b.y));
  }
}

function resolvePlayerBlockCollision(p) {
  const half = BLOCK_SIZE / 2;
  for (const block of Object.values(blocks)) {
    // Find nearest point on block to player center
    const nearX = Math.max(block.x - half, Math.min(block.x + half, p.x));
    const nearY = Math.max(block.y - half, Math.min(block.y + half, p.y));
    const dx = p.x - nearX, dy = p.y - nearY;
    const dist = Math.sqrt(dx*dx + dy*dy);
    if (dist < PLAYER_RADIUS && dist > 0) {
      const push = PLAYER_RADIUS - dist;
      p.x += (dx / dist) * push;
      p.y += (dy / dist) * push;
      const c = clampToBounds(p.x, p.y);
      p.x = c.x; p.y = c.y;
    }
  }
}


function killPlayer(playerId) {
  const p = players[playerId];
  if (!p || p.dead) return;
  p.dead = true;
  // Drop owned blocks — they stay in the world but go unclaimed
  for (const block of Object.values(blocks)) {
    if (block.ownerId === playerId) {
      block.ownerId = null;
      io.emit('blockUnclaimed', { id: block.id });
    }
  }
  io.emit('playerDied', { id: playerId });
  setTimeout(() => {
    if (!players[playerId]) return;
    const pos = clampToBounds(
      Math.random() * (MAP_WIDTH  - 100) + 50,
      Math.random() * (MAP_HEIGHT - 100) + 50
    );
    p.x = pos.x; p.y = pos.y; p.hp = PLAYER_MAX_HP; p.dead = false;
    p.blocks = BLOCK_STARTING_COUNT;
    p.iframeUntil = Date.now() + 2000;
    io.emit('playerRespawned', { id: playerId, x: p.x, y: p.y, hp: p.hp });
    const sock = io.sockets.sockets.get(playerId);
if (sock) sock.emit('blockCount', { blocks: p.blocks });
  }, PLAYER_RESPAWN_DELAY);
}

// ─── Sockets ──────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id.slice(0, 6));
  players[socket.id] = { joined: false };

  socket.emit('hello', {
    id: socket.id,
    mapWidth: MAP_WIDTH, mapHeight: MAP_HEIGHT,
    playerRadius: PLAYER_RADIUS, playerMaxHp: PLAYER_MAX_HP,
    attackDefs: ATTACK_DEFS,
  });

  socket.on('join', (data) => {
    if (players[socket.id]?.joined) return;
    const cls  = VALID_CLASSES.has(data.class) ? data.class : 'warrior';
    const name = sanitizeName(data.name);
    const pos  = clampToBounds(
      Math.random() * (MAP_WIDTH  - 100) + 50,
      Math.random() * (MAP_HEIGHT - 100) + 50
    );
    players[socket.id] = {
      joined: true, name, x: pos.x, y: pos.y,
      class: cls, color: CLASS_COLORS[cls],
      hp: PLAYER_MAX_HP, maxHp: PLAYER_MAX_HP, dead: false,
      lastPrimary: 0, lastSecondary: 0, iframeUntil: 0,
      blocks: BLOCK_STARTING_COUNT,
    };
    const p = players[socket.id];
    socket.emit('init', {
      id: socket.id,
      mapWidth: MAP_WIDTH, mapHeight: MAP_HEIGHT,
      playerRadius: PLAYER_RADIUS, playerMaxHp: PLAYER_MAX_HP,
      attackDefs: ATTACK_DEFS,
      players: Object.fromEntries(Object.entries(players).filter(([, pl]) => pl.joined)),
      enemies: Object.fromEntries(Object.entries(enemies).map(([k, v]) => [k, clientView(v)])),
      blocks:  Object.values(blocks),
    });
    socket.broadcast.emit('playerJoined', {
      id: socket.id, name: p.name, x: p.x, y: p.y,
      class: p.class, color: p.color, hp: p.hp, maxHp: p.maxHp, dead: false,
    });
    console.log(`Joined: ${name} (${cls})`);
    socket.emit('blockCount', { blocks: p.blocks });
  });

  socket.on('move', (data) => {
    const p = players[socket.id];
    if (!p?.joined || p.dead) return;
    const dx = data.x - p.x, dy = data.y - p.y;
    if (Math.sqrt(dx*dx + dy*dy) > PLAYER_SPEED_LIMIT * 4) {
      socket.emit('correction', { x: p.x, y: p.y }); return;
    }
    const c = clampToBounds(data.x, data.y);
    p.x = c.x; p.y = c.y;
    for (const [oid, other] of Object.entries(players)) {
      if (oid !== socket.id && other.joined) resolvePlayerCollision(p, other);
    }
    resolvePlayerBlockCollision(p);
    io.emit('playerMoved', { id: socket.id, x: p.x, y: p.y });
    for (const [oid, other] of Object.entries(players)) {
      if (oid !== socket.id && other.joined) io.emit('playerMoved', { id: oid, x: other.x, y: other.y });
    }
  });

  socket.on('primaryAttack', (data) => {
    const p = players[socket.id];
    if (!p?.joined || p.dead) return;
    handlePrimary(socket.id, data);
  });

  socket.on('placeBlock', () => {
    const p = players[socket.id];
    if (!p?.joined || p.dead) return;
    if ((p.blocks || 0) <= 0) return;
    const id = `block_${blockIdCounter++}`;
    blocks[id] = { id, x: p.x, y: p.y, ownerId: socket.id, color: p.color };
    p.blocks--;
    io.emit('blockPlaced', blocks[id]);
    socket.emit('blockCount', { blocks: p.blocks });
  });

  socket.on('secondaryRelease', (data) => {
    const p = players[socket.id];
    if (!p?.joined || p.dead) return;
    handleChargeRelease(socket.id, data);
  });

  socket.on('disconnect', () => {
    const p = players[socket.id];
    console.log(`Disconnected: ${p?.name ?? '(lobby)'} [${socket.id.slice(0, 6)}]`);
    delete players[socket.id];
    io.emit('playerLeft', socket.id);
  });
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
for (let i = 0; i < MAX_ENEMIES; i++) spawnEnemy();
setInterval(
  () => runEnemyAI(tickProjectiles, tickAoeZones, killPlayer),
  ENEMY_AI_TICK
);

server.listen(3000, () => {
  console.log(`Server → http://localhost:3000`);
  console.log(`Map: ${MAP_WIDTH}x${MAP_HEIGHT} | Enemies: ${MAX_ENEMIES} | Tick: ${ENEMY_AI_TICK}ms`);
});