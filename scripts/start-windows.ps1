$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
	throw 'Install Node.js 22 LTS or newer, then reopen the terminal.'
}
if (-not (Test-Path node_modules)) { npm install }
npm run build
npm start
