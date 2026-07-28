use std::{
  collections::{HashMap, HashSet},
  future::Future,
  pin::Pin,
  sync::{Arc, Mutex as StdMutex, OnceLock},
  time::{Duration, Instant},
};

use base64::prelude::BASE64_STANDARD;
use base64::Engine;
use btleplug::{
  api::{
    Central, CentralEvent, CentralState, CharPropFlags, Characteristic, Manager as _,
    Peripheral as _, PeripheralProperties, ScanFilter, Service, ValueNotification, WriteType,
  },
  platform::{Adapter, Manager as BtleManager, Peripheral},
};
use futures::{FutureExt, StreamExt};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tauri::{
  async_runtime::{self, JoinHandle, Mutex, RwLock},
  http::{header::CONTENT_TYPE, Response, StatusCode},
  plugin::{Builder as PluginBuilder, PluginApi},
  AppHandle, Emitter, Listener, Runtime, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tokio::{
  sync::oneshot,
  time::{sleep, timeout},
};
use uuid::Uuid;

use crate::{
  models::*,
  Error, Result,
};

const SCAN_POLL_INTERVAL: Duration = Duration::from_millis(300);
const SELECTION_EVENT_PREFIX: &str = "web-bluetooth://select-bluetooth-device/";
const SELECTION_UPDATE_EVENT_SUFFIX: &str = "devices";
const SELECTION_WINDOW_PREFIX: &str = "web-bluetooth-selector-";
const SELECTION_WINDOW_TITLE: &str = "Select Bluetooth Device";
const SELECTION_WINDOW_SCHEME: &str = "web-bluetooth-selector";
const SELECTION_WINDOW_HOST: &str = "dialog";
const SELECTION_RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);

static SELECTION_PAGE_STORE: OnceLock<Arc<StdMutex<HashMap<String, String>>>> = OnceLock::new();

type SelectionFuture = Pin<Box<dyn Future<Output = Result<Option<String>>> + Send>>;

pub trait DeviceSelectionHandler<R: Runtime>: Send + Sync + 'static {
  fn select(&self, ctx: DeviceSelectionContext<R>) -> SelectionFuture;
  fn wants_full_scan(&self) -> bool {
    false
  }
}

impl<R: Runtime, F, Fut> DeviceSelectionHandler<R> for F
where
  F: Fn(DeviceSelectionContext<R>) -> Fut + Send + Sync + 'static,
  Fut: Future<Output = Result<Option<String>>> + Send + 'static,
{
  fn select(&self, ctx: DeviceSelectionContext<R>) -> SelectionFuture {
    Box::pin((self)(ctx))
  }
}

pub struct SelectionHandler<R: Runtime> {
  inner: Arc<dyn DeviceSelectionHandler<R>>,
}

impl<R: Runtime> SelectionHandler<R> {
  pub fn new<H>(handler: H) -> Self
  where
    H: DeviceSelectionHandler<R>,
  {
    Self {
      inner: Arc::new(handler),
    }
  }

  pub fn select(&self, ctx: DeviceSelectionContext<R>) -> SelectionFuture {
    self.inner.select(ctx)
  }

  pub fn wants_full_scan(&self) -> bool {
    self.inner.wants_full_scan()
  }
}

impl<R: Runtime> Clone for SelectionHandler<R> {
  fn clone(&self) -> Self {
    Self {
      inner: self.inner.clone(),
    }
  }
}

impl<R: Runtime> Default for SelectionHandler<R> {
  fn default() -> Self {
    Self::new(FirstMatchSelectionHandler)
  }
}

#[derive(Clone)]
pub struct DeviceSelectionContext<R: Runtime> {
  pub app: AppHandle<R>,
  pub options: RequestDeviceOptions,
  pub devices: Vec<BluetoothDevice>,
  pub selection_event: String,
  pub update_event: String,
  pub window_label: String,
  pub initial_scanning: bool,
}

struct FirstMatchSelectionHandler;

impl<R: Runtime> DeviceSelectionHandler<R> for FirstMatchSelectionHandler {
  fn select(&self, ctx: DeviceSelectionContext<R>) -> SelectionFuture {
    Box::pin(async move { Ok(ctx.devices.first().map(|device| device.id.clone())) })
  }
}

pub struct NativeDialogSelectionHandler {
  response_timeout: Duration,
  full_scan_before_dialog: bool,
}

impl NativeDialogSelectionHandler {
  pub fn new() -> Self {
    Self {
      response_timeout: SELECTION_RESPONSE_TIMEOUT,
      full_scan_before_dialog: false,
    }
  }

  pub fn with_response_timeout(mut self, timeout: Duration) -> Self {
    self.response_timeout = timeout;
    self
  }

  pub fn require_full_scan_before_dialog(mut self, enabled: bool) -> Self {
    self.full_scan_before_dialog = enabled;
    self
  }
}

impl Default for NativeDialogSelectionHandler {
  fn default() -> Self {
    Self::new()
  }
}

