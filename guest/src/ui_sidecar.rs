//! Interactive user-session UI sidecar.
//!
//! The main guest agent commonly runs as a Windows service, which means it
//! cannot reliably interact with the logged-in user's desktop. This sidecar is
//! intended to be launched inside that user's session. The service-facing guest
//! agent proxies UI RPCs to it over loopback.

use std::io::{BufRead, BufReader, Write};
use std::net::SocketAddr;
#[cfg(target_os = "windows")]
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
#[cfg(target_os = "windows")]
use std::sync::{Mutex, OnceLock};

use anyhow::{anyhow, Context};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::task;
use tracing::{info, warn};

const DEFAULT_CONNECT_ADDR: &str = "127.0.0.1:50151";
const POWERSHELL_PROCESS_ENGINE: &str = "powershell-process";
const POWERSHELL_HELPER_ENGINE: &str = "powershell-helper";
const NATIVE_ENGINE: &str = "native";
static START_TIME: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
#[cfg(target_os = "windows")]
static POWERSHELL_HELPER: OnceLock<Mutex<Option<PowershellHelper>>> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UiAutomationEngine {
    PowershellProcess,
    PowershellHelper,
    Native,
}

impl UiAutomationEngine {
    fn selected() -> Self {
        Self::from_env(std::env::var("SIGNALMAN_UI_ENGINE").ok().as_deref())
    }

    fn from_env(value: Option<&str>) -> Self {
        match value.unwrap_or("").trim().to_ascii_lowercase().as_str() {
            "helper" | POWERSHELL_HELPER_ENGINE => Self::PowershellHelper,
            "native" | "uia" | "windows-uia" => Self::Native,
            _ => Self::PowershellProcess,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::PowershellProcess => POWERSHELL_PROCESS_ENGINE,
            Self::PowershellHelper => POWERSHELL_HELPER_ENGINE,
            Self::Native => NATIVE_ENGINE,
        }
    }

    fn execute(self, method: &str, params: &Value) -> anyhow::Result<Value> {
        match self {
            Self::PowershellProcess | Self::PowershellHelper => {
                execute_backend(&PowershellUiBackend { engine: self }, method, params)
            }
            Self::Native => execute_backend(&NativeUiBackend, method, params),
        }
    }

    #[cfg(test)]
    fn backend(self) -> PowershellUiBackend {
        match self {
            Self::PowershellProcess | Self::PowershellHelper => {
                PowershellUiBackend { engine: self }
            }
            Self::Native => PowershellUiBackend {
                engine: Self::PowershellProcess,
            },
        }
    }

    #[cfg(not(target_os = "windows"))]
    fn run_script_json(self, _script: &str) -> anyhow::Result<Value> {
        Err(anyhow!(
            "UI sidecar automation engine '{}' is only supported on Windows",
            self.name()
        ))
    }

    #[cfg(target_os = "windows")]
    fn run_script_json(self, script: &str) -> anyhow::Result<Value> {
        match self {
            Self::PowershellProcess => run_powershell_process_json(script),
            Self::PowershellHelper => run_powershell_helper_json(script),
            Self::Native => Err(anyhow!(
                "native UI Automation backend does not use PowerShell scripts"
            )),
        }
    }
}

trait UiAutomationBackend {
    fn engine_name(&self) -> &'static str;

    fn health(&self) -> UiHealthResult {
        UiHealthResult {
            engine: self.engine_name().to_string(),
            pid: std::process::id(),
            uptime_ms: START_TIME
                .get()
                .map(|started| started.elapsed().as_millis() as u64)
                .unwrap_or(0),
        }
    }

    fn find(&self, params: &UiFindParams) -> anyhow::Result<UiFindResult>;
    fn click(&self, params: &UiClickParams) -> anyhow::Result<UiActionResult>;
    fn type_text(&self, params: &UiTypeParams) -> anyhow::Result<UiActionResult>;
    fn key(&self, params: &UiKeyParams) -> anyhow::Result<UiActionResult>;
    fn screenshot(&self, params: &UiScreenshotParams) -> anyhow::Result<UiScreenshotResult>;
}

