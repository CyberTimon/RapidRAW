<#
.SYNOPSIS
    Runs a command while preventing the computer from sleeping / entering idle power-saving.
    Guarantees sleep prevention is deactivated immediately upon completion or cancellation.

.EXAMPLE
    .\scripts\with-stay-awake.ps1 cargo check
    .\scripts\with-stay-awake.ps1 npm.cmd run tauri build -- --bundles nsis
    .\scripts\with-stay-awake.ps1 cargo test --lib
#>

$CommandToRun = $args
if (-not $CommandToRun -or $CommandToRun.Length -eq 0) {
    Write-Host "[SleepGuard] Error: No command specified to execute." -ForegroundColor Red
    exit 1
}

# Define native Windows Win32 API for Thread Execution State
if (-not ([System.Management.Automation.PSTypeName]'RapidRAW.Win32.PowerManagement').Type) {
    Add-Type -TypeDefinition @"
    using System;
    using System.Runtime.InteropServices;

    namespace RapidRAW.Win32 {
        public static class PowerManagement {
            [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
            public static extern uint SetThreadExecutionState(uint esFlags);

            public const uint ES_SYSTEM_REQUIRED  = 0x00000001;
            public const uint ES_DISPLAY_REQUIRED = 0x00000002;
            public const uint ES_AWAYMODE_REQUIRED = 0x00000040;
            public const uint ES_CONTINUOUS       = 0x80000000;
        }
    }
"@
}

$commandString = $CommandToRun -join " "
Write-Host "`n[SleepGuard] >>> Initializing Sleep Prevention Guard..." -ForegroundColor Cyan

# Acquire wake lock: Prevent system sleep and keep CPU active
$flags = [RapidRAW.Win32.PowerManagement]::ES_CONTINUOUS -bor `
         [RapidRAW.Win32.PowerManagement]::ES_SYSTEM_REQUIRED -bor `
         [RapidRAW.Win32.PowerManagement]::ES_DISPLAY_REQUIRED

$previousState = [RapidRAW.Win32.PowerManagement]::SetThreadExecutionState($flags)
Write-Host "[SleepGuard] >>> System sleep is LOCKED (Computer will stay awake)." -ForegroundColor Green
Write-Host "[SleepGuard] >>> Executing: $commandString`n" -ForegroundColor Yellow

$exitCode = 0

try {
    # Execute the command with all arguments
    & $CommandToRun[0] $CommandToRun[1..($CommandToRun.Length - 1)]
    if ($LASTEXITCODE) {
        $exitCode = $LASTEXITCODE
    }
}
catch {
    Write-Host "`n[SleepGuard] Execution encountered an error: $_" -ForegroundColor Red
    $exitCode = 1
}
finally {
    # Guaranteed release of sleep lock: restore normal continuous OS power behavior
    [RapidRAW.Win32.PowerManagement]::SetThreadExecutionState([RapidRAW.Win32.PowerManagement]::ES_CONTINUOUS)
    Write-Host "`n[SleepGuard] <<< Task finished. Sleep lock RELEASED (Power management restored)." -ForegroundColor Cyan
}

exit $exitCode