impl<R: Runtime> DeviceSelectionHandler<R> for NativeDialogSelectionHandler {
  fn select(&self, ctx: DeviceSelectionContext<R>) -> SelectionFuture {
    let timeout_duration = self.response_timeout;
    Box::pin(async move {
      let event_name = ctx.selection_event.clone();
      let update_event = ctx.update_event.clone();
      let window_label = ctx.window_label.clone();
      let devices = ctx.devices.clone();
      let initial_scanning = ctx.initial_scanning;
      let app = ctx.app.clone();
      let (tx, rx) = oneshot::channel();
      let sender = Arc::new(StdMutex::new(Some(tx)));
      let sender_handle = sender.clone();

      let event_id = app.listen_any(event_name.clone(), move |event| {
        if let Ok(message) = serde_json::from_str::<SelectionEventPayload>(event.payload()) {
          if let Ok(mut guard) = sender_handle.lock() {
            if let Some(sender) = guard.take() {
              let _ = sender.send(message.device_id);
            }
          }
        }
      });

      let request_id = event_name
        .strip_prefix(SELECTION_EVENT_PREFIX)
        .unwrap_or(&event_name)
        .to_string();
      let page_url = match build_selection_window_url(&app, &request_id, &devices, &event_name, &update_event, initial_scanning) {
        Ok(url) => url,
        Err(err) => {
          app.unlisten(event_id);
          return Err(err);
        }
      };
      let window = match WebviewWindowBuilder::new(&app, window_label.clone(), page_url)
        .title(SELECTION_WINDOW_TITLE)
        .inner_size(420.0, 520.0)
        .decorations(false)
        .always_on_top(true)
        .resizable(false)
        .visible(true)
        .build()
      {
        Ok(window) => window,
        Err(err) => {
          app.unlisten(event_id);
          return Err(err.into());
        }
      };

      // Ensure closing the selector window is treated as an explicit cancel
      let selection_event_on_close = event_name.clone();
      let app_on_close = app.clone();
      window.on_window_event(move |event| {
        if let WindowEvent::Destroyed = event {
          let _ = app_on_close.emit(&selection_event_on_close, SelectionEventPayload { device_id: None });
        }
      });

      let selection = match timeout(timeout_duration, rx).await {
        Ok(Ok(value)) => value,
        _ => None,
      };

      app.unlisten(event_id);
      let _ = window.close();

      Ok(selection)
    })
  }

