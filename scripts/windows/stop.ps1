[CmdletBinding()]
param()

. "$PSScriptRoot\common.ps1"
Initialize-StudyAssistantConsole

try {
    $state = Read-StudyAssistantProcessState
    $stopped = 0
    if ($state) {
        if ([System.IO.Path]::GetFullPath([string]$state.root) -ne (Get-StudyAssistantRoot)) {
            throw "The tracked process belongs to another checkout: $($state.root)"
        }

        $processId = [int]$state.processId
        $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if ($process) {
            $expectedStart = [datetime]::Parse([string]$state.startedAtUtc).ToUniversalTime()
            $actualStart = $process.StartTime.ToUniversalTime()
            if ([math]::Abs(($actualStart - $expectedStart).TotalSeconds) -gt 2) {
                throw 'PID was reused by another process; refusing to stop it.'
            }

            Write-Host 'Stopping the tracked Node.js process tree...'
            Stop-StudyAssistantProcessTree -ProcessId $processId
            Remove-StudyAssistantProcessState -ExpectedProcessId $processId
            $stopped++
        }
        else {
            Remove-StudyAssistantProcessState -ExpectedProcessId $processId
            Write-Host 'Removed stale process state; the process was already stopped.'
        }
    }

    # A prior terminal can leave this checkout's Server/Vite processes running
    # without a state file. Only stop listeners whose command line identifies
    # this exact project root; foreign processes using the same ports are untouched.
    foreach ($listener in @(Get-StudyAssistantPortListeners)) {
        Write-Host "Stopping untracked Study Assistant $($listener.Role) process on port $($listener.Port)..."
        Stop-StudyAssistantProcessTree -ProcessId $listener.ProcessId
        $stopped++
    }

    if ($stopped -eq 0) {
        Write-Host 'No tracked or identifiable Study Assistant process is running.'
    }
    else {
        Write-Host 'Stopped Study Assistant process tree.'
    }
}
catch {
    Write-Error $_
    exit 1
}
