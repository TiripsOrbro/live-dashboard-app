@echo off
title Dashboard Dev + Tunnel

REM --- Move to the folder where this .bat lives ---
cd /d "%~dp0"

echo Killing old Node processes...
taskkill /IM node.exe /F >nul 2>&1

echo Starting backend (npm run dev)...
start "Backend" cmd /c "npm run dev"

echo Waiting 3 seconds for backend to boot...
timeout /t 3 >nul

echo Starting Cloudflare Tunnel...
start "Tunnel" cmd /c "cloudflared tunnel run dashboard-tunnel"

echo All systems running.
