[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch]$Build
)

. "$PSScriptRoot\common.ps1"
Initialize-StudyAssistantConsole

try {
    $nodeVersion = Assert-StudyAssistantPrerequisites
    Write-Host "Using Node.js $nodeVersion"

    if ($PSCmdlet.ShouldProcess((Get-StudyAssistantRoot), 'Install root, server, and client dependencies')) {
        Invoke-StudyAssistantNpm -Arguments @('install')
    }

    if ($Build -and $PSCmdlet.ShouldProcess((Get-StudyAssistantRoot), 'Build the client')) {
        Invoke-StudyAssistantNpm -Arguments @('run', 'build')
    }

    Write-Host 'Setup complete. Run windows-dev.cmd for development.'
}
catch {
    Write-Error $_
    exit 1
}
