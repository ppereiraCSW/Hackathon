@echo off
rem Double-click to start the avionics pipeline. Shows a menu, then opens the
rem flight display in the browser. Same as: node tools\start.mjs
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo   Node.js is not installed. Install it from https://nodejs.org ^(version 22 or newer^),
    echo   or run:  winget install --id OpenJS.NodeJS.LTS --exact
    echo.
    pause
    exit /b 1
)
node tools\start.mjs %*
if errorlevel 1 pause
