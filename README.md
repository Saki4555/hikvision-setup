# Hikvision Attendance System

A Node.js service that pulls face recognition attendance events from Hikvision devices and syncs them to the HRMS through its device API. It is built for reliability: no punch is lost when the HRMS API is down or the PC is offline.

---

## How it works

```
Hikvision device
      │  polled every 10 seconds
      ▼
Node.js service ──► SQLite (attendance.db), status = PENDING
                          │
                          ▼
                  Sync worker (every cycle)
                          │  POST + X-Device-Key
                          ▼
                    HRMS device API
                          │
                          ▼
                   status = SYNCED
```

### Features

| Feature | Description |
|---|---|
| **Checkpoint** | Remembers the last event time per device, so old data is never fetched twice |
| **State machine** | Every punch is saved locally as `PENDING` first, and marked `SYNCED` only after the API confirms it |
| **Anti-flood batcher** | Sends at most 100 punches per cycle with a 200 ms delay between requests |
| **Smart retries** | Network or server problems retry forever. Punches the API refuses become `FAILED` after 10 tries, then are retried automatically every hour |
| **Startup validation** | Refuses to start if `.env` is missing the API URL, device key, or any per-device setting |
| **Watchdog logger** | Logs readable error messages for HTTP errors (`401`, `404`, `503`, ...) |
| **Pagination** | Reads device records in pages of 1000, so long downtime is no problem |
| **Auto restart / start** | A `.bat` loop restarts the service after a crash, and Task Scheduler starts it at login |

---

## Requirements

- Windows PC that stays on during office hours
- Node.js v20 LTS or later
- Hikvision device on the same local network
- HRMS device API URL and **device key**

---

## Device setup

