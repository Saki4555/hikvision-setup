// =============================================
//  index.js — Main attendance polling script
//  Inserts into:
//    1. Local MySQL (direct)
//    2. Oracle HRMS (via API call to localhost:4000)
// =============================================
require("dotenv").config();
const axios = require("axios");
const db = require("./db");
const { getDataFromApi } = require("./hikvision");

// ---- In-memory trackers ----
const lastEntryTimeMap = {};
const lastEntrySerialMap = {};

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS) || 10000;
const HRMS_API_URL = process.env.HRMS_API_URL || "http://localhost:4000/api/attlog";
const HRMS_API_TOKEN = process.env.HRMS_API_TOKEN || "123456";
const ENABLE_HRMS = process.env.ENABLE_HRMS_INSERT !== "false";

// =============================================
//  Fetch all active terminals from local MySQL
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
//  Determine IN/OUT type
//  - 1 or 2 → use directly
//  - 3 (auto) → before 11am = IN (1), else OUT (2)
// =============================================
function resolveInOutType(inOutType, eventTime) {
  if (inOutType !== 3) return inOutType;
  const hour = new Date(eventTime).getHours();
  return hour >= 6 && hour < 11 ? 1 : 2;
}

// =============================================
//  Insert into LOCAL MySQL
// =============================================
async function insertIntoMySQL(empNo, inOutTime, resolvedType, ipAddress, simpleTime) {
  const sql = `
    INSERT IGNORE INTO xx_attlog_hik 
      (am_empno, am_time_in_out, am_type_in_out, am_mac_id, am_time_in_out_simple)
    VALUES (?, ?, ?, ?, ?)
  `;
  try {
    await db.query(sql, [empNo, inOutTime, resolvedType, ipAddress, simpleTime]);
    console.log(`    [MySQL  ✓] Emp: ${empNo} | ${simpleTime} | ${resolvedType === 1 ? "IN" : "OUT"}`);
  } catch (err) {
    console.error(`    [MySQL  ✗] ${empNo}: ${err.message}`);
  }
}

// =============================================
//  Insert into ORACLE via HRMS API
//  POST http://localhost:4000/api/attlog
//  Authorization: Bearer 123456
// =============================================
async function insertIntoHRMS(empNo, inOutTime, resolvedType, ipAddress) {
  const body = {
    AM_EMPNO:       parseInt(empNo),  // Oracle column is NUMBER(15)
    AM_TIME_IN_OUT: inOutTime,
    AM_TYPE_IN_OUT: resolvedType,
    AM_MAC_ID:      ipAddress,
    AM_LAT_IN_OUT:  null,
    AM_LON_IN_OUT:  null,
    T_ZONE:         null,
    LOCATION_ID:    null,
    TEAM_LEAD_ID:   null,
  };

  try {
    await axios.post(HRMS_API_URL, body, {
      headers: {
        Authorization: `Bearer ${HRMS_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      timeout: 10000,
    });
    console.log(`    [HRMS   ✓] Emp: ${empNo} | ${inOutTime} | ${resolvedType === 1 ? "IN" : "OUT"}`);
  } catch (err) {
    const status = err.response?.status;
    const message = err.response?.data?.error || err.message;

    if (status === 500 && message.toLowerCase().includes("unique")) {
      // Duplicate record — Oracle unique constraint — safe to ignore
      console.log(`    [HRMS   ~] Duplicate skipped for Emp ${empNo} at ${inOutTime}`);
    } else {
      console.error(`    [HRMS   ✗] Emp ${empNo}: ${message}`);
    }
  }
}

// =============================================
//  Insert into BOTH — MySQL + HRMS API
// =============================================
async function insertAttendance(empNo, inOutTime, inOutType, ipAddress) {
  const resolvedType = resolveInOutType(inOutType, inOutTime);

  const simpleTime = new Date(inOutTime)
    .toISOString()
    .replace("T", " ")
    .substring(0, 19);

  await insertIntoMySQL(empNo, inOutTime, resolvedType, ipAddress, simpleTime);

  if (ENABLE_HRMS) {
    await insertIntoHRMS(empNo, inOutTime, resolvedType, ipAddress);
  }
}

// =============================================
//  Process one terminal / device
// =============================================
async function processTerminal(terminal) {
  const { ip_address, api_string, in_out, max_time } = terminal;

  const startTime = lastEntryTimeMap[ip_address] || max_time;
  const tomorrow = new Date(Date.now() + 86400000);
  const endTime = tomorrow.toISOString().substring(0, 10) + "T00:00:00+06:00";

  console.log(`\n[POLLING] ${ip_address}`);
  console.log(`  From: ${startTime}`);

  const events = await getDataFromApi(api_string, startTime, endTime);

  if (!events || events.length === 0) {
    console.log(`  No new events.`);
    return;
  }

  console.log(`  Found ${events.length} event(s).`);

  for (const event of events) {
    const time   = event.time;
    const serial = event.serialNo;
    const empNo  = event.employeeNoString || null;

    lastEntryTimeMap[ip_address] = time;

    if (!empNo) continue;

    const lastSerial = lastEntrySerialMap[ip_address] ?? -1;

    if (serial > lastSerial) {
      await insertAttendance(empNo, time, in_out, ip_address);
      lastEntrySerialMap[ip_address] = serial;
    }
  }
}

// =============================================
//  MAIN LOOP
// =============================================
async function main() {
  console.log("==============================================");
  console.log("  Hikvision Attendance System — Node.js");
  console.log("  Local MySQL  →  direct insert");
  console.log("  Oracle HRMS  →  via API (localhost:4000)");
  console.log("  Started at: " + new Date().toLocaleString());
  console.log("==============================================\n");

  // Test MySQL
  try {
    await db.query("SELECT 1");
    console.log("[✓] MySQL connected.");
  } catch (err) {
    console.error("[✗] MySQL connection failed:", err.message);
    console.error("    Make sure XAMPP MySQL is running.");
    process.exit(1);
  }

  // Test HRMS API
  if (ENABLE_HRMS) {
    try {
      await axios.get(
        HRMS_API_URL + "?page=1&limit=1",
        { headers: { Authorization: `Bearer ${HRMS_API_TOKEN}` }, timeout: 5000 }
      );
      console.log("[✓] HRMS API connected (localhost:4000).");
    } catch (err) {
      console.warn("[!] HRMS API not reachable —", err.message);
      console.warn("    Data will still be saved to MySQL.");
      console.warn("    Fix the HRMS API or set ENABLE_HRMS_INSERT=false in .env");
    }
  } else {
    console.log("[~] HRMS API insert disabled (ENABLE_HRMS_INSERT=false)");
  }

  console.log("");

  // Infinite polling loop
  while (true) {
    try {
      const terminals = await getTerminals();

      if (terminals.length === 0) {
        console.log("[WARNING] No active terminals found in xx_att_api table.");
      }

      for (const terminal of terminals) {
        await processTerminal(terminal);
      }
    } catch (err) {
      console.error("[LOOP ERROR]", err.message);
    }

    console.log(`\n[WAITING] ${POLL_INTERVAL_MS / 1000}s until next poll...`);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

main();