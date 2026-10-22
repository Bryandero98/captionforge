# Crea .env a partir de .env.example con contraseñas aleatorias (lo usa start.bat; lo mismo que hace start.sh).
# Solo letras y números en las contraseñas: van dentro de URLs de conexión sin codificar.
param(
  [string]$Example = ".env.example",
  [string]$Target = ".env"
)
$ErrorActionPreference = "Stop"

$secrets = @(
  "POSTGRES_PASSWORD", "CF_OWNER_DB_PASSWORD", "CF_API_DB_PASSWORD", "CF_WORKER_DB_PASSWORD",
  "REDIS_PASSWORD", "S3_ROOT_PASSWORD", "S3_API_SECRET_KEY", "S3_WORKER_SECRET_KEY"
)
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
function New-Secret {
  $bytes = New-Object byte[] 18
  $rng.GetBytes($bytes)
  -join ($bytes | ForEach-Object { $_.ToString("x2") })
}

$lines = Get-Content -LiteralPath $Example -Encoding UTF8 | ForEach-Object {
  $line = $_
  foreach ($name in $secrets) {
    if ($line -match ("^" + [regex]::Escape($name) + "=")) { $line = "$name=$(New-Secret)"; break }
  }
  $line
}
# UTF-8 sin BOM y fin de línea LF: el .env lo leen contenedores Linux.
$text = ($lines -join "`n") + "`n"
[System.IO.File]::WriteAllText((Join-Path (Get-Location) $Target), $text, (New-Object System.Text.UTF8Encoding $false))
