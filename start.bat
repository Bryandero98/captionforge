@echo off
rem CaptionForge: arranque local con un solo comando (Windows).
rem   start.bat     levanta todo (primera vez: construye las imagenes, tarda unos minutos)
rem Lo unico que hay que tener instalado es Docker Desktop. Detalles: README, "Quickstart".
setlocal
cd /d "%~dp0"
chcp 65001 >nul

if "%CF_PORT%"=="" (set "PORT=3000") else (set "PORT=%CF_PORT%")
set "URL=http://localhost:%PORT%"

rem --- 1. Docker ---------------------------------------------------------------------------
where docker >nul 2>&1
if errorlevel 1 (
  echo.
  echo No se pudo continuar: Docker no esta instalado. Instala Docker Desktop desde https://docs.docker.com/desktop/setup/install/windows-install/ y vuelve a ejecutar start.bat
  exit /b 1
)
docker compose version >nul 2>&1
if errorlevel 1 (
  echo.
  echo No se pudo continuar: falta "docker compose" ^(v2^). Actualiza Docker Desktop.
  exit /b 1
)
docker info >nul 2>&1
if errorlevel 1 (
  echo.
  echo No se pudo continuar: Docker esta instalado pero no responde. Abre Docker Desktop, espera a que diga "Engine running" y vuelve a ejecutar start.bat
  exit /b 1
)

rem --- 2. .env con contrasenas propias -----------------------------------------------------------
if exist ".env" (
  echo Se usa el .env que ya existe ^(no se modifica^).
) else (
  if not exist ".env.example" (
    echo.
    echo No se pudo continuar: no encuentro .env.example en %CD%. Ejecuta el script desde la carpeta de CaptionForge.
    exit /b 1
  )
  echo Creando .env con contrasenas aleatorias...
  powershell -NoProfile -ExecutionPolicy Bypass -File "tools\new-env.ps1"
  if errorlevel 1 (
    echo.
    echo No se pudo continuar: no se pudo crear el .env.
    if exist ".env" del ".env"
    exit /b 1
  )
  echo .env creado. Guardalo: tiene las contrasenas de tu instalacion ^(no se sube a git^).
)

rem --- 3. Levantar todo ----------------------------------------------------------------------
echo Levantando PostgreSQL, Redis, S3, la API y el worker ^(la primera vez tarda unos minutos^)...
docker compose --profile app up -d --build
if errorlevel 1 (
  echo.
  echo No se pudo continuar: docker compose fallo. Revisa el error de arriba; "docker compose --profile app logs" da mas detalle.
  exit /b 1
)

rem --- 4. Esperar a que responda ---------------------------------------------------------------
echo Esperando a que la API responda...
set "READY="
for /l %%i in (1,1,90) do (
  if not defined READY (
    curl.exe -fsS "%URL%/health" >nul 2>&1 && set "READY=1"
    if not defined READY timeout /t 2 /nobreak >nul
  )
)
if not defined READY (
  echo.
  echo No se pudo continuar: la API no respondio en 3 minutos. Mira "docker compose --profile app logs api-gateway ai-worker".
  exit /b 1
)

echo.
echo   CaptionForge esta listo.
echo.
echo     Abre:  %URL%
echo.
echo   Los videos y los subtitulos se borran del servidor pasado un dia.
echo   La primera transcripcion descarga el modelo de Whisper ^(puede tardar unos minutos^).
echo.
echo     Ver registros:  docker compose --profile app logs -f
echo     Apagar:         docker compose --profile app down
echo     Volver a abrir: start.bat
endlocal
