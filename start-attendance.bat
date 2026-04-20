@echo off
:: Hikvision Attendance System — Auto Start
:: Runs hidden via run_hidden.vbs
:: Log file is wiped clean on every fresh start

:START
cd /d "E:\Web_Dev\JOB\revinns-limited\xx-att-api\sqlite-node-js-version"

:: Overwrite log file on every fresh start (keeps it clean)
echo [START] System initiated at %date% %time% > service_log.txt

:: Run node — append all output to the fresh log
node index.js >> service_log.txt 2>&1

:: If script stops or crashes — append to log and restart
echo [CRASH] Script stopped at %date% %time% >> service_log.txt
echo [INFO] Restarting in 10 seconds... >> service_log.txt
timeout /t 10 /nobreak >nul

goto START