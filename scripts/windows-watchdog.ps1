<#
.SYNOPSIS
  Windows host watchdog for the_forge + Docker Desktop + WSL2.
  Detects both container-level hangs and WSL2/Docker Desktop wedges, and recovers automatically.
#>
param(
  [string]$ForgeDir = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = "Continue"
$StateDir = Join-Path $ForgeDir ".forge-state"
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
$LogFile = Join-Path $StateDir "watchdog.log"
$LockFile = Join-Path $StateDir "watchdog.lock"

function Write-Log([string]$Message) {
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
  Add-Content -Path $LogFile -Value $line
  Write-Output $line
}

# Prevent overlapping runs
if (Test-Path $LockFile) {
  $age = (Get-Date) - (Get-Item $LockFile).LastWriteTime
  if ($age.TotalMinutes -lt 5) {
    exit 0
  }
}
Set-Content -Path $LockFile -Value $PID

try {
  function Invoke-WithTimeout([scriptblock]$Block, [int]$TimeoutSec = 12) {
    $job = Start-Job -ScriptBlock $Block
    if (Wait-Job $job -Timeout $TimeoutSec) {
      $out = Receive-Job $job -ErrorAction SilentlyContinue
      Remove-Job $job -Force -ErrorAction SilentlyContinue
      return @{ TimedOut = $false; Output = $out }
    }
    Stop-Job $job -ErrorAction SilentlyContinue
    Remove-Job $job -Force -ErrorAction SilentlyContinue
    return @{ TimedOut = $true; Output = $null }
  }

  # Tier 1: Fast probe of the_forge :5173 + container responsiveness
  $probe = Invoke-WithTimeout -TimeoutSec 12 -Block {
    $out = docker exec the_forge curl -fsS --max-time 4 http://127.0.0.1:5173/api/state 2>&1
    return @{ ExitCode = $LASTEXITCODE; Text = ($out | Out-String) }
  }

  if (-not $probe.TimedOut -and $probe.Output -and $probe.Output.ExitCode -eq 0) {
    exit 0
  }

  Write-Log "Health probe failed (timedOut=$($probe.TimedOut)). Checking Docker daemon..."

  # Tier 2: Check if Docker Desktop itself is responsive
  $dockerCheck = Invoke-WithTimeout -TimeoutSec 10 -Block {
    $out = docker info --format "{{.ServerVersion}}" 2>&1
    return @{ ExitCode = $LASTEXITCODE; Text = ($out | Out-String) }
  }

  if ($dockerCheck.TimedOut -or -not $dockerCheck.Output -or $dockerCheck.Output.ExitCode -ne 0) {
    Write-Log "Docker/WSL2 appears wedged. Running wsl --shutdown and restarting Docker Desktop..."
    Stop-Process -Name "Docker Desktop", "com.docker.backend", "docker" -Force -ErrorAction SilentlyContinue
    & wsl --shutdown 2>&1 | Out-Null
    for ($w = 0; $w -lt 15; $w++) {
      if (-not (Get-Process "Docker Desktop", "com.docker.backend" -ErrorAction SilentlyContinue)) { break }
      Start-Sleep -Seconds 1
    }
    Start-Sleep -Seconds 2

    $candidates = @(
      (Join-Path $env:LOCALAPPDATA "Programs\DockerDesktop\Docker Desktop.exe"),
      "C:\Program Files\Docker\Docker\Docker Desktop.exe",
      (Join-Path $env:LOCALAPPDATA "Programs\Docker\Docker\Docker Desktop.exe")
    )
    $dockerExe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($dockerExe) {
      Start-Process $dockerExe
    } else {
      Write-Log "Docker Desktop.exe not found in standard locations"
      exit 1
    }

    $ready = $false
    for ($i = 0; $i -lt 24; $i++) {
      Start-Sleep -Seconds 5
      $check = Invoke-WithTimeout -TimeoutSec 8 -Block {
        docker info --format "{{.ServerVersion}}" 2>&1 | Out-Null
        return $LASTEXITCODE
      }
      if (-not $check.TimedOut -and $check.Output -eq 0) {
        $ready = $true
        break
      }
    }

    if (-not $ready) {
      Write-Log "Docker Desktop did not become ready within 120s."
      exit 1
    }
    Write-Log "Docker Desktop recovered."
  }

  # Bring containers back up cleanly via compose
  $composeFile = Join-Path $ForgeDir "generated\docker-compose.yml"
  Write-Log "Ensuring the_forge stack is up via docker compose..."
  $upOut = docker compose -f $composeFile up -d 2>&1 | Out-String
  Write-Log ("compose up result: " + ($upOut.Trim() -replace "\r?\n", " | "))
} finally {
  Remove-Item -Path $LockFile -Force -ErrorAction SilentlyContinue
}
