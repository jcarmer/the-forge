# bootstrap.ps1: one-line entry point. Checks Node, installs dependencies, then hands off to sandboxctl.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Node.js was not found. Installing the LTS version with winget..."
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Write-Error "winget is not available. Install Node.js LTS from https://nodejs.org and re-run this script."
        exit 1
    }
    winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
    Write-Host "Node.js installed. Close and re-open PowerShell, then run bootstrap.ps1 again."
    exit 0
}

if (-not (Test-Path "node_modules")) {
    Write-Host "Installing dependencies..."
    npm install
}

if (-not (Test-Path "dist/src/cli.js")) {
    Write-Host "Building TypeScript CLI..."
    npm run build
}

if ($args.Count -eq 0) {
    npx tsx src/cli.ts init
} else {
    npx tsx src/cli.ts @args
}
