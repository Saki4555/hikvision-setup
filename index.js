// =============================================
//  index.js — Hikvision Attendance System
//
//  Features:
//    1. Checkpoint logic     — never re-fetch old data
//    2. State machine        — PENDING → SYNCED lifecycle
//    3. Anti-flood batcher   — sends 100 records at a time
//    4. Positive ACK         — only marks SYNCED on confirmed success
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
  resetFailed,
  getStats,
} = require("./localDb");
const { getDataFromApi } = require("./hikvision");

// ---- Config ----
const POLL_INTERVAL_MS    = parseInt(process.env.POLL_INTERVAL_MS) || 10000;
const HRMS_API_URL        = process.env.HRMS_API_URL        || "";
const HRMS_API_DEVICE_KEY = process.env.HRMS_API_DEVICE_KEY || "";

// How many PENDING records to send per sync cycle
// Prevents flooding the HRMS API after a long downtime
const SYNC_BATCH_SIZE = 100;

// Delay between each request in a batch (ms)
const BATCH_DELAY_MS = 200;

// How often FAILED punches are put back to PENDING (ms)
const RETRY_FAILED_EVERY_MS = 60 * 60 * 1000; // 1 hour

// ip → terminal config (filled in main() after validation)
let TERMINAL_MAP = {};

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
//  Validate config at startup — fail loudly
// =============================================
function validateConfig(terminals) {
  const problems = [];

  if (!HRMS_API_URL)        problems.push("HRMS_API_URL is missing in .env");
  if (!HRMS_API_DEVICE_KEY) problems.push("HRMS_API_DEVICE_KEY is missing in .env");
  if (terminals.length === 0) problems.push("TERMINALS is empty or invalid in .env");

  const seenIds = new Set();
  for (const t of terminals) {
    if (!t.ip || !t.api_string) {
      problems.push(`Terminal missing ip or api_string: ${JSON.stringify(t)}`);
    }
    if (!t.att_device_id) {
      problems.push(`Terminal ${t.ip} is missing att_device_id`);
    } else if (seenIds.has(t.att_device_id)) {
      problems.push(`Duplicate att_device_id "${t.att_device_id}" (must be unique per device)`);
    } else {
      seenIds.add(t.att_device_id);
    }
    if (t.device_location_id === undefined || t.device_location_id === null || t.device_location_id === "") {
      problems.push(`Terminal ${t.ip} is missing device_location_id`);
    }
    if (!t.password) {
      problems.push(`Terminal ${t.ip} is missing password`);
    }
  }

  if (problems.length > 0) {
    problems.forEach((p) => logger.error(`CONFIG ERROR — ${p}`));
    throw new Error("Invalid configuration — fix .env and restart");
  }
}

// =============================================
//  IN/OUT resolver (kept for local records only —
//  the new API decides IN/OUT by itself)
// =============================================
function resolveInOutType(inOutType, eventTime) {
  if (inOutType !== 3) return inOutType;
  const hour = new Date(eventTime).getHours();
  return hour >= 6 && hour < 11 ? 1 : 2;
}

// "2026-10-30T09:15:23+06:00" → "2026/10/30 09:15"
function toHrmsTime(t) {
  return t.substring(0, 16).replace("T", " ").replace(/-/g, "/");
}

// =============================================
//  FEATURE 1: CHECKPOINT
// =============================================
function getStartTime(ipAddress) {
  const checkpoint = getCheckpoint(ipAddress);
  if (checkpoint) return checkpoint;

  // First run ever — go back X days (configurable via .env, default 30)
  const fallbackDays = parseInt(process.env.FALLBACK_DAYS) || 30;
  const fallbackDate = new Date(Date.now() - fallbackDays * 24 * 60 * 60 * 1000);
  const fallback = fallbackDate.toISOString().substring(0, 10) + "T00:00:00+06:00";
  logger.info(`No checkpoint for ${ipAddress} — first run, fetching last ${fallbackDays} days`);
  return fallback;
}

// =============================================
//  FEATURE 4 + 5: HRMS API CALL
//  Success = API says success AND rejected = 0
//  (inserted or duplicate both count as success)
// =============================================
async function sendOneToHRMS(punch) {
  const term = TERMINAL_MAP[punch.ip_address];
  if (!term) {
    return { success: false, error: `No terminal config for ${punch.ip_address}` };
  }

  const body = {
    emp_id:             String(punch.emp_no),
    log_date_time:      toHrmsTime(punch.in_out_time),
    att_device_id:      term.att_device_id,
    device_location_id: term.device_location_id,
  };

  try {
    const response = await axios.post(HRMS_API_URL, body, {
      headers: {
        "X-Device-Key": HRMS_API_DEVICE_KEY,
        "Content-Type": "application/json",
      },
      timeout: 10000,
    });

    const d = response.data;
    const rejected = d?.data?.rejected ?? 0;

    if (d?.success === true && rejected === 0) {
      return { success: true };
    }

    // API answered but refused the punch → counts toward FAILED
    const detail = JSON.stringify(d?.data?.results ?? d).slice(0, 300);
    logger.warn(`HRMS rejected punch ${punch.emp_no} @ ${body.log_date_time} — ${detail}`);
    return { success: false, error: detail, rejected: true };
  } catch (err) {
    const status  = err.response?.status;
    const message = String(
      err.response?.data?.message || err.response?.data?.error || err.message
    );

    if (status) {
      logger.apiError(status, message, HRMS_API_URL);
    } else {
      logger.error(`HRMS API unreachable — ${err.message}`);
    }

    // 400 / 422 = API refused this punch's data → counts toward FAILED
    // Everything else (network, 401/403/404/429, 5xx) = temporary → retry forever
    const rejected = status === 400 || status === 422;
    return { success: false, error: message, rejected };
  }
}