  fn wants_full_scan(&self) -> bool {
    self.full_scan_before_dialog
  }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SelectionEventPayload {
  device_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SelectionUpdatePayload {
  devices: Vec<BluetoothDevice>,
  completed: bool,
}

fn selection_page_store() -> &'static Arc<StdMutex<HashMap<String, String>>> {
  SELECTION_PAGE_STORE.get_or_init(|| Arc::new(StdMutex::new(HashMap::new())))
}

pub(crate) fn register_selection_scheme_protocol<R: Runtime, C: DeserializeOwned>(
  builder: PluginBuilder<R, C>,
) -> PluginBuilder<R, C> {
  let store = selection_page_store().clone();
  builder.register_uri_scheme_protocol(SELECTION_WINDOW_SCHEME, move |_ctx, request| {
    handle_selection_scheme_request(store.clone(), request)
  })
}

fn handle_selection_scheme_request(
  store: Arc<StdMutex<HashMap<String, String>>>,
  request: tauri::http::Request<Vec<u8>>,
) -> Response<Vec<u8>> {
  let path = request.uri().path().trim_start_matches('/');
  let mut segments = path.split('/');
  let page_id = segments.next().unwrap_or_default();
  let content = {
    store
      .lock()
      .ok()
      .and_then(|pages| pages.get(page_id).cloned())
  };
  let (status, body, mime) = if let Some(content) = content {
    (StatusCode::OK, content, "text/html; charset=utf-8")
  } else {
    (
      StatusCode::NOT_FOUND,
      format!("selector page '{page_id}' not found"),
      "text/plain; charset=utf-8",
    )
  };
  Response::builder()
    .status(status)
    .header(CONTENT_TYPE, mime)
    .body(body.into_bytes())
    .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn store_selection_page(request_id: &str, html: String) {
  if let Ok(mut pages) = selection_page_store().lock() {
    pages.insert(request_id.to_string(), html);
  }
}

fn build_selection_window_url<R: Runtime>(
  _app: &AppHandle<R>,
  request_id: &str,
  devices: &[BluetoothDevice],
  selection_event: &str,
  update_event: &str,
  initial_scanning: bool,
) -> Result<WebviewUrl> {
  let devices_json = serde_json::to_string(devices)?;
  let selection_event_json = serde_json::to_string(selection_event)?;
  let update_event_json = serde_json::to_string(update_event)?;
  let initial_scanning_flag = if initial_scanning { "true" } else { "false" };
  let html = format!(
    r#"<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>{title}</title>
    <style>
      :root {{
        font-family: 'Segoe UI', system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
        color: #101828;
        background-color: #f4f5f7;
      }}
      body {{
        margin: 0;
        min-height: 100vh;
      }}
      .container {{
        padding: 24px;
        display: flex;
        flex-direction: column;
        gap: 16px;
        min-height: 100vh;
        box-sizing: border-box;
      }}
      h1 {{
        font-size: 18px;
        margin: 0;
      }}
      p {{
        margin: 0;
        color: #475467;
      }}
      .status {{
        display: flex;
        flex-direction: column;
        gap: 8px;
      }}
      .scan-status {{
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 13px;
        color: #475467;
      }}
      .scan-status[aria-hidden="true"] {{
        display: none;
      }}
      .spinner-icon {{
        width: 14px;
        height: 14px;
        border-radius: 50%;
        border: 2px solid #d0d5dd;
        border-top-color: #0082f6;
        animation: spin 0.9s linear infinite;
      }}
      @keyframes spin {{
        to {{
          transform: rotate(360deg);
        }}
      }}
      .device-list {{
        display: flex;
        flex-direction: column;
        gap: 8px;
        min-height: 140px;
        max-height: calc(100vh - 220px);
        overflow: auto;
      }}
      .device {{
        border: 1px solid #d0d5dd;
        border-radius: 8px;
        padding: 12px;
        display: flex;
        flex-direction: column;
        gap: 4px;
        background-color: #fff;
        cursor: pointer;
        text-align: left;
      }}
      .device:hover {{
        border-color: #0082f6;
        box-shadow: 0 0 0 2px rgba(0,130,246,0.15);
      }}
      .device-name {{
        font-weight: 600;
      }}
      .device-meta {{
        font-size: 12px;
        color: #667085;
      }}
      .actions {{
        position: sticky;
        bottom: 0;
        background: linear-gradient(180deg, rgba(244,245,247,0) 0%, #f4f5f7 30%);
        padding-top: 8px;
        padding-bottom: 4px;
      }}
      #cancel-btn {{
        border: 1px solid #d0d5dd;
        border-radius: 8px;
        background: #fff;
        color: #0082f6;
        font-weight: 600;
        cursor: pointer;
        padding: 10px 12px;
        width: 100%;
        text-align: center;
      }}
      .empty {{
        padding: 16px;
        border: 1px dashed #d0d5dd;
        border-radius: 8px;
        text-align: center;
        color: #667085;
      }}
      .error-banner {{
        padding: 12px 14px;
        border-radius: 8px;
        border: 1px solid rgba(255, 99, 71, 0.4);
        background-color: rgba(255, 99, 71, 0.12);
        color: #b42318;
        font-size: 13px;
      }}
    </style>
  </head>
  <body>
    <div class="container">
      <div>
        <h1>{title}</h1>
        <p>Select a nearby Bluetooth device.</p>
      </div>
      <div id="tauri-error" class="error-banner" aria-live="polite" hidden>
        Connecting to Tauri bridge...
      </div>
      <div class="status">
        <div id="scan-status" class="scan-status" aria-hidden="true">
          <span class="spinner-icon" aria-hidden="true"></span>
          <span>Scanning for devices...</span>
        </div>
      </div>
      <div id="device-list" class="device-list"></div>
      <div class="actions">
        <button id="cancel-btn" type="button">Cancel</button>
      </div>
    </div>
    <script>
      const DEVICES = {devices};
      const EVENT_NAME = {selection_event};
      const UPDATE_EVENT_NAME = {update_event};
      const INITIAL_SCANNING = {initial_scanning};
      const list = document.getElementById('device-list');
      const scanStatus = document.getElementById('scan-status');
      const tauriError = document.getElementById('tauri-error');
      const cancelBtn = document.getElementById('cancel-btn');
      const state = {{
        devices: [...DEVICES],
        scanning: INITIAL_SCANNING,
      }};
      let selectHandler = () => {{}};

      const showError = (message) => {{
        if (!tauriError) return;
        tauriError.textContent = message;
        tauriError.hidden = false;
      }};

      const setScanning = (active) => {{
        if (!scanStatus) return;
        scanStatus.setAttribute('aria-hidden', active ? 'false' : 'true');
      }};

      const renderDevices = () => {{
        list.innerHTML = '';
        if (!state.devices.length) {{
          const empty = document.createElement('div');
          empty.className = 'empty';
          empty.textContent = state.scanning ? 'Looking for devices...' : 'No devices were found.';
          list.appendChild(empty);
          return;
        }}

        state.devices.forEach((device) => {{
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'device';
          button.innerHTML = `
            <span class="device-name">${{device.name ?? 'Unnamed Device'}}</span>
            <span class="device-meta">${{device.id}}</span>
          `;
          button.addEventListener('click', () => selectHandler(device.id));
          list.appendChild(button);
        }});
      }};

      const applyUpdate = (payload) => {{
        if (!payload) return;
        state.devices = Array.isArray(payload.devices) ? payload.devices : [];
        state.scanning = !(payload.completed ?? false);
        setScanning(state.scanning);
        renderDevices();
      }};

      const parsePayload = (raw) => {{
        if (!raw) return null;
        if (typeof raw === 'string') {{
          try {{
            return JSON.parse(raw);
          }} catch (err) {{
            console.warn('Failed to parse update payload', err);
            return null;
          }}
        }}
        return raw;
      }};

      const waitForTauri = (timeout = 5000) => {{
        if (window.__TAURI__?.event) return Promise.resolve(window.__TAURI__);
        return new Promise((resolve) => {{
          const started = Date.now();
          const poll = () => {{
            if (window.__TAURI__?.event) {{
              resolve(window.__TAURI__);
              return;
            }}
            if (Date.now() - started >= timeout) {{
              resolve(null);
              return;
            }}
            requestAnimationFrame(poll);
          }};
          poll();
        }});
      }};

      setScanning(state.scanning);
      renderDevices();

      const bootstrap = async () => {{
        const api = await waitForTauri();
        if (!api?.event) {{
          showError('Unable to access Tauri APIs. Please enable withGlobalTauri for this window.');
          state.scanning = false;
          setScanning(false);
          return;
        }}

        if (tauriError) {{
          tauriError.hidden = true;
        }}

        const {{ event, window: tauriWindow }} = api;
        let currentWindow = null;
        if (typeof tauriWindow?.getCurrent === 'function') {{
          try {{
            currentWindow = await tauriWindow.getCurrent();
          }} catch (err) {{
            console.warn('Failed to resolve current window', err);
          }}
        }}

        const emitSelection = async (deviceId) => {{
          try {{
            await event.emit(EVENT_NAME, {{ deviceId }});
          }} catch (err) {{
            console.warn('Failed to emit selection', err);
          }}
        }};

        const handleSelection = async (deviceId) => {{
          await emitSelection(deviceId);
          currentWindow?.close?.();
        }};
        selectHandler = handleSelection;

        cancelBtn?.addEventListener('click', () => handleSelection(null));
        window.addEventListener('keydown', (evt) => {{
          if (evt.key === 'Escape') {{
            handleSelection(null);
          }}
        }});

        const subscribeToUpdates = async () => {{
          if (!UPDATE_EVENT_NAME) {{
            return null;
          }}
          const handler = (message) => {{
            applyUpdate(parsePayload(message?.payload));
          }};
          if (currentWindow?.listen) {{
            try {{
              return await currentWindow.listen(UPDATE_EVENT_NAME, handler);
            }} catch (err) {{
              console.warn('Failed to subscribe via window listener', err);
            }}
          }}
          if (event?.listen) {{
            try {{
              return await event.listen(UPDATE_EVENT_NAME, handler);
            }} catch (err) {{
              console.warn('Failed to subscribe via global listener', err);
            }}
          }}
          showError('Unable to subscribe to device updates.');
          return null;
        }};

        let unlisten = await subscribeToUpdates();

        window.addEventListener('beforeunload', () => {{
          if (typeof unlisten === 'function') {{
            unlisten();
          }}
          emitSelection(null);
        }});
      }};

      bootstrap();
    </script>
  </body>
</html>
"#,
    title = SELECTION_WINDOW_TITLE,
    devices = devices_json,
    selection_event = selection_event_json,
    update_event = update_event_json,
    initial_scanning = initial_scanning_flag,
  );

  store_selection_page(request_id, html);
  let raw_url = format!("{SELECTION_WINDOW_SCHEME}://{SELECTION_WINDOW_HOST}/{request_id}");
  let url = Url::parse(&raw_url).map_err(|err| Error::InvalidRequest(err.to_string()))?;
  Ok(WebviewUrl::External(url))
}

fn emit_selection_update<R: Runtime>(
  app: &AppHandle<R>,
  window_label: &str,
  event: &str,
  devices: &[BluetoothDevice],
  completed: bool,
) {
  if event.is_empty() {
    return;
  }
  let payload = SelectionUpdatePayload {
    devices: devices.to_vec(),
    completed,
  };
  if let Err(err) = app.emit_to(window_label, event, payload) {
    log::warn!(
      "Failed to emit selection update | window_label={} | event={} | err={:?}",
      window_label,
      event,
      err
    );
  }
}

pub fn init<R: Runtime, C: DeserializeOwned>(
  app: &AppHandle<R>,
  _api: PluginApi<R, C>,
  selection_handler: SelectionHandler<R>,
) -> Result<WebBluetooth<R>> {
  let app_handle = app.clone();
  let (manager, adapter, adapter_index) = async_runtime::block_on(async move {
    let manager = BtleManager::new().await?;
    let mut adapters = manager.adapters().await?;
    if adapters.is_empty() {
      return Err(Error::NoAdapter);
    }
    let adapter = adapters.remove(0);
    Ok::<_, Error>((manager, adapter, 0usize))
  })?;

  Ok(WebBluetooth::new(
    app_handle,
    manager,
    adapter,
    adapter_index,
    selection_handler,
  ))
}

/// Access to the web-bluetooth APIs.
pub struct WebBluetooth<R: Runtime> {
  inner: Arc<WebBluetoothState<R>>,
}

struct WebBluetoothState<R: Runtime> {
  app: AppHandle<R>,
  manager: BtleManager,
  adapter: Adapter,
  adapter_index: usize,
  peripherals: RwLock<HashMap<String, Peripheral>>,
  notification_tasks: Arc<Mutex<HashMap<String, JoinHandle<()>>>>,
  selection_handler: SelectionHandler<R>,
}

impl<R: Runtime> WebBluetooth<R> {
  fn new(
    app: AppHandle<R>,
    manager: BtleManager,
    adapter: Adapter,
    adapter_index: usize,
    selection_handler: SelectionHandler<R>,
  ) -> Self {
    let state = Arc::new(WebBluetoothState {
      app,
      manager,
      adapter,
      adapter_index,
      peripherals: RwLock::new(HashMap::new()),
      notification_tasks: Arc::new(Mutex::new(HashMap::new())),
      selection_handler,
    });
    state.spawn_event_listener();
    Self { inner: state }
  }

