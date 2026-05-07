import type { GuestAgentClient } from "./client.js";

export interface EnsureUiSidecarOptions {
  username: string;
  bind?: string;
  taskName?: string;
  runNow?: boolean;
  timeoutMs?: number;
}

export interface EnsureUiSidecarResult {
  taskName: string;
  username: string;
  bind: string;
  executable: string;
  created: boolean;
  runNow: boolean;
  state: string;
}

function psSingle(value: string): string {
  return value.replace(/'/g, "''");
}

function validateUsername(username: string): string {
  const trimmed = username.trim();
  if (trimmed.length === 0) {
    throw new Error("UI sidecar username is required");
  }
  if (/[\0\r\n]/.test(trimmed)) {
    throw new Error("UI sidecar username contains invalid characters");
  }
  return trimmed;
}

function validateBind(bind: string): string {
  if (!/^(127\.0\.0\.1|localhost):[0-9]{1,5}$/.test(bind)) {
    throw new Error("UI sidecar bind must be loopback host:port");
  }
  const port = Number(bind.split(":").at(-1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("UI sidecar bind port must be between 1 and 65535");
  }
  return bind;
}

function validateTaskName(taskName: string): string {
  const trimmed = taskName.trim();
  if (!/^[A-Za-z0-9 _.-]{1,80}$/.test(trimmed)) {
    throw new Error(
      "UI sidecar task name must be 1-80 chars: letters, numbers, space, dot, underscore, hyphen",
    );
  }
  return trimmed;
}

export function buildEnsureUiSidecarScript(options: EnsureUiSidecarOptions): string {
  const username = validateUsername(options.username);
  const bind = validateBind(options.bind ?? "127.0.0.1:50151");
  const taskName = validateTaskName(options.taskName ?? "SignalmanUiSidecar");
  const runNow = options.runNow ?? true;

  return `
$ErrorActionPreference = 'Stop'
$username = '${psSingle(username)}'
$bind = '${psSingle(bind)}'
$taskName = '${psSingle(taskName)}'
$runNow = ${runNow ? "$true" : "$false"}

function Resolve-SignalmanGuestExe {
  $service = Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\SignalmanGuest' -ErrorAction SilentlyContinue
  $candidates = @()
  if ($service -and $service.ImagePath) {
    $imagePath = [string]$service.ImagePath
    if ($imagePath -match '^"([^"]+)"') {
      $candidates += $matches[1]
    } elseif ($imagePath.Trim().Length -gt 0) {
      $candidates += ($imagePath.Trim() -split '\\s+')[0]
    }
  }
  $candidates += @(
    (Join-Path $env:ProgramFiles 'Signalman\\Guest\\signalman-guest.exe'),
    (Join-Path $env:ProgramFiles 'Signalman\\signalman-guest.exe')
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }
  throw 'signalman-guest.exe not found; install the guest MSI before enabling the UI sidecar'
}

$exe = Resolve-SignalmanGuestExe
$existed = [bool](Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)
$action = New-ScheduledTaskAction -Execute $exe -Argument "--ui-sidecar --ui-sidecar-bind $bind"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $username
$principal = New-ScheduledTaskPrincipal -UserId $username -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Signalman interactive user-session UI sidecar' -Force | Out-Null

if ($runNow) {
  Start-ScheduledTask -TaskName $taskName
  Start-Sleep -Milliseconds 500
}

$task = Get-ScheduledTask -TaskName $taskName
[pscustomobject]@{
  taskName = $taskName
  username = $username
  bind = $bind
  executable = $exe
  created = -not $existed
  runNow = [bool]$runNow
  state = [string]$task.State
} | ConvertTo-Json -Compress
`;
}

export async function ensureUiSidecar(
  client: GuestAgentClient,
  options: EnsureUiSidecarOptions,
): Promise<EnsureUiSidecarResult> {
  const script = buildEnsureUiSidecarScript(options);
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const result = await client.runCommand(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    {
      timeoutMs: options.timeoutMs ?? 30_000,
      runAs: "SYSTEM",
      maxRetries: 1,
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `ensure UI sidecar failed with exit ${result.exitCode}: ${result.stderr || result.stdout}`,
    );
  }
  return JSON.parse(result.stdout) as EnsureUiSidecarResult;
}
