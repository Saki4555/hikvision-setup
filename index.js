// =============================================
//  index.js — Hikvision Attendance System
//
//  Features:
//    1. Checkpoint logic     — never re-fetch old data
//    2. State machine        — PENDING → SYNCED lifecycle
//    3. Anti-flood batcher   — sends 100 records at a time
//    4. Positive ACK         — only marks SYNCED on 200/201
//    5. Watchdog error log   — specific HTTP error messages
// =============================================
require("dotenv").config();
const axios  = require("axios");
const logger = require("./logger");
const {
  getCheckpoint,
  setCheckpoint,
  insertBatch,
  getPendingBatch,
  markSynced,
  recordFailedAttempt,
  getStats,
} = require("./localDb");
const { getDataFromApi } = require("./hikvision");

// ---- Config ----
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS) || 10000;
const HRMS_API_URL     = process.env.HRMS_API_URL   || "http://localhost:4000/api/attlog";
const HRMS_API_TOKEN   = process.env.HRMS_API_TOKEN || "123456";

// How many PENDING records to send per sync cycle
// Prevents flooding the HRMS API after a long downtime
const SYNC_BATCH_SIZE = 100;

// Delay between each request in a batch (ms)
// Keeps the Oracle server comfortable
const BATCH_DELAY_MS = 200;

// =============================================
//  Load terminals from .env
// =============================================
function getTerminals() {
  try {
    const terminals = JSON.parse(process.env.TERMINALS || "[]");
    if (terminals.length === 0) {
      logger.error("No terminals found in .env — check TERMINALS setting");
    }
    return terminals;
  } catch (err) {
    logger.error(`Failed to parse TERMINALS from .env: ${err.message}`);
    return [];
  }
}

// =============================================
//  IN/OUT resolver
//  1 or 2 → use directly
//  3 (auto) → before 11am = IN (1), else OUT (2)
// =============================================
function resolveInOutType(inOutType, eventTime) {
  if (inOutType !== 3) return inOutType;
  const hour = new Date(eventTime).getHours();
  return hour >= 6 && hour < 11 ? 1 : 2;
}

// =============================================
//  FEATURE 1: CHECKPOINT
//  Get start time for device polling.
//  Reads MAX punch time from SQLite — never
//  fetches data we already have.
// =============================================
function getStartTime(ipAddress) {
  const checkpoint = getCheckpoint(ipAddress);
  if (checkpoint) return checkpoint;

  // First run ever — go back 10 days
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  const fallback = tenDaysAgo.toISOString().substring(0, 10) + "T00:00:00+06:00";
  logger.info(`No checkpoint for ${ipAddress} — first run, fetching last 10 days`);
  return fallback;
}

