# Crea o completa el .env de CaptionForge (lo usa start.bat; lo mismo que hace tools/ensure-env.sh para start.sh).
# Contraseñas con solo letras y números (hexadecimal): van dentro de URLs de conexión sin codificar. Nunca imprime un secreto.
#  - Sin -Complete: crea el .env desde .env.example con valores aleatorios.
#  - Con -Complete: no cambia NINGÚN valor que ya exista; solo añade lo que falte o esté vacío (DEFAULT_API_KEY, APP_SECRET y
#    WORKER_INTERNAL_TOKEN, que un .env anterior a la tenencia o a BYOK no trae). APP_SECRET jamás se regenera: cambiarlo deja
#    ilegibles las claves externas ya guardadas (docs/runbook-app-secret.md).
param(
  [string]$Example = ".env.example",
  [string]$Target = ".env",
  [switch]$Complete
)
$ErrorActionPreference = "Stop"

$secrets = @(
  "POSTGRES_PASSWORD", "CF_OWNER_DB_PASSWORD", "CF_API_DB_PASSWORD", "CF_WORKER_DB_PASSWORD",
  "REDIS_PASSWORD", "S3_ROOT_PASSWORD", "S3_API_SECRET_KEY", "S3_WORKER_SECRET_KEY"
)
# Claves de 32 bytes (64 hexadecimales), tres valores independientes entre sí (ADR 0015 y ADR 0020).
$strong = @("DEFAULT_API_KEY", "APP_SECRET", "WORKER_INTERNAL_TOKEN")

$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
function New-Secret([int]$Length = 18) {
  $bytes = New-Object byte[] $Length
  $rng.GetBytes($bytes)
  -join ($bytes | ForEach-Object { $_.ToString("x2") })
}
function New-Strong([string]$Name) {
  if ($Name -eq "DEFAULT_API_KEY") { "cfk_$(New-Secret 32)" } else { New-Secret 32 }
}
$utf8 = New-Object System.Text.UTF8Encoding $false
$path = Join-Path (Get-Location) $Target

if ($Complete) {
  $text = [System.IO.File]::ReadAllText($path, $utf8)
  $changed = $false
  foreach ($name in $strong) {
    if ($text -cnotmatch ("(?m)^" + $name + "=[ 	]*\S")) {
      # «Falta» incluye la línea vacía (también con salto de línea de Windows); lo demás del archivo no se toca.
      $text = [regex]::Replace($text, "(?m)^" + $name + "=[ \t]*\r?\n?", "")
      if ($text.Length -gt 0 -and -not $text.EndsWith("`n")) { $text += "`n" }
      $text += "$name=$(New-Strong $name)`n"
      $changed = $true
    }
  }
  if ($changed) {
    # Escritura atómica: temporal en la misma carpeta y reemplazo, para que un corte no deje el .env truncado.
    $tmp = "$path.$([guid]::NewGuid().ToString('N')).tmp"
    try {
      [System.IO.File]::WriteAllText($tmp, $text, $utf8)
      Move-Item -LiteralPath $tmp -Destination $path -Force
    } finally {
      if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force }
    }
  }
  return
}

# UTF-8 sin BOM y fin de línea LF: el .env lo leen contenedores Linux.
$lines = Get-Content -LiteralPath $Example -Encoding UTF8 | ForEach-Object {
  $line = $_
  foreach ($name in $secrets) {
    if ($line -cmatch ("^" + [regex]::Escape($name) + "=")) { $line = "$name=$(New-Secret)"; break }
  }
  foreach ($name in $strong) {
    if ($line -cmatch ("^" + $name + "=")) { $line = "$name=$(New-Strong $name)"; break }
  }
  $line
}
[System.IO.File]::WriteAllText($path, (($lines -join "`n") + "`n"), $utf8)
