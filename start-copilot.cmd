@echo off
node "%~dp0scripts\run-copilot.mjs" %*
exit /b %errorlevel%
