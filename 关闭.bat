@echo off
title Reelax Assistant - Stop
cd /d "%~dp0"
setlocal EnableExtensions
REM Put System32 first in PATH so "find" inside the for-loop pipes is the
REM Windows builtin (GNU find from Git Bash/MSYS breaks "find /I").
set "PATH=C:\Windows\System32;%PATH%"
echo ============================================
echo   Reelax Auxiliary Console - Stop Service
echo ============================================
echo.

set "KILLED=0"

REM ---- 1) Kill the minimized service window created by Launcher.bat ----
REM NOTE: "taskkill /FI WINDOWTITLE" returns 0 even when nothing matched,
REM so we list real PIDs with tasklist first, then kill each one.
for /f "tokens=2" %%p in ('tasklist /FI "WINDOWTITLE eq ReelaxAssistant*" /NH 2^>nul ^| find /I "cmd.exe"') do (
    taskkill /F /T /PID %%p >nul 2>nul
    if not errorlevel 1 set "KILLED=1"
)

REM ---- 2) Fallback: kill whatever is listening on 8580 ----
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8580" ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>nul
    if not errorlevel 1 set "KILLED=1"
)

REM ---- 3) Poll until the port is released (max ~10s) ----
set /a TRIES=0
:waitport
netstat -ano | findstr ":8580" | findstr "LISTENING" >nul 2>nul
if errorlevel 1 goto portfree
set /a TRIES+=1
if %TRIES% GEQ 10 goto portbusy
call :sleep 1
goto waitport

:portfree
if "%KILLED%"=="1" (
    echo Service stopped.
) else (
    echo Service is not running.
)
goto end

:portbusy
echo [Warn] Port 8580 still busy - close it manually or retry.

:end
call :sleep 2
endlocal
exit /b 0

:sleep
REM "timeout" fails when stdin is redirected (Git Bash, Task Scheduler, pipes);
REM fall back to "ping -n N+1" which waits about N seconds.
timeout /t %1 /nobreak >nul 2>nul
if not errorlevel 1 goto :eof
set /a PINGN=%1+1
ping -n %PINGN% 127.0.0.1 >nul 2>nul
goto :eof