  pub async fn get_availability(&self) -> Result<bool> {
    Ok(!self
      .inner
      .manager
      .adapters()
      .await?
      .into_iter()
      .nth(self.inner.adapter_index)
      .is_none())
  }

  // GPX Rider addition: get_availability() only reports whether adapter
  // *hardware* exists, not whether its radio is switched on — a Mac with
  // Bluetooth toggled off still has an adapter, so request_device() would
  // scan for the full timeout and report "no devices found" with no way to
  // tell that from a real absence of nearby devices. Exposes btleplug's
  // actual CentralState (PoweredOn/PoweredOff/Unknown) instead.
  pub async fn get_adapter_state(&self) -> Result<CentralState> {
    Ok(self.inner.adapter.adapter_state().await?)
  }

  pub async fn get_devices(&self) -> Result<Vec<BluetoothDevice>> {
    let peripherals = self.inner.peripherals.read().await;
    let mut devices = Vec::with_capacity(peripherals.len());
    for peripheral in peripherals.values() {
      devices.push(self.describe_device(peripheral).await?);
    }
    Ok(devices)
  }

  pub async fn request_device(&self, options: RequestDeviceOptions) -> Result<BluetoothDevice> {
    let request_options = options.clone();
    let normalized = NormalizedRequestDeviceOptions::try_from(options)?;
    let adapter = self.inner.adapter.clone();
    // GPX Rider patch: ScanFilter::default() (empty services) makes
    // CoreBluetooth's scanForPeripheralsWithServices:options: pass `nil`,
    // which macOS has a long-standing bug for — it silently stops
    // delivering *any* advertisement data at all, on any platform other
    // than CoreBluetooth this would be harmless (see
    // scan_filter_to_service_uuids in btleplug's corebluetooth backend,
    // and https://github.com/hbldh/bleak/pull/692 for the same workaround
    // in another BLE library). Passing the union of every filter's
    // requested service UUIDs keeps CoreBluetooth actually receiving
    // advertisements for any of them, matching Web Bluetooth's own
    // behavior of only discovering devices that advertise a requested
    // service anyway. Filters with no services at all (accept_all_devices,
    // or a namePrefix-only filter) still can't avoid this bug — nothing
    // outside CoreBluetooth itself can fix that half of it.
    let mut scan_services: Vec<Uuid> = normalized
      .filters
      .iter()
      .flat_map(|filter| filter.services.iter().cloned())
      .collect();
    scan_services.sort_unstable();
    scan_services.dedup();
    adapter
      .start_scan(ScanFilter {
        services: scan_services,
      })
      .await?;
    let deadline = Instant::now() + normalized.scan_timeout;
    let require_full_scan = self.inner.selection_handler.wants_full_scan();
    let request_id = Uuid::new_v4().to_string();
    let selection_event = format!("{SELECTION_EVENT_PREFIX}{request_id}");
    let update_event = format!("{selection_event}{SELECTION_UPDATE_EVENT_SUFFIX}");
    let window_label = format!("{SELECTION_WINDOW_PREFIX}{request_id}");

    log::info!(
      "request_device invoked | accept_all_devices={} | filter_count={} | timeout_ms={} | full_scan={}",
      request_options.accept_all_devices,
      request_options.filters.len(),
      request_options.scan_timeout_ms,
      require_full_scan
    );

    if require_full_scan {
      let mut matched: HashMap<String, Peripheral> = HashMap::new();
      while Instant::now() < deadline {
        let peripherals = adapter.peripherals().await?;
        for peripheral in peripherals {
          if let Some(properties) = peripheral.properties().await? {
            if normalized.matches(&properties) {
              let device_id = peripheral_key(&peripheral);
              if matched.contains_key(&device_id) {
                continue;
              }
              log::info!(
                "Full scan match | device_id={} | name={:?}",
                device_id,
                properties.local_name
              );
              matched.insert(device_id, peripheral);
            }
          }
        }
        sleep(SCAN_POLL_INTERVAL).await;
      }
      adapter.stop_scan().await.ok();

      if matched.is_empty() {
        log::warn!("Full scan completed with 0 matching devices");
        return Err(Error::DeviceNotFound("No devices matched the provided filters".into()));
      }

      let matched_peripherals: Vec<Peripheral> = matched.values().cloned().collect();
      let mut devices = Vec::with_capacity(matched_peripherals.len());
      for peripheral in &matched_peripherals {
        devices.push(self.describe_device(peripheral).await?);
      }

      let context = DeviceSelectionContext {
        app: self.inner.app.clone(),
        options: request_options.clone(),
        devices: devices.clone(),
        selection_event,
        update_event,
        window_label,
        initial_scanning: false,
      };
      log::info!("Presenting {} devices to selection handler (full-scan mode)", devices.len());
      let selected_id = self
        .inner
        .selection_handler
        .select(context)
        .await?
        .ok_or(Error::SelectionCancelled)?;

      let selected_device = devices
        .into_iter()
        .find(|device| device.id == selected_id)
        .ok_or_else(|| Error::DeviceNotFound(selected_id.clone()))?;

      if let Some(selected_peripheral) = matched.remove(&selected_id) {
        let mut cache = self.inner.peripherals.write().await;
        cache.insert(selected_id.clone(), selected_peripheral);
      }

      return Ok(selected_device);
    }

    let app = self.inner.app.clone();
    let context = DeviceSelectionContext {
      app: self.inner.app.clone(),
      options: request_options,
      devices: Vec::new(),
      selection_event: selection_event.clone(),
      update_event: update_event.clone(),
      window_label: window_label.clone(),
      initial_scanning: true,
    };
    let mut selection_future = Box::pin(self.inner.selection_handler.select(context));
    let mut selection_result: Option<Option<String>> = None;
    let mut matched: HashMap<String, Peripheral> = HashMap::new();
    let mut devices: Vec<BluetoothDevice> = Vec::new();
    let mut last_emit = Instant::now();

    log::info!("Streaming scan started | request_id={request_id}");
    while Instant::now() < deadline {
      if let Some(value) = selection_future.as_mut().now_or_never() {
        selection_result = Some(value?);
        break;
      }

      sleep(SCAN_POLL_INTERVAL).await;
      let peripherals = adapter.peripherals().await?;
      let mut updated = false;
      for peripheral in peripherals {
        if let Some(properties) = peripheral.properties().await? {
          if normalized.matches(&properties) {
            let device_id = peripheral_key(&peripheral);
            if matched.contains_key(&device_id) {
              continue;
            }
            matched.insert(device_id.clone(), peripheral.clone());
            devices.push(self.describe_device(&peripheral).await?);
            log::info!(
              "Streaming scan match | device_id={} | name={:?}",
              device_id,
              properties.local_name
            );
            updated = true;
          }
        }
      }
      if updated {
        emit_selection_update(&app, &window_label, &update_event, &devices, false);
        last_emit = Instant::now();
      } else if !devices.is_empty() && last_emit.elapsed() >= Duration::from_millis(800) {
        emit_selection_update(&app, &window_label, &update_event, &devices, false);
        last_emit = Instant::now();
      }
    }

    adapter.stop_scan().await.ok();
    emit_selection_update(&app, &window_label, &update_event, &devices, true);
    log::info!(
      "Streaming scan completed | request_id={request_id} | devices_found={} | selection_resolved={}",
      devices.len(),
      selection_result.is_some()
    );

    if matches!(selection_result, Some(None)) {
      return Err(Error::SelectionCancelled);
    }

    if devices.is_empty() {
      log::warn!("Streaming scan produced no matching devices");
      if selection_result.is_none() {
        let _ = app.emit(&selection_event, SelectionEventPayload { device_id: None });
        let _ = selection_future.await?;
      }
      return Err(Error::DeviceNotFound("No devices matched the provided filters".into()));
    }

    let selected_id = match selection_result {
      Some(result) => result,
      None => selection_future.await?,
    }
    .ok_or(Error::SelectionCancelled)?;

    let selected_device = devices
      .into_iter()
      .find(|device| device.id == selected_id)
      .ok_or_else(|| Error::DeviceNotFound(selected_id.clone()))?;

    if let Some(selected_peripheral) = matched.remove(&selected_id) {
      let mut cache = self.inner.peripherals.write().await;
      cache.insert(selected_id.clone(), selected_peripheral);
    }

    log::info!("Device selected | device_id={} | name={:?}", selected_device.id, selected_device.name);
    Ok(selected_device)
  }

