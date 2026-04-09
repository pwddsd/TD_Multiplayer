// ─── game.js ──────────────────────────────────────────────────────────────────
// Client-side game logic: input, socket events, update, draw.
// Expects: socket (from socket.io), and DOM elements set up in index.html.
// ──────────────────────────────────────────────────────────────────────────────

// ─── DOM Refs ─────────────────────────────────────────────────────────────────
const lobbyEl    = document.getElementById('lobby');
const gameEl     = document.getElementById('game');
const canvas     = document.getElementById('gameCanvas');
const ctx        = canvas.getContext('2d');
const classLbl   = document.getElementById('classLabel');
const hpFill     = document.getElementById('hpFill');
const hpText     = document.getElementById('hpText');
const chargeWrap = document.getElementById('chargeWrap');
const chargeFill = document.getElementById('chargeFill');
const cd1El      = document.getElementById('cd1');
const cd2El      = document.getElementById('cd2');
const blockEl    = document.getElementById('blockCount');
const deathScr   = document.getElementById('deathScreen');
const respawnEl  = document.getElementById('respawnCountdown');

// ─── Constants (mirrored from server) ────────────────────────────────────────
const BRUTE_FOV_ANGLE = 2.44;
const BRUTE_FOV_RANGE = 200;
const BLOCK_SIZE      = 24;

// ─── State ────────────────────────────────────────────────────────────────────
const players     = {};
const enemies     = {};
const projectiles = {};
const aoeZones    = {};
const blocks      = {};
const vfx         = [];

const keys = {};
let myId = null, myName = null, myClass = null;
let MAP_W = 800, MAP_H = 600, RADIUS = 16, MAX_HP = 10;
const SPEED = 3;

let mouseX = 0, mouseY = 0;

let attackDefs             = {};
let primaryCooldownUntil   = 0;
let secondaryCooldownUntil = 0;
let chargeStartTime        = 0;
let isCharging             = false;
let myBlocks               = 0;

let damageFlashTimer = 0;
let iframeFlashTimer = 0;
let isDead           = false;
let respawnTimer     = null;

// ─── Socket ───────────────────────────────────────────────────────────────────
const socket = io();

// ─── Input ────────────────────────────────────────────────────────────────────
//const nameInput = document.getElementById('nameInput');
document.getElementById('enterBtn').addEventListener('click', () => {
  if (!window.selectedClass) return;
  myName  = nameInput.value.trim() || 'anon';
  myClass = window.selectedClass;
  const btn = document.getElementById('enterBtn');
  btn.disabled = true;
  btn.textContent = 'entering...';
  socket.emit('join', { class: window.selectedClass, name: myName });
});


document.addEventListener('keydown', e => {
  if (document.activeElement === nameInput) return;
  keys[e.key] = true;
  if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','w','a','s','d'].includes(e.key)) e.preventDefault();
  if (e.key === '1' && !e.repeat) { e.preventDefault(); tryPrimary(); }
  if (e.key === '2' && !e.repeat) { e.preventDefault(); startCharge(); }
  if (e.key === 'e' && !e.repeat) { e.preventDefault(); placeBlock(); }
});
document.addEventListener('keyup', e => {
  keys[e.key] = false;
  if (e.key === '2') releaseCharge();
});

canvas.addEventListener('mousemove', e => {
  const rect = canvas.getBoundingClientRect();
  mouseX = e.clientX - rect.left;
  mouseY = e.clientY - rect.top;
});
canvas.addEventListener('mousedown', e => {
  if (e.button === 0) tryPrimary();
  if (e.button === 2) startCharge();
});
canvas.addEventListener('mouseup', e => {
  if (e.button === 2) releaseCharge();
});
canvas.addEventListener('contextmenu', e => e.preventDefault());

// ─── Attack Firing ────────────────────────────────────────────────────────────
function aimAngle() {
  const p = players[myId];
  if (!p) return 0;
  return Math.atan2(mouseY - p.y, mouseX - p.x);
}

