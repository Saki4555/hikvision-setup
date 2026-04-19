// =============================================
//  localDb.js — SQLite local database
//  Uses better-sqlite3 (synchronous API)
//
//  Tables:
//    punch_queue  — every punch with lifecycle status
//    device_state — checkpoint per device (last seen time)
//
//  Features:
//    - WAL mode for crash safety
//    - Indexes for fast PENDING queries
//    - Transactions for atomic batch inserts
//    - Duplicate detection before insert
// =============================================
const Database = require("better-sqlite3");
const path     = require("path");

const db = new Database(path.join(__dirname, "attendance.db"));

// ---- WAL mode: faster writes, safe on power loss ----
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL"); // safe + fast balance

// ---- Create tables ----
db.exec(`
  -- Every punch from every device lives here
  -- Status lifecycle: PENDING → SYNCED
  CREATE TABLE IF NOT EXISTS punch_queue (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    emp_no       TEXT    NOT NULL,
    in_out_time  TEXT    NOT NULL,
    in_out_type  INTEGER NOT NULL,
    ip_address   TEXT    NOT NULL,
    sync_status  TEXT    NOT NULL DEFAULT 'PENDING',
    attempts     INTEGER NOT NULL DEFAULT 0,
    last_error   TEXT,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
    synced_at    TEXT
  );

  -- Checkpoint: last event time we received per device
  -- Used to ask Hikvision "give me everything AFTER this time"
  CREATE TABLE IF NOT EXISTS device_state (
    ip_address  TEXT PRIMARY KEY,
    last_time   TEXT NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  -- ---- Indexes for performance ----
  -- Fast lookup of PENDING records (used every poll cycle)
  CREATE INDEX IF NOT EXISTS idx_punch_status
    ON punch_queue (sync_status, id);

  -- Fast duplicate detection (emp + time + device = unique punch)
  CREATE UNIQUE INDEX IF NOT EXISTS idx_punch_unique
    ON punch_queue (emp_no, in_out_time, ip_address);

  -- Fast device state lookup
  CREATE INDEX IF NOT EXISTS idx_device_ip
    ON device_state (ip_address);
`);

// =============================================
//  CHECKPOINT — device_state
// =============================================

/**
 * Get the last event time we received from a device.
 * Returns ISO string or null (first run ever).
 */
function getCheckpoint(ipAddress) {
  const row = db
    .prepare("SELECT last_time FROM device_state WHERE ip_address = ?")
    .get(ipAddress);
  return row ? row.last_time : null;
}

/**
 * Save checkpoint for a device.
 * Called after every event we receive (including non-employee events)
 * so we never re-fetch old data.
 */
function setCheckpoint(ipAddress, time) {
  db.prepare(`
    INSERT INTO device_state (ip_address, last_time, updated_at)
    VALUES (?, ?, datetime('now', 'localtime'))
    ON CONFLICT(ip_address) DO UPDATE SET
      last_time  = excluded.last_time,
      updated_at = excluded.updated_at
  `).run(ipAddress, time);
}

// =============================================
//  PUNCH QUEUE — state machine
// =============================================

/**
 * Save a batch of punches as PENDING in a single transaction.
 * Uses better-sqlite3's transaction() for atomicity —
 * if power is lost mid-write, nothing is partially saved.
 *
 * Skips duplicates silently (IGNORE on unique constraint).
 */
const insertBatch = db.transaction((punches) => {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO punch_queue
      (emp_no, in_out_time, in_out_type, ip_address, sync_status)
    VALUES
      (?, ?, ?, ?, 'PENDING')
  `);
  for (const p of punches) {
    stmt.run(p.emp_no, p.in_out_time, p.in_out_type, p.ip_address);
  }
});

/**
 * Get a batch of PENDING punches to sync.
 * Ordered by id ASC (oldest first — FIFO).
 * Limited to batchSize to avoid flooding the API.
 */
function getPendingBatch(batchSize = 100) {
  return db.prepare(`
    SELECT * FROM punch_queue
    WHERE sync_status = 'PENDING'
    ORDER BY id ASC
    LIMIT ?
  `).all(batchSize);
}

/**
 * Mark a punch as SYNCED after confirmed API success.
 * Only called when API returns 200/201.
 */
function markSynced(id) {
  db.prepare(`
    UPDATE punch_queue
    SET sync_status = 'SYNCED',
        synced_at   = datetime('now', 'localtime')
    WHERE id = ?
  `).run(id);
}

/**
 * Record a failed sync attempt.
 * Keeps status as PENDING so it will be retried.
 * After MAX_ATTEMPTS, marks as FAILED and stops retrying.
 */
const MAX_ATTEMPTS = 10;
function recordFailedAttempt(id, errorMessage) {
  const row = db.prepare("SELECT attempts FROM punch_queue WHERE id = ?").get(id);
  if (!row) return;

  if (row.attempts + 1 >= MAX_ATTEMPTS) {
    db.prepare(`
      UPDATE punch_queue
      SET sync_status = 'FAILED',
          attempts    = attempts + 1,
          last_error  = ?
      WHERE id = ?
    `).run(errorMessage, id);
  } else {
    db.prepare(`
      UPDATE punch_queue
      SET attempts   = attempts + 1,
          last_error = ?
      WHERE id = ?
    `).run(errorMessage, id);
  }
}

// =============================================
//  STATS — for startup summary
// =============================================

function getStats() {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN sync_status = 'PENDING' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN sync_status = 'SYNCED'  THEN 1 ELSE 0 END) AS synced,
      SUM(CASE WHEN sync_status = 'FAILED'  THEN 1 ELSE 0 END) AS failed
    FROM punch_queue
  `).get();
  return row;
}

module.exports = {
  getCheckpoint,
  setCheckpoint,
  insertBatch,
  getPendingBatch,
  markSynced,
  recordFailedAttempt,
  getStats,
};