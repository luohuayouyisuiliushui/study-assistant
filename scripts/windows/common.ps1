Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$script:StateDirectory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'StudyAssistant'
$script:StatePath = Join-Path $script:StateDirectory 'windows-process.json'

function Initialize-StudyAssistantConsole {
    $utf8 = New-Object System.Text.UTF8Encoding $false
    [Console]::InputEncoding = $utf8
    [Console]::OutputEncoding = $utf8
    $global:OutputEncoding = $utf8
}

function Get-StudyAssistantRoot {
    return $script:ProjectRoot
}

function Get-NpmCommand {
    $npm = Get-Command 'npm.cmd' -ErrorAction SilentlyContinue
    if (-not $npm) {
        throw 'npm.cmd was not found. Install Node.js, then open a new terminal.'
    }

    return $npm.Source
}

function Get-NodeVersion {
    $node = Get-Command 'node.exe' -ErrorAction SilentlyContinue
    if (-not $node) {
        throw 'node.exe was not found. Install Node.js 20.19+ or 22.12+.'
    }

    $rawVersion = (& $node.Source --version).Trim().TrimStart('v')
    return [version]$rawVersion
}

function Assert-StudyAssistantPrerequisites {
    $nodeVersion = Get-NodeVersion
    $supported = (($nodeVersion.Major -eq 20 -and $nodeVersion -ge [version]'20.19.0') -or
        $nodeVersion -ge [version]'22.12.0')

    if (-not $supported) {
        throw "Node.js $nodeVersion is not supported. Install Node.js 20.19+ or 22.12+."
    }

    $null = Get-NpmCommand
    return $nodeVersion
}

function Get-PortListeners {
    param(
        [Parameter(Mandatory = $true)]
        [int[]]$Ports
    )

    $listeners = @()
    foreach ($port in $Ports) {
        $connections = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
        foreach ($connection in $connections) {
            $processName = 'unknown'
            try {
                $processName = (Get-Process -Id $connection.OwningProcess -ErrorAction Stop).ProcessName
            }
            catch {
                # The process may have exited between the two queries.
            }

            $listeners += [pscustomobject]@{
                Port = $port
                ProcessId = $connection.OwningProcess
                ProcessName = $processName
            }
        }
    }

    return $listeners
}

function Get-StudyAssistantPortListeners {
    $projectRootPattern = [regex]::Escape($script:ProjectRoot)
    $listeners = @()

    foreach ($connection in @(Get-NetTCPConnection -State Listen -LocalPort 3001, 5173 -ErrorAction SilentlyContinue)) {
        try {
            $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($connection.OwningProcess)" -ErrorAction Stop
            $commandLine = [string]$process.CommandLine
            $isServer = $connection.LocalPort -eq 3001 -and $process.Name -ieq 'node.exe' -and
                $commandLine -match "${projectRootPattern}\\server\\index\.js"
            $isClient = $connection.LocalPort -eq 5173 -and $process.Name -ieq 'node.exe' -and
                $commandLine -match "${projectRootPattern}\\client\\" -and
                $commandLine -match 'vite[\\/]+bin[\\/]+vite\.js'

            if ($isServer -or $isClient) {
                $listeners += [pscustomobject]@{
                    Port = $connection.LocalPort
                    ProcessId = $connection.OwningProcess
                    ProcessName = $process.Name
                    CommandLine = $commandLine
                    Role = if ($isServer) { 'server' } else { 'client' }
                }
            }
        }
        catch {
            # The listener may have exited while its process details were queried.
        }
    }

    return $listeners
}

function Stop-StudyAssistantProcessTree {
    param(
        [Parameter(Mandatory = $true)]
        [int]$ProcessId
    )

    & taskkill.exe /PID ([string]$ProcessId) /T /F
    if ($LASTEXITCODE -ne 0) {
        throw "taskkill exited with code $LASTEXITCODE."
    }
}

