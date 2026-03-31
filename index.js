// =============================================
//  index.js — Main attendance polling script
//  Replaces: attendanceCall.php + common.php
// =============================================
require("dotenv").config();
const db = require("./db");
const { getDataFromApi } = require("./hikvision");

// ---- In-memory trackers (same as PHP arrays) ----
// Tracks the last event time per device IP (to avoid re-fetching old data)
const lastEntryTimeMap = {};
// Tracks the last event serial number per device IP (to avoid duplicate inserts)
const lastEntrySerialMap = {};

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS) || 10000;

// =============================================
//  STEP 1: Fetch all active terminals from DB
// =============================================
async function getTerminals() {
  const [rows] = await db.query(`
    SELECT 
      t.id,
      t.ip_address,
      t.in_out,
      t.api_string,
      t.location,
      COALESCE(
        (
          SELECT DATE_FORMAT(
            DATE_ADD(MAX(am_time_in_out_simple), INTERVAL 1 SECOND),
            '%Y-%m-%dT%H:%i:%s+06:00'
          )
          FROM xx_attlog_hik h
          WHERE h.am_mac_id = t.ip_address
        ),
        DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 10 DAY), '%Y-%m-%dT00:00:00+06:00')
      ) AS max_time
    FROM xx_att_api t
    WHERE t.status = 1
  `);
  return rows;
}

// =============================================
//  STEP 2: Determine IN/OUT type
//  - If DB says 1 or 2 → use it directly
//  - If DB says 3 (auto) → decide by time of day
//    (same logic as original PHP: before 11am = IN, after = OUT)
// =============================================
function resolveInOutType(inOutType, eventTime) {
  if (inOutType !== 3) return inOutType;

  const hour = new Date(eventTime).getHours();
  if (hour >= 6 && hour < 11) {
    return 1; // IN
  } else {
    return 2; // OUT
  }
}

// =============================================
//  STEP 3: Insert attendance record into MySQL
// =============================================
async function insertAttendance(empNo, inOutTime, inOutType, ipAddress) {
  const resolvedType = resolveInOutType(inOutType, inOutTime);

  // Convert ISO time string to simple datetime for MySQL
  const simpleTime = new Date(inOutTime)
    .toISOString()
    .replace("T", " ")
    .substring(0, 19);

  const sql = `
    INSERT IGNORE INTO xx_attlog_hik 
      (am_empno, am_time_in_out, am_type_in_out, am_mac_id, am_time_in_out_simple)
    VALUES (?, ?, ?, ?, ?)
  `;

  try {
    await db.query(sql, [empNo, inOutTime, resolvedType, ipAddress, simpleTime]);
    console.log(
      `  [INSERT] Emp: ${empNo} | Time: ${simpleTime} | Type: ${resolvedType === 1 ? "IN" : "OUT"} | IP: ${ipAddress}`
    );
  } catch (err) {
    console.error(`  [DB ERROR] Insert failed for ${empNo}: ${err.message}`);
  }
}

// =============================================
//  STEP 4: Process one terminal
// =============================================
async function processTerminal(terminal) {
  const { ip_address, api_string, in_out, max_time } = terminal;

  // Use in-memory tracker if available, otherwise use DB max_time
  const startTime = lastEntryTimeMap[ip_address] || max_time;
  const now = new Date();
const bdMidnightTomorrow = new Date(now.getTime() + (6 * 60 * 60 * 1000) + 86400000);
const endTime = bdMidnightTomorrow.toISOString().substring(0, 10) + "T00:00:00+06:00";


  console.log(`\n[POLLING] ${ip_address}`);
  console.log(`  From: ${startTime}`);
  console.log(`  To:   ${endTime}`);

  const events = await getDataFromApi(api_string, startTime, endTime);

  

  if (!events || events.length === 0) {
    console.log(`  No new events.`);
    return;
  }

  console.log(`  Found ${events.length} event(s).`);

  for (const event of events) {
    const time = event.time;
    const serial = event.serialNo;
    const empNo = event.employeeNoString || null;

    // Always update last seen time for this device
    lastEntryTimeMap[ip_address] = time;

    if (!empNo) continue; // Skip events with no employee number

    const lastSerial = lastEntrySerialMap[ip_address] ?? -1;

    // Only insert if this event is newer than last processed (by serial number)
    if (serial > lastSerial) {
      await insertAttendance(empNo, time, in_out, ip_address);
      lastEntrySerialMap[ip_address] = serial;
    }
  }
}

// =============================================
//  MAIN LOOP — polls all terminals forever
// =============================================
async function main() {
  console.log("==============================================");
  console.log("  Hikvision Attendance System — Node.js");
  console.log("  Started at: " + new Date().toLocaleString());
  console.log("==============================================");

  // Test DB connection first
  try {
    await db.query("SELECT 1");
    console.log("[DB] Connected to MySQL successfully.\n");
  } catch (err) {
    console.error("[DB ERROR] Cannot connect to MySQL:", err.message);
    console.error("Check your .env file and make sure XAMPP MySQL is running.");
    process.exit(1);
  }

  // Infinite polling loop
  while (true) {
    try {
      const terminals = await getTerminals();

      if (terminals.length === 0) {
        console.log(
          "[WARNING] No active terminals found in xx_att_api table."
        );
      }

      for (const terminal of terminals) {
        await processTerminal(terminal);
      }
    } catch (err) {
      console.error("[LOOP ERROR]", err.message);
    }

    console.log(
      `\n[WAITING] Next poll in ${POLL_INTERVAL_MS / 1000} seconds...`
    );
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

main();