function tryPrimary() {
  if (!myId || !players[myId] || isDead) return;
  const now = Date.now();
  if (now < primaryCooldownUntil) return;
  const def = attackDefs[myClass]?.primary;
  if (!def) return;
  primaryCooldownUntil = now + def.cooldown;
  socket.emit('primaryAttack', { angle: aimAngle() });
  if (def.type === 'melee') {
    const p = players[myId];
    vfx.push({ type: 'meleeRing', x: p.x, y: p.y, radius: def.radius, life: 10, maxLife: 10, color: p.color });
  }
}

function startCharge() {
  if (!myId || !players[myId] || isDead) return;
  const def = attackDefs[myClass]?.secondary;
  if (!def || Date.now() < secondaryCooldownUntil) return;
  isCharging      = true;
  chargeStartTime = Date.now();
  chargeWrap.classList.add('visible');
}

function releaseCharge() {
  if (!isCharging) return;
  isCharging = false;
  chargeWrap.classList.remove('visible');
  chargeFill.style.width = '0%';
  if (!myId || !players[myId] || isDead) return;
  const def = attackDefs[myClass]?.secondary;
  if (!def || Date.now() < secondaryCooldownUntil) return;
  secondaryCooldownUntil = Date.now() + def.cooldown;
  socket.emit('secondaryRelease', { chargeStart: chargeStartTime, angle: aimAngle() });
}

function placeBlock() {
  if (!myId || !players[myId] || isDead) return;
  if (myBlocks <= 0) return;
  socket.emit('placeBlock');
}

// ─── Socket: Lobby → Game ─────────────────────────────────────────────────────
socket.on('hello', (data) => {
  MAP_W  = data.mapWidth;
  MAP_H  = data.mapHeight;
  RADIUS = data.playerRadius;
  MAX_HP = data.playerMaxHp;
  attackDefs    = data.attackDefs || {};
  canvas.width  = MAP_W;
  canvas.height = MAP_H;
  document.getElementById('lobbyStatus').textContent = 'server connected';
});

document.getElementById('enterBtn').addEventListener('click', () => {
  if (!window.selectedClass) return;
  myName  = nameInput.value.trim() || 'anon';
  myClass = window.selectedClass;
  const btn = document.getElementById('enterBtn');
  btn.disabled    = true;
  btn.textContent = 'entering...';
  socket.emit('join', { class: window.selectedClass, name: myName });
});

socket.on('init', (data) => {
  myId       = data.id;
  attackDefs = data.attackDefs || {};
  for (const [id, p] of Object.entries(data.players)) players[id] = { ...p };
  for (const [id, e] of Object.entries(data.enemies))  enemies[id] = { ...e };
  for (const b of (data.blocks || []))                 blocks[b.id] = { ...b };
  const me = players[myId];
  classLbl.textContent = `${me?.name ?? myName} · ${me?.class ?? '?'}`;
  updateHpBar(me?.hp ?? MAX_HP, MAX_HP);
  lobbyEl.style.display = 'none';
  gameEl.classList.add('active');
  gameLoop();
});

// ─── Socket: Game Events ──────────────────────────────────────────────────────
socket.on('playerJoined', d => {
  players[d.id] = { x:d.x, y:d.y, name:d.name, class:d.class, color:d.color, hp:d.hp, maxHp:d.maxHp, dead:false };
});
socket.on('playerMoved', d => {
  if (!players[d.id] || d.id === myId) return;
  players[d.id].x = d.x; players[d.id].y = d.y;
});
socket.on('correction', d => {
  if (players[myId]) { players[myId].x = d.x; players[myId].y = d.y; }
});
socket.on('playerLeft', id => { delete players[id]; });

socket.on('enemySpawned',  d => { enemies[d.id] = { ...d }; });
socket.on('enemiesUpdate', updates => {
  for (const u of updates) { if (enemies[u.id]) Object.assign(enemies[u.id], u); }
});
socket.on('enemyHit', d => {
  if (enemies[d.id]) { enemies[d.id].hp = d.hp; enemies[d.id].maxHp = d.maxHp; enemies[d.id]._hitFlash = 6; }
});
socket.on('enemyDied', d => { delete enemies[d.id]; });

