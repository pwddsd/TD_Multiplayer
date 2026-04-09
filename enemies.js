// ─── enemies.js ───────────────────────────────────────────────────────────────
// Enemy type definitions, AI tick functions, spawn/kill/respawn logic.
// ──────────────────────────────────────────────────────────────────────────────

const {
  MAP_WIDTH, MAP_HEIGHT, PLAYER_RADIUS,
  ENEMY_DAMAGE_INTERVAL, ENEMY_RESPAWN_DELAY, MAX_ENEMIES,
} = require('./constants');

// ─── Enemy Type Templates ─────────────────────────────────────────────────────
const ENEMY_TYPES = {
  runner: { type: 'runner', color: '#ffcc00', hp: 2, speed: 2.4, damage: 1, radius: 10 },
  grunt:  { type: 'grunt',  color: '#ff4444', hp: 3, speed: 1.4, damage: 1, radius: 14,
            ALERT_RADIUS: 140, LEASH_RADIUS: 180, PATROL_SPEED: 0.7, WAYPOINT_REACH: 8 },
  brute:  { type: 'brute',  color: '#ff8800', hp: 6, speed: 1,   damage: 3, radius: 20,
            FOV_ANGLE: 2.44, FOV_RANGE: 200, AGGRO_COOLDOWN: 2500, SCAN_SPEED: 0.012 },
};

