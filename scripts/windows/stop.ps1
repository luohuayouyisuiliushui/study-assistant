[CmdletBinding()]
param()

. "$PSScriptRoot\common.ps1"
Initialize-StudyAssistantConsole

try {
    $state = Read-StudyAssistantProcessState
    if (-not $state) {
        Write-Host 'No tracked Study Assistant process is running.'
        exit 0
    }

    if ([System.IO.Path]::GetFullPath([string]$state.root) -ne (Get-StudyAssistantRoot)) {
        throw "The tracked process belongs to another checkout: $($state.root)"
    }

    $processId = [int]$state.processId
    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if (-not $process) {
        Remove-StudyAssistantProcessState -ExpectedProcessId $processId
        Write-Host 'Removed stale process state; the process was already stopped.'
        exit 0
    }

    $expectedStart = [datetime]::Parse([string]$state.startedAtUtc).ToUniversalTime()
    $actualStart = $process.StartTime.ToUniversalTime()
    if ([math]::Abs(($actualStart - $expectedStart).TotalSeconds) -gt 2) {
        throw 'PID was reused by another process; refusing to stop it.'
    }

    Write-Host 'Stopping the tracked Node.js process tree...'

    # A separate Windows console cannot reliably send Ctrl+C to this tree.
    # /F is required so taskkill does not leave nested npm/Vite/Node processes behind.
    & taskkill.exe /PID ([string]$processId) /T /F
    $taskkillExitCode = $LASTEXITCODE

    if ($taskkillExitCode -ne 0) {
        throw "taskkill exited with code $taskkillExitCode."
    }

    Remove-StudyAssistantProcessState -ExpectedProcessId $processId
    Write-Host "Stopped Study Assistant PID $processId."
}
catch {
    Write-Error $_
    exit 1
}