socket.on('meleeSwing', d => {
  const p = players[d.playerId];
  vfx.push({ type: 'meleeRing', x: d.x, y: d.y, radius: d.radius, life: 10, maxLife: 10, color: p?.color ?? '#fff' });
  for (const h of (d.hits || [])) {
    if (enemies[h.id]) { enemies[h.id].hp = h.hp; enemies[h.id]._hitFlash = 6; }
    if (h.hp <= 0) delete enemies[h.id];
  }
});

socket.on('projectileSpawned', d => { projectiles[d.id] = { ...d, born: Date.now() }; });
socket.on('projectileMoved',   d => { if (projectiles[d.id]) { projectiles[d.id].x = d.x; projectiles[d.id].y = d.y; } });
socket.on('projectileHit', d => {
  if (projectiles[d.id]) {
    vfx.push({ type: 'projectileImpact', x: d.x, y: d.y, life: 8, maxLife: 8, color: projectiles[d.id].color });
    delete projectiles[d.id];
  }
  if (d.enemyId && enemies[d.enemyId]) { enemies[d.enemyId].hp = d.hp; enemies[d.enemyId]._hitFlash = 6; }
  if (d.enemyId && d.hp <= 0) delete enemies[d.enemyId];
});
socket.on('projectileGone', d => { delete projectiles[d.id]; });

socket.on('aoeSpawned', d => { aoeZones[d.id] = { ...d, spawnedAt: Date.now() }; });
socket.on('aoeGone',    d => { delete aoeZones[d.id]; });

socket.on('dashPerformed', d => {
  vfx.push({ type: 'dashTrail', x1: d.fromX, y1: d.fromY, x2: d.toX, y2: d.toY,
    life: 12, maxLife: 12, color: players[d.playerId]?.color ?? '#fff' });
  for (const h of (d.hits || [])) {
    if (enemies[h.id]) { enemies[h.id].hp = h.hp; enemies[h.id]._hitFlash = 6; }
    if (h.hp <= 0) delete enemies[h.id];
  }
  if (d.playerId === myId && players[myId]) {
    players[myId].x = d.toX; players[myId].y = d.toY;
    iframeFlashTimer = 8;
  }
});

socket.on('damaged', d => {
  if (players[myId]) { players[myId].hp = d.hp; updateHpBar(d.hp, MAX_HP); damageFlashTimer = 8; }
});
socket.on('playerDied', d => {
  if (d.id === myId) {
    isDead = true;
    deathScr.classList.add('visible');
    let secs = 3;
    respawnEl.textContent = `respawning in ${secs}s...`;
    respawnTimer = setInterval(() => {
      secs--;
      respawnEl.textContent = secs > 0 ? `respawning in ${secs}s...` : '';
      if (secs <= 0) clearInterval(respawnTimer);
    }, 1000);
  }
  if (players[d.id]) players[d.id].dead = true;
});
socket.on('playerRespawned', d => {
  if (d.id === myId) {
    isDead = false;
    deathScr.classList.remove('visible');
    clearInterval(respawnTimer);
    updateHpBar(d.hp, MAX_HP);
    iframeFlashTimer = 20;
  }
  if (players[d.id]) {
    players[d.id].x = d.x; players[d.id].y = d.y;
    players[d.id].hp = d.hp; players[d.id].dead = false;
  }
});