[Hik-Vision setup guide](https://www.notion.so/Hik-Vision-DS-K1T343-setup-334c08e7602580d0a4fbd018b3f944b6)

---

## Installation

### 1. Install Node.js

Download the **LTS** version from [nodejs.org](https://nodejs.org), install with the defaults, and check:

```
node -v
```

### 2. Find the device IP

Install the [Hikvision SADP tool](https://www.hikvision.com/en/support/tools/sadp/), open it on the same network, and note the device IP.

### 3. Configure `.env`

Copy `.env.example` to `.env` and fill it in:

```env
# --- HRMS API ---
HRMS_API_URL=https://sl.nexirion.tech/api/v1/device/attendance-logs
HRMS_API_DEVICE_KEY=your_device_key

# --- Polling interval (milliseconds) ---
POLL_INTERVAL_MS=10000

# --- Terminals ---
TERMINALS=[{"ip":"192.168.0.107","in_out":3,"api_string":"http://192.168.0.107/ISAPI/AccessControl/AcsEvent?format=json","location":"Dhaka Center","att_device_id":"DHAKA-CENTER-01","device_location_id":25,"password":"device_admin_password"}]

# development = log everything to file, production = only WARN and ERROR
NODE_ENV=production

# Days to fetch on a fresh install (no attendance.db)
FALLBACK_DAYS=30
```

**Terminal fields** (one object per device)

| Field | Meaning |
|---|---|
| `ip` | Device IP address |
| `api_string` | Device AcsEvent URL (use the same IP) |
| `location` | Free-text name, used in logs only |
| `att_device_id` | Unique ID for this machine. **Never change it** once the device starts sending |
| `device_location_id` | Location ID given by the HRMS team (for example `25` for Dhaka Center) |
| `password` | Device admin password (can differ per device) |
| `in_out` | Ignored. The API decides IN or OUT itself |

**Multiple devices:** add more objects to the `TERMINALS` array, each with its own `ip`, `api_string`, `att_device_id` and `password`.

### 4. Install dependencies

```bash
cd C:\attendance-system
npm install
```

> Keep the folder outside OneDrive. OneDrive can lock `attendance.db`.

### 5. Test run

```bash
node index.js
```

Healthy output looks like this:

```
[INFO ] SQLite stats — Total: 0 | Pending: 0 | Synced: 0 | Failed: 0
[INFO ] Loaded 1 terminal(s):
[INFO ]   → 192.168.0.107 | Dhaka Center | DHAKA-CENTER-01 | loc 25 | checkpoint: first run
[POLL ] 131 event(s) received from 192.168.0.107
[INFO ] Saved 131 punch(es) as PENDING from 192.168.0.107
[SYNC ] Syncing 100 PENDING record(s) to HRMS...
[SYNC ] Batch complete — 100 synced, 0 failed
```

### 6. Auto start (Task Scheduler)

1. Edit the paths in `start-attendance.bat` and `run_hidden.vbs` to your real install folder.
2. Open **Task Scheduler** and click **Create Basic Task**.
3. **Name:** `Attendance System`. **Trigger:** `When I log on`. **Action:** `Start a program`.
4. **Program/script:** `wscript.exe`
5. **Add arguments:** `"C:\attendance-system\run_hidden.vbs"` (your real path)
6. **Start in:** `C:\attendance-system` (your real path)
7. Open the task **Properties**:
   - **General:** check **Run with highest privileges**
   - **Conditions:** uncheck **Start only if on AC power**
   - **Settings:** uncheck **Stop the task if it runs longer than**
8. Log in again and check that **Last Run Time** matches.

---

## Punch lifecycle

```
Device event
     ↓
Saved to SQLite → PENDING
     ↓
Sync worker → HRMS API
     ├─ accepted or already exists ───────────► SYNCED ✅
     ├─ network error / 5xx / bad key ────────► stays PENDING, retried forever
     └─ refused by API (e.g. unknown emp_id) ─► retried up to 10 times, then FAILED ⚠️
                                                   ↓
                              reset to PENDING at startup and every hour
```

FAILED punches are never deleted. Once the missing employee is added in HRMS, their punches sync automatically within an hour.

---

## Data sent to the API

| Field | Example | Notes |
|---|---|---|
| `emp_id` | `SL518` | Employee number from the device, sent as text |
| `log_date_time` | `2026/10/30 09:15` | Dhaka time, `yyyy/mm/dd hh:mm` |
| `att_device_id` | `DHAKA-CENTER-01` | From `TERMINALS` |
| `device_location_id` | `25` | From `TERMINALS` |

The device key is sent in the `X-Device-Key` header.

> Punches have no seconds. Two punches by the same person in the same minute look identical to the API.

---

## Logging

| `NODE_ENV` | Console | `service_log.txt` |
|---|---|---|
| `development` | All levels | All levels |
| `production` | All levels | `WARN` and `ERROR` only |

The log file is wiped on every restart, so it never grows without limit. Log times use the PC's local time, so keep the PC timezone set to Dhaka.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `CONFIG ERROR` at startup | Read the message. A required `.env` value or a terminal field is missing |
| `Invalid or missing device key` | Check `HRMS_API_DEVICE_KEY` in `.env` |
| `emp_id not found among active employees` | The employee isn't in HRMS yet. Add them and the punches sync within an hour |
| `404` in the log | `HRMS_API_URL` is wrong or has changed |
| `503` in the log | HRMS is under maintenance. Punches are queued safely |
| `No new events` | Check the device IP and that the device is on the network (`ping 192.168.x.x`) |
| Device returns `401` | Wrong device `password` in `TERMINALS`. Several wrong tries lock the device for about 6 minutes |
| Script not auto-starting | Check Task Scheduler: status `Ready`, and Last Run Time matches your login |
| Fresh PC, `attendance.db` missing | The last `FALLBACK_DAYS` days are fetched from the device automatically |
| PC was off longer than `FALLBACK_DAYS` | Increase `FALLBACK_DAYS` and restart (only matters when `attendance.db` is missing) |

---

## Updating the code or `.env`

Any change needs a restart of `node.exe`:

1. Disable the Task Scheduler task.
2. In an admin Command Prompt: `taskkill /F /IM node.exe`
3. Make the change.
4. Run `node index.js` to test, then re-enable the task.

> Never delete `attendance.db` while the script is running. It holds the checkpoint and any unsynced punches.

---

## Project files

| File | Purpose |
|---|---|
| `index.js` | Main loop: poll, save, sync, retry |
| `hikvision.js` | Device client: Digest Auth and pagination |
| `localDb.js` | SQLite: checkpoints and punch state machine |
| `logger.js` | Console and file logger |
| `downloadFaces.js` | One-time face image downloader (not part of the sync, endpoints untested) |
| `start-attendance.bat` | Runs the service, restarts on crash, wipes the log on start |
| `run_hidden.vbs` | Launches the `.bat` with no visible window |
| `.env` | Your configuration (never commit it) |
| `.env.example` | Configuration template |
| `attendance.db` | Auto-created SQLite database. Do not delete |
| `service_log.txt` | Auto-created log file |

---

## Stopping the service

- **Manual run:** press `Ctrl + C`.
- **Task Scheduler:** find `Attendance System` and click **End Task**.