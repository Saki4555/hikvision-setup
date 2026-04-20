# Hikvision Attendance System

A production-grade Node.js service that continuously pulls face recognition attendance events from Hikvision devices and syncs them to the HRMS Oracle database via API. Built for reliability — zero data loss even when the HRMS API is down or the PC is offline for extended periods.

---

## Architecture

```
Hikvision Device (Face Recognition)
          ↓  polls every 10 seconds
      Node.js Service
          ↓
  SQLite (attendance.db)
  status = PENDING
          ↓
  Sync worker (every cycle)
          ↓
  POST /api/attlog → HRMS API
          ↓
  Oracle ATT_LOG
  status = SYNCED
```

### Core Features

| Feature | Description |
|---|---|
| **Checkpoint** | Reads `MAX(punch_time)` from SQLite before every poll — never re-fetches data already collected |
| **State Machine** | Every punch saved as `PENDING` first, only marked `SYNCED` after confirmed `200/201` from HRMS API |
| **Anti-Flood Batcher** | Sends max 100 records per cycle with 200ms delay between requests — safe for Oracle server after long downtime |
| **Positive ACK** | Only marks `SYNCED` on HTTP `200` or `201` — timeouts and `500` errors keep status as `PENDING` for retry |
| **Watchdog Logger** | Logs specific HTTP error codes (`401`, `404`, `503` etc.) with human-readable IT messages |
| **Pagination** | Fetches device records in pages of 1000 — handles months of missed data correctly |
| **Auto Restart** | `.bat` file restarts the script automatically if it crashes |
| **Auto Start** | Task Scheduler starts the script silently on every Windows login |

---

## Requirements

- Windows PC or laptop that stays on during office hours
- Node.js v20 LTS or later
- Hikvision device connected to the same local network
- HRMS backend API running and accessible

---

## Device Setup

> ### 👉 [Hik-Vision Setup Guide](https://www.notion.so/Hik-Vision-DS-K1T343-setup-334c08e7602580d0a4fbd018b3f944b6)

---

## Installation

### STEP 1 — Install Node.js

