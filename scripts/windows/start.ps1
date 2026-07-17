[CmdletBinding()]
param(
    [switch]$SkipBuild
)

. "$PSScriptRoot\common.ps1"
Initialize-StudyAssistantConsole

try {
    $null = Assert-StudyAssistantPrerequisites
    Assert-PortsAvailable -Ports @(3001)

    if (-not $SkipBuild) {
        Write-Host 'Building the client for production...'
        Invoke-StudyAssistantNpm -Arguments @('run', 'build')
    }
    elseif (-not (Test-Path -LiteralPath (Join-Path (Get-StudyAssistantRoot) 'client\dist\index.html'))) {
        throw 'client/dist/index.html is missing. Start again without -SkipBuild.'
    }

    Write-Host 'Production UI: http://localhost:3001'
    Start-TrackedNpmProcess -Mode production -Arguments @('start')
}
catch {
    Write-Error $_
    exit 1
}