// =============================================
//  FEATURE 3: ANTI-FLOOD BATCHER
// =============================================
async function syncPendingBatch() {
  const batch = getPendingBatch(SYNC_BATCH_SIZE);

  if (batch.length === 0) return;

  logger.sync(`Syncing ${batch.length} PENDING record(s) to HRMS...`);

  let synced = 0;
  let failed = 0;

  for (const punch of batch) {
    const result = await sendOneToHRMS(punch);

    if (result.success) {
      markSynced(punch.id);
      synced++;
    } else {
      recordFailedAttempt(punch.id, result.error, result.rejected === true);
      failed++;
    }

    if (BATCH_DELAY_MS > 0) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  if (synced > 0) logger.sync(`Batch complete — ${synced} synced, ${failed} failed`);
  if (failed > 0) logger.warn(`${failed} record(s) failed — will retry next cycle`);
}

// =============================================
//  POLL ONE DEVICE
// =============================================
async function pollDevice(terminal) {
  const { ip, api_string, in_out, password } = terminal;

  const startTime = getStartTime(ip);
  const tomorrow  = new Date(Date.now() + 86400000);
  const endTime   = tomorrow.toISOString().substring(0, 10) + "T00:00:00+06:00";

  logger.poll(`Polling ${ip} from ${startTime}`);

  const events = await getDataFromApi(api_string, startTime, endTime, password);

  if (!events || events.length === 0) {
    logger.poll(`No new events from ${ip}`);
    return;
  }

  logger.poll(`${events.length} event(s) received from ${ip}`);

  const punchesToSave = [];

  for (const event of events) {
    const time  = event.time;
    const empNo = event.employeeNoString || null;

    // Always update checkpoint — even for door lock / system events
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

  insertBatch(punchesToSave);

  logger.info(`Saved ${punchesToSave.length} punch(es) as PENDING from ${ip}`);
}

// =============================================
//  MAIN LOOP
// =============================================
async function main() {
  logger.info("==============================================");
  logger.info("  Hikvision Attendance System — Node.js v6");
  logger.info("  1. Checkpoint   — incremental device fetch");
  logger.info("  2. State machine — PENDING → SYNCED");
  logger.info("  3. Anti-flood    — batch sync (100/cycle)");
  logger.info("  4. Positive ACK  — confirmed success only");
  logger.info("  5. Watchdog      — HTTP error logging");
  logger.info(`  API: ${HRMS_API_URL}`);
  logger.info("==============================================");

  // ---- Load + validate terminals and config ----
  const terminals = getTerminals();
  validateConfig(terminals);
  TERMINAL_MAP = Object.fromEntries(terminals.map((t) => [t.ip, t]));

  // ---- Startup stats ----
  const stats = getStats();
  logger.info(`SQLite stats — Total: ${stats.total} | Pending: ${stats.pending} | Synced: ${stats.synced} | Failed: ${stats.failed}`);

  if (stats.pending > 0) {
    logger.warn(`${stats.pending} PENDING record(s) from previous session — will sync now`);
  }

  // ---- Show terminals ----
  logger.info(`Loaded ${terminals.length} terminal(s):`);
  terminals.forEach((t) => {
    const checkpoint = getCheckpoint(t.ip) || "first run";
    logger.info(`  → ${t.ip} | ${t.location || "no location"} | ${t.att_device_id} | loc ${t.device_location_id} | checkpoint: ${checkpoint}`);
  });

  logger.info("----------------------------------------------");

  // ---- Give FAILED punches another chance at startup ----
  let lastRetryAt = Date.now();
  const resetAtStart = resetFailed();
  if (resetAtStart > 0) logger.info(`Reset ${resetAtStart} FAILED punch(es) to PENDING`);

  // ---- Infinite poll loop ----
  while (true) {
    // Hourly: put FAILED punches back to PENDING (e.g. employee added to HRMS later)
    if (Date.now() - lastRetryAt >= RETRY_FAILED_EVERY_MS) {
      lastRetryAt = Date.now();
      try {
        const n = resetFailed();
        if (n > 0) logger.info(`Hourly retry — reset ${n} FAILED punch(es) to PENDING`);
      } catch (err) {
        logger.error(`Reset FAILED error: ${err.message}`);
      }
    }

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