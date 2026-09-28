@echo off
rem CharImageGen word-library importer (ASCII-only launcher; the real work is in the .ps1 next to it).
chcp 65001 >nul
setlocal
set "PS1="
for %%f in ("%~dp0*.ps1") do set "PS1=%%~ff"
if not defined PS1 (
    echo [ERROR] No .ps1 file found next to this .bat
    pause
    exit /b 1
)
echo Running: %PS1%
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
echo.
pause