#[derive(Debug, Clone, Copy)]
struct PowershellUiBackend {
    engine: UiAutomationEngine,
}

impl UiAutomationBackend for PowershellUiBackend {
    fn engine_name(&self) -> &'static str {
        self.engine.name()
    }

    fn find(&self, params: &UiFindParams) -> anyhow::Result<UiFindResult> {
        powershell_ui_find(self.engine, params)
    }

    fn click(&self, params: &UiClickParams) -> anyhow::Result<UiActionResult> {
        powershell_ui_click(self.engine, params)
    }

    fn type_text(&self, params: &UiTypeParams) -> anyhow::Result<UiActionResult> {
        powershell_ui_type(self.engine, params)
    }

    fn key(&self, params: &UiKeyParams) -> anyhow::Result<UiActionResult> {
        powershell_ui_key(self.engine, params)
    }

    fn screenshot(&self, params: &UiScreenshotParams) -> anyhow::Result<UiScreenshotResult> {
        powershell_ui_screenshot(self.engine, params)
    }
}

#[derive(Debug, Clone, Copy)]
struct NativeUiBackend;

impl NativeUiBackend {
    fn not_implemented(&self) -> anyhow::Error {
        anyhow!("native UI Automation backend is not implemented yet")
    }
}

impl UiAutomationBackend for NativeUiBackend {
    fn engine_name(&self) -> &'static str {
        NATIVE_ENGINE
    }

    fn find(&self, _params: &UiFindParams) -> anyhow::Result<UiFindResult> {
        Err(self.not_implemented())
    }

    fn click(&self, _params: &UiClickParams) -> anyhow::Result<UiActionResult> {
        Err(self.not_implemented())
    }

    fn type_text(&self, _params: &UiTypeParams) -> anyhow::Result<UiActionResult> {
        Err(self.not_implemented())
    }

    fn key(&self, _params: &UiKeyParams) -> anyhow::Result<UiActionResult> {
        Err(self.not_implemented())
    }

    fn screenshot(&self, _params: &UiScreenshotParams) -> anyhow::Result<UiScreenshotResult> {
        Err(self.not_implemented())
    }
}

#[derive(Debug, Deserialize, Serialize)]
struct SidecarRequest {
    id: u64,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Deserialize, Serialize)]