// =============================================
//  FEATURE 4 + 5: HRMS API CALL
//  Positive acknowledgment — only returns true
//  on 200/201. Logs specific HTTP errors.
// =============================================
async function sendOneToHRMS(punch) {
  const body = {
    AM_EMPNO:       parseInt(punch.emp_no),
    AM_TIME_IN_OUT: punch.in_out_time,
    AM_TYPE_IN_OUT: punch.in_out_type,
    AM_MAC_ID:      punch.ip_address,
    AM_LAT_IN_OUT:  null,
    AM_LON_IN_OUT:  null,
    T_ZONE:         null,
    LOCATION_ID:    null,
    TEAM_LEAD_ID:   null,
  };

  try {
    const response = await axios.post(HRMS_API_URL, body, {
      headers: {
        Authorization: `Bearer ${HRMS_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      timeout: 10000,
    });

    // Feature 4: Positive ACK — only accept 200 or 201
    if (response.status === 200 || response.status === 201) {
      return { success: true };
    }

    return { success: false, error: `Unexpected status ${response.status}` };

  } catch (err) {
    const status  = err.response?.status;
    const message = err.response?.data?.error || err.message;

    // Duplicate in Oracle — treat as success (data already there)
    if (status === 500 && message.toLowerCase().includes("unique")) {
      return { success: true };
    }

    // Feature 5: Watchdog — log specific HTTP error codes
    if (status) {
      logger.apiError(status, message, HRMS_API_URL);
    } else {
      // Network error — timeout, connection refused, etc.
      logger.error(`HRMS API unreachable — ${err.message}`);
    }

    return { success: false, error: message };
  }
}

// =============================================
//  FEATURE 3: ANTI-FLOOD BATCHER
//  Reads PENDING records in batches of 100.
//  Sends one at a time with a small delay
//  between each to be kind to the Oracle server.
//  Only marks SYNCED on confirmed 200/201.
// =============================================
async function syncPendingBatch() {
  const batch = getPendingBatch(SYNC_BATCH_SIZE);

  if (batch.length === 0) return;

  logger.sync(`Syncing ${batch.length} PENDING record(s) to HRMS...`);

  let synced  = 0;
  let failed  = 0;

  for (const punch of batch) {
    const result = await sendOneToHRMS(punch);

    if (result.success) {
      // Feature 4: Positive ACK — only mark SYNCED on confirmed success
      markSynced(punch.id);
      synced++;
    } else {
      // Keep as PENDING, increment attempt counter
      recordFailedAttempt(punch.id, result.error);
      failed++;
    }

    // Anti-flood delay between requests
    if (BATCH_DELAY_MS > 0) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  if (synced > 0) logger.sync(`Batch complete — ${synced} synced, ${failed} failed`);
  if (failed > 0) logger.warn(`${failed} record(s) failed — will retry next cycle`);
}

// =============================================
//  POLL ONE DEVICE
//  Feature 1: Checkpoint — fetch only new events
//  Feature 2: Save ALL as PENDING first
// =============================================
async function pollDevice(terminal) {
  const { ip, api_string, in_out } = terminal;

  // Feature 1: Checkpoint — only ask for events after last known time
  const startTime = getStartTime(ip);
  const tomorrow  = new Date(Date.now() + 86400000);
  const endTime   = tomorrow.toISOString().substring(0, 10) + "T00:00:00+06:00";

  logger.poll(`Polling ${ip} from ${startTime}`);

  const events = await getDataFromApi(api_string, startTime, endTime);

  if (!events || events.length === 0) {
    logger.poll(`No new events from ${ip}`);
    return;
  }

  logger.poll(`${events.length} event(s) received from ${ip}`);

  // Build list of employee punches to save
  const punchesToSave = [];

  for (const event of events) {
    const time  = event.time;
    const empNo = event.employeeNoString || null;

    // Always update checkpoint — even for door lock / system events
    // This prevents re-fetching non-employee events on restart
    setCheckpoint(ip, time);

    if (!empNo) continue; // skip door lock / system events

    const resolvedType = resolveInOutType(in_out, time);

    punchesToSave.push({
      emp_no:      empNo,
      in_out_time: time,
      in_out_type: resolvedType,
      ip_address:  ip,
    });
  }

  if (punchesToSave.length === 0) {
    logger.poll(`No employee punches in this batch from ${ip}`);
    return;
  }

  // Feature 2: Save ALL punches as PENDING in a single transaction
  // If power is lost here, nothing is partially saved
  insertBatch(punchesToSave);

  logger.info(`Saved ${punchesToSave.length} punch(es) as PENDING from ${ip}`);
}

// =============================================
//  MAIN LOOP
// =============================================
async function main() {
  logger.info("==============================================");
  logger.info("  Hikvision Attendance System — Node.js v5");
  logger.info("  1. Checkpoint   — incremental device fetch");
  logger.info("  2. State machine — PENDING → SYNCED");
  logger.info("  3. Anti-flood    — batch sync (100/cycle)");
  logger.info("  4. Positive ACK  — confirmed 200/201 only");
  logger.info("  5. Watchdog      — HTTP error logging");
  logger.info(`  API: ${HRMS_API_URL}`);
  logger.info("==============================================");

  // ---- Startup stats ----
  const stats = getStats();
  logger.info(`SQLite stats — Total: ${stats.total} | Pending: ${stats.pending} | Synced: ${stats.synced} | Failed: ${stats.failed}`);

  if (stats.pending > 0) {
    logger.warn(`${stats.pending} PENDING record(s) from previous session — will sync now`);
  }

  // ---- Show terminals ----
  const terminals = getTerminals();
  logger.info(`Loaded ${terminals.length} terminal(s):`);
  terminals.forEach((t) => {
    const checkpoint = getCheckpoint(t.ip) || "first run";
    logger.info(`  → ${t.ip} | ${t.location || "no location"} | checkpoint: ${checkpoint}`);
  });

  // ---- Test HRMS API ----
  try {
    await axios.get(`${HRMS_API_URL}?page=1&limit=1`, {
      headers: { Authorization: `Bearer ${HRMS_API_TOKEN}` },
      timeout: 5000,
    });
    logger.info("HRMS API reachable — starting poll loop");
  } catch (err) {
    logger.warn(`HRMS API not reachable on startup — ${err.message}`);
    logger.warn("Polling will continue — punches saved locally until API recovers");
  }

  logger.info("----------------------------------------------");

  // ---- Infinite poll loop ----
  while (true) {

    // Step 1: Sync PENDING records to HRMS (drain backlog first)
    try {
      await syncPendingBatch();
    } catch (err) {
      logger.error(`Sync batch error: ${err.message}`);
    }

    // Step 2: Poll all devices for new events
    for (const terminal of terminals) {
      try {
        await pollDevice(terminal);
      } catch (err) {
        logger.error(`Poll error for ${terminal.ip}: ${err.message}`);
      }
    }

    logger.info(`Waiting ${POLL_INTERVAL_MS / 1000}s...`);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch((err) => {
  logger.error(`Fatal error: ${err.message}`);
  process.exit(1);
});