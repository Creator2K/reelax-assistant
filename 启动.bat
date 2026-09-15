@echo off
title Reelax Assistant - Launcher
cd /d "%~dp0"
setlocal EnableExtensions
REM Put System32 first in PATH so "find"/"tasklist" resolve to Windows builtins
REM (Git Bash / MSYS entries in PATH break them inside this console session).
set "PATH=C:\Windows\System32;%PATH%"
echo ============================================
echo   Reelax Auxiliary Console - One-click Start
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [Error] Node.js not found. Please install Node.js 18+ first: https://nodejs.org
    call :pause
    exit /b 1
)

if not exist "node_modules" (
    echo [1/3] First run - installing dependencies, may take a few minutes...
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo [Error] npm install failed. Check your network and retry.
        call :pause
        exit /b 1
    )
) else (
    echo [1/3] Dependencies ready.
)

if not exist "web\dist\index.html" (
    echo [2/3] Building frontend...
    call npm run build
    if errorlevel 1 (
        echo [Error] Frontend build failed.
        call :pause
        exit /b 1
    )
) else (
    echo [2/3] Frontend ready.
)

netstat -ano | findstr ":8580" | findstr "LISTENING" >nul 2>nul
if not errorlevel 1 (
    echo [3/3] Service already running - opening console...
    start "" http://localhost:8580
    call :sleep 2
    exit /b 0
)

echo [3/3] Starting service in a minimized window...
start "ReelaxAssistant" /min cmd /c "node server\src\index.js"
echo       Waiting for service to be ready...
call :sleep 3
start "" http://localhost:8580

echo.
echo Service started: http://localhost:8580
echo It runs in a minimized window - use Stop.bat to close it.
call :sleep 3
exit /b 0

:pause
REM "pause" prints nothing useful when stdin is redirected (Git Bash etc.),
REM so wait a fixed 10s instead so the error message stays readable.
pause >nul 2>nul
if not errorlevel 1 goto :eof
call :sleep 10
goto :eof

:sleep
REM "timeout" fails when stdin is redirected (Git Bash, Task Scheduler, pipes);
REM fall back to "ping -n N+1" which waits about N seconds.
timeout /t %1 /nobreak >nul 2>nul
if not errorlevel 1 goto :eof
set /a PINGN=%1+1
ping -n %PINGN% 127.0.0.1 >nul 2>nul
goto :eof