struct SidecarResponse {
    id: u64,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct UiFindParams {
    #[serde(default)]
    selector: String,
    #[serde(default)]
    window_title: String,
    #[serde(default)]
    timeout_ms: Option<u64>,
}

#[derive(Debug, Deserialize, Default)]
struct UiClickParams {
    #[serde(default)]
    selector: String,
    #[serde(default)]
    window_title: String,
    #[serde(default)]
    click_type: String,
}

#[derive(Debug, Deserialize, Default)]
struct UiTypeParams {
    #[serde(default)]
    text: String,
    #[serde(default)]
    selector: String,
    #[serde(default)]
    window_title: String,
    #[serde(default)]
    clear_first: bool,
}

#[derive(Debug, Deserialize, Default)]
struct UiKeyParams {
    #[serde(default)]
    keys: String,
    #[serde(default)]
    selector: String,
    #[serde(default)]
    window_title: String,
    #[serde(default)]
    repeat: Option<u64>,
}

#[derive(Debug, Deserialize, Default)]
struct UiScreenshotParams {
    #[serde(default)]
    window_title: String,
    #[serde(default)]
    format: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct UiHealthResult {
    pub(crate) engine: String,
    pub(crate) pid: u32,
    pub(crate) uptime_ms: u64,
}

#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct UiActionResult {
    #[serde(default = "default_true")]
    pub(crate) success: bool,
    #[serde(default)]
    pub(crate) error: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct UiFindResult {
    #[serde(default)]
    pub(crate) elements: Vec<UiElementResult>,
}

#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct UiElementResult {
    #[serde(default)]
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) automation_id: String,
    #[serde(default)]
    pub(crate) control_type: String,
    #[serde(default)]
    pub(crate) class_name: String,
    #[serde(default)]
    pub(crate) is_enabled: bool,
    #[serde(default)]
    pub(crate) is_visible: bool,
    #[serde(default)]
    pub(crate) x: i32,
    #[serde(default)]
    pub(crate) y: i32,
    #[serde(default)]
    pub(crate) width: i32,
    #[serde(default)]
    pub(crate) height: i32,
    #[serde(default)]
    pub(crate) value: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct UiScreenshotResult {
    pub(crate) image_data_base64: String,
    #[serde(default = "default_screenshot_format")]
    pub(crate) format: String,
    #[serde(default)]
    pub(crate) width: u32,
    #[serde(default)]
    pub(crate) height: u32,
}

#[cfg(target_os = "windows")]
#[derive(Debug, Deserialize)]
struct HelperResponse {
    ok: bool,
    #[serde(default)]
    result: Value,
    #[serde(default)]
    error: String,
}

pub async fn run(addr: SocketAddr) -> anyhow::Result<()> {
    START_TIME.get_or_init(std::time::Instant::now);
    let listener = TcpListener::bind(addr).await?;
    loop {
        let (stream, peer) = listener.accept().await?;
        info!(%peer, "UI sidecar client connected");
        task::spawn_blocking(move || {
            let stream = match stream.into_std() {
                Ok(stream) => stream,
                Err(err) => {
                    warn!(%peer, error = %err, "UI sidecar stream conversion failed");
                    return;
                }
            };
            let _ = stream.set_nonblocking(false);
            if let Err(err) = handle_connection(stream) {
                warn!(%peer, error = %err, "UI sidecar connection failed");
            }
        });
    }
}

pub async fn call(method: &str, params: Value) -> anyhow::Result<Value> {
    let addr = std::env::var("SIGNALMAN_UI_SIDECAR_ADDR")
        .unwrap_or_else(|_| DEFAULT_CONNECT_ADDR.to_string());
    let method = method.to_string();
    task::spawn_blocking(move || call_blocking(&addr, &method, params))
        .await
        .context("UI sidecar proxy task panicked")?
}

pub async fn call_typed<T>(method: &str, params: Value) -> anyhow::Result<T>
where
    T: DeserializeOwned,
{
    let value = call(method, params).await?;
    parse_response(method, value)
}

fn handle_connection(mut stream: std::net::TcpStream) -> anyhow::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    loop {
        line.clear();
        let n = reader.read_line(&mut line)?;
        if n == 0 {
            return Ok(());
        }
        let response = match serde_json::from_str::<SidecarRequest>(&line) {
            Ok(req) => handle_request(req),
            Err(err) => SidecarResponse {
                id: 0,
                ok: false,
                result: None,
                error: Some(format!("invalid request JSON: {err}")),
            },
        };
        let serialized = serde_json::to_string(&response)?;
        stream.write_all(serialized.as_bytes())?;
        stream.write_all(b"\n")?;
        stream.flush()?;
    }
}

fn call_blocking(addr: &str, method: &str, params: Value) -> anyhow::Result<Value> {
    let mut stream = std::net::TcpStream::connect(addr)
        .with_context(|| format!("connect UI sidecar at {addr}"))?;
    let req = SidecarRequest {
        id: 1,
        method: method.to_string(),
        params,
    };
    stream.write_all(serde_json::to_string(&req)?.as_bytes())?;
    stream.write_all(b"\n")?;
    stream.flush()?;

    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let response: SidecarResponse = serde_json::from_str(&line)?;
    if response.ok {
        Ok(response.result.unwrap_or(Value::Null))
    } else {
        Err(anyhow!(response.error.unwrap_or_else(|| {
            "UI sidecar returned an unknown error".to_string()
        })))
    }
}

fn handle_request(req: SidecarRequest) -> SidecarResponse {
    let result = UiAutomationEngine::selected().execute(&req.method, &req.params);
    match result {
        Ok(value) => SidecarResponse {
            id: req.id,
            ok: true,
            result: Some(value),
            error: None,
        },
        Err(err) => SidecarResponse {
            id: req.id,
            ok: false,
            result: None,
            error: Some(err.to_string()),
        },
    }
}

