// ─── attacks.js ───────────────────────────────────────────────────────────────
// Attack definitions and server-side fire handlers.
// Requires: state (players, enemies, projectiles, aoeZones), helpers, io
// ──────────────────────────────────────────────────────────────────────────────

const {
  MAP_WIDTH, MAP_HEIGHT, PLAYER_RADIUS, ENEMY_DAMAGE_INTERVAL,
} = require('./constants');

// ─── Attack Definitions ───────────────────────────────────────────────────────
const ATTACK_DEFS = {
  warrior: {
    primary:   { type: 'melee', damage: 2, radius: 60, cooldown: 400 },
    secondary: {
      type: 'aoe', damage: 1,
      minRadius: 50, maxRadius: 130, minDuration: 800, maxDuration: 2000,
      chargeMin: 200, chargeMax: 1500, cooldown: 2500, color: '#e63946',
    },
  },
  ranger: {
    primary:   { type: 'projectile', damage: 2, speed: 10, ttl: 1500, radius: 6, cooldown: 350, color: '#2a9d8f' },
    secondary: {
      type: 'dash', damage: 1, minDist: 80, maxDist: 280,
      chargeMin: 150, chargeMax: 1200, iframeDuration: 300, cooldown: 2000,
    },
  },
  mage: {
    primary:   { type: 'projectile', damage: 1, speed: 14, ttl: 1200, radius: 5, cooldown: 250, color: '#9b5de5' },
    secondary: {
      type: 'aoe', damage: 1,
      minRadius: 40, maxRadius: 160, minDuration: 1200, maxDuration: 4000,
      chargeMin: 300, chargeMax: 2000, cooldown: 3500, color: '#9b5de5',
    },
  },
  rogue: {
    primary:   { type: 'melee', damage: 1, radius: 44, cooldown: 220 },
    secondary: {
      type: 'dash', damage: 2,        // backstab
      minDist: 100, maxDist: 100,     // fixed distance
      chargeMin: 0, chargeMax: 0,     // instant
      iframeDuration: 250, cooldown: 1400,
    },
  },
};

// ─── Helpers (local) ──────────────────────────────────────────────────────────
function lerp(a, b, t) { return a + (b - a) * Math.max(0, Math.min(1, t)); }

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

function pointNearSegment(point, segA, segB, threshold) {
  const dx = segB.x - segA.x, dy = segB.y - segA.y;
  const lenSq = dx*dx + dy*dy;
  if (lenSq === 0) return distance(point, segA) <= threshold;
  const t = Math.max(0, Math.min(1,
    ((point.x - segA.x)*dx + (point.y - segA.y)*dy) / lenSq
  ));
  const cx = segA.x + t*dx, cy = segA.y + t*dy;
  return Math.sqrt((point.x - cx)**2 + (point.y - cy)**2) <= threshold;
}

// ─── Module Factory ───────────────────────────────────────────────────────────
// Returns bound fire handlers that close over shared state + io.
// Circle vs AABB collision: is circle (cx,cy,cr) overlapping rect centered at (rx,ry) with half-size hs?
function circleHitsSquare(cx, cy, cr, rx, ry, hs) {
  const nearX = Math.max(rx - hs, Math.min(rx + hs, cx));
  const nearY = Math.max(ry - hs, Math.min(ry + hs, cy));
  const dx = cx - nearX, dy = cy - nearY;
  return dx*dx + dy*dy <= cr*cr;
}

