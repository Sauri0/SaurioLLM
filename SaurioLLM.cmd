@echo off
setlocal EnableDelayedExpansion
title SaurioLLM
cd /d "%~dp0"

echo [SaurioLLM] Verificando Ollama en 127.0.0.1:11434 ...
curl -s -m 3 http://127.0.0.1:11434/api/version >nul 2>&1
if not "%errorlevel%"=="0" goto need_ollama
echo [SaurioLLM] Ollama ya esta corriendo.
goto start_app

:need_ollama
echo [SaurioLLM] Ollama no responde. Intentando "ollama serve" en segundo plano...
where ollama >nul 2>&1
if not "%errorlevel%"=="0" (
    echo [SaurioLLM] ERROR: no se encontro "ollama" en el PATH. Instala Ollama o abrilo manualmente
    echo [SaurioLLM] desde su icono en la bandeja del sistema y volve a correr este script.
    pause
    exit /b 1
)
start "Ollama" /min cmd /c "ollama serve"
echo [SaurioLLM] Esperando a que Ollama levante...
set _tries=0

:wait_ollama
set /a _tries=!_tries!+1
timeout /t 2 /nobreak >nul
curl -s -m 3 http://127.0.0.1:11434/api/version >nul 2>&1
if "%errorlevel%"=="0" goto ollama_up
if !_tries! lss 15 goto wait_ollama
echo [SaurioLLM] ERROR: Ollama no respondio a tiempo. Revisa que este instalado
echo [SaurioLLM] correctamente y volve a intentar.
pause
exit /b 1

:ollama_up
echo [SaurioLLM] Ollama esta arriba.

:start_app
echo [SaurioLLM] Iniciando la app (pnpm dev)...
call pnpm dev
if not "%errorlevel%"=="0" (
    echo [SaurioLLM] La app termino con un error ^(codigo %errorlevel%^). Revisa el mensaje de arriba.
    pause
)
endlocal