// ─── Socket: Block Events ─────────────────────────────────────────────────────
socket.on('blockPlaced',   d => { blocks[d.id] = { ...d }; });
socket.on('blockUnclaimed', d => { if (blocks[d.id]) blocks[d.id].ownerId = null; });
socket.on('blockCount',    d => {
  myBlocks = d.blocks;
  if (blockEl) blockEl.textContent = `blocks: ${myBlocks}`;
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function updateHpBar(hp, maxHp) {
  const pct = Math.max(0, hp / maxHp * 100);
  hpFill.style.width      = pct + '%';
  hpFill.style.background = pct > 50 ? '#2a9d8f' : pct > 25 ? '#f4a261' : '#e63946';
  hpText.textContent      = `${hp}/${maxHp}`;
}

// ─── Update ───────────────────────────────────────────────────────────────────
function update() {
  if (damageFlashTimer > 0) damageFlashTimer--;
  if (iframeFlashTimer > 0) iframeFlashTimer--;

  if (isCharging) {
    const def = attackDefs[myClass]?.secondary;
    if (def) {
      const held = Date.now() - chargeStartTime;
      const t    = def.chargeMax > 0 ? Math.min(1, Math.max(0, (held - def.chargeMin) / (def.chargeMax - def.chargeMin))) : 1;
      chargeFill.style.width      = (t * 100) + '%';
      chargeFill.style.background = t >= 1 ? '#fff' : '#888';
    }
  }

  for (let i = vfx.length - 1; i >= 0; i--) {
    vfx[i].life--;
    if (vfx[i].life <= 0) vfx.splice(i, 1);
  }

  if (!myId || !players[myId] || isDead) return;
  const p = players[myId];
  let moved = false;
  if (keys['ArrowUp']    || keys['w']) { p.y -= SPEED; moved = true; }
  if (keys['ArrowDown']  || keys['s']) { p.y += SPEED; moved = true; }
  if (keys['ArrowLeft']  || keys['a']) { p.x -= SPEED; moved = true; }
  if (keys['ArrowRight'] || keys['d']) { p.x += SPEED; moved = true; }
  p.x = Math.max(RADIUS, Math.min(MAP_W - RADIUS, p.x));
  p.y = Math.max(RADIUS, Math.min(MAP_H - RADIUS, p.y));
  if (moved) socket.emit('move', { x: p.x, y: p.y });

  const now = Date.now();
  cd1El.classList.toggle('ready', now >= primaryCooldownUntil);
  cd2El.classList.toggle('ready', now >= secondaryCooldownUntil && !isCharging);
}

// ─── Draw: Map ────────────────────────────────────────────────────────────────
function drawMap() {
  ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = 1;
  const G = 50;
  for (let x = 0; x <= MAP_W; x += G) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,MAP_H); ctx.stroke(); }
  for (let y = 0; y <= MAP_H; y += G) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(MAP_W,y); ctx.stroke(); }
  ctx.strokeStyle = '#333'; ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, MAP_W - 2, MAP_H - 2);
}

// ─── Draw: Blocks ─────────────────────────────────────────────────────────────
function drawBlocks() {
  const half = BLOCK_SIZE / 2;
  for (const b of Object.values(blocks)) {
    const owned = b.ownerId != null;
    ctx.globalAlpha = owned ? 0.85 : 0.5;
    ctx.fillStyle   = owned ? b.color : '#444';
    ctx.strokeStyle = owned ? b.color : '#666';
    ctx.lineWidth   = 1;
    ctx.fillRect(b.x - half, b.y - half, BLOCK_SIZE, BLOCK_SIZE);
    ctx.strokeRect(b.x - half, b.y - half, BLOCK_SIZE, BLOCK_SIZE);
    ctx.globalAlpha = 1;
  }
}

// ─── Draw: AOE Zones ──────────────────────────────────────────────────────────
function drawAoeZones() {
  const now = Date.now();
  for (const zone of Object.values(aoeZones)) {
    const remaining = Math.max(0, zone.expiresAt - now) / zone.duration;
    const pulse     = 0.5 + 0.3 * Math.sin(now / 120);
    ctx.save();
    ctx.globalAlpha = remaining * pulse * 0.5;
    ctx.fillStyle   = zone.color;
    ctx.beginPath(); ctx.arc(zone.x, zone.y, zone.radius, 0, Math.PI*2); ctx.fill();
    ctx.globalAlpha = remaining * 0.6;
    ctx.strokeStyle = zone.color; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(zone.x, zone.y, zone.radius, 0, Math.PI*2); ctx.stroke();
    ctx.restore();
  }
}

// ─── Draw: Projectiles ────────────────────────────────────────────────────────
function drawProjectiles() {
  for (const proj of Object.values(projectiles)) {
    ctx.fillStyle = proj.color;
    ctx.beginPath(); ctx.arc(proj.x, proj.y, proj.radius, 0, Math.PI*2); ctx.fill();
    ctx.save();
    ctx.globalAlpha = 0.3;
    ctx.fillStyle   = proj.color;
    ctx.beginPath(); ctx.arc(proj.x, proj.y, proj.radius * 2.2, 0, Math.PI*2); ctx.fill();
    ctx.restore();
  }
}

