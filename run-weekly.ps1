# Wrapper: cd into this site and run weekly-report
# Used by scheduled task kicchin-weekly-report (Mon 09:00 JST)
$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location $PSScriptRoot
$reportDir = Join-Path $PSScriptRoot "editorial\reports"
if (-not (Test-Path $reportDir)) { New-Item -ItemType Directory -Force -Path $reportDir | Out-Null }
npm run weekly-report 2>&1 | Out-File (Join-Path $reportDir "_last-run.log") -Encoding utf8
