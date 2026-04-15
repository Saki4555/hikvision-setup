Set WinScriptHost = CreateObject("WScript.Shell")
' Replace the path below with the exact path to your .bat file
WinScriptHost.Run Chr(34) & "E:\Web_Dev\JOB\revinns-limited\xx-att-api\node-js-version\start-attendance.bat" & Chr(34), 0
Set WinScriptHost = Nothing