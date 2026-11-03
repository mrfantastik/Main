@echo off
rem AI Hustle City, totally free: every conversation, thought and decision is
rem written by an open-source AI running on this computer (through Ollama).
rem No account, no API key, no credits, nothing to pay. Double-click to play:
rem anything missing (Node.js, Ollama, a model) is installed the first time.
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"
title AI Hustle City - free, on this computer
echo.
echo   AI Hustle City - totally free. The AI runs on this computer, with Ollama.
echo   No account, no API key, no credits: nothing to pay.
echo.

rem Opened from inside the zip: the rest of the game isn't next to this file.
if exist "package.json" goto unzipped
echo   This file needs the rest of the game next to it, so unpack the zip first:
echo   right-click the zip file, choose "Extract All...", then open the AI-Hustle-City
echo   folder it makes and double-click Play-Free.bat in there.
echo.
pause
exit /b 1

:unzipped
call :findprograms
call :look
if defined HAVENODE if defined HAVEOLLAMA goto checknode

call :have winget
if not defined HAVE goto manual
echo   The game needs these free programs, which aren't installed yet:
if not defined HAVENODE echo     - Node.js, which runs the game
if not defined HAVEOLLAMA echo     - Ollama, which runs the AI on this computer
echo   (You do NOT need an ollama.com account, an API key or any credits.)
echo.
echo   Press any key to install them now with Windows' own installer (winget),
echo   or close this window to stop. Windows may ask you to allow it: say Yes.
pause >nul
echo.
if not defined HAVENODE winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-source-agreements --accept-package-agreements
if not defined HAVEOLLAMA winget install --id Ollama.Ollama -e --source winget --accept-source-agreements --accept-package-agreements
call :findprograms
call :look
if not defined HAVENODE goto manual
if not defined HAVEOLLAMA goto manual
echo.

:checknode
node -e "process.exit(+process.versions.node.split('.')[0] >= 20 ? 0 : 1)"
if errorlevel 1 goto oldnode
rem (A marker written after a complete install, so a half-finished one is done again.)
if exist "node_modules\.hustle-ready" goto run
echo   First time: getting the game's parts ready. This takes a few minutes, once.
echo.
call npm install --no-audit --no-fund
if errorlevel 1 goto npmfailed
echo ready> "node_modules\.hustle-ready"

:run
call npm run free -- %*
echo.
pause
exit /b 0

:have
rem Is %1 on the PATH? (HAVE is set if so.)
set "HAVE="
where %1 >nul 2>nul
if not errorlevel 1 set "HAVE=1"
exit /b 0

:look
rem Which of the two are here now.
call :have node
set "HAVENODE=%HAVE%"
call :have ollama
set "HAVEOLLAMA=%HAVE%"
exit /b 0

:findprograms
rem Programs installed a moment ago aren't on this window's PATH yet: look where they go.
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
if exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" set "PATH=%LOCALAPPDATA%\Programs\Ollama;%PATH%"
exit /b 0

:manual
call :look
echo.
echo   They couldn't be installed automatically. Both are free; opening their download pages:
if not defined HAVENODE echo     - Node.js: get the LTS version and install it.
if not defined HAVENODE start "" "https://nodejs.org/en/download"
if not defined HAVEOLLAMA echo     - Ollama: download it and install it.
if not defined HAVEOLLAMA start "" "https://ollama.com/download"
echo   Then double-click this file again.
echo.
echo   You do NOT need an ollama.com account, an API key or any credits:
echo   those are only for Ollama's cloud models, which this game never uses.
echo.
pause
exit /b 1

:oldnode
echo   Your Node.js is too old: this game needs version 20 or newer.
call :have winget
if not defined HAVE goto oldnodemanual
echo   Press any key to update it with winget (free), or close this window to stop.
pause >nul
winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-source-agreements --accept-package-agreements
call :findprograms
node -e "process.exit(+process.versions.node.split('.')[0] >= 20 ? 0 : 1)"
if not errorlevel 1 goto checknode

:oldnodemanual
echo   Opening the download page: get the LTS version, install it, then double-click this file again.
start "" "https://nodejs.org/en/download"
echo.
pause
exit /b 1

:npmfailed
echo.
echo   Getting the game's parts failed (see above). Check your internet connection and try again.
echo   If the game's folder is inside OneDrive, move it somewhere else first (for example C:\AI-Hustle-City).
echo.
pause
exit /b 1