fn sidecar_health() -> Value {
    let engine = UiAutomationEngine::selected();
    let result = match engine {
        UiAutomationEngine::PowershellProcess | UiAutomationEngine::PowershellHelper => {
            PowershellUiBackend { engine }.health()
        }
        UiAutomationEngine::Native => NativeUiBackend.health(),
    };
    serde_json::to_value(result).expect("UI health result serializes")
}

fn engine_name_for_env(value: Option<&str>) -> &'static str {
    UiAutomationEngine::from_env(value).name()
}

fn parse_params<T>(method: &str, params: &Value) -> anyhow::Result<T>
where
    T: DeserializeOwned,
{
    serde_json::from_value(params.clone())
        .with_context(|| format!("invalid parameters for UI sidecar method '{method}'"))
}

fn execute_backend<B>(backend: &B, method: &str, params: &Value) -> anyhow::Result<Value>
where
    B: UiAutomationBackend,
{
    match method {
        "ui.health" => to_value(backend.health(), method),
        "ui.find" => to_value(backend.find(&parse_params(method, params)?)?, method),
        "ui.click" => to_value(backend.click(&parse_params(method, params)?)?, method),
        "ui.type" => to_value(backend.type_text(&parse_params(method, params)?)?, method),
        "ui.key" => to_value(backend.key(&parse_params(method, params)?)?, method),
        "ui.screenshot" => to_value(backend.screenshot(&parse_params(method, params)?)?, method),
        other => Err(anyhow!("unknown UI sidecar method '{other}'")),
    }
}

fn parse_response<T>(method: &str, value: Value) -> anyhow::Result<T>
where
    T: DeserializeOwned,
{
    serde_json::from_value(value)
        .with_context(|| format!("invalid response from UI sidecar method '{method}'"))
}

fn to_value<T>(value: T, method: &str) -> anyhow::Result<Value>
where
    T: Serialize,
{
    serde_json::to_value(value)
        .with_context(|| format!("serialize response for UI sidecar method '{method}'"))
}

fn default_true() -> bool {
    true
}

fn default_screenshot_format() -> String {
    "png".to_string()
}