// ─── Helpers (local) ──────────────────────────────────────────────────────────
function distance(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function clampToBounds(x, y, radius = PLAYER_RADIUS) {
  return {
    x: Math.max(radius, Math.min(MAP_WIDTH  - radius, x)),
    y: Math.max(radius, Math.min(MAP_HEIGHT - radius, y)),
  };
}

function angleTo(a, b) { return Math.atan2(b.y - a.y, b.x - a.x); }

function inCone(a, b, facing, fovHalf, range) {
  if (distance(a, b) > range) return false;
  let diff = angleTo(a, b) - facing;
  while (diff >  Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  return Math.abs(diff) <= fovHalf;
}

function randomWaypoint(margin = 60) {
  return {
    x: margin + Math.random() * (MAP_WIDTH  - margin * 2),
    y: margin + Math.random() * (MAP_HEIGHT - margin * 2),
  };
}

function stepToward(enemy, target, speed) {
  const d = distance(enemy, target);
  if (d < 0.5) return false;
  const nx = (target.x - enemy.x) / d, ny = (target.y - enemy.y) / d;
  enemy.x += nx * Math.min(speed, d);
  enemy.y += ny * Math.min(speed, d);
  enemy.facingAngle = Math.atan2(ny, nx);
  const c = clampToBounds(enemy.x, enemy.y, enemy.radius);
  enemy.x = c.x; enemy.y = c.y;
  return true;
}

// ─── clientView ───────────────────────────────────────────────────────────────
// Strips internal server fields before broadcasting.
function clientView(e) {
  return {
    id: e.id, x: e.x, y: e.y, type: e.type, color: e.color,
    hp: e.hp, maxHp: e.maxHp, radius: e.radius, dead: e.dead,
    facingAngle: e.facingAngle, aiState: e.aiState,
  };
}

// ─── Module Factory ───────────────────────────────────────────────────────────
function createEnemySystem({ enemies, players, damageTimers, io }) {
  let enemyIdCounter = 0;

  // ── Spawn ──────────────────────────────────────────────────────────────────
  function spawnEnemy() {
    const id       = `enemy_${enemyIdCounter++}`;
    const typeKeys = Object.keys(ENEMY_TYPES);
    const tmpl     = ENEMY_TYPES[typeKeys[Math.floor(Math.random() * typeKeys.length)]];
    const edge = Math.floor(Math.random() * 4);
    const m = tmpl.radius + 10;
    let x, y;
    switch (edge) {
      case 0: x = Math.random() * MAP_WIDTH; y = m;              break;
      case 1: x = Math.random() * MAP_WIDTH; y = MAP_HEIGHT - m; break;
      case 2: x = m;             y = Math.random() * MAP_HEIGHT; break;
      case 3: x = MAP_WIDTH - m; y = Math.random() * MAP_HEIGHT; break;
    }
    const e = {
      id, x, y, type: tmpl.type, color: tmpl.color,
      hp: tmpl.hp, maxHp: tmpl.hp, speed: tmpl.speed,
      damage: tmpl.damage, radius: tmpl.radius,
      dead: false, facingAngle: Math.random() * Math.PI * 2, aiState: 'idle',
    };
    if (e.type === 'grunt') {
      e.patrolA = { x, y }; e.patrolB = randomWaypoint();
      e.patrolTarget = 'B'; e.aggroTarget = null; e.aiState = 'patrol';
    } else if (e.type === 'brute') {
      e.aggroTarget = null; e.aggroUntil = 0;
      e.scanDirection = Math.random() < 0.5 ? 1 : -1; e.aiState = 'scan';
    } else {
      e.aiState = 'chase';
    }
    enemies[id] = e;
    io.emit('enemySpawned', clientView(e));
    return id;
  }

  function scheduleEnemyRespawn() {
    setTimeout(() => {
      Object.keys(enemies).length < MAX_ENEMIES ? spawnEnemy() : scheduleEnemyRespawn();
    }, ENEMY_RESPAWN_DELAY);
  }

  function killEnemy(id) {
    const e = enemies[id];
    if (!e || e.dead) return;
    e.dead = true;
    io.emit('enemyDied', { id });
    for (const key of Object.keys(damageTimers)) {
      if (key.startsWith(`${id}:`)) delete damageTimers[key];
    }
    delete enemies[id];
    scheduleEnemyRespawn();
  }

  // ── AI helpers ─────────────────────────────────────────────────────────────
  function findNearestLivingPlayer(ref) {
    let best = null, bestD = Infinity;
    for (const [id, p] of Object.entries(players)) {
      if (!p.joined || p.dead) continue;
      const d = distance(ref, p);
      if (d < bestD) { bestD = d; best = { id, player: p, dist: d }; }
    }
    return best;
  }

  // ── AI ticks ───────────────────────────────────────────────────────────────
  function tickRunner(e) {
    const t = findNearestLivingPlayer(e);
    if (!t) return null;
    if (distance(e, t.player) > e.radius + PLAYER_RADIUS) stepToward(e, t.player, e.speed);
    return t;
  }

  function tickGrunt(e) {
    const cfg = ENEMY_TYPES.grunt;
    if (e.aiState === 'patrol') {
      const near = findNearestLivingPlayer(e);
      if (near && near.dist < cfg.ALERT_RADIUS) {
        e.aiState = 'chase'; e.aggroTarget = near.id;
      } else {
        const dest = e.patrolTarget === 'A' ? e.patrolA : e.patrolB;
        stepToward(e, dest, cfg.PATROL_SPEED);
        if (distance(e, dest) < cfg.WAYPOINT_REACH) e.patrolTarget = e.patrolTarget === 'A' ? 'B' : 'A';
        return null;
      }
    }
    const p = players[e.aggroTarget];
    if (!p || p.dead || distance(e, p) > cfg.LEASH_RADIUS) {
      e.aiState = 'patrol'; e.aggroTarget = null; e.patrolTarget = 'A'; return null;
    }
    if (distance(e, p) > e.radius + PLAYER_RADIUS) stepToward(e, p, e.speed);
    return { id: e.aggroTarget, player: p, dist: distance(e, p) };
  }

  function tickBrute(e, now) {
    const cfg     = ENEMY_TYPES.brute;
    const fovHalf = cfg.FOV_ANGLE / 2;
    if (e.aiState === 'scan') {
      e.facingAngle += cfg.SCAN_SPEED * e.scanDirection;
      if (Math.random() < 0.008) e.scanDirection *= -1;
      for (const [pid, p] of Object.entries(players)) {
        if (!p.joined || p.dead) continue;
        if (inCone(e, p, e.facingAngle, fovHalf, cfg.FOV_RANGE)) {
          e.aiState = 'aggro'; e.aggroTarget = pid; e.aggroUntil = now + cfg.AGGRO_COOLDOWN; break;
        }
      }
      return null;
    }
    const p = players[e.aggroTarget];
    if (!p || p.dead) { e.aiState = 'scan'; e.aggroTarget = null; return null; }
    if (inCone(e, p, e.facingAngle, fovHalf, cfg.FOV_RANGE)) e.aggroUntil = now + cfg.AGGRO_COOLDOWN;
    if (now > e.aggroUntil) { e.aiState = 'scan'; e.aggroTarget = null; return null; }
    if (distance(e, p) > e.radius + PLAYER_RADIUS) stepToward(e, p, e.speed);
    return { id: e.aggroTarget, player: p, dist: distance(e, p) };
  }

  // ── Contact damage ─────────────────────────────────────────────────────────
  function applyContactDamage(enemy, playerId, player, now, killPlayer) {
    if (distance(enemy, player) > enemy.radius + PLAYER_RADIUS) return;
    if (player.iframeUntil && now < player.iframeUntil) return;
    const key  = `${enemy.id}:${playerId}`;
    const last = damageTimers[key] || 0;
    if (now - last < ENEMY_DAMAGE_INTERVAL) return;
    damageTimers[key] = now;
    player.hp = Math.max(0, player.hp - enemy.damage);
    const sock = io.sockets.sockets.get(playerId);
    if (sock) sock.emit('damaged', { hp: player.hp, by: enemy.id });
    if (player.hp <= 0 && !player.dead) killPlayer(playerId);
  }

  // ── Main AI tick (called by setInterval) ───────────────────────────────────
  function runEnemyAI(tickProjectiles, tickAoeZones, killPlayer) {
    const now     = Date.now();
    const updates = [];
    for (const [, enemy] of Object.entries(enemies)) {
      if (enemy.dead) continue;
      let target = null;
      switch (enemy.type) {
        case 'runner': target = tickRunner(enemy);      break;
        case 'grunt':  target = tickGrunt(enemy);      break;
        case 'brute':  target = tickBrute(enemy, now); break;
      }
      if (target) applyContactDamage(enemy, target.id, target.player, now, killPlayer);
      // Runners also check nearest (handles edge-case where tickRunner returns null)
      if (enemy.type === 'runner') {
        const near = findNearestLivingPlayer(enemy);
        if (near) applyContactDamage(enemy, near.id, near.player, now, killPlayer);
      }
      updates.push(clientView(enemy));
    }
    if (updates.length) io.emit('enemiesUpdate', updates);
    tickProjectiles(now);
    tickAoeZones(now);
  }

  return { spawnEnemy, killEnemy, runEnemyAI, clientView };
}

module.exports = { ENEMY_TYPES, createEnemySystem };