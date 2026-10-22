# Crea .env a partir de .env.example con contraseñas aleatorias (lo usa start.bat; lo mismo que hace start.sh).
# Solo letras y números en las contraseñas: van dentro de URLs de conexión sin codificar.
param(
  [string]$Example = ".env.example",
  [string]$Target = ".env",
  # Un .env anterior a la tenencia (ADR 0015) no trae DEFAULT_API_KEY: con -EnsureKey solo se la añade, sin tocar el resto.
  [switch]$EnsureKey
)
$ErrorActionPreference = "Stop"

$secrets = @(
  "POSTGRES_PASSWORD", "CF_OWNER_DB_PASSWORD", "CF_API_DB_PASSWORD", "CF_WORKER_DB_PASSWORD",
  "REDIS_PASSWORD", "S3_ROOT_PASSWORD", "S3_API_SECRET_KEY", "S3_WORKER_SECRET_KEY"
)
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
function New-Secret([int]$Length = 18) {
  $bytes = New-Object byte[] $Length
  $rng.GetBytes($bytes)
  -join ($bytes | ForEach-Object { $_.ToString("x2") })
}
# UTF-8 sin BOM y fin de línea LF: el .env lo leen contenedores Linux.
function Write-Env([string[]]$Lines) {
  $text = ($Lines -join "`n") + "`n"
  [System.IO.File]::WriteAllText((Join-Path (Get-Location) $Target), $text, (New-Object System.Text.UTF8Encoding $false))
}

if ($EnsureKey) {
  $current = @(Get-Content -LiteralPath $Target -Encoding UTF8)
  if (-not ($current | Where-Object { $_ -match "^DEFAULT_API_KEY=.+" })) {
    $kept = @($current | Where-Object { $_ -notmatch "^DEFAULT_API_KEY=" })
    Write-Env ($kept + "DEFAULT_API_KEY=cfk_$(New-Secret 32)")
  }
  return
}

$lines = Get-Content -LiteralPath $Example -Encoding UTF8 | ForEach-Object {
  $line = $_
  foreach ($name in $secrets) {
    if ($line -match ("^" + [regex]::Escape($name) + "=")) { $line = "$name=$(New-Secret)"; break }
  }
  if ($line -match "^DEFAULT_API_KEY=") { $line = "DEFAULT_API_KEY=cfk_$(New-Secret 32)" }
  $line
}
Write-Env $lines