  pub async fn connect_gatt(&self, request: DeviceRequest) -> Result<GattServerInfo> {
    let peripheral = self.get_or_try_load_peripheral(&request.device_id).await?;
    if !peripheral.is_connected().await.unwrap_or(false) {
      peripheral.connect().await?;
    }
    peripheral.discover_services().await?;
    Ok(self.describe_gatt_server(&request.device_id, &peripheral).await?)
  }

  pub async fn disconnect_gatt(&self, request: DeviceRequest) -> Result<()> {
    let peripheral = self.get_or_try_load_peripheral(&request.device_id).await?;
    if peripheral.is_connected().await.unwrap_or(false) {
      peripheral.disconnect().await?;
    }
    Ok(())
  }

  pub async fn forget_device(&self, request: DeviceRequest) -> Result<()> {
    let mut cache = self.inner.peripherals.write().await;
    cache.remove(&request.device_id);
    Ok(())
  }

  pub async fn get_primary_services(&self, request: ServiceRequest) -> Result<Vec<BluetoothService>> {
    let peripheral = self.get_or_try_load_peripheral(&request.device_id).await?;
    peripheral.discover_services().await?;
    let services = peripheral.services();
    let response = services
      .into_iter()
      .filter(|service| match &request.service_uuid {
        Some(target) => format_uuid(&service.uuid) == normalize_uuid_string(target),
        None => true,
      })
      .map(service_to_model)
      .collect();
    Ok(response)
  }

