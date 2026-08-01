[CmdletBinding()]
param()

. "$PSScriptRoot\common.ps1"
Initialize-StudyAssistantConsole

try {
    $null = Assert-StudyAssistantPrerequisites
    Assert-PortsAvailable -Ports @(3001, 5270)
    Write-Host 'Development UI: http://localhost:5270'
    Start-TrackedNpmProcess -Mode development -Arguments @('run', 'dev')
}
catch {
    Write-Error $_
    exit 1
}
