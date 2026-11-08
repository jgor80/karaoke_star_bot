@echo off
setlocal
rem Sets up a daily task that copies KaraFun history into
rem Documents\KaraokeStats\karaoke_stats.db, then runs it once now.

set "SCRIPT=%~dp0karaoke_sync.py"
if not exist "%SCRIPT%" (
  echo Can't find karaoke_sync.py. Keep it in the same folder as this file.
  pause & exit /b 1
)

set "CFG=%~dp0karaoke_sync_config.json"
if exist "%CFG%" (
  findstr /c:"PASTE_" "%CFG%" >nul && (
    echo Open karaoke_sync_config.json in Notepad and paste in your Cloudflare
    echo account ID and API token first, then run this file again.
    notepad "%CFG%"
    pause & exit /b 1
  )
)

set "PYW="
for /f "delims=" %%i in ('where pythonw 2^>nul') do if not defined PYW set "PYW=%%i"
if not defined PYW (
  echo Python isn't installed. Install "Python 3.13" from the Microsoft Store,
  echo then run this file again.
  start ms-windows-store://pdp/?ProductId=9PNRBTZXMB4Z
  pause & exit /b 1
)

echo Running the first sync...
"%PYW:pythonw=python%" "%SCRIPT%"
if errorlevel 1 (
  echo The first sync failed. See the message above.
  pause & exit /b 1
)

echo Scheduling a daily sync at 12:00 (runs at next wake-up if the laptop was asleep)...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$a = New-ScheduledTaskAction -Execute '%PYW%' -Argument '\"%SCRIPT%\"';" ^
  "$t = New-ScheduledTaskTrigger -Daily -At 12:00;" ^
  "$s = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries;" ^
  "Register-ScheduledTask -TaskName 'Karaoke stats sync' -Action $a -Trigger $t -Settings $s -Force | Out-Null"
if errorlevel 1 (
  echo Couldn't create the scheduled task.
  pause & exit /b 1
)

echo.
echo Done. New songs upload to your Cloudflare database every day, and a local
echo copy is kept in %USERPROFILE%\Documents\KaraokeStats
echo Each run adds a line to sync_log.txt in that folder.
pause
