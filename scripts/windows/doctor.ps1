[CmdletBinding()]
param(
    [switch]$SkipPorts
)

. "$PSScriptRoot\common.ps1"
Initialize-StudyAssistantConsole

$root = Get-StudyAssistantRoot
Write-Host "Project: $root"

try {
    $nodeVersion = Assert-StudyAssistantPrerequisites
    Write-Host "[OK] Node.js $nodeVersion"
    Write-Host "[OK] npm.cmd $(& (Get-NpmCommand) --version)"

    if (-not $SkipPorts) {
        $listeners = @(Get-PortListeners -Ports @(3001, 5173))
        if ($listeners.Count -eq 0) {
            Write-Host '[OK] Ports 3001 and 5173 are available.'
        }
        else {
            foreach ($listener in $listeners) {
                Write-Warning "Port $($listener.Port) is used by $($listener.ProcessName) (PID $($listener.ProcessId))."
            }
        }
    }

    if (Test-Path -LiteralPath (Join-Path $root 'server\.env')) {
        Write-Host '[OK] server/.env exists (contents were not read).'
    }
    else {
        Write-Warning 'server/.env is absent. You can still enter an API key in the application settings.'
    }

    if ((Test-Path -LiteralPath (Join-Path $root 'node_modules')) -and
        (Test-Path -LiteralPath (Join-Path $root 'server\node_modules')) -and
        (Test-Path -LiteralPath (Join-Path $root 'client\node_modules'))) {
        Write-Host '[OK] Dependencies are installed.'
    }
    else {
        Write-Warning 'Dependencies are incomplete. Run windows-setup.cmd.'
    }
}
catch {
    Write-Error $_
    exit 1
}
