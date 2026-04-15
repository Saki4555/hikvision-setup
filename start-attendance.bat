@echo off
:: No title needed as the window is hidden

:START
:: Change to the correct directory
cd /d "E:\Web_Dev\JOB\revinns-limited\xx-att-api\node-js-version"

:: Run node and save all output (success and errors) to service_log.txt
:: The '>>' appends the new logs to the end of the file
echo [START] System initiated at %date% %time% >> service_log.txt
node index.js >> service_log.txt 2>&1

:: If it crashes, log it and wait
echo [CRASH] Script stopped at %date% %time% >> service_log.txt
timeout /t 10 /nobreak >nul

goto START