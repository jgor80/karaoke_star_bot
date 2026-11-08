@echo off
setlocal
rem Keeps the karaoke stats site live: starts a background sync at every
rem sign-in that uploads each new KaraFun song within seconds.
rem Put this file next to karaoke_sync.py and karaoke_sync_config.json.

set "SCRIPT=%~dp0karaoke_sync.py"
if not exist "%SCRIPT%" (
  echo Can't find karaoke_sync.py. Keep it in the same folder as this file.
  pause & exit /b 1
)
findstr /c:"--watch" "%SCRIPT%" >nul || (
  echo This karaoke_sync.py is the old version. Replace it with the new one, then run this again.
  pause & exit /b 1
)
if not exist "%~dp0karaoke_sync_config.json" (
  echo Can't find karaoke_sync_config.json next to this file, so nothing would upload.
  pause & exit /b 1
)

set "PYW="
for /f "delims=" %%i in ('where pythonw 2^>nul') do if not defined PYW set "PYW=%%i"
if not defined PYW (
  echo Python isn't installed. Install "Python 3.13" from the Microsoft Store, then run this again.
  start ms-windows-store://pdp/?ProductId=9PNRBTZXMB4Z
  pause & exit /b 1
)

echo Testing one sync...
"%PYW:pythonw=python%" "%SCRIPT%"
if errorlevel 1 (
  echo The test sync failed. See the message above.
  pause & exit /b 1
)

echo Setting up the live sync to start whenever you sign in...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$a = New-ScheduledTaskAction -Execute '%PYW%' -Argument '\"%SCRIPT%\" --watch';" ^
  "$t = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME;" ^
  "$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew;" ^
  "Register-ScheduledTask -TaskName 'Karaoke stats live sync' -Action $a -Trigger $t -Settings $s -Force | Out-Null;" ^
  "Start-ScheduledTask -TaskName 'Karaoke stats live sync'"
if errorlevel 1 (
  echo Couldn't create the scheduled task.
  pause & exit /b 1
)

echo.
echo Done. The live sync is running now and starts by itself every time you sign in.
echo New songs reach the website within about 10 seconds while KaraFun is open.
echo The daily noon sync stays as a backup. Activity is logged to
echo %USERPROFILE%\Documents\KaraokeStats\sync_log.txt
pause