  pub async fn get_characteristics(&self, request: CharacteristicsRequest) -> Result<Vec<BluetoothCharacteristic>> {
    let peripheral = self.get_or_try_load_peripheral(&request.device_id).await?;
    peripheral.discover_services().await?;
    let services = peripheral.services();
    let service_uuid = parse_uuid(&request.service_uuid)?;
    let service = services
      .into_iter()
      .find(|service| service.uuid == service_uuid)
      .ok_or_else(|| Error::ServiceNotFound {
        device_id: request.device_id.clone(),
        service_uuid: request.service_uuid.clone(),
      })?;
    let mut chars: Vec<BluetoothCharacteristic> = service
      .characteristics
      .iter()
      .map(characteristic_to_model)
      .collect();
    if let Some(target) = request.characteristic_uuid.as_ref() {
      chars.retain(|item| item.uuid.eq_ignore_ascii_case(target));
    }
    Ok(chars)
  }

  pub async fn read_characteristic_value(&self, request: ReadValueRequest) -> Result<BluetoothValue> {
    let (peripheral, characteristic) = self.resolve_characteristic(&request.device_id, &request.service_uuid, &request.characteristic_uuid).await?;
    let bytes = peripheral.read(&characteristic).await?;
    Ok(BluetoothValue {
      value: BASE64_STANDARD.encode(bytes),
    })
  }

  pub async fn write_characteristic_value(&self, request: WriteValueRequest) -> Result<()> {
    let (peripheral, characteristic) = self
      .resolve_characteristic(&request.device_id, &request.service_uuid, &request.characteristic_uuid)
      .await?;
    let payload = BASE64_STANDARD.decode(request.value)?;
    let write_type = if request.with_response {
      WriteType::WithResponse
    } else {
      WriteType::WithoutResponse
    };
    peripheral.write(&characteristic, &payload, write_type).await?;
    Ok(())
  }

