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

impl UiAutomationBackend for NativeUiBackend {
    fn engine_name(&self) -> &'static str {
        NATIVE_ENGINE
    }

    fn find(&self, params: &UiFindParams) -> anyhow::Result<UiFindResult> {
        native_ui_find(params)
    }

    fn click(&self, params: &UiClickParams) -> anyhow::Result<UiActionResult> {
        native_ui_click(params)
    }

    fn type_text(&self, params: &UiTypeParams) -> anyhow::Result<UiActionResult> {
        native_ui_type(params)
    }

    fn key(&self, params: &UiKeyParams) -> anyhow::Result<UiActionResult> {
        native_ui_key(params)
    }

    fn screenshot(&self, params: &UiScreenshotParams) -> anyhow::Result<UiScreenshotResult> {
        native_ui_screenshot(params)
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

fn normalize_screenshot_format(value: &str) -> (&'static str, image::ImageFormat) {
    if value.eq_ignore_ascii_case("jpeg") || value.eq_ignore_ascii_case("jpg") {
        ("jpeg", image::ImageFormat::Jpeg)
    } else {
        ("png", image::ImageFormat::Png)
    }
}

fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0];
        let b1 = *chunk.get(1).unwrap_or(&0);
        let b2 = *chunk.get(2).unwrap_or(&0);
        out.push(TABLE[(b0 >> 2) as usize] as char);
        out.push(TABLE[(((b0 & 0b0000_0011) << 4) | (b1 >> 4)) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[(((b1 & 0b0000_1111) << 2) | (b2 >> 6)) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TABLE[(b2 & 0b0011_1111) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

#[cfg(not(target_os = "windows"))]
fn native_ui_screenshot(_params: &UiScreenshotParams) -> anyhow::Result<UiScreenshotResult> {
    Err(anyhow!(
        "native UI Automation screenshot is only supported on Windows"
    ))
}

#[cfg(not(target_os = "windows"))]
fn native_ui_find(_params: &UiFindParams) -> anyhow::Result<UiFindResult> {
    Err(anyhow!(
        "native UI Automation find is only supported on Windows"
    ))
}

#[cfg(not(target_os = "windows"))]
fn native_ui_click(_params: &UiClickParams) -> anyhow::Result<UiActionResult> {
    Err(anyhow!(
        "native UI Automation click is only supported on Windows"
    ))
}

#[cfg(not(target_os = "windows"))]
fn native_ui_type(_params: &UiTypeParams) -> anyhow::Result<UiActionResult> {
    Err(anyhow!(
        "native UI Automation type is only supported on Windows"
    ))
}

#[cfg(not(target_os = "windows"))]
fn native_ui_key(_params: &UiKeyParams) -> anyhow::Result<UiActionResult> {
    Err(anyhow!(
        "native UI Automation key is only supported on Windows"
    ))
}

#[cfg(target_os = "windows")]
fn native_ui_screenshot(params: &UiScreenshotParams) -> anyhow::Result<UiScreenshotResult> {
    use image::{DynamicImage, ImageBuffer, Rgba};
    use std::io::Cursor;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, GetDC, GetDIBits, GetDeviceCaps,
        SelectObject, BITMAPINFO, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, HORZRES, SRCCOPY, VERTRES,
    };

    let _window_title = &params.window_title;
    let (format_name, image_format) = normalize_screenshot_format(&params.format);
    unsafe {
        let hwnd = HWND::default();
        let screen_dc = GetDC(hwnd);
        if screen_dc.is_invalid() {
            return Err(anyhow!("native UI screenshot failed to acquire screen DC"));
        }
        let _screen_dc = ScreenDcGuard {
            hwnd,
            hdc: screen_dc,
        };

        let width = GetDeviceCaps(screen_dc, HORZRES);
        let height = GetDeviceCaps(screen_dc, VERTRES);
        if width <= 0 || height <= 0 {
            return Err(anyhow!(
                "native UI screenshot saw invalid desktop size {width}x{height}"
            ));
        }

        let memory_dc = CreateCompatibleDC(screen_dc);
        if memory_dc.is_invalid() {
            return Err(anyhow!("native UI screenshot failed to create memory DC"));
        }
        let memory_dc = MemoryDcGuard { hdc: memory_dc };

        let bitmap = CreateCompatibleBitmap(screen_dc, width, height);
        if bitmap.is_invalid() {
            return Err(anyhow!("native UI screenshot failed to create bitmap"));
        }
        let bitmap = BitmapGuard { bitmap };

        let previous = SelectObject(memory_dc.hdc, bitmap.bitmap);
        if previous.is_invalid() {
            return Err(anyhow!("native UI screenshot failed to select bitmap"));
        }
        let selected = SelectedObjectGuard {
            hdc: memory_dc.hdc,
            previous,
        };

        BitBlt(
            memory_dc.hdc,
            0,
            0,
            width,
            height,
            screen_dc,
            0,
            0,
            SRCCOPY | CAPTUREBLT,
        )
        .context("native UI screenshot BitBlt failed")?;

        let mut bitmap_info = BITMAPINFO::default();
        bitmap_info.bmiHeader.biSize = std::mem::size_of_val(&bitmap_info.bmiHeader) as u32;
        bitmap_info.bmiHeader.biWidth = width;
        bitmap_info.bmiHeader.biHeight = -height;
        bitmap_info.bmiHeader.biPlanes = 1;
        bitmap_info.bmiHeader.biBitCount = 32;
        bitmap_info.bmiHeader.biCompression = BI_RGB.0;

        let byte_len = (width as usize)
            .checked_mul(height as usize)
            .and_then(|px| px.checked_mul(4))
            .ok_or_else(|| anyhow!("native UI screenshot dimensions overflow buffer size"))?;
        let mut bgra = vec![0u8; byte_len];
        let rows = GetDIBits(
            memory_dc.hdc,
            bitmap.bitmap,
            0,
            height as u32,
            Some(bgra.as_mut_ptr().cast()),
            &mut bitmap_info,
            DIB_RGB_COLORS,
        );
        if rows == 0 {
            return Err(anyhow!("native UI screenshot failed to read bitmap pixels"));
        }

        drop(selected);

        for px in bgra.chunks_exact_mut(4) {
            px.swap(0, 2);
        }
        let image = ImageBuffer::<Rgba<u8>, _>::from_raw(width as u32, height as u32, bgra)
            .ok_or_else(|| anyhow!("native UI screenshot produced invalid pixel buffer"))?;
        let mut encoded = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(image)
            .write_to(&mut encoded, image_format)
            .context("encode native UI screenshot")?;

        Ok(UiScreenshotResult {
            image_data_base64: encode_base64(&encoded.into_inner()),
            format: format_name.to_string(),
            width: width as u32,
            height: height as u32,
        })
    }
}

#[cfg(target_os = "windows")]
fn native_ui_find(params: &UiFindParams) -> anyhow::Result<UiFindResult> {
    use windows::core::{BSTR, VARIANT};
    use windows::Win32::Foundation::{BOOL, RECT, RPC_E_CHANGED_MODE};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomationCondition, IUIAutomationElement,
        TreeScope_Children, TreeScope_Descendants, UIA_AutomationIdPropertyId,
        UIA_ButtonControlTypeId, UIA_CheckBoxControlTypeId, UIA_ClassNamePropertyId,
        UIA_ComboBoxControlTypeId, UIA_ControlTypePropertyId, UIA_CustomControlTypeId,
        UIA_DocumentControlTypeId, UIA_EditControlTypeId, UIA_GroupControlTypeId,
        UIA_HyperlinkControlTypeId, UIA_ImageControlTypeId, UIA_ListControlTypeId,
        UIA_ListItemControlTypeId, UIA_MenuControlTypeId, UIA_MenuItemControlTypeId,
        UIA_NamePropertyId, UIA_PaneControlTypeId, UIA_RadioButtonControlTypeId,
        UIA_TabControlTypeId, UIA_TabItemControlTypeId, UIA_TextControlTypeId,
        UIA_TreeControlTypeId, UIA_TreeItemControlTypeId, UIA_WindowControlTypeId,
    };

    struct ComGuard {
        should_uninitialize: bool,
    }

    impl Drop for ComGuard {
        fn drop(&mut self) {
            if self.should_uninitialize {
                unsafe { CoUninitialize() };
            }
        }
    }

    fn native_uia_root(
        automation: &IUIAutomation,
        window_title: &str,
    ) -> anyhow::Result<IUIAutomationElement> {
        let root =
            unsafe { automation.GetRootElement() }.context("native UI Automation root element")?;
        if window_title.trim().is_empty() {
            return Ok(root);
        }
        let title = VARIANT::from(BSTR::from(window_title));
        let condition = unsafe { automation.CreatePropertyCondition(UIA_NamePropertyId, &title) }
            .context("native UI Automation window-title condition")?;
        match unsafe { root.FindFirst(TreeScope_Children, &condition) } {
            Ok(window) => Ok(window),
            Err(_) => Ok(root),
        }
    }

    fn native_uia_condition(
        automation: &IUIAutomation,
        selector: &NativeSelector,
    ) -> anyhow::Result<IUIAutomationCondition> {
        if let NativeSelector::Property { key, value } = selector {
            let condition = match key.as_str() {
                "name" => {
                    let variant = VARIANT::from(BSTR::from(value.as_str()));
                    unsafe { automation.CreatePropertyCondition(UIA_NamePropertyId, &variant) }
                }
                "automationId" => {
                    let variant = VARIANT::from(BSTR::from(value.as_str()));
                    unsafe {
                        automation.CreatePropertyCondition(UIA_AutomationIdPropertyId, &variant)
                    }
                }
                "className" => {
                    let variant = VARIANT::from(BSTR::from(value.as_str()));
                    unsafe { automation.CreatePropertyCondition(UIA_ClassNamePropertyId, &variant) }
                }
                "controlType" => native_control_type_id(value).map_or_else(
                    || unsafe { automation.CreateTrueCondition() },
                    |control_type| {
                        let variant = VARIANT::from(control_type.0);
                        unsafe {
                            automation.CreatePropertyCondition(UIA_ControlTypePropertyId, &variant)
                        }
                    },
                ),
                _ => unsafe { automation.CreateTrueCondition() },
            };
            return condition.context("native UI Automation selector condition");
        }
        unsafe { automation.CreateTrueCondition() }.context("native UI Automation true condition")
    }

    fn native_uia_element_result(element: &IUIAutomationElement) -> UiElementResult {
        let name = unsafe { element.CurrentName() }
            .map(bstr_to_string)
            .unwrap_or_default();
        let automation_id = unsafe { element.CurrentAutomationId() }
            .map(bstr_to_string)
            .unwrap_or_default();
        let class_name = unsafe { element.CurrentClassName() }
            .map(bstr_to_string)
            .unwrap_or_default();
        let control_type = unsafe { element.CurrentControlType() }
            .map(native_control_type_name)
            .unwrap_or_else(|_| String::new());
        let rect = unsafe { element.CurrentBoundingRectangle() }.unwrap_or_default();
        let is_enabled = unsafe { element.CurrentIsEnabled() }
            .map(bool_from_win32)
            .unwrap_or(false);
        let is_offscreen = unsafe { element.CurrentIsOffscreen() }
            .map(bool_from_win32)
            .unwrap_or(true);
        let (x, y, width, height) = rect_to_bounds(rect);
        UiElementResult {
            name,
            automation_id,
            control_type,
            class_name,
            is_enabled,
            is_visible: !is_offscreen && width > 0 && height > 0,
            x,
            y,
            width,
            height,
            value: String::new(),
        }
    }

    fn bstr_to_string(value: BSTR) -> String {
        value.to_string()
    }

    fn bool_from_win32(value: BOOL) -> bool {
        value.as_bool()
    }

    fn rect_to_bounds(rect: RECT) -> (i32, i32, i32, i32) {
        let width = rect.right.saturating_sub(rect.left).max(0);
        let height = rect.bottom.saturating_sub(rect.top).max(0);
        (rect.left, rect.top, width, height)
    }

    fn native_control_type_id(
        value: &str,
    ) -> Option<windows::Win32::UI::Accessibility::UIA_CONTROLTYPE_ID> {
        let normalized = value
            .trim()
            .trim_start_matches("ControlType.")
            .to_ascii_lowercase();
        Some(match normalized.as_str() {
            "button" => UIA_ButtonControlTypeId,
            "checkbox" => UIA_CheckBoxControlTypeId,
            "combobox" => UIA_ComboBoxControlTypeId,
            "custom" => UIA_CustomControlTypeId,
            "document" => UIA_DocumentControlTypeId,
            "edit" => UIA_EditControlTypeId,
            "group" => UIA_GroupControlTypeId,
            "hyperlink" => UIA_HyperlinkControlTypeId,
            "image" => UIA_ImageControlTypeId,
            "list" => UIA_ListControlTypeId,
            "listitem" => UIA_ListItemControlTypeId,
            "menu" => UIA_MenuControlTypeId,
            "menuitem" => UIA_MenuItemControlTypeId,
            "pane" => UIA_PaneControlTypeId,
            "radiobutton" => UIA_RadioButtonControlTypeId,
            "tab" => UIA_TabControlTypeId,
            "tabitem" => UIA_TabItemControlTypeId,
            "text" => UIA_TextControlTypeId,
            "tree" => UIA_TreeControlTypeId,
            "treeitem" => UIA_TreeItemControlTypeId,
            "window" => UIA_WindowControlTypeId,
            _ => return None,
        })
    }

    fn native_control_type_name(
        value: windows::Win32::UI::Accessibility::UIA_CONTROLTYPE_ID,
    ) -> String {
        let name = match value.0 {
            id if id == UIA_ButtonControlTypeId.0 => "Button",
            id if id == UIA_CheckBoxControlTypeId.0 => "CheckBox",
            id if id == UIA_ComboBoxControlTypeId.0 => "ComboBox",
            id if id == UIA_CustomControlTypeId.0 => "Custom",
            id if id == UIA_DocumentControlTypeId.0 => "Document",
            id if id == UIA_EditControlTypeId.0 => "Edit",
            id if id == UIA_GroupControlTypeId.0 => "Group",
            id if id == UIA_HyperlinkControlTypeId.0 => "Hyperlink",
            id if id == UIA_ImageControlTypeId.0 => "Image",
            id if id == UIA_ListControlTypeId.0 => "List",
            id if id == UIA_ListItemControlTypeId.0 => "ListItem",
            id if id == UIA_MenuControlTypeId.0 => "Menu",
            id if id == UIA_MenuItemControlTypeId.0 => "MenuItem",
            id if id == UIA_PaneControlTypeId.0 => "Pane",
            id if id == UIA_RadioButtonControlTypeId.0 => "RadioButton",
            id if id == UIA_TabControlTypeId.0 => "Tab",
            id if id == UIA_TabItemControlTypeId.0 => "TabItem",
            id if id == UIA_TextControlTypeId.0 => "Text",
            id if id == UIA_TreeControlTypeId.0 => "Tree",
            id if id == UIA_TreeItemControlTypeId.0 => "TreeItem",
            id if id == UIA_WindowControlTypeId.0 => "Window",
            _ => return format!("ControlType.{}", value.0),
        };
        format!("ControlType.{name}")
    }

    let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    let _com = if hr.is_ok() {
        ComGuard {
            should_uninitialize: true,
        }
    } else if hr == RPC_E_CHANGED_MODE {
        ComGuard {
            should_uninitialize: false,
        }
    } else {
        return Err(windows::core::Error::from(hr))
            .context("initialize COM for native UI Automation");
    };

    let selector = NativeSelector::parse(&params.selector);
    let automation: IUIAutomation =
        unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }
            .context("create native UI Automation client")?;
    let root = native_uia_root(&automation, &params.window_title)?;
    let condition = native_uia_condition(&automation, &selector)?;
    let elements = unsafe { root.FindAll(TreeScope_Descendants, &condition) }
        .context("native UI Automation FindAll")?;
    let count = unsafe { elements.Length() }.context("native UI Automation element count")?;
    let mut results = Vec::new();
    for index in 0..count {
        let element = unsafe { elements.GetElement(index) }
            .with_context(|| format!("native UI Automation element at index {index}"))?;
        let element_result = native_uia_element_result(&element);
        if selector.matches(&element_result) {
            results.push(element_result);
        }
    }
    Ok(UiFindResult { elements: results })
}

#[cfg(target_os = "windows")]
fn native_ui_click(params: &UiClickParams) -> anyhow::Result<UiActionResult> {
    let element = native_first_element(&params.selector, &params.window_title)?;
    let x = element.x + element.width / 2;
    let y = element.y + element.height / 2;
    native_click_at(x, y, &params.click_type)?;
    Ok(UiActionResult {
        success: true,
        error: String::new(),
    })
}

#[cfg(target_os = "windows")]
fn native_ui_type(params: &UiTypeParams) -> anyhow::Result<UiActionResult> {
    if !params.selector.trim().is_empty() {
        let element = native_first_element(&params.selector, &params.window_title)?;
        native_click_at(
            element.x + element.width / 2,
            element.y + element.height / 2,
            "left",
        )?;
    }
    if params.clear_first {
        native_send_key_sequence("^a", 1)?;
    }
    native_send_unicode_text(&params.text)?;
    Ok(UiActionResult {
        success: true,
        error: String::new(),
    })
}

#[cfg(target_os = "windows")]
fn native_ui_key(params: &UiKeyParams) -> anyhow::Result<UiActionResult> {
    if params.keys.trim().is_empty() {
        return Err(anyhow!("keys is required"));
    }
    if !params.selector.trim().is_empty() {
        let element = native_first_element(&params.selector, &params.window_title)?;
        native_click_at(
            element.x + element.width / 2,
            element.y + element.height / 2,
            "left",
        )?;
    }
    native_send_key_sequence(&params.keys, params.repeat.unwrap_or(1).clamp(1, 100))?;
    Ok(UiActionResult {
        success: true,
        error: String::new(),
    })
}

#[cfg(target_os = "windows")]
fn native_first_element(selector: &str, window_title: &str) -> anyhow::Result<UiElementResult> {
    let result = native_ui_find(&UiFindParams {
        selector: selector.to_string(),
        window_title: window_title.to_string(),
        timeout_ms: Some(5_000),
    })?;
    result
        .elements
        .into_iter()
        .find(|element| element.is_visible && element.width > 0 && element.height > 0)
        .ok_or_else(|| anyhow!("element not found: {selector}"))
}

#[cfg(target_os = "windows")]
fn native_click_at(x: i32, y: i32, click_type: &str) -> anyhow::Result<()> {
    use std::mem::size_of;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
        MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEINPUT,
    };
    use windows::Win32::UI::WindowsAndMessaging::SetCursorPos;

    unsafe { SetCursorPos(x, y) }.context("native UI click SetCursorPos failed")?;
    let (down, up, count) = match click_type.trim().to_ascii_lowercase().as_str() {
        "right" => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, 1),
        "double" => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, 2),
        _ => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, 1),
    };
    for _ in 0..count {
        let inputs = [
            INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 {
                    mi: MOUSEINPUT {
                        dwFlags: down,
                        ..Default::default()
                    },
                },
            },
            INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 {
                    mi: MOUSEINPUT {
                        dwFlags: up,
                        ..Default::default()
                    },
                },
            },
        ];
        let sent = unsafe { SendInput(&inputs, size_of::<INPUT>() as i32) };
        if sent != inputs.len() as u32 {
            return Err(anyhow!("native UI click SendInput sent {sent} events"));
        }
        std::thread::sleep(std::time::Duration::from_millis(80));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn native_send_unicode_text(text: &str) -> anyhow::Result<()> {
    for unit in text.encode_utf16() {
        native_send_unicode_unit(unit)?;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn native_send_unicode_unit(unit: u16) -> anyhow::Result<()> {
    use std::mem::size_of;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE,
        VIRTUAL_KEY,
    };

    let inputs = [
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(0),
                    wScan: unit,
                    dwFlags: KEYEVENTF_UNICODE,
                    ..Default::default()
                },
            },
        },
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(0),
                    wScan: unit,
                    dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
                    ..Default::default()
                },
            },
        },
    ];
    let sent = unsafe { SendInput(&inputs, size_of::<INPUT>() as i32) };
    if sent != inputs.len() as u32 {
        return Err(anyhow!("native UI type SendInput sent {sent} events"));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn native_send_key_sequence(keys: &str, repeat: u64) -> anyhow::Result<()> {
    for _ in 0..repeat {
        for (key, ctrl) in parse_native_key_sequence(keys)? {
            native_send_virtual_key(key, ctrl)?;
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn native_send_virtual_key(vk: u16, ctrl: bool) -> anyhow::Result<()> {
    use std::mem::size_of;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VIRTUAL_KEY,
        VK_CONTROL,
    };

    let mut inputs = Vec::new();
    if ctrl {
        inputs.push(keyboard_input(VK_CONTROL, Default::default()));
    }
    inputs.push(keyboard_input(VIRTUAL_KEY(vk), Default::default()));
    inputs.push(keyboard_input(VIRTUAL_KEY(vk), KEYEVENTF_KEYUP));
    if ctrl {
        inputs.push(keyboard_input(VK_CONTROL, KEYEVENTF_KEYUP));
    }
    let sent = unsafe { SendInput(&inputs, size_of::<INPUT>() as i32) };
    if sent != inputs.len() as u32 {
        return Err(anyhow!("native UI key SendInput sent {sent} events"));
    }

    fn keyboard_input(
        vk: VIRTUAL_KEY,
        flags: windows::Win32::UI::Input::KeyboardAndMouse::KEYBD_EVENT_FLAGS,
    ) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    dwFlags: flags,
                    ..Default::default()
                },
            },
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn parse_native_key_sequence(keys: &str) -> anyhow::Result<Vec<(u16, bool)>> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{VK_BACK, VK_ESCAPE, VK_RETURN, VK_TAB};

    let trimmed = keys.trim();
    if trimmed.eq_ignore_ascii_case("{ESC}") || trimmed.eq_ignore_ascii_case("{ESCAPE}") {
        return Ok(vec![(VK_ESCAPE.0, false)]);
    }
    if trimmed.eq_ignore_ascii_case("{ENTER}") || trimmed.eq_ignore_ascii_case("~") {
        return Ok(vec![(VK_RETURN.0, false)]);
    }
    if trimmed.eq_ignore_ascii_case("{TAB}") {
        return Ok(vec![(VK_TAB.0, false)]);
    }
    if trimmed.eq_ignore_ascii_case("{BACKSPACE}") || trimmed.eq_ignore_ascii_case("{BS}") {
        return Ok(vec![(VK_BACK.0, false)]);
    }
    if let Some(chord) = trimmed.strip_prefix('^') {
        let mut chars = chord.chars();
        let Some(ch) = chars.next() else {
            return Err(anyhow!("unsupported native key sequence: {keys}"));
        };
        if chars.next().is_some() || !ch.is_ascii_alphabetic() {
            return Err(anyhow!("unsupported native key sequence: {keys}"));
        }
        return Ok(vec![(ch.to_ascii_uppercase() as u16, true)]);
    }
    if trimmed.chars().count() == 1 {
        return Ok(vec![(
            trimmed.chars().next().unwrap().to_ascii_uppercase() as u16,
            false,
        )]);
    }
    Err(anyhow!("unsupported native key sequence: {keys}"))
}

#[cfg(target_os = "windows")]
struct ScreenDcGuard {
    hwnd: windows::Win32::Foundation::HWND,
    hdc: windows::Win32::Graphics::Gdi::HDC,
}

#[cfg(target_os = "windows")]
impl Drop for ScreenDcGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Graphics::Gdi::ReleaseDC(self.hwnd, self.hdc);
        }
    }
}

