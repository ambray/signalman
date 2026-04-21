<#
.SYNOPSIS
    Create a running-state "warm" Hyper-V checkpoint derived from a
    cold base checkpoint.

.DESCRIPTION
    Cold Hyper-V checkpoints capture the off-state disk only. Restoring
    one triggers a full cold boot of the guest — on Win11 this can take
    6-10+ minutes before PowerShell's first invocation JIT-warms. That
    unreliable warmup tail was the root cause of most signalman VM-smoke
    flakiness we've observed (timings: 101s first PS call on the Win11
    test VM after cold restore; 345ms on second call; 2.6s first call
    after warm restore).

    This script harvests a warm checkpoint:
      1. Restores the given cold base checkpoint.
      2. Starts the VM.
      3. Waits for the guest agent port (default 50051) to listen.
      4. Pauses briefly so integration services stabilise.
      5. Takes a new checkpoint WHILE THE VM IS RUNNING, capturing the
         memory state + warmed PowerShell runtime.

    Scenarios then point their `checkpoint_restore:` at the warm name
    and skip the cold boot entirely. Restore time is typically 2-5 s
    to guest-reachable and 2-4 s to PowerShell-responsive.

.PARAMETER VMName
    Hyper-V VM to harvest from. Required.

.PARAMETER BaseCheckpoint
    Name of the cold base checkpoint to restore before harvesting.
    Required.

.PARAMETER WarmCheckpoint
    Name for the new warm checkpoint. Defaults to "<base>-warm".

.PARAMETER GuestIp
    Guest IP to probe for the agent port. Default 172.30.0.10.

.PARAMETER GuestPort
    Guest agent TCP port. Default 50051.

.PARAMETER StabilizeSeconds
    Extra seconds to wait after the agent port is reachable before
    taking the checkpoint. Covers the tail where TCP listens but
    PowerShell/integration services are still registering. Default 30.

.EXAMPLE
    ./harvest-warm-checkpoint.ps1 -VMName Win11x64 -BaseCheckpoint test-signing-enabled

    Produces "test-signing-warm" ready for use in signalman scenarios.

.NOTES
    Requires: Hyper-V PowerShell module, elevated context (gsudo or
    Administrator prompt).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]  [string] $VMName,
    [Parameter(Mandatory = $true)]  [string] $BaseCheckpoint,
    [Parameter(Mandatory = $false)] [string] $WarmCheckpoint = $null,
    [Parameter(Mandatory = $false)] [string] $GuestIp = '172.30.0.10',
    [Parameter(Mandatory = $false)] [int]    $GuestPort = 50051,
    [Parameter(Mandatory = $false)] [int]    $StabilizeSeconds = 30
)

$ErrorActionPreference = 'Stop'

if (-not $WarmCheckpoint) {
    $WarmCheckpoint = "$BaseCheckpoint-warm"
    # Avoid the "enabled-warm" suffix chain if the base already ends in -enabled.
    if ($BaseCheckpoint -match '-enabled$') {
        $WarmCheckpoint = ($BaseCheckpoint -replace '-enabled$', '-warm')
    }
}

Write-Host "Harvesting warm checkpoint"
Write-Host "  VM:                $VMName"
Write-Host "  Base checkpoint:   $BaseCheckpoint"
Write-Host "  Warm checkpoint:   $WarmCheckpoint"
Write-Host "  Guest probe:       ${GuestIp}:$GuestPort"
Write-Host "  Stabilize secs:    $StabilizeSeconds"
Write-Host ""

# Step 1: ensure VM is in a stable state before touching checkpoints.
$stableStates = @('Off', 'Running', 'Saved', 'Paused')
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
    $s = (Get-VM -Name $VMName).State
    if ($stableStates -contains $s.ToString()) { break }
    Write-Host "  VM state '$s' — waiting for stable transition"
    Start-Sleep -Seconds 2
}

# Step 2: restore the cold base.
Write-Host "[1/5] Restoring base checkpoint '$BaseCheckpoint'..."
Restore-VMSnapshot -VMName $VMName -Name $BaseCheckpoint -Confirm:$false
Start-Sleep -Seconds 1

# Step 3: start the VM.
Write-Host "[2/5] Starting VM..."
Start-VM -Name $VMName

# Step 4: wait for the guest agent port. Accept up to 15 min of cold boot.
Write-Host "[3/5] Waiting for ${GuestIp}:$GuestPort (up to 15 min cold-boot budget)..."
$t0 = Get-Date
$timeout = (Get-Date).AddMinutes(15)
$reachable = $false
while ((Get-Date) -lt $timeout) {
    if (Test-NetConnection -ComputerName $GuestIp -Port $GuestPort -InformationLevel Quiet -WarningAction SilentlyContinue) {
        $reachable = $true
        break
    }
    Start-Sleep -Seconds 2
}
if (-not $reachable) {
    throw "Guest agent on ${GuestIp}:$GuestPort did not become reachable within 15 min"
}
$bootElapsed = [int]((Get-Date) - $t0).TotalSeconds
Write-Host "      Guest agent reachable after $bootElapsed s"

# Step 5: stabilize. PowerShell cold-start, integration services, Defender
#         scans etc. all settle in this window.
Write-Host "[4/5] Stabilizing for $StabilizeSeconds s..."
Start-Sleep -Seconds $StabilizeSeconds

# Step 6: take the warm checkpoint.
Write-Host "[5/5] Creating warm checkpoint '$WarmCheckpoint'..."
# Remove an existing warm checkpoint of the same name so re-harvesting
# is idempotent.
$existing = Get-VMCheckpoint -VMName $VMName -Name $WarmCheckpoint -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "      Removing stale '$WarmCheckpoint' first"
    Remove-VMCheckpoint -VMCheckpoint $existing -Confirm:$false
}
Checkpoint-VM -Name $VMName -SnapshotName $WarmCheckpoint
Write-Host ""
Write-Host "Done. Scenarios can now use:"
Write-Host "  checkpoint_restore: $WarmCheckpoint"
