# Hikvision Attendance System

A Node.js service that continuously pulls face recognition attendance events from Hikvision devices and sends them to the HRMS Oracle database via API. Uses SQLite locally to track progress and queue failed requests for automatic retry.

---

## How It Works

```
Hikvision Device (Face Recognition)
          ↓  polls every 10 seconds
      Node.js Service
          ↓                    ↓
  SQLite (local)          HRMS API
  - last punch time    POST /api/attlog
  - retry queue              ↓
                       Oracle ATT_LOG
```

- **No data loss** — if the HRMS API is unreachable, punches are saved to a local SQLite retry queue and automatically retried on the next cycle
- **Survives restarts** — SQLite tracks the exact last punch time per device, so on restart the script picks up from exactly where it left off — even after weeks offline
- **Pagination** — fetches all records from the device in pages of 1000, so catching up after a long offline period works correctly regardless of how many records are waiting

---

## Requirements

- Windows PC or laptop that stays on during office hours
- Node.js v20 or later
- Hikvision device connected to the same local network
- HRMS backend running and accessible

---

## STEP 1 — Install Node.js

1. Go to [https://nodejs.org](https://nodejs.org)
2. Download the **LTS version**
3. Install with all default options
4. Verify the installation — open Command Prompt and run:
   ```
   node -v
   ```
   You should see something like `v20.x.x`

---

## STEP 2 — Find Your Device IP

1. Download the **Hikvision SADP Tool** from:
   [https://www.hikvision.com/en/support/tools/sadp/](https://www.hikvision.com/en/support/tools/sadp/)
2. Install and open it
3. Make sure the Hikvision device is connected to the same network
4. Your device will appear in the list with its IP address
5. Note it down — you will need it in the next step

---

## STEP 3 — Configure the .env File

Open the `.env` file in Notepad and fill in your values:

```env
# HRMS API
HRMS_API_URL=http://localhost:4000/api/attlog
HRMS_API_TOKEN=your_token_here

# Polling interval in milliseconds (10000 = 10 seconds)
POLL_INTERVAL_MS=10000

# Hikvision devices — one object per device
# in_out: 1 = always IN, 2 = always OUT, 3 = auto by time (before 11am = IN, after = OUT)
TERMINALS=[{"ip":"192.168.0.107","in_out":3,"api_string":"http://192.168.0.107/ISAPI/AccessControl/AcsEvent?format=json","location":"Main Entrance"}]
```

**For multiple devices**, add more objects to the array:
```env
TERMINALS=[{"ip":"192.168.0.107","in_out":3,"api_string":"http://192.168.0.107/ISAPI/AccessControl/AcsEvent?format=json","location":"Main Entrance"},{"ip":"192.168.0.108","in_out":2,"api_string":"http://192.168.0.108/ISAPI/AccessControl/AcsEvent?format=json","location":"Exit Gate"}]
```

---

## STEP 4 — Install Dependencies

Open Command Prompt, navigate to the project folder, and run:

```
cd C:\attendance-system
npm install
```

---

## STEP 5 — Run the Script

```
node index.js
```

On a successful start you will see:

```
==============================================
  Hikvision Attendance System — Node.js
  Oracle HRMS  →  via API
  Retry queue  →  SQLite (attendance.db)
  API: http://localhost:4000/api/attlog
  Started at: 19/04/2026, 09:00:00
==============================================

[✓] HRMS API connected.

[✓] Loaded 1 terminal(s):
    → 192.168.0.107 | Main Entrance
      Last time: first run — will fetch last 10 days

[POLLING] 192.168.0.107
  From: 2026-04-09T00:00:00+06:00
  Found 131 event(s).
    [HRMS ✓] Emp: 200002 | 2026-04-15T08:32:11+06:00 | IN
    [HRMS ✓] Emp: 200023 | 2026-04-15T08:45:07+06:00 | IN

[WAITING] 10s until next poll...
```

---

## STEP 6 — Set Up Auto Start (Windows)

So the script starts automatically every time the PC is turned on:

1. **Task Scheduler** → Open it via Start Menu search
2. Click **Create Basic Task** on the right
3. Set **Name**: `Attendance System`
4. Set **Trigger**: `When I log on`
5. Set **Action**: `Start a program`
6. **Program/script**: `wscript.exe`
7. **Add arguments**: `"C:\attendance-system\run_hidden.vbs"` *(update path)*
8. **Start in**: `C:\attendance-system` *(update path)*
9. After creating, right-click the task → **Properties**:
   - **General** tab → check **Run with highest privileges**
   - **Conditions** tab → uncheck **Start only if on AC power**
   - **Settings** tab → uncheck **Stop the task if it runs longer than**

The script will now start silently in the background every time the PC boots. All output is saved to `service_log.txt` in the project folder.

---

## IN/OUT Logic

| `in_out` value | Behavior |
|---|---|
| `1` | Always recorded as IN |
| `2` | Always recorded as OUT |
| `3` | Auto — before 11:00am = IN, 11:00am onwards = OUT |

Set per device in the `TERMINALS` array in `.env`.

---

## Retry Queue

If the HRMS API is unreachable when a punch comes in, the punch is saved to a local SQLite database (`attendance.db`) and retried automatically at the start of every poll cycle. After 10 failed attempts, the record is discarded and a warning is logged.

On startup, if there are punches from a previous session waiting in the queue, they are retried immediately before polling begins.

---

## Troubleshooting

| Problem | Solution |
|---|---|
| `HRMS API not reachable` | Check the HRMS backend is running and `HRMS_API_URL` in `.env` is correct |
| `No terminals found` | Check the `TERMINALS` value in `.env` is valid JSON |
| `No new events` | Verify device IP is correct and device is on the same network |
| Device not responding | Run `ping 192.168.x.x` in Command Prompt to check connectivity |
| Wrong device password | Default is `hik12345` — if changed, update the `specialIps` section in `hikvision.js` |
| Script not auto-starting | Check Task Scheduler → verify the task status shows `Ready` and last run time matches login time |

---

## Files

| File | Purpose |
|---|---|
| `index.js` | Main polling loop |
| `hikvision.js` | Hikvision device API client with Digest Auth and pagination |
| `localDb.js` | SQLite — tracks last punch time and retry queue |
| `start-attendance.bat` | Runs the script and auto-restarts on crash |
| `run_hidden.vbs` | Launches the `.bat` file silently with no visible window |
| `attendance.db` | Auto-created SQLite database file |
| `.env` | Configuration — API URL, token, device list |

---

## Stopping the Script

If running manually in a terminal window, press `Ctrl + C`.

If running via Task Scheduler (hidden), open **Task Scheduler**, find `Attendance System`, and click **End**.