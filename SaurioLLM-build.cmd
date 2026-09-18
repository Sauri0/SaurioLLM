@echo off
setlocal
title SaurioLLM - build
cd /d "%~dp0"

echo [SaurioLLM] Compilando (pnpm build) ...
call pnpm build
if not "%errorlevel%"=="0" (
    echo [SaurioLLM] ERROR: pnpm build fallo ^(codigo %errorlevel%^).
    pause
    exit /b 1
)

echo [SaurioLLM] Generando carpeta desempaquetada (electron-builder --dir) ...
call pnpm --filter @saurio/desktop run build:installer -- --dir
if not "%errorlevel%"=="0" (
    echo [SaurioLLM] ERROR: pnpm --filter @saurio/desktop run build:installer fallo ^(codigo %errorlevel%^).
    pause
    exit /b 1
)

echo [SaurioLLM] Listo. Revisa la carpeta "release\win-unpacked" para el .exe desempaquetado.
pause
endlocal