// ─── Draw: VFX ────────────────────────────────────────────────────────────────
function drawVfx() {
  for (const fx of vfx) {
    const t = fx.life / fx.maxLife;
    if (fx.type === 'meleeRing') {
      ctx.save();
      ctx.globalAlpha = t * 0.7; ctx.strokeStyle = fx.color; ctx.lineWidth = 2;
      const r = fx.radius * (1.2 - t * 0.3);
      ctx.beginPath(); ctx.arc(fx.x, fx.y, r, 0, Math.PI*2); ctx.stroke();
      ctx.restore();
    }
    if (fx.type === 'projectileImpact') {
      ctx.save();
      ctx.globalAlpha = t; ctx.fillStyle = fx.color;
      ctx.beginPath(); ctx.arc(fx.x, fx.y, 12 * (1 - t) + 2, 0, Math.PI*2); ctx.fill();
      ctx.restore();
    }
    if (fx.type === 'dashTrail') {
      ctx.save();
      ctx.globalAlpha = t * 0.5; ctx.strokeStyle = fx.color; ctx.lineWidth = 3;
      ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(fx.x1, fx.y1); ctx.lineTo(fx.x2, fx.y2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
  }
}

// ─── Draw: Enemies ────────────────────────────────────────────────────────────
function drawBruteCone(e) {
  const fovHalf = BRUTE_FOV_ANGLE / 2;
  const aggro   = e.aiState === 'aggro';
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(e.x, e.y);
  ctx.arc(e.x, e.y, BRUTE_FOV_RANGE, e.facingAngle - fovHalf, e.facingAngle + fovHalf);
  ctx.closePath();
  ctx.fillStyle   = aggro ? 'rgba(255,136,0,0.18)' : 'rgba(255,136,0,0.07)';
  ctx.strokeStyle = aggro ? 'rgba(255,136,0,0.5)'  : 'rgba(255,136,0,0.18)';
  ctx.lineWidth = 1;
  ctx.fill(); ctx.stroke();
  ctx.restore();
}

function drawEnemy(e) {
  if (e.dead) return;
  if (e.type === 'brute') drawBruteCone(e);
  if (e.type === 'grunt' && e.aiState === 'patrol') {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,68,68,0.3)'; ctx.lineWidth = 1.5;
    ctx.setLineDash([3,4]);
    ctx.beginPath(); ctx.arc(e.x, e.y, e.radius+5, 0, Math.PI*2); ctx.stroke();
    ctx.setLineDash([]); ctx.restore();
  }
  const r        = e.radius || 14;
  const flashing = e._hitFlash > 0;
  ctx.fillStyle  = flashing ? '#ffffff' : e.color;
  ctx.beginPath(); ctx.arc(e.x, e.y, r, 0, Math.PI*2); ctx.fill();
  if (!flashing && e.facingAngle != null) {
    ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(e.x, e.y);
    ctx.lineTo(e.x + Math.cos(e.facingAngle)*r*0.7, e.y + Math.sin(e.facingAngle)*r*0.7);
    ctx.stroke();
  }
  const bw=r*2+4, bh=3, bx=e.x-bw/2, by=e.y-r-7;
  ctx.fillStyle='#333'; ctx.fillRect(bx,by,bw,bh);
  ctx.fillStyle=flashing?'#fff':e.color; ctx.fillRect(bx,by,bw*Math.max(0,e.hp/e.maxHp),bh);
  ctx.fillStyle='#555'; ctx.font='9px monospace'; ctx.textAlign='center';
  ctx.fillText(e.type, e.x, e.y+r+11);
  if (e._hitFlash > 0) e._hitFlash--;
}

// ─── Draw: Players ────────────────────────────────────────────────────────────
function drawShape(cls, x, y, r, color) {
  ctx.fillStyle = color;
  switch (cls) {
    case 'warrior': { const s=r*1.4; ctx.fillRect(x-s/2, y-s/2, s, s); break; }
    case 'ranger': {
      const rr=r*1.3;
      ctx.beginPath(); ctx.moveTo(x,y-rr); ctx.lineTo(x+rr*0.866,y+rr*0.5); ctx.lineTo(x-rr*0.866,y+rr*0.5); ctx.closePath(); ctx.fill(); break;
    }
    case 'mage': {
      const rr=r*1.4;
      ctx.beginPath(); ctx.moveTo(x,y-rr); ctx.lineTo(x+rr,y); ctx.lineTo(x,y+rr); ctx.lineTo(x-rr,y); ctx.closePath(); ctx.fill(); break;
    }
    case 'rogue': {
      const rr=r*1.3;
      ctx.beginPath();
      for(let i=0;i<5;i++){const a=(i*2*Math.PI/5)-Math.PI/2; i===0?ctx.moveTo(x+rr*Math.cos(a),y+rr*Math.sin(a)):ctx.lineTo(x+rr*Math.cos(a),y+rr*Math.sin(a));}
      ctx.closePath(); ctx.fill(); break;
    }
    default:
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI*2); ctx.fill();
  }
}

