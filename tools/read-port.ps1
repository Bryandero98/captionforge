# Imprime el puerto en el que se publica CaptionForge en tu equipo: CF_PORT del entorno, si no el de .env, si no 3000.
# Lo usa start.bat (start.sh hace lo mismo con tools/read-port.sh). Se ejecuta desde la carpeta que tiene el .env.
# Si el valor no es un puerto válido (1 a 65535) sale con error y no imprime nada.
$ErrorActionPreference = "Stop"

$port = $env:CF_PORT
if ([string]::IsNullOrWhiteSpace($port) -and (Test-Path -LiteralPath ".env")) {
  # La última línea CF_PORT= gana, como en docker compose.
  $line = Get-Content -LiteralPath ".env" -Encoding UTF8 | Where-Object { $_ -cmatch "^CF_PORT=" } | Select-Object -Last 1
  if ($null -ne $line) { $port = ($line -replace "^CF_PORT=", "").Trim() }
}
if ([string]::IsNullOrWhiteSpace($port)) { $port = "3000" }
$port = $port.Trim()

if ($port -notmatch "^[0-9]{1,5}$" -or [int]$port -lt 1 -or [int]$port -gt 65535) {
  [Console]::Error.WriteLine("CF_PORT debe ser un número entre 1 y 65535 (tiene «$port»). Corrígelo en .env o en el entorno.")
  exit 1
}
Write-Output ([int]$port)
