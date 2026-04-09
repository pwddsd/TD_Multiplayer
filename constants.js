// ─── constants.js ─────────────────────────────────────────────────────────────
// Single source of truth for all server-side constants.
// ──────────────────────────────────────────────────────────────────────────────

module.exports = {
  // World
  MAP_WIDTH:  800,
  MAP_HEIGHT: 600,

  // Player
  PLAYER_RADIUS:       16,
  PLAYER_SPEED_LIMIT:  6,
  PLAYER_MAX_HP:       10,
  PLAYER_RESPAWN_DELAY: 3000,

  // Blocks
  BLOCK_SIZE:           24,
  BLOCK_STARTING_COUNT: 10,

  // Enemies
  ENEMY_DAMAGE_INTERVAL: 600,
  ENEMY_RESPAWN_DELAY:   5000,
  MAX_ENEMIES:           8,
  ENEMY_AI_TICK:         100,
};