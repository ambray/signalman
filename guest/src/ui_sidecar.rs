//! Interactive user-session UI sidecar.
//!
//! The main guest agent commonly runs as a Windows service, which means it
//! cannot reliably interact with the logged-in user's desktop. This sidecar is
//! intended to be launched inside that user's session. The service-facing guest
//! agent proxies UI RPCs to it over loopback.

use std::io::{BufRead, BufReader, Write};
use std::net::SocketAddr;
#[cfg(target_os = "windows")]
use std::process::Command;

use anyhow::{anyhow, Context};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::net::TcpListener;
use tokio::task;
use tracing::{info, warn};

const DEFAULT_CONNECT_ADDR: &str = "127.0.0.1:50151";

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

pub async fn run(addr: SocketAddr) -> anyhow::Result<()> {
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
    let result = match req.method.as_str() {
        "ui.find" => ps_ui_find(&req.params),
        "ui.click" => ps_ui_click(&req.params),
        "ui.type" => ps_ui_type(&req.params),
        "ui.screenshot" => ps_ui_screenshot(&req.params),
        other => Err(anyhow!("unknown UI sidecar method '{other}'")),
    };
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

#[cfg(not(target_os = "windows"))]
fn run_powershell_json(_script: &str) -> anyhow::Result<Value> {
    Err(anyhow!(
        "UI sidecar automation is only supported on Windows"
    ))
}

#[cfg(target_os = "windows")]
fn run_powershell_json(script: &str) -> anyhow::Result<Value> {
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

fn ps_string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .replace('\'', "''")
}

fn ps_bool(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
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
      'controlType' {{ return $e.Current.ControlType.ProgrammaticName -eq $v }}
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

fn ps_ui_find(params: &Value) -> anyhow::Result<Value> {
    let selector = ps_string(params, "selector");
    let window_title = ps_string(params, "window_title");
    let timeout_ms = params
        .get("timeout_ms")
        .and_then(Value::as_u64)
        .unwrap_or(2_000);
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
    run_powershell_json(&script)
}

fn ps_ui_click(params: &Value) -> anyhow::Result<Value> {
    let selector = ps_string(params, "selector");
    let window_title = ps_string(params, "window_title");
    let click_type = ps_string(params, "click_type");
    let (down, up) = if click_type == "right" {
        ("0x0008", "0x0010")
    } else {
        ("0x0002", "0x0004")
    };
    let count = if click_type == "double" { 2 } else { 1 };
    let script = format!(
        r#"{}
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class SignalmanMouse {{
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}}
"@
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
    run_powershell_json(&script)
}

fn ps_ui_type(params: &Value) -> anyhow::Result<Value> {
    let selector = ps_string(params, "selector");
    let window_title = ps_string(params, "window_title");
    let text = ps_string(params, "text");
    let clear_first = if ps_bool(params, "clear_first") {
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
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class SignalmanTextFocus {{
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}}
"@
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
    run_powershell_json(&script)
}

fn ps_ui_screenshot(params: &Value) -> anyhow::Result<Value> {
    let format = ps_string(params, "format");
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
    run_powershell_json(&script)
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
}