#[cfg(target_os = "windows")]
struct MemoryDcGuard {
    hdc: windows::Win32::Graphics::Gdi::HDC,
}

#[cfg(target_os = "windows")]
impl Drop for MemoryDcGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Graphics::Gdi::DeleteDC(self.hdc);
        }
    }
}

#[cfg(target_os = "windows")]
struct BitmapGuard {
    bitmap: windows::Win32::Graphics::Gdi::HBITMAP,
}

#[cfg(target_os = "windows")]
impl Drop for BitmapGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Graphics::Gdi::DeleteObject(self.bitmap);
        }
    }
}

#[cfg(target_os = "windows")]
struct SelectedObjectGuard {
    hdc: windows::Win32::Graphics::Gdi::HDC,
    previous: windows::Win32::Graphics::Gdi::HGDIOBJ,
}

#[cfg(target_os = "windows")]
impl Drop for SelectedObjectGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Graphics::Gdi::SelectObject(self.hdc, self.previous);
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum NativeSelector {
    Any,
    Property { key: String, value: String },
    Text(String),
}

impl NativeSelector {
    fn parse(selector: &str) -> Self {
        let trimmed = selector.trim();
        if trimmed.is_empty() {
            return Self::Any;
        }
        if let Some(inner) = trimmed.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
            if let Some((key, quoted)) = inner.split_once('=') {
                if matches!(key, "name" | "automationId" | "className" | "controlType")
                    && quoted.starts_with('\'')
                    && quoted.ends_with('\'')
                    && quoted.len() >= 2
                {
                    return Self::Property {
                        key: key.to_string(),
                        value: quoted[1..quoted.len() - 1].to_string(),
                    };
                }
            }
        }
        Self::Text(trimmed.to_string())
    }

    fn matches(&self, element: &UiElementResult) -> bool {
        match self {
            Self::Any => true,
            Self::Property { key, value } => match key.as_str() {
                "name" => element.name == *value,
                "automationId" => element.automation_id == *value,
                "className" => element.class_name == *value,
                "controlType" => {
                    let normalized = value.trim().trim_start_matches("ControlType.");
                    element.control_type == format!("ControlType.{normalized}")
                }
                _ => false,
            },
            Self::Text(value) => element.name.contains(value) || element.automation_id == *value,
        }
    }
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
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom
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
function Convert-SignalmanInt {{
  param($Value)
  try {{
    $d = [double]$Value
    if ([double]::IsNaN($d) -or [double]::IsInfinity($d)) {{ return 0 }}
    if ($d -gt [int]::MaxValue) {{ return [int]::MaxValue }}
    if ($d -lt [int]::MinValue) {{ return [int]::MinValue }}
    return [int][Math]::Round($d)
  }} catch {{
    return 0
  }}
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
    $x = Convert-SignalmanInt $r.X
    $y = Convert-SignalmanInt $r.Y
    $width = Convert-SignalmanInt $r.Width
    $height = Convert-SignalmanInt $r.Height
    $items += [pscustomobject]@{{
      name = [string]$e.Current.Name
      automation_id = [string]$e.Current.AutomationId
      control_type = [string]$e.Current.ControlType.ProgrammaticName
      class_name = [string]$e.Current.ClassName
      is_enabled = [bool]$e.Current.IsEnabled
      is_visible = (-not $r.IsEmpty) -and ($width -gt 0) -and ($height -gt 0)
      x = $x
      y = $y
      width = $width
      height = $height
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
    fn native_engine_is_selectable() {
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
    }

    #[test]
    fn native_selector_matches_supported_selector_shapes() {
        let element = UiElementResult {
            name: "Start".to_string(),
            automation_id: "StartButton".to_string(),
            control_type: "ControlType.Button".to_string(),
            class_name: "ToggleButton".to_string(),
            is_enabled: true,
            is_visible: true,
            x: 0,
            y: 0,
            width: 48,
            height: 48,
            value: String::new(),
        };

        assert!(NativeSelector::parse("").matches(&element));
        assert!(NativeSelector::parse("[name='Start']").matches(&element));
        assert!(NativeSelector::parse("[automationId='StartButton']").matches(&element));
        assert!(NativeSelector::parse("[className='ToggleButton']").matches(&element));
        assert!(NativeSelector::parse("[controlType='Button']").matches(&element));
        assert!(NativeSelector::parse("[controlType='ControlType.Button']").matches(&element));
        assert!(NativeSelector::parse("Sta").matches(&element));
        assert!(!NativeSelector::parse("[name='Search']").matches(&element));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn native_key_parser_handles_smoke_sequences() {
        assert_eq!(
            parse_native_key_sequence("{ESC}").unwrap(),
            vec![(
                windows::Win32::UI::Input::KeyboardAndMouse::VK_ESCAPE.0,
                false
            )]
        );
        assert_eq!(
            parse_native_key_sequence("^a").unwrap(),
            vec![('A' as u16, true)]
        );
        assert!(parse_native_key_sequence("{NOPE}").is_err());
    }

    #[test]
    fn screenshot_format_normalizes_png_and_jpeg() {
        assert_eq!(normalize_screenshot_format("").0, "png");
        assert_eq!(normalize_screenshot_format("png").0, "png");
        assert_eq!(normalize_screenshot_format("jpeg").0, "jpeg");
        assert_eq!(normalize_screenshot_format("JPG").0, "jpeg");
    }

    #[test]
    fn base64_encoder_handles_padding() {
        assert_eq!(encode_base64(b""), "");
        assert_eq!(encode_base64(b"f"), "Zg==");
        assert_eq!(encode_base64(b"fo"), "Zm8=");
        assert_eq!(encode_base64(b"foo"), "Zm9v");
        assert_eq!(encode_base64(b"hello"), "aGVsbG8=");
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
        assert!(script.contains("[double]::IsInfinity($d)"));
    }

    #[test]
    fn helper_loop_decodes_json_string_results() {
        let script = powershell_helper_loop();
        assert!(script.contains("$result = $result | ConvertFrom-Json"));
        assert!(script.contains("[Console]::OutputEncoding = $utf8NoBom"));
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
