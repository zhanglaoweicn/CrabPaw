@echo off
rem dev-electron.cmd - dev Electron launcher (detached window)
rem clear ELECTRON_RUN_AS_NODE: host agent session sets it, electron degrades to Node mode
set ELECTRON_RUN_AS_NODE=
cd /d D:/bossagent/gui
set PORT=38767
echo [dev-electron] starting... > D:/bossagent/gui/scripts/dev-electron.log 2>&1
call npm run electron:dev >> D:/bossagent/gui/scripts/dev-electron.log 2>&1