  pub async fn start_notifications(&self, request: NotificationRequest) -> Result<()> {
    let (peripheral, characteristic) = self
      .resolve_characteristic(&request.device_id, &request.service_uuid, &request.characteristic_uuid)
      .await?;
    let key = notification_key(&request.device_id, &request.characteristic_uuid);
    {
      let tasks = self.inner.notification_tasks.lock().await;
      if tasks.contains_key(&key) {
        return Err(Error::NotificationsAlreadyActive {
          device_id: request.device_id.clone(),
          characteristic_uuid: request.characteristic_uuid.clone(),
        });
      }
    }
    peripheral.subscribe(&characteristic).await?;
    let mut stream = peripheral.notifications().await?;
    let app = self.inner.app.clone();
    let device_id = request.device_id.clone();
    let service_uuid = request.service_uuid.clone();
    let characteristic_uuid = request.characteristic_uuid.clone();
    let handle = async_runtime::spawn(async move {
      while let Some(notification) = stream.next().await {
        if notification.uuid == characteristic.uuid {
          emit_notification(&app, &device_id, &service_uuid, &characteristic_uuid, &notification);
        }
      }
    });
    self
      .inner
      .notification_tasks
      .lock()
      .await
      .insert(key, handle);
    Ok(())
  }

  pub async fn stop_notifications(&self, request: NotificationRequest) -> Result<()> {
    let (peripheral, characteristic) = self
      .resolve_characteristic(&request.device_id, &request.service_uuid, &request.characteristic_uuid)
      .await?;
    let key = notification_key(&request.device_id, &request.characteristic_uuid);
    let handle = self.inner.notification_tasks.lock().await.remove(&key).ok_or(Error::NotificationsNotActive {
      device_id: request.device_id.clone(),
      characteristic_uuid: request.characteristic_uuid.clone(),
    })?;
    handle.abort();
    peripheral.unsubscribe(&characteristic).await?;
    Ok(())
  }

  async fn get_or_try_load_peripheral(&self, device_id: &str) -> Result<Peripheral> {
    if let Some(peripheral) = self.inner.peripherals.read().await.get(device_id) {
      return Ok(peripheral.clone());
    }
    let adapter = self.inner.adapter.clone();
    let peripherals = adapter.peripherals().await?;
    for peripheral in peripherals {
      if peripheral_key(&peripheral) == device_id {
        let mut cache = self.inner.peripherals.write().await;
        cache.insert(device_id.to_string(), peripheral.clone());
        return Ok(peripheral);
      }
    }
    Err(Error::DeviceNotFound(device_id.to_string()))
  }

  async fn describe_device(&self, peripheral: &Peripheral) -> Result<BluetoothDevice> {
    let properties = peripheral.properties().await?;
    let connected = peripheral.is_connected().await.unwrap_or(false);
    Ok(BluetoothDevice {
      id: peripheral_key(peripheral),
      name: properties.as_ref().and_then(|p| p.local_name.clone()),
      uuids: properties
        .as_ref()
        .map(|p| p.services.iter().map(format_uuid).collect())
        .unwrap_or_default(),
      watching_advertisements: false,
      connected,
    })
  }

  async fn describe_gatt_server(&self, device_id: &str, peripheral: &Peripheral) -> Result<GattServerInfo> {
    let services = peripheral.services().into_iter().map(service_to_model).collect();
    Ok(GattServerInfo {
      device_id: device_id.to_string(),
      connected: peripheral.is_connected().await.unwrap_or(false),
      services,
    })
  }