1. Go to [https://nodejs.org](https://nodejs.org)
2. Download the **LTS version**
3. Install with all default options
4. Verify — open Command Prompt and run:
   ```
   node -v
   ```
   Expected output: `v20.x.x` or later

---

### STEP 2 — Find Your Device IP

1. Download **Hikvision SADP Tool** from:
   [https://www.hikvision.com/en/support/tools/sadp/](https://www.hikvision.com/en/support/tools/sadp/)
2. Install and open it
3. Make sure the Hikvision device is on the same network
4. Your device will appear in the list with its IP address
5. Note it down — you need it in Step 3

---

### STEP 3 — Configure `.env`

Open the `.env` file in Notepad and fill in your values:

```env
# ---- Environment ----
# development = all logs written to service_log.txt
# production  = only WARN and ERROR written to service_log.txt
NODE_ENV=development

# ---- HRMS API ----
HRMS_API_URL=http://localhost:4000/api/attlog
HRMS_API_TOKEN=your_token_here

# ---- Polling interval (milliseconds) ----
POLL_INTERVAL_MS=10000

# ---- Fallback window on fresh install (no checkpoint) ----
# Used only when attendance.db does not exist (new PC / first run)
# Device stores ~150,000 events — increase if PC was off longer than 30 days
FALLBACK_DAYS=30

# ---- Hikvision Devices ----
# in_out: 1 = always IN, 2 = always OUT, 3 = auto by time of day
TERMINALS=[{"ip":"192.168.0.107","in_out":3,"api_string":"http://192.168.0.107/ISAPI/AccessControl/AcsEvent?format=json","location":"Main Entrance"}]
```

**Multiple devices** — add more objects to the array:
```env
TERMINALS=[{"ip":"192.168.0.107","in_out":3,"api_string":"http://192.168.0.107/ISAPI/AccessControl/AcsEvent?format=json","location":"Main Entrance"},{"ip":"192.168.0.108","in_out":2,"api_string":"http://192.168.0.108/ISAPI/AccessControl/AcsEvent?format=json","location":"Exit Gate"}]
```

---

### STEP 4 — Install Dependencies

```bash
cd C:\attendance-system
npm install
```

---

### STEP 5 — Run Manually (for testing)

```bash
node index.js
```

Expected output on successful start:

```
[2026-04-20 09:00:00] [INFO ] ==============================================
[2026-04-20 09:00:00] [INFO ]   Hikvision Attendance System — Node.js v5
[2026-04-20 09:00:00] [INFO ]   1. Checkpoint   — incremental device fetch
[2026-04-20 09:00:00] [INFO ]   2. State machine — PENDING → SYNCED
[2026-04-20 09:00:00] [INFO ]   3. Anti-flood    — batch sync (100/cycle)
[2026-04-20 09:00:00] [INFO ]   4. Positive ACK  — confirmed 200/201 only
[2026-04-20 09:00:00] [INFO ]   5. Watchdog      — HTTP error logging
[2026-04-20 09:00:00] [INFO ] SQLite stats — Total: 0 | Pending: 0 | Synced: 0 | Failed: 0
[2026-04-20 09:00:00] [INFO ] HRMS API reachable — starting poll loop
[2026-04-20 09:00:00] [POLL ] Polling 192.168.0.107 from 2026-03-21T00:00:00+06:00
[2026-04-20 09:00:00] [POLL ] 131 event(s) received from 192.168.0.107
[2026-04-20 09:00:00] [INFO ] Saved 131 punch(es) as PENDING
[2026-04-20 09:00:00] [SYNC ] Syncing 100 PENDING record(s) to HRMS...
[2026-04-20 09:00:20] [SYNC ] Batch complete — 100 synced, 0 failed
```

---

### STEP 6 — Set Up Auto Start (Windows Task Scheduler)

So the script starts silently in the background every time the PC is turned on:

1. Open **Task Scheduler** via Start Menu search
2. Click **Create Basic Task** on the right panel
3. Set **Name**: `Attendance System`
4. Set **Trigger**: `When I log on`
5. Set **Action**: `Start a program`
6. Configure the action:
   - **Program/script**: `wscript.exe`
   - **Add arguments**: `"C:\attendance-system\run_hidden.vbs"` *(update to your actual path)*
   - **Start in**: `C:\attendance-system` *(update to your actual path)*
7. After creating, right-click the task → **Properties**:
   - **General** tab → check **Run with highest privileges**
   - **Conditions** tab → uncheck **Start only if on AC power**
   - **Settings** tab → uncheck **Stop the task if it runs longer than**
8. Verify — after logging in, the task **Last Run Time** should match your login time

> **Tip**: In the right-side Actions pane, select **Enable All Tasks History**, then check the **History** tab for `Event 102` (Task Completed) to confirm it ran.

---

## IN/OUT Logic

| `in_out` value | Behavior |
|---|---|
| `1` | Always recorded as IN |
| `2` | Always recorded as OUT |
| `3` | Auto — before 11:00am = IN, 11:00am onwards = OUT |

Configured per device in the `TERMINALS` array in `.env`.

---

## Punch Lifecycle

```
Device event received
      ↓
Saved to SQLite → status: PENDING
      ↓
Sync worker tries HRMS API
      ↓
  200/201 → status: SYNCED ✅
  timeout/500 → status: PENDING (retry next cycle)
  after 10 failed attempts → status: FAILED ⚠️
```

---

## Logging

Controlled by `NODE_ENV` in `.env`:

| Mode | Console | `service_log.txt` |
|---|---|---|
| `development` | All levels | All levels |
| `production` | All levels | `WARN` and `ERROR` only |

Log file is wiped clean on every script restart — no unbounded growth.

---

## Troubleshooting

| Problem | Solution |
|---|---|
| `HRMS API not reachable` | Check HRMS backend is running and `HRMS_API_URL` in `.env` is correct |
| `No terminals found` | Check `TERMINALS` in `.env` is valid JSON |
| `No new events` | Verify device IP is correct and device is on the same network |
| Device not responding | Run `ping 192.168.x.x` in Command Prompt |
| Wrong device password | Default is `hik12345` — if changed, update `specialIps` in `hikvision.js` |
| Script not auto-starting | Open Task Scheduler → verify status is `Ready` and last run time matches login |
| `401` in service_log.txt | `HRMS_API_TOKEN` expired — update it in `.env` |
| `404` in service_log.txt | `HRMS_API_URL` changed — update it in `.env` |
| `503` in service_log.txt | HRMS server under maintenance — punches are queued safely |
| Fresh PC / `attendance.db` missing | Script automatically fetches last `FALLBACK_DAYS` days from device — no action needed |
| PC was off longer than `FALLBACK_DAYS` | Increase `FALLBACK_DAYS` in `.env` and restart — e.g. set to `60` if PC was off 60 days |

---

## Project Files

| File | Purpose |
|---|---|
| `index.js` | Main polling and sync loop |
| `hikvision.js` | Hikvision device API client — Digest Auth + pagination |
| `localDb.js` | SQLite — checkpoint tracking and punch state machine |
| `logger.js` | Structured logger — console + file with `NODE_ENV` control |
| `start-attendance.bat` | Runs the script, auto-restarts on crash, wipes log on start |
| `run_hidden.vbs` | Launches `.bat` silently — no visible CMD window |
| `attendance.db` | Auto-created SQLite database — do not delete |
| `.env` | Configuration — API credentials, device list, environment |
| `service_log.txt` | Auto-created log file — wiped on each restart |

---

## Stopping the Script

**Manual run** — press `Ctrl + C` in the terminal.

**Running via Task Scheduler** — open Task Scheduler, find `Attendance System`, click **End Task**.