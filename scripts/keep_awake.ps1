$code = @'
using System;
using System.Runtime.InteropServices;
public class SleepUtil {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint SetThreadExecutionState(uint esFlags);
}
'@
Add-Type -TypeDefinition $code
[uint32]$flags = [Convert]::ToUInt32("80000003", 16)
[SleepUtil]::SetThreadExecutionState($flags)
Write-Host "Windows 11 Continuous Wake Lock Loop Started."
while ($true) {
    [SleepUtil]::SetThreadExecutionState($flags)
    Start-Sleep -Seconds 60
}
