@echo off
rem AI Hustle City, totally free: every conversation, thought and decision is
rem written by an open-source AI running on this computer (through Ollama).
rem No account, no API key, no credits, nothing to pay. Double-click to play.
setlocal
cd /d "%~dp0"
title AI Hustle City - free, on this computer
echo.
echo   AI Hustle City - totally free. The AI runs on this computer, with Ollama.
echo   No account, no API key, no credits: nothing to pay.
echo.

where node >nul 2>nul
if errorlevel 1 goto nonode
node -e "process.exit(+process.versions.node.split('.')[0] >= 20 ? 0 : 1)"
if errorlevel 1 goto oldnode

where ollama >nul 2>nul
if not errorlevel 1 goto haveollama
rem (Just installed: this window may not know where it went yet.)
if not exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" goto noollama
set "PATH=%LOCALAPPDATA%\Programs\Ollama;%PATH%"

:haveollama
if exist "node_modules\" goto run
echo   First time: getting the game's parts ready. This takes a few minutes, once.
echo.
call npm install
if errorlevel 1 goto npmfailed

:run
call npm run free -- %*
echo.
pause
exit /b 0

:nonode
echo   This game needs Node.js, which is free. Opening its download page:
echo   get the LTS version, install it, then double-click this file again.
start "" "https://nodejs.org/en/download"
echo.
pause
exit /b 1

:oldnode
echo   Your Node.js is too old: this game needs version 20 or newer.
echo   Opening the download page: get the LTS version, install it, then double-click this file again.
start "" "https://nodejs.org/en/download"
echo.
pause
exit /b 1

:noollama
echo   The free AI needs Ollama, which is free. Opening its download page:
echo   install it, then double-click this file again.
echo.
echo   You do NOT need an ollama.com account, an API key or any credits.
echo   Those are only for Ollama's cloud models, which this game never uses.
start "" "https://ollama.com/download"
echo.
pause
exit /b 1

:npmfailed
echo.
echo   Getting the game's parts failed (see above). Check your internet connection and try again.
echo.
pause
exit /b 1