#[cfg(target_os = "windows")]
fn run_powershell_process_json(script: &str) -> anyhow::Result<Value> {
    let output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-Sta",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .output()
        .context("spawn powershell.exe for UI automation")?;
    if !output.status.success() {
        return Err(anyhow!(
            "PowerShell UI automation failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(stdout.trim()).context("parse UI sidecar PowerShell JSON")
}

#[cfg(target_os = "windows")]
fn run_powershell_helper_json(script: &str) -> anyhow::Result<Value> {
    let slot = POWERSHELL_HELPER.get_or_init(|| Mutex::new(None));
    let mut guard = slot
        .lock()
        .map_err(|_| anyhow!("PowerShell UI helper lock poisoned"))?;
    if guard.is_none() {
        *guard = Some(PowershellHelper::start()?);
    }
    let first = guard.as_mut().expect("helper initialized").call(script);
    match first {
        Ok(value) => Ok(value),
        Err(first_err) => {
            if let Some(mut helper) = guard.take() {
                helper.stop();
            }
            *guard = Some(PowershellHelper::start()?);
            guard
                .as_mut()
                .expect("helper restarted")
                .call(script)
                .with_context(|| format!("PowerShell UI helper restarted after: {first_err}"))
        }
    }
}

#[cfg(target_os = "windows")]
struct PowershellHelper {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

#[cfg(target_os = "windows")]
impl PowershellHelper {
    fn start() -> anyhow::Result<Self> {
        let mut child = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-Sta",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                powershell_helper_loop(),
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .context("spawn persistent powershell.exe UI helper")?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("PowerShell UI helper stdin unavailable"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("PowerShell UI helper stdout unavailable"))?;
        Ok(Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
        })
    }

    fn call(&mut self, script: &str) -> anyhow::Result<Value> {
        if let Some(status) = self.child.try_wait()? {
            return Err(anyhow!("PowerShell UI helper exited with {status}"));
        }
        let request = serde_json::to_string(&json!({ "script": script }))?;
        self.stdin.write_all(request.as_bytes())?;
        self.stdin.write_all(b"\n")?;
        self.stdin.flush()?;

        let mut line = String::new();
        let n = self.stdout.read_line(&mut line)?;
        if n == 0 {
            return Err(anyhow!("PowerShell UI helper closed stdout"));
        }
        let response: HelperResponse =
            serde_json::from_str(line.trim()).context("parse PowerShell UI helper response")?;
        if response.ok {
            Ok(response.result)
        } else {
            Err(anyhow!(
                "PowerShell UI helper failed: {}",
                if response.error.is_empty() {
                    "unknown error"
                } else {
                    response.error.as_str()
                }
            ))
        }
    }

    fn stop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(target_os = "windows")]
fn powershell_helper_loop() -> &'static str {
    r#"
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    $req = $line | ConvertFrom-Json
    $result = Invoke-Expression ([string]$req.script)
    if ($null -eq $result) { $result = [pscustomobject]@{} }
    if ($result -is [string]) {
      try { $result = $result | ConvertFrom-Json } catch {}
    }
    [pscustomobject]@{ ok = $true; result = $result } | ConvertTo-Json -Depth 20 -Compress
  } catch {
    [pscustomobject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Depth 6 -Compress
  }
}
"#
}

fn ps_quote_value(value: &str) -> String {
    value.replace('\'', "''")
}

fn common_uia_script(selector: &str, window_title: &str, timeout_ms: u64) -> String {
    format!(
        r#"
Add-Type -AssemblyName UIAutomationClient
$selector = '{selector}'
$windowTitle = '{window_title}'
$deadline = [DateTime]::UtcNow.AddMilliseconds({timeout_ms})
function Match-SignalmanElement($e, $selector) {{
  if ([string]::IsNullOrWhiteSpace($selector)) {{ return $true }}
  if ($selector -match "^\[(name|automationId|className|controlType)='([^']*)'\]$") {{
    $k = $matches[1]; $v = $matches[2]
    switch ($k) {{
      'name' {{ return $e.Current.Name -eq $v }}
      'automationId' {{ return $e.Current.AutomationId -eq $v }}
      'className' {{ return $e.Current.ClassName -eq $v }}
      'controlType' {{
        $controlType = if ($v -like 'ControlType.*') {{ $v }} else {{ "ControlType.$v" }}
        return $e.Current.ControlType.ProgrammaticName -eq $controlType
      }}
    }}
  }}
  return ($e.Current.Name -like "*$selector*") -or ($e.Current.AutomationId -eq $selector)
}}
function Get-SignalmanRoot {{
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  if (-not [string]::IsNullOrWhiteSpace($windowTitle)) {{
    $cond = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::NameProperty,
      $windowTitle
    )
    $w = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
    if ($w) {{ return $w }}
  }}
  return $root
}}
function Find-SignalmanElement {{
  do {{
    $root = Get-SignalmanRoot
    $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($e in $all) {{ if (Match-SignalmanElement $e $selector) {{ return $e }} }}
    Start-Sleep -Milliseconds 100
  }} while ([DateTime]::UtcNow -lt $deadline)
  return $null
}}
"#
    )
}

fn powershell_ui_find(
    engine: UiAutomationEngine,
    params: &UiFindParams,
) -> anyhow::Result<UiFindResult> {
    let selector = ps_quote_value(&params.selector);
    let window_title = ps_quote_value(&params.window_title);
    let timeout_ms = params.timeout_ms.unwrap_or(2_000);
    let script = format!(
        r#"{}
$root = Get-SignalmanRoot
$all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$items = @()
foreach ($e in $all) {{
  if (Match-SignalmanElement $e $selector) {{
    $r = $e.Current.BoundingRectangle
    $items += [pscustomobject]@{{
      name = [string]$e.Current.Name
      automation_id = [string]$e.Current.AutomationId
      control_type = [string]$e.Current.ControlType.ProgrammaticName
      class_name = [string]$e.Current.ClassName
      is_enabled = [bool]$e.Current.IsEnabled
      is_visible = -not $r.IsEmpty
      x = [int]$r.X
      y = [int]$r.Y
      width = [int]$r.Width
      height = [int]$r.Height
      value = ''
    }}
  }}
}}
[pscustomobject]@{{ elements = $items }} | ConvertTo-Json -Depth 6 -Compress
"#,
        common_uia_script(&selector, &window_title, timeout_ms)
    );
    parse_response("ui.find", engine.run_script_json(&script)?)
}

