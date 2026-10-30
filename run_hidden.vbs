Set WinScriptHost = CreateObject("WScript.Shell")
' Replace the path below with the exact path to your .bat file
WinScriptHost.Run Chr(34) & "C:\Users\User\OneDrive\Desktop\temp-dev\nexirion\hikvision-setup\start-attendance.bat" & Chr(34), 0
Set WinScriptHost = Nothing