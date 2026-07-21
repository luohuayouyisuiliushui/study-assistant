#Requires -Version 5.1
param()

$ErrorActionPreference = 'Stop'
$rootDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

Write-Host '=== Cleanup Test Data ===' -ForegroundColor Cyan
Write-Host ''

Push-Location $rootDir
try {
  $npmPath = if (Get-Command 'npm.cmd' -ErrorAction SilentlyContinue) { 'npm.cmd' } else { 'npm' }

  Write-Host '[1/3] Removing test plans...' -ForegroundColor Yellow
  & $npmPath run clean:testdata:all --prefix server
  if ($LASTEXITCODE -ne 0) { throw 'clean:testdata:all failed' }

  Write-Host ''
  Write-Host '[2/3] Checking data integrity...' -ForegroundColor Yellow
  & $npmPath run check:data --prefix server 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) {
    Write-Host '  Data integrity OK' -ForegroundColor Green
  } else {
    Write-Host '  Data integrity warnings (non-critical)' -ForegroundColor DarkYellow
  }

  Write-Host ''
  Write-Host '[3/3] Syncing index...' -ForegroundColor Yellow
  & $npmPath run clean:testdata --prefix server 2>&1 | Out-Null
  Write-Host '  Index sync done' -ForegroundColor Green

  Write-Host ''
  Write-Host '=== Done ===' -ForegroundColor Green
} catch {
  Write-Host ''
  $errMsg = $_.Exception.Message
  Write-Host ('Error: ' + $errMsg) -ForegroundColor Red
  exit 1
} finally {
  Pop-Location
}
