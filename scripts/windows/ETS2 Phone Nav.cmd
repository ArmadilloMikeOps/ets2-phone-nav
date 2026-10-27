@echo off
rem Double-click to start ETS2 Phone Nav (bypasses the default .ps1 execution policy).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