function createAttackHandlers({ players, enemies, projectiles, aoeZones, blocks, killEnemy, io }) {
  const HALF = require('./constants').BLOCK_SIZE / 2;
  let projectileIdCounter = 0;
  let aoeIdCounter        = 0;

  // ── Melee ──────────────────────────────────────────────────────────────────
  function fireMelee(playerId, p, def) {
    const hits = [];
    for (const [eid, enemy] of Object.entries(enemies)) {
      if (enemy.dead) continue;
      if (distance(p, enemy) <= def.radius + enemy.radius) {
        enemy.hp -= def.damage;
        hits.push({ id: eid, hp: enemy.hp, maxHp: enemy.maxHp });
        if (enemy.hp <= 0) killEnemy(eid);
      }
    }
    io.emit('meleeSwing', { playerId, x: p.x, y: p.y, radius: def.radius, hits });
  }

  // ── Projectile ─────────────────────────────────────────────────────────────
  function fireProjectile(playerId, p, def, angle) {
    if (angle == null) return;
    const id = `proj_${projectileIdCounter++}`;
    projectiles[id] = {
      id, ownerId: playerId,
      x: p.x, y: p.y,
      vx: Math.cos(angle) * def.speed,
      vy: Math.sin(angle) * def.speed,
      damage: def.damage, radius: def.radius, color: def.color,
      ttl: def.ttl, born: Date.now(),
    };
    io.emit('projectileSpawned', {
      id, x: p.x, y: p.y,
      vx: projectiles[id].vx, vy: projectiles[id].vy,
      radius: def.radius, color: def.color, ttl: def.ttl,
    });
  }

  // ── AOE Zone ───────────────────────────────────────────────────────────────
  function fireAoe(playerId, p, def, chargeT) {
    const id       = `aoe_${aoeIdCounter++}`;
    const radius   = Math.round(lerp(def.minRadius, def.maxRadius, chargeT));
    const duration = Math.round(lerp(def.minDuration, def.maxDuration, chargeT));
    aoeZones[id] = {
      id, ownerId: playerId,
      x: p.x, y: p.y, radius,
      damage: def.damage, color: def.color,
      expiresAt: Date.now() + duration,
      tickTimers: {},
    };
    io.emit('aoeSpawned', { id, x: p.x, y: p.y, radius, color: def.color, duration });
  }

  // ── Dash ───────────────────────────────────────────────────────────────────
  function fireDash(playerId, p, def, chargeT, angle) {
    if (angle == null) return;
    const dashDist = Math.round(lerp(def.minDist, def.maxDist, chargeT));
    const fromX = p.x, fromY = p.y;
    const dest  = clampToBounds(p.x + Math.cos(angle) * dashDist, p.y + Math.sin(angle) * dashDist);

    p.iframeUntil = Date.now() + def.iframeDuration;

    const hits = [];
    for (const [eid, enemy] of Object.entries(enemies)) {
      if (enemy.dead) continue;
      if (pointNearSegment(enemy, { x: fromX, y: fromY }, dest, enemy.radius + PLAYER_RADIUS)) {
        enemy.hp -= def.damage;
        hits.push({ id: eid, hp: enemy.hp, maxHp: enemy.maxHp });
        if (enemy.hp <= 0) killEnemy(eid);
      }
    }

    p.x = dest.x; p.y = dest.y;
    io.emit('dashPerformed', { playerId, fromX, fromY, toX: dest.x, toY: dest.y, hits });
    io.emit('playerMoved',   { id: playerId, x: p.x, y: p.y });
  }

  // ── Projectile + AOE Tick ──────────────────────────────────────────────────
  function tickProjectiles(now) {
    for (const [id, proj] of Object.entries(projectiles)) {
      if (now - proj.born > proj.ttl) {
        delete projectiles[id]; io.emit('projectileGone', { id }); continue;
      }
      proj.x += proj.vx; proj.y += proj.vy;
      if (proj.x < 0 || proj.x > MAP_WIDTH || proj.y < 0 || proj.y > MAP_HEIGHT) {
        delete projectiles[id]; io.emit('projectileGone', { id }); continue;
      }
      // Block collision — stops projectile on contact
      let blockedByBlock = false;
      for (const block of Object.values(blocks)) {
        if (circleHitsSquare(proj.x, proj.y, proj.radius, block.x, block.y, HALF)) {
          io.emit('projectileHit', { id, enemyId: null, hp: 0, maxHp: 0, x: proj.x, y: proj.y });
          delete projectiles[id];
          blockedByBlock = true; break;
        }
      }
      if (blockedByBlock) continue;

      let hit = false;
      for (const [eid, enemy] of Object.entries(enemies)) {
        if (enemy.dead) continue;
        if (distance(proj, enemy) <= proj.radius + enemy.radius) {
          enemy.hp -= proj.damage;
          io.emit('projectileHit', { id, enemyId: eid, hp: enemy.hp, maxHp: enemy.maxHp, x: proj.x, y: proj.y });
          if (enemy.hp <= 0) killEnemy(eid);
          delete projectiles[id];
          hit = true; break;
        }
      }
      if (!hit) io.emit('projectileMoved', { id, x: proj.x, y: proj.y });
    }
  }

  function tickAoeZones(now) {
    for (const [id, zone] of Object.entries(aoeZones)) {
      if (now > zone.expiresAt) {
        delete aoeZones[id]; io.emit('aoeGone', { id }); continue;
      }
      for (const [eid, enemy] of Object.entries(enemies)) {
        if (enemy.dead) continue;
        if (distance(zone, enemy) <= zone.radius + enemy.radius) {
          const key  = `${id}:${eid}`;
          const last = zone.tickTimers[key] || 0;
          if (now - last >= ENEMY_DAMAGE_INTERVAL) {
            zone.tickTimers[key] = now;
            enemy.hp -= zone.damage;
            io.emit('enemyHit', { id: eid, hp: enemy.hp, maxHp: enemy.maxHp });
            if (enemy.hp <= 0) killEnemy(eid);
          }
        }
      }
    }
  }

  // ── Top-level handlers (called by socket events) ───────────────────────────
  function handlePrimary(playerId, data) {
    const p   = players[playerId];
    const def = ATTACK_DEFS[p.class]?.primary;
    if (!def) return;
    const now = Date.now();
    if (now - (p.lastPrimary || 0) < def.cooldown) return;
    p.lastPrimary = now;

    if (def.type === 'melee')      fireMelee(playerId, p, def);
    if (def.type === 'projectile') fireProjectile(playerId, p, def, data.angle);
  }

  function handleChargeRelease(playerId, data) {
    const p   = players[playerId];
    const def = ATTACK_DEFS[p.class]?.secondary;
    if (!def) return;
    const now    = Date.now();
    if (now - (p.lastSecondary || 0) < def.cooldown) return;

    const heldMs  = Math.max(0, now - (data.chargeStart || now));
    const chargeT = def.chargeMax > 0
      ? Math.min(1, Math.max(0, heldMs - def.chargeMin) / (def.chargeMax - def.chargeMin))
      : 1;

    if (def.chargeMin > 0 && heldMs < def.chargeMin) return;

    p.lastSecondary = now;

    if (def.type === 'aoe')  fireAoe (playerId, p, def, chargeT);
    if (def.type === 'dash') fireDash(playerId, p, def, chargeT, data.angle);
  }

  return { handlePrimary, handleChargeRelease, tickProjectiles, tickAoeZones };
}

module.exports = { ATTACK_DEFS, createAttackHandlers };