function Assert-PortsAvailable {
    param(
        [Parameter(Mandatory = $true)]
        [int[]]$Ports
    )

    $listeners = @(Get-PortListeners -Ports $Ports)
    if ($listeners.Count -eq 0) {
        return
    }

    $details = ($listeners | ForEach-Object {
        "port $($_.Port): $($_.ProcessName) (PID $($_.ProcessId))"
    }) -join '; '
    throw "Required port is already in use: $details. Run windows-stop.cmd or stop that process."
}

function Invoke-StudyAssistantNpm {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $npm = Get-NpmCommand
    Push-Location $script:ProjectRoot
    try {
        & $npm @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "npm exited with code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }
}

function Read-StudyAssistantProcessState {
    if (-not (Test-Path -LiteralPath $script:StatePath)) {
        return $null
    }

    try {
        return Get-Content -Raw -LiteralPath $script:StatePath | ConvertFrom-Json
    }
    catch {
        throw "Process state is invalid: $script:StatePath"
    }
}

function Remove-StudyAssistantProcessState {
    param([int]$ExpectedProcessId = 0)

    if (-not (Test-Path -LiteralPath $script:StatePath)) {
        return
    }

    if ($ExpectedProcessId -ne 0) {
        $state = Read-StudyAssistantProcessState
        if ($state -and [int]$state.processId -ne $ExpectedProcessId) {
            return
        }
    }

    # stop.ps1 and the waiting start/dev process can finish at the same time.
    # Retry the Windows delete race and treat an already-removed file as success.
    for ($attempt = 0; $attempt -lt 5; $attempt++) {
        if (-not (Test-Path -LiteralPath $script:StatePath)) {
            return
        }

        try {
            Remove-Item -LiteralPath $script:StatePath -Force -ErrorAction Stop
            return
        }
        catch {
            if (-not (Test-Path -LiteralPath $script:StatePath)) {
                return
            }
            if ($attempt -eq 4) {
                throw
            }
            Start-Sleep -Milliseconds 100
        }
    }
}

function Start-TrackedNpmProcess {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('development', 'production')]
        [string]$Mode,

        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $existing = Read-StudyAssistantProcessState
    if ($existing) {
        $existingRoot = [System.IO.Path]::GetFullPath([string]$existing.root)
        if ($existingRoot -ne $script:ProjectRoot) {
            throw "The tracked process belongs to another checkout: $($existing.root)"
        }

        $existingProcess = Get-Process -Id ([int]$existing.processId) -ErrorAction SilentlyContinue
        if ($existingProcess) {
            throw "Study Assistant is already tracked in $($existing.mode) mode (PID $($existing.processId))."
        }
        Remove-StudyAssistantProcessState
    }

    $npm = Get-NpmCommand
    $process = Start-Process -FilePath $npm -ArgumentList $Arguments -WorkingDirectory $script:ProjectRoot -NoNewWindow -PassThru

    New-Item -ItemType Directory -Path $script:StateDirectory -Force | Out-Null
    [pscustomobject]@{
        processId = $process.Id
        mode = $Mode
        root = $script:ProjectRoot
        startedAtUtc = $process.StartTime.ToUniversalTime().ToString('o')
    } | ConvertTo-Json | Set-Content -LiteralPath $script:StatePath -Encoding UTF8

    Write-Host "Study Assistant started in $Mode mode (PID $($process.Id)). Press Ctrl+C to stop."
    try {
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) {
            # stop.ps1 removes this state after terminating the tracked npm tree.
            # Wait briefly for that handoff so the outer .cmd does not treat a
            # requested stop as an error and remain blocked at its pause prompt.
            for ($attempt = 0; $attempt -lt 10; $attempt++) {
                $currentState = Read-StudyAssistantProcessState
                if (-not $currentState -or [int]$currentState.processId -ne $process.Id) {
                    Write-Host 'Study Assistant was stopped.'
                    return
                }
                Start-Sleep -Milliseconds 100
            }
            throw "Study Assistant exited with code $($process.ExitCode)."
        }
    }
    finally {
        Remove-StudyAssistantProcessState -ExpectedProcessId $process.Id
    }
}
