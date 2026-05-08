import type { GuestAgentClient } from "./client.js";

export interface EnsureUiSidecarOptions {
  username: string;
  bind?: string;
  engine?: string;
  taskName?: string;
  runNow?: boolean;
  waitReadyMs?: number;
  timeoutMs?: number;
}

export interface EnsureUiSidecarResult {
  taskName: string;
  username: string;
  bind: string;
  engine: string;
  executable: string;
  created: boolean;
  runNow: boolean;
  state: string;
  ready: boolean;
  waitReadyMs: number;
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

function validateEngine(engine: string): string {
  const normalized = engine.trim().toLowerCase();
  if (
    normalized === "powershell-process" ||
    normalized === "powershell-helper" ||
    normalized === "native"
  ) {
    return normalized;
  }
  throw new Error("UI sidecar engine must be powershell-process, powershell-helper, or native");
}

function validateWaitReadyMs(waitReadyMs: number | undefined, runNow: boolean): number {
  const value = waitReadyMs ?? (runNow ? 5_000 : 0);
  if (!Number.isFinite(value) || value < 0 || value > 300_000) {
    throw new Error("UI sidecar waitReadyMs must be between 0 and 300000");
  }
  return Math.floor(value);
}

export function buildEnsureUiSidecarScript(options: EnsureUiSidecarOptions): string {
  const username = validateUsername(options.username);
  const bind = validateBind(options.bind ?? "127.0.0.1:50151");
  const engine = validateEngine(options.engine ?? "powershell-process");
  const taskName = validateTaskName(options.taskName ?? "SignalmanUiSidecar");
  const runNow = options.runNow ?? true;
  const waitReadyMs = validateWaitReadyMs(options.waitReadyMs, runNow);

  return `
$ErrorActionPreference = 'Stop'
$username = '${psSingle(username)}'
$bind = '${psSingle(bind)}'
$engine = '${psSingle(engine)}'
$taskName = '${psSingle(taskName)}'
$runNow = ${runNow ? "$true" : "$false"}
$waitReadyMs = ${waitReadyMs}

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

function Test-SignalmanSidecarPort {
  param([string]$Bind)
  $uri = [Uri]("tcp://" + $Bind)
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $async = $client.BeginConnect($uri.Host, $uri.Port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne(250, $false)) { return $false }
    $client.EndConnect($async)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Wait-SignalmanSidecarReady {
  param([string]$Bind, [int]$TimeoutMs)
  if (Test-SignalmanSidecarPort -Bind $Bind) { return $true }
  if ($TimeoutMs -le 0) { return $false }
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
  do {
    Start-Sleep -Milliseconds 100
    if (Test-SignalmanSidecarPort -Bind $Bind) { return $true }
  } while ([DateTime]::UtcNow -lt $deadline)
  return $false
}

$exe = Resolve-SignalmanGuestExe
$existed = [bool](Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)
$action = New-ScheduledTaskAction -Execute $exe -Argument "--ui-sidecar --ui-sidecar-bind $bind --ui-engine $engine"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $username
$principal = New-ScheduledTaskPrincipal -UserId $username -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Signalman interactive user-session UI sidecar' -Force | Out-Null

if ($runNow) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "name = 'signalman-guest.exe'" |
    Where-Object { $_.CommandLine -like '*--ui-sidecar*' } |
    ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null }
  Start-Sleep -Milliseconds 1000
  Start-ScheduledTask -TaskName $taskName
  Start-Sleep -Milliseconds 500
}

$task = Get-ScheduledTask -TaskName $taskName
$ready = Wait-SignalmanSidecarReady -Bind $bind -TimeoutMs $waitReadyMs
[pscustomobject]@{
  taskName = $taskName
  username = $username
  bind = $bind
  engine = $engine
  executable = $exe
  created = -not $existed
  runNow = [bool]$runNow
  state = [string]$task.State
  ready = [bool]$ready
  waitReadyMs = [int]$waitReadyMs
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