  async fn resolve_characteristic(
    &self,
    device_id: &str,
    service_uuid: &str,
    characteristic_uuid: &str,
  ) -> Result<(Peripheral, Characteristic)> {
    let peripheral = self.get_or_try_load_peripheral(device_id).await?;
    peripheral.discover_services().await?;
    let target_service = parse_uuid(service_uuid)?;
    let services = peripheral.services();
    let service = services
      .into_iter()
      .find(|srv| srv.uuid == target_service)
      .ok_or_else(|| Error::ServiceNotFound {
        device_id: device_id.to_string(),
        service_uuid: service_uuid.to_string(),
      })?;
    let target_char = parse_uuid(characteristic_uuid)?;
    let characteristic = service
      .characteristics
      .into_iter()
      .find(|chr| chr.uuid == target_char)
      .ok_or_else(|| Error::CharacteristicNotFound {
        device_id: device_id.to_string(),
        characteristic_uuid: characteristic_uuid.to_string(),
      })?;
    Ok((peripheral, characteristic))
  }
}

impl<R: Runtime> WebBluetoothState<R> {
  fn spawn_event_listener(self: &Arc<Self>) {
    let adapter = self.adapter.clone();
    let app = self.app.clone();
    let notifications = self.notification_tasks.clone();
    async_runtime::spawn(async move {
      let events = adapter.events().await;
      let mut events = match events {
        Ok(stream) => stream,
        Err(err) => {
          log::error!("Failed to subscribe to Bluetooth adapter events: {err}");
          return;
        }
      };
      while let Some(event) = events.next().await {
        if let CentralEvent::DeviceDisconnected(id) = event {
          if let Ok(peripheral) = adapter.peripheral(&id).await {
            let device_id = peripheral_key(&peripheral);
            clear_notifications_for(&notifications, &device_id).await;
            let _ = app.emit(
              EVENT_GATT_DISCONNECTED,
              DeviceEventPayload {
                device_id,
              },
            );
          }
        }
      }
    });
  }
}

fn emit_notification<R: Runtime>(
  app: &AppHandle<R>,
  device_id: &str,
  service_uuid: &str,
  characteristic_uuid: &str,
  notification: &ValueNotification,
) {
  let payload = NotificationEventPayload {
    device_id: device_id.to_string(),
    service_uuid: service_uuid.to_string(),
    characteristic_uuid: characteristic_uuid.to_string(),
    value: BASE64_STANDARD.encode(&notification.value),
  };
  let _ = app.emit(EVENT_NOTIFICATION, payload);
}

async fn clear_notifications_for(
  tasks: &Mutex<HashMap<String, JoinHandle<()>>>,
  device_id: &str,
) {
  let mut guard = tasks.lock().await;
  let keys: Vec<String> = guard
    .keys()
    .filter(|key| key.starts_with(device_id))
    .cloned()
    .collect();
  for key in keys {
    if let Some(handle) = guard.remove(&key) {
      handle.abort();
    }
  }
}

fn service_to_model(service: Service) -> BluetoothService {
  BluetoothService {
    uuid: format_uuid(&service.uuid),
    is_primary: service.primary,
    characteristics: service
      .characteristics
      .iter()
      .map(characteristic_to_model)
      .collect(),
  }
}

fn characteristic_to_model(characteristic: &Characteristic) -> BluetoothCharacteristic {
  let flags = characteristic.properties;
  BluetoothCharacteristic {
    uuid: format_uuid(&characteristic.uuid),
    properties: CharacteristicProperties {
      broadcast: flags.contains(CharPropFlags::BROADCAST),
      read: flags.contains(CharPropFlags::READ),
      write_without_response: flags.contains(CharPropFlags::WRITE_WITHOUT_RESPONSE),
      write: flags.contains(CharPropFlags::WRITE),
      notify: flags.contains(CharPropFlags::NOTIFY),
      indicate: flags.contains(CharPropFlags::INDICATE),
      authenticated_signed_writes: flags.contains(CharPropFlags::AUTHENTICATED_SIGNED_WRITES),
      reliable_write: false,
      writable_auxiliaries: false,
    },
    descriptors: characteristic
      .descriptors
      .iter()
      .map(|descriptor| BluetoothDescriptor {
        uuid: format_uuid(&descriptor.uuid),
      })
      .collect(),
  }
}

fn format_uuid(uuid: &Uuid) -> String {
  uuid.to_string()
}

fn normalize_uuid_string(input: &str) -> String {
  match parse_uuid(input) {
    Ok(uuid) => uuid.to_string(),
    Err(_) => input.to_string(),
  }
}

fn notification_key(device_id: &str, characteristic_uuid: &str) -> String {
  format!("{device_id}:{characteristic_uuid}")
}

fn peripheral_key(peripheral: &Peripheral) -> String {
  peripheral.address().to_string()
}

fn parse_uuid(input: &str) -> Result<Uuid> {
  let trimmed = input.trim().trim_start_matches("0x");
  let normalized = match trimmed.len() {
    4 => format!("0000{trimmed}-0000-1000-8000-00805f9b34fb"),
    8 => format!("{trimmed}-0000-1000-8000-00805f9b34fb"),
    _ => trimmed.to_string(),
  };
  Ok(Uuid::parse_str(&normalized)?)
}

struct NormalizedRequestDeviceOptions {
  accept_all_devices: bool,
  filters: Vec<NormalizedDeviceFilter>,
  scan_timeout: Duration,
}

struct NormalizedDeviceFilter {
  services: Vec<Uuid>,
  name: Option<String>,
  name_prefix: Option<String>,
}

impl TryFrom<RequestDeviceOptions> for NormalizedRequestDeviceOptions {
  type Error = Error;

  fn try_from(options: RequestDeviceOptions) -> Result<Self> {
    if !options.accept_all_devices && options.filters.is_empty() {
      return Err(Error::InvalidRequest(
        "Either acceptAllDevices must be true or filters must be provided".into(),
      ));
    }

    let filters = options
      .filters
      .into_iter()
      .map(|filter| {
        let services = filter
          .services
          .iter()
          .map(|value| parse_uuid(value))
          .collect::<Result<Vec<_>>>()?;
        Ok(NormalizedDeviceFilter {
          services,
          name: filter.name,
          name_prefix: filter.name_prefix,
        })
      })
      .collect::<Result<Vec<_>>>()?;

    Ok(Self {
      accept_all_devices: options.accept_all_devices,
      filters,
      scan_timeout: Duration::from_millis(options.scan_timeout_ms.max(1)),
    })
  }
}

impl NormalizedRequestDeviceOptions {
  fn matches(&self, properties: &PeripheralProperties) -> bool {
    if self.accept_all_devices {
      return true;
    }
    self.filters.iter().any(|filter| filter.matches(properties))
  }
}

impl NormalizedDeviceFilter {
  fn matches(&self, properties: &PeripheralProperties) -> bool {
    if let Some(name) = &self.name {
      if properties.local_name.as_deref() != Some(name.as_str()) {
        return false;
      }
    }
    if let Some(prefix) = &self.name_prefix {
      if !properties
        .local_name
        .as_deref()
        .map(|value| value.starts_with(prefix))
        .unwrap_or(false)
      {
        return false;
      }
    }
    if !self.services.is_empty() {
      let present: HashSet<Uuid> = properties.services.iter().cloned().collect();
      if !self.services.iter().all(|uuid| present.contains(uuid)) {
        return false;
      }
    }
    true
  }
}