function drawPlayer(p, id) {
  const isMe = id === myId;
  if (p.dead) {
    ctx.globalAlpha = 0.25;
    drawShape(p.class, p.x, p.y, RADIUS, p.color);
    ctx.globalAlpha = 1;
    return;
  }
  if (isMe && iframeFlashTimer > 0) {
    ctx.save();
    ctx.globalAlpha = 0.4 + 0.4 * Math.sin(Date.now() / 50);
    drawShape(p.class, p.x, p.y, RADIUS * 1.1, '#ffffff');
    ctx.restore();
  }
  drawShape(p.class, p.x, p.y, RADIUS, p.color);
  if (isMe) {
    ctx.strokeStyle = 'white'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(p.x, p.y, RADIUS * 1.1, 0, Math.PI*2); ctx.stroke();
  }
  if (isMe && isCharging) {
    const def = attackDefs[myClass]?.secondary;
    if (def && (def.type === 'projectile' || def.type === 'dash')) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(p.x, p.y);
      const len = def.type === 'dash' ? def.maxDist : 120;
      ctx.lineTo(p.x + Math.cos(aimAngle()) * len, p.y + Math.sin(aimAngle()) * len);
      ctx.stroke(); ctx.setLineDash([]); ctx.restore();
    }
  }
  ctx.fillStyle = isMe ? 'white' : '#777';
  ctx.font = '10px monospace'; ctx.textAlign = 'center';
  ctx.fillText(isMe ? (myName || 'YOU') : (p.name || p.class), p.x, p.y - RADIUS - 6);
  if (!isMe && p.hp != null) {
    const bw=28, bh=3, bx=p.x-14, by=p.y-RADIUS-8;
    ctx.fillStyle='#333'; ctx.fillRect(bx,by,bw,bh);
    ctx.fillStyle=p.color; ctx.fillRect(bx,by,bw*(p.hp/(p.maxHp||MAX_HP)),bh);
  }
}

// ─── Draw: Aim Indicator ──────────────────────────────────────────────────────
function drawAimIndicator() {
  if (!myId || !players[myId] || isDead) return;
  const def = attackDefs[myClass]?.primary;
  if (!def) return;
  if (def.type === 'melee' && keys['1']) {
    ctx.strokeStyle='rgba(255,255,255,0.1)'; ctx.lineWidth=1;
    ctx.setLineDash([3,3]);
    ctx.beginPath(); ctx.arc(players[myId].x, players[myId].y, def.radius, 0, Math.PI*2); ctx.stroke();
    ctx.setLineDash([]);
  }
}

// ─── Draw ─────────────────────────────────────────────────────────────────────
function draw() {
  ctx.clearRect(0, 0, MAP_W, MAP_H);
  if (damageFlashTimer > 0) {
    ctx.fillStyle = `rgba(230,57,70,${0.2 * damageFlashTimer/8})`;
    ctx.fillRect(0,0,MAP_W,MAP_H);
  }
  drawMap();
  drawBlocks();
  drawAoeZones();
  drawVfx();
  drawProjectiles();
  for (const e of Object.values(enemies))        drawEnemy(e);
  for (const [id, p] of Object.entries(players)) drawPlayer(p, id);
  drawAimIndicator();
}

// ─── Loop ─────────────────────────────────────────────────────────────────────
function gameLoop() { update(); draw(); requestAnimationFrame(gameLoop); }
// Started on socket 'init'