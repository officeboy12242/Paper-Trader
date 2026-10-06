@echo off
title PaperTrader watchdog (PAPER TRADING ONLY)
cd /d "%~dp0\..\.."

REM Restarts the engine 5 s after any exit. All state lives in SQLite, so a
REM restart resumes open positions, pending orders and replays missed bars.
REM stdout+stderr go to logs\run.log; structured logs to logs\papertrader-*.jsonl.

if not exist logs mkdir logs

:loop
echo [%date% %time%] === PaperTrader starting === >> logs\run.log
node src\index.js >> logs\run.log 2>&1
echo [%date% %time%] === PaperTrader EXITED code=%errorlevel% === >> logs\run.log
if exist STOP (
  echo [%date% %time%] === STOP file found, watchdog exiting === >> logs\run.log
  del STOP
  goto :eof
)
timeout /t 5 /nobreak >nul
goto loop
