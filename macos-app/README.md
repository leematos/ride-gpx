# GPX Rider — macOS desktop app

A [Tauri](https://tauri.app/) shell that loads the same `app/` static site
served by the browser build, so it renders the exact same map, HUD, and ride
logic — the only thing this project adds is a native Bluetooth backend
([tauri-plugin-web-bluetooth-api](https://github.com/ParticleG/tauri-plugin-web-bluetooth-api),
a [btleplug](https://github.com/deviceplug/btleplug)-based BLE client that
mirrors the Web Bluetooth API) for platforms where the embedded webview has
no Web Bluetooth implementation (WKWebView on macOS, in particular).

`app/` itself is unchanged: no build step, no bundler, no app-side
dependency on Tauri. The bridge is a small, self-contained shim —
see "How the Bluetooth bridge works" below.

## Prerequisites

- Rust (stable) — https://www.rust-lang.org/tools/install
- The Tauri CLI: `cargo install tauri-cli --version "^2.0.0" --locked`
- macOS + Xcode command line tools (`xcode-select --install`) to build or
  bundle a `.app`/`.dmg` — Tauri cannot cross-compile a macOS bundle from
  another OS.
- No Node.js/npm is required. The frontend (`app/`) is plain static files;
  its Tauri-facing JS dependencies (the `core`/`event` modules of
  `@tauri-apps/api`, plus the Bluetooth plugin's bindings) are vendored as
  plain ES modules under `app/vendor/`, the same way Leaflet is — see
  `app/vendor/tauri-api/NOTICE.md` and `app/vendor/web-bluetooth-plugin/NOTICE.md`.

## Run in development

`app/app.html` doesn't reference the Bluetooth bridge at all in git — it's
injected only at CI build time (see "How the Bluetooth bridge works"
below), so `make run`'s plain checkout won't have it either. Inject it
locally first, from the repo root:

```sh
python3 scripts/inject_macos_bluetooth_bridge.py
make run
```

Then, from this directory, in another terminal:

```sh
cargo tauri dev
```

`cargo tauri dev` opens a native window loading
`http://127.0.0.1:5173/app/app.html` (what `tauri.conf.json`'s `devUrl`
points at) with hot classic reload (edit files under `app/`, reload the
window). When you're done and want to go back to testing the plain browser
build, revert the injected copy:

```sh
git checkout -- app/app.html
```

## Build a macOS app

On a Mac, from this directory:

```sh
cargo tauri build
```

Produces a `.app` bundle and a `.dmg` under
`src-tauri/target/release/bundle/`.

CI builds this automatically on `macos-latest` runners —
[`.github/workflows/build-macos-app.yml`](../.github/workflows/build-macos-app.yml)
runs on pushes to `main` and PRs touching `app/`/`macos-app/`, plus manual
dispatch, and uploads the `.app`/`.dmg` as a downloadable workflow artifact
(it does not create a GitHub Release or publish anywhere). That's the
easiest way to get a real macOS build of a given commit without a Mac
of your own.

This step was validated on Linux only
as far as `cargo check`/`cargo build --release` (the Rust code compiles and
the plugin registers correctly) — the actual `.app`/`.dmg` bundling and any
on-device Bluetooth testing needs to happen on macOS, which this development
environment does not have. Real-hardware testing already caught two CSP
gaps this way (wrong tile-CDN domain and a missing `ipc:` allowance for
Tauri's own IPC calls — see `tauri.conf.json`'s `app.security.csp`, now
deliberately broadened to `https:`/`ipc:` rather than an exact per-domain
allowlist, since this app has no backend/account data for a strict CSP to
protect and hand-picking domains had already gone wrong twice), so treat
anything not exercised on a real Mac yet as unverified until it is.

### "\*.app is damaged and can't be opened" / "\*.dmg is damaged"

Expected, not a bug in the build: CI produces an ad-hoc-signed but
**unnotarized** build (no Apple Developer certificate is configured), and
macOS — Apple Silicon especially — shows this "damaged" message for
quarantined, unnotarized downloads instead of the older "unidentified
developer" prompt. The file isn't actually corrupt. Clear the quarantine
flag before opening it:

```sh
xattr -cr "~/Downloads/GPX Rider_*.dmg"
# or, after dragging the app out of the mounted dmg:
xattr -cr "/Applications/GPX Rider.app"
```

Shipping a build that doesn't need this requires enrolling in the Apple
Developer Program, adding a Developer ID Application certificate + notarization
credentials as GitHub secrets, and wiring `tauri.conf.json`'s
`bundle.macOS.signingIdentity` (and notarizing via `xcrun notarytool` or
`tauri-action`'s built-in signing support) into
[`build-macos-app.yml`](../.github/workflows/build-macos-app.yml) — not set
up here since it needs the maintainer's own certificate/credentials.

### Icons

`src-tauri/icons/` ships placeholder icons (a simple amber dot on the app's
dark background, generated for this change) so the project builds out of
the box. Replace them with real artwork before shipping:

```sh
cargo tauri icon path/to/logo.png
```

## Debugging

The window has no chrome of its own (no toolbar), so `src-tauri/src/lib.rs`
builds a standard native menu bar with the usual App/Edit/Window items plus
a **View** menu:

- **Reload** (⌘R) — reloads the webview, same as a browser refresh.
- **Toggle Developer Tools** (⌘⌥I) — opens the WebKit inspector (console,
  network, elements, etc.), same as Chrome/Safari devtools. Enabled in
  release builds too via the `devtools` feature on the `tauri` dependency
  in `Cargo.toml` (normally devtools are debug-build-only) — this is a
  private API on macOS, fine here since the app isn't distributed through
  the App Store.

`trainer.mjs`/`heartrate.mjs`'s existing `[trainer]`-style `console.debug`
lines, `tauri-ble-shim.mjs`'s `[tauri-ble]` lines, and `heartrate.mjs`'s new
`[heartrate]` lines all show up in that console — they're the only field
diagnostics available for a hardware pairing failure, so open it before
reproducing one.

### Rust-side logs (scan/permission diagnostics)

The devtools console only shows JS — the Bluetooth plugin's own
`log::info!`/`log::warn!` calls (scan start/stop, every device the scan
matched or didn't, why `request_device` gave up) are a separate, native-side
log stream, invisible unless something subscribes to the `log` crate.
`main.rs` initializes `env_logger` at "info" level by default so that
stream goes to stderr — but stderr only reaches you if the app is launched
from a terminal, not double-clicked from Finder or the mounted `.dmg`:

```sh
# after copying it out of the .dmg, or straight from the build output:
/Applications/GPX\ Rider.app/Contents/MacOS/gpx-rider
# or, for a dev build:
./src-tauri/target/debug/gpx-rider
```

Set `RUST_LOG=debug` (or `trace`) before that command for more detail if
"info" isn't enough.

## How the Bluetooth bridge works

`trainer.mjs` and `heartrate.mjs` (both in `app/trainer/`) are written
against the standard [Web Bluetooth API](https://developer.chrome.com/docs/capabilities/bluetooth)
(`navigator.bluetooth.requestDevice()`, `device.gatt`,
`service.getCharacteristic()`, `characteristic.startNotifications()` /
`writeValue()` / the `characteristicvaluechanged` event). Tauri's webview
doesn't implement that API, so
[`app/trainer/tauri-ble-shim.mjs`](../app/trainer/tauri-ble-shim.mjs)
polyfills exactly that surface, backed by tauri-plugin-web-bluetooth-api,
when it detects it's running inside Tauri (`window.__TAURI_INTERNALS__`).
In a real browser it's a no-op — `trainer.mjs`/`heartrate.mjs` are
completely unmodified.

It's loaded via a `<script type="module">` tag (before `app.js`) plus an
import map resolving `@tauri-apps/api/core` and `@tauri-apps/api/event` to
the vendored `app/vendor/tauri-api/` files — but that markup lives in
neither `app/app.html` nor any file under `app/` at all. `.github/workflows/
build-macos-app.yml` injects it into `app/app.html` with
[`scripts/inject_macos_bluetooth_bridge.py`](../scripts/inject_macos_bluetooth_bridge.py)
right after checkout, before `cargo tauri build` copies `app/` into the
bundle via `frontendDist`. The browser/GitHub Pages build never runs that
script, so its `app.html` never has this markup at all — not even inert,
no-op markup — rather than relying on the shim's own `isTauri` no-op check
to keep it invisible. `app/trainer/tauri-ble-shim.mjs` and its supporting
files (`ble-uuid.mjs`, `app/vendor/tauri-api/`, `app/vendor/web-bluetooth-plugin/`)
are still ordinary files in `app/` — served and shipped either way, just
never *referenced* unless something injects the script tag that imports
them. See "Run in development" above for running this injection locally.

**Multiple simultaneous connections work**, matching the browser build: the
plugin keeps one GATT connection per device (a `HashMap` keyed by device
id on the Rust side), unlike some simpler BLE plugins that hold a single
global connection for the whole app — a trainer and a heart-rate strap can
be connected at the same time. This needed one more patch to actually work
on macOS, though: the plugin's device-id function
(`peripheral_key`) used `Peripheral::address()`, which is a real per-device
address on Linux/Windows/Android but which btleplug's macOS backend
unconditionally hard-codes to a placeholder zero value for *every*
peripheral (CoreBluetooth never exposes real MAC addresses to apps at
all — see `corebluetooth/peripheral.rs` in btleplug itself). Every device
on macOS was colliding on the same id: connecting a KICKR right after a
heart-rate strap reused the strap's cached device/services on the JS side
instead of discovering the KICKR's own, so the FTMS/FE-C lookup failed
against the *strap's* service list ("This trainer exposes neither FTMS nor
Tacx FE-C over Bluetooth" — a real device, just the wrong one). Patched
`peripheral_key` to use `Peripheral::id()` instead, which wraps a real
per-device identifier on every platform btleplug supports.

**"No devices matched the provided filters" for every device.** On real
hardware, this turned out to be the Mac's Bluetooth radio simply being
switched off — Bluetooth permission for the app was granted (visible and
toggled on in System Settings), yet every scan still came back with
`devices_found=0` after the full timeout for both a Wahoo KICKR and a Polar
heart-rate strap, regardless of filter shape (service UUID vs.
`namePrefix`). That's expected: `getAvailability()` only reports whether
adapter *hardware* exists, not whether its radio is powered on, and this
plugin has no permission/state command of its own to distinguish "radio
off" from "no matching devices nearby." `tauri-ble-shim.mjs` now calls a
`get_adapter_state` command added to the vendored plugin (see below) before
every `requestDevice()`/connect attempt and fails fast with "Bluetooth is
turned off" instead of burning the full scan timeout on an unhelpful "no
devices found."

Investigating this also surfaced a real, independent bug worth patching
regardless: `request_device` scans with `ScanFilter::default()` (empty
services), which its CoreBluetooth backend turns into a `nil` services
list for `scanForPeripheralsWithServices:options:` — and macOS has a
long-standing bug where that silently stops delivering *any* advertisement
data at all (the same issue [worked around in the `bleak` BLE
library](https://github.com/hbldh/bleak/pull/692)). Patched to scan with
the union of every filter's requested service UUIDs instead — see
"Vendored and patched" below.

**Device selection is native, not a hand-rolled dialog.** Unlike a
straight `btleplug` wrapper, this plugin's `request_device` command runs
its own selection flow on the Rust side; `lib.rs` configures it with
`NativeDialogSelectionHandler`, which pops a small native Tauri window
(registered on the `web-bluetooth-selector://` scheme) styled after
Chromium's device chooser. `requestDevice()` in the JS shim is a thin
pass-through to that command — it does not implement its own scan/picker
UI. This requires `withGlobalTauri: true` in `tauri.conf.json` (so the
picker window can reach `window.__TAURI__` to report the selection back)
and the `web-bluetooth-selector-*` window pattern + `core:event:default`
permission in `capabilities/default.json`.

**Not published to crates.io or npm as of this writing, and locally
patched.** The JS side has no prebuilt bundle to vendor —
`app/vendor/web-bluetooth-plugin/index.js` is a hand-written,
behavior-preserving port of its `guest-js/index.ts` (command names and
payload shapes only, types dropped; `getAdapterState()` is a genuine
addition, not part of the upstream API — see its comment). The Rust side
goes further: `src-tauri/vendor/tauri-plugin-web-bluetooth/` is the pinned
commit's full source, checked in and patched directly (not just a `git`
dependency), with three changes from upstream:

1. `request_device`'s scan now uses the union of every filter's service
   UUIDs instead of `ScanFilter::default()`, working around the macOS
   empty-scan bug described above.
2. A new `get_adapter_state` command (plus its `commands.rs` wiring and
   `permissions/` entries) exposes btleplug's actual `CentralState`, backing
   the "Bluetooth is turned off" detection above.
3. `peripheral_key` uses `Peripheral::id()` instead of `Peripheral::address()`,
   fixing the device-id collision described above that broke connecting a
   second device on macOS.

`Cargo.toml`'s `[patch]` section redirects the `git` dependency to this
local, patched copy — see the comment there and
`app/vendor/web-bluetooth-plugin/NOTICE.md` for how to re-sync everything
(JS bindings, the two patches, and both pinned commit references) when
bumping to a newer upstream commit.

## Project layout

```
macos-app/
  README.md              this file
  src-tauri/
    Cargo.toml            tauri + tauri-plugin-web-bluetooth dependencies, [patch] to the vendored copy
    tauri.conf.json        window/bundle config; frontendDist points at ../../app
    capabilities/default.json   grants core + core:event + web-bluetooth:default
    Info.plist              NSBluetoothAlwaysUsageDescription, merged into the app bundle
    icons/                 app icon set (placeholder — see above)
    vendor/tauri-plugin-web-bluetooth/   pinned commit's source, patched — see "Vendored and patched" above
    src/
      lib.rs               registers the plugin with a native device picker, boots the window
      main.rs               binary entry point; initializes env_logger
```
