# Hikvision Attendance System — Setup Guide

## What This Does
This Node.js script connects to your Hikvision DS-K1T43 face recognition device,
pulls attendance data every 10 seconds, and saves it to a local MySQL database (XAMPP).

---

## STEP 1 — Install Node.js

1. Go to https://nodejs.org
2. Download the **LTS version** (the green button)
3. Install it with all default options
4. To verify, open Command Prompt and type:
   ```
   node -v
   ```
   You should see something like `v20.x.x`

---

## STEP 2 — Start XAMPP

1. Open XAMPP Control Panel
2. Click **Start** next to **Apache**
3. Click **Start** next to **MySQL**
4. Both should show green "Running" status

---

## STEP 3 — Set Up the Database

1. Open your browser and go to: http://localhost/phpmyadmin
2. Click **SQL** tab at the top
3. Open the file `setup.sql` from this folder
4. Copy ALL its contents and paste into the SQL box
5. **IMPORTANT**: Before running, find this line and change the IP:
   ```sql
   VALUES ('192.168.1.64', ...
   ```
   Replace `192.168.1.64` with your actual Hikvision device IP
   (Use Hikvision SADP Tool to find it)
6. Click **Go** to run it
7. You should see `attendance_db` appear in the left panel

---

## STEP 4 — Find Your Device IP (SADP Tool)

1. Download Hikvision SADP Tool from:
   https://www.hikvision.com/en/support/tools/sadp/
2. Install and open it
3. Make sure your Hikvision device is plugged into the same network
4. Your device will appear in the list with its IP address
5. Note down that IP — you need it in Step 3 and Step 6

---

## STEP 5 — Put This Project on Your Computer

1. Copy this entire folder (attendance-system) to anywhere, e.g.:
   ```
   C:\attendance-system\
   ```

---

## STEP 6 — Configure the .env File

1. Open `.env` file in Notepad
2. It looks like this:
   ```
   DB_HOST=127.0.0.1
   DB_PORT=3306
   DB_USER=root
   DB_PASSWORD=
   DB_NAME=attendance_db
   POLL_INTERVAL_MS=10000
   ```
3. If your XAMPP MySQL has a password, fill in `DB_PASSWORD=yourpassword`
   (By default XAMPP has no password, so leave it blank)
4. Save the file

---

## STEP 7 — Install Dependencies

1. Open Command Prompt
2. Navigate to your project folder:
   ```
   cd C:\attendance-system
   ```
3. Run:
   ```
   npm install
   ```
4. Wait for it to finish (it downloads the required libraries)

---

## STEP 8 — Run the Script

In the same Command Prompt window, type:
```
node index.js
```

You should see:
```
==============================================
  Hikvision Attendance System — Node.js
  Started at: ...
==============================================
[DB] Connected to MySQL successfully.

[POLLING] 192.168.1.64
  From: 2024-01-01T00:00:00+06:00
  Found 5 event(s).
  [INSERT] Emp: 1001 | Time: 2024-01-15 08:32:11 | Type: IN | IP: 192.168.1.64
```

---

## STEP 9 — Verify Data in phpMyAdmin

1. Go to http://localhost/phpmyadmin
2. Click `attendance_db` → `xx_attlog_hik`
3. You should see attendance records appearing

---

## How IN/OUT is Determined

| DB Setting | Meaning |
|---|---|
| `in_out = 1` | Always IN |
| `in_out = 2` | Always OUT |
| `in_out = 3` | Auto: before 11am = IN, 11am onwards = OUT |

Change this in the `xx_att_api` table per device.

---

## Troubleshooting

| Problem | Solution |
|---|---|
| `Cannot connect to MySQL` | Make sure XAMPP MySQL is running |
| `No active terminals found` | Check `xx_att_api` table has a row with `status=1` |
| `No new events` | Check device IP is correct and device is on same network |
| Device not responding | Ping the device: `ping 192.168.x.x` in Command Prompt |
| Wrong password | Device default password is `hik12345`. If changed, update `hikvision.js` |

---

## To Stop the Script
Press `Ctrl + C` in the Command Prompt window.

## To Run Again
```
node index.js
```