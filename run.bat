@echo off
title Dashboard Dev (Local Only)

REM --- Move to the folder where this .bat lives ---
cd /d "%~dp0"

echo Killing old Node processes...
taskkill /IM node.exe /F >nul 2>&1

echo Starting backend (npm run dev)...
start "Backend" cmd /c "npm run dev"

echo Local development server is running.
pause
