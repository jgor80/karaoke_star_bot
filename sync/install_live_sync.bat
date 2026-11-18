@echo off
setlocal
rem Keeps the karaoke stats site live: starts a background sync at every
rem sign-in that uploads each new karaoke song within seconds.
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

echo Installing the crowd meter's mic reader (sounddevice)...
"%PYW:pythonw=python%" -m pip install --user --quiet --disable-pip-version-check sounddevice
if errorlevel 1 echo Couldn't install sounddevice, so the crowd meter stays off. Everything else still works.

echo Stopping any live sync that's already running (an old copy can keep the new one from starting)...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Stop-ScheduledTask -TaskName 'Karaoke stats live sync' -ErrorAction SilentlyContinue;" ^
  "Get-CimInstance Win32_Process -Filter \"Name like 'python%%'\" | Where-Object { $_.CommandLine -like '*karaoke_sync*' -and $_.CommandLine -like '*--watch*' } | ForEach-Object { Write-Host ('  stopped old copy, process ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

echo Testing the crowd meter's mic. Clap or cheer while the numbers scroll...
"%PYW:pythonw=python%" "%SCRIPT%" --mic-test
if errorlevel 1 echo The mic test didn't pass (see above). Songs still sync; only the crowd meter is affected.
echo.
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
echo New songs reach the website within about 10 seconds while the karaoke app is open.
echo The crowd meter listens to this laptop's mic during karaoke (loudness numbers only).
echo Check okenight.com/wbl/host, Laptop: it should say "Live sync running" and "Crowd mic".
echo For honest readings, turn off audio enhancements for the mic: Settings, System, Sound,
echo your microphone, Audio enhancements: Off. See the README for more.
echo The daily noon sync stays as a backup. Activity is logged to
echo %USERPROFILE%\Documents\KaraokeStats\sync_log.txt
pause