fn powershell_ui_click(
    engine: UiAutomationEngine,
    params: &UiClickParams,
) -> anyhow::Result<UiActionResult> {
    let selector = ps_quote_value(&params.selector);
    let window_title = ps_quote_value(&params.window_title);
    let click_type = ps_quote_value(&params.click_type);
    let (down, up) = if click_type == "right" {
        ("0x0008", "0x0010")
    } else {
        ("0x0002", "0x0004")
    };
    let count = if click_type == "double" { 2 } else { 1 };
    let script = format!(
        r#"{}
if (-not ('SignalmanMouse' -as [type])) {{
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class SignalmanMouse {{
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}}
"@
}}
$e = Find-SignalmanElement
if (-not $e) {{ throw "element not found: $selector" }}
$r = $e.Current.BoundingRectangle
$x = [int]($r.X + ($r.Width / 2)); $y = [int]($r.Y + ($r.Height / 2))
[SignalmanMouse]::SetCursorPos($x, $y) | Out-Null
1..{count} | ForEach-Object {{
  [SignalmanMouse]::mouse_event({down}, 0, 0, 0, [UIntPtr]::Zero)
  [SignalmanMouse]::mouse_event({up}, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 80
}}
[pscustomobject]@{{ success = $true; error = '' }} | ConvertTo-Json -Compress
"#,
        common_uia_script(&selector, &window_title, 5_000),
        count = count,
        down = down,
        up = up,
    );
    parse_response("ui.click", engine.run_script_json(&script)?)
}

fn powershell_ui_type(
    engine: UiAutomationEngine,
    params: &UiTypeParams,
) -> anyhow::Result<UiActionResult> {
    let selector = ps_quote_value(&params.selector);
    let window_title = ps_quote_value(&params.window_title);
    let text = ps_quote_value(&params.text);
    let clear_first = if params.clear_first {
        "$true"
    } else {
        "$false"
    };
    let escaped_text = text
        .replace('{', "{{}")
        .replace('}', "{}}")
        .replace('+', "{+}")
        .replace('^', "{^}")
        .replace('%', "{%}")
        .replace('~', "{~}")
        .replace('(', "{(}")
        .replace(')', "{)}");
    let script = format!(
        r#"{}
Add-Type -AssemblyName System.Windows.Forms
if (-not ('SignalmanTextFocus' -as [type])) {{
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class SignalmanTextFocus {{
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}}
"@
}}
if (-not [string]::IsNullOrWhiteSpace($selector)) {{
  $e = Find-SignalmanElement
  if (-not $e) {{ throw "element not found: $selector" }}
  try {{ $e.SetFocus() }} catch {{ }}
  $r = $e.Current.BoundingRectangle
  $x = [int]($r.X + ($r.Width / 2)); $y = [int]($r.Y + ($r.Height / 2))
  [SignalmanTextFocus]::SetCursorPos($x, $y) | Out-Null
  [SignalmanTextFocus]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  [SignalmanTextFocus]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 80
}}
if ({clear_first}) {{ [System.Windows.Forms.SendKeys]::SendWait('^a') }}
[System.Windows.Forms.SendKeys]::SendWait('{escaped_text}')
[pscustomobject]@{{ success = $true; error = '' }} | ConvertTo-Json -Compress
"#,
        common_uia_script(&selector, &window_title, 5_000),
        clear_first = clear_first,
        escaped_text = escaped_text
    );
    parse_response("ui.type", engine.run_script_json(&script)?)
}

fn powershell_ui_key(
    engine: UiAutomationEngine,
    params: &UiKeyParams,
) -> anyhow::Result<UiActionResult> {
    let selector = ps_quote_value(&params.selector);
    let window_title = ps_quote_value(&params.window_title);
    let keys = ps_quote_value(&params.keys);
    let repeat = params.repeat.unwrap_or(1).clamp(1, 100);
    if keys.trim().is_empty() {
        return Err(anyhow!("keys is required"));
    }
    let script = format!(
        r#"{}
Add-Type -AssemblyName System.Windows.Forms
if (-not ('SignalmanKeyFocus' -as [type])) {{
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class SignalmanKeyFocus {{
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}}
"@
}}
if (-not [string]::IsNullOrWhiteSpace($selector)) {{
  $e = Find-SignalmanElement
  if (-not $e) {{ throw "element not found: $selector" }}
  try {{ $e.SetFocus() }} catch {{ }}
  $r = $e.Current.BoundingRectangle
  $x = [int]($r.X + ($r.Width / 2)); $y = [int]($r.Y + ($r.Height / 2))
  [SignalmanKeyFocus]::SetCursorPos($x, $y) | Out-Null
  [SignalmanKeyFocus]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  [SignalmanKeyFocus]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 80
}}
1..{repeat} | ForEach-Object {{
  [System.Windows.Forms.SendKeys]::SendWait('{keys}')
  Start-Sleep -Milliseconds 40
}}
[pscustomobject]@{{ success = $true; error = '' }} | ConvertTo-Json -Compress
"#,
        common_uia_script(&selector, &window_title, 5_000),
        repeat = repeat,
        keys = keys
    );
    parse_response("ui.key", engine.run_script_json(&script)?)
}

fn powershell_ui_screenshot(
    engine: UiAutomationEngine,
    params: &UiScreenshotParams,
) -> anyhow::Result<UiScreenshotResult> {
    let _window_title = ps_quote_value(&params.window_title);
    let format = ps_quote_value(&params.format);
    let format = if format.eq_ignore_ascii_case("jpeg") {
        "Jpeg"
    } else {
        "Png"
    };
    let script = format!(
        r#"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bmp)
$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::{format})
$bytes = $ms.ToArray()
$graphics.Dispose(); $bmp.Dispose(); $ms.Dispose()
[pscustomobject]@{{
  image_data_base64 = [Convert]::ToBase64String($bytes)
  format = '{lower}'
  width = [int]$bounds.Width
  height = [int]$bounds.Height
}} | ConvertTo-Json -Compress
"#,
        format = format,
        lower = format.to_ascii_lowercase()
    );
    parse_response("ui.screenshot", engine.run_script_json(&script)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sidecar_response_roundtrips() {
        let response = SidecarResponse {
            id: 7,
            ok: true,
            result: Some(json!({"success": true})),
            error: None,
        };
        let encoded = serde_json::to_string(&response).unwrap();
        let decoded: SidecarResponse = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded.id, 7);
        assert!(decoded.ok);
    }

    #[test]
    fn invalid_request_response_preserves_connection_shape() {
        let response = handle_request(SidecarRequest {
            id: 3,
            method: "ui.nope".to_string(),
            params: Value::Null,
        });
        assert_eq!(response.id, 3);
        assert!(!response.ok);
        assert!(response
            .error
            .unwrap()
            .contains("unknown UI sidecar method"));
    }

    #[test]
    fn ui_key_requires_keys() {
        let err = powershell_ui_key(
            UiAutomationEngine::PowershellProcess,
            &UiKeyParams {
                keys: String::new(),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(err.to_string().contains("keys is required"));
    }

    #[test]
    fn typed_params_default_optional_fields() {
        let params: UiFindParams = parse_params("ui.find", &json!({ "selector": "Save" })).unwrap();
        assert_eq!(params.selector, "Save");
        assert_eq!(params.window_title, "");
        assert_eq!(params.timeout_ms, None);

        let params: UiKeyParams =
            parse_params("ui.key", &json!({ "keys": "{ENTER}", "repeat": 3 })).unwrap();
        assert_eq!(params.keys, "{ENTER}");
        assert_eq!(params.repeat, Some(3));
    }

    #[test]
    fn typed_params_reject_wrong_field_types() {
        let err = parse_params::<UiKeyParams>("ui.key", &json!({ "keys": 9 })).unwrap_err();
        assert!(err
            .to_string()
            .contains("invalid parameters for UI sidecar method 'ui.key'"));
    }

    #[test]
    fn typed_responses_default_optional_fields() {
        let result: UiActionResult = parse_response("ui.click", json!({})).unwrap();
        assert!(result.success);
        assert_eq!(result.error, "");

        let result: UiFindResult = parse_response(
            "ui.find",
            json!({
                "elements": [{
                    "name": "Save",
                    "automation_id": "save-button",
                    "control_type": "ControlType.Button",
                    "x": 10,
                    "y": 20,
                    "width": 100,
                    "height": 30
                }]
            }),
        )
        .unwrap();
        assert_eq!(result.elements.len(), 1);
        assert_eq!(result.elements[0].name, "Save");
        assert_eq!(result.elements[0].value, "");
    }

    #[test]
    fn powershell_backend_reports_selected_engine_name() {
        let backend = UiAutomationEngine::PowershellHelper.backend();
        assert_eq!(backend.engine_name(), POWERSHELL_HELPER_ENGINE);

        let health = backend.health();
        assert_eq!(health.engine, POWERSHELL_HELPER_ENGINE);
        assert_eq!(health.pid, std::process::id());
    }

    #[test]
    fn native_engine_is_selectable_and_reports_not_implemented_actions() {
        assert_eq!(
            UiAutomationEngine::from_env(Some("native")),
            UiAutomationEngine::Native
        );
        assert_eq!(
            UiAutomationEngine::from_env(Some("uia")),
            UiAutomationEngine::Native
        );
        assert_eq!(engine_name_for_env(Some("windows-uia")), NATIVE_ENGINE);

        let health = NativeUiBackend.health();
        assert_eq!(health.engine, NATIVE_ENGINE);

        let err = UiAutomationEngine::Native
            .execute("ui.find", &json!({ "selector": "Save" }))
            .unwrap_err();
        assert!(err
            .to_string()
            .contains("native UI Automation backend is not implemented yet"));
    }

    #[test]
    fn selected_engine_dispatches_known_methods_and_rejects_unknown_methods() {
        let health = UiAutomationEngine::PowershellProcess
            .execute("ui.health", &Value::Null)
            .unwrap();
        assert_eq!(
            health.get("engine").and_then(Value::as_str),
            Some(POWERSHELL_PROCESS_ENGINE)
        );
        let err = UiAutomationEngine::PowershellProcess
            .execute("ui.nope", &Value::Null)
            .unwrap_err();
        assert!(err.to_string().contains("unknown UI sidecar method"));
    }

    #[test]
    fn engine_selection_defaults_to_process_and_accepts_helper_aliases() {
        assert_eq!(
            UiAutomationEngine::from_env(None),
            UiAutomationEngine::PowershellProcess
        );
        assert_eq!(
            UiAutomationEngine::from_env(Some("helper")),
            UiAutomationEngine::PowershellHelper
        );
        assert_eq!(engine_name_for_env(None), POWERSHELL_PROCESS_ENGINE);
        assert_eq!(engine_name_for_env(Some("")), POWERSHELL_PROCESS_ENGINE);
        assert_eq!(
            engine_name_for_env(Some("powershell-helper")),
            POWERSHELL_HELPER_ENGINE
        );
        assert_eq!(
            engine_name_for_env(Some("helper")),
            POWERSHELL_HELPER_ENGINE
        );
        assert_eq!(
            engine_name_for_env(Some("unknown")),
            POWERSHELL_PROCESS_ENGINE
        );
    }

    #[test]
    fn control_type_selectors_accept_short_and_programmatic_names() {
        let script = common_uia_script("[controlType='Button']", "", 2_000);
        assert!(script.contains("\"ControlType.$v\""));
        assert!(script.contains("ProgrammaticName -eq $controlType"));
    }

    #[test]
    fn helper_loop_decodes_json_string_results() {
        assert!(powershell_helper_loop().contains("$result = $result | ConvertFrom-Json"));
    }

    #[test]
    fn health_reports_engine_and_process() {
        START_TIME.get_or_init(std::time::Instant::now);
        let value = sidecar_health();
        assert_eq!(
            value.get("engine").and_then(Value::as_str),
            Some(POWERSHELL_PROCESS_ENGINE)
        );
        assert_eq!(
            value.get("pid").and_then(Value::as_u64),
            Some(std::process::id() as u64)
        );
        assert!(value.get("uptime_ms").and_then(Value::as_u64).is_some());
    }
}
