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

From this directory:

```sh
cargo tauri dev
```

This expects the GPX Rider dev server to already be running (it's what
`tauri.conf.json`'s `devUrl` points at):

```sh
# from the repo root, in another terminal
make run
```

`cargo tauri dev` opens a native window loading
`http://127.0.0.1:5173/app/app.html` with hot classic reload (edit files
under `app/`, reload the window).

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
environment does not have. In particular, the native device-picker window
(a separate webview registered by the plugin) and the `web-bluetooth`
CSP/capability wiring below are unverified outside a real macOS build.

### Icons

`src-tauri/icons/` ships placeholder icons (a simple amber dot on the app's
dark background, generated for this change) so the project builds out of
the box. Replace them with real artwork before shipping:

```sh
cargo tauri icon path/to/logo.png
```

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

It's loaded via one added `<script type="module">` tag in `app/app.html`
(before `app.js`) plus an import map resolving `@tauri-apps/api/core` and
`@tauri-apps/api/event` to the vendored `app/vendor/tauri-api/` files — no
other change to `app/` was needed.

**Multiple simultaneous connections work**, matching the browser build:
the plugin keeps one GATT connection per device (a `HashMap` keyed by
device id on the Rust side), unlike some simpler BLE plugins that hold a
single global connection for the whole app. A trainer and a heart-rate
strap can be connected at the same time.

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

**Not published to crates.io or npm as of this writing.** `Cargo.toml`
depends on it via `git` + a pinned `rev` rather than a version, and there's
no prebuilt JS bundle to vendor — `app/vendor/web-bluetooth-plugin/index.js`
is a hand-written, behavior-preserving port of its `guest-js/index.ts`
(command names and payload shapes only, types dropped). See
`app/vendor/web-bluetooth-plugin/NOTICE.md` for how to re-sync both sides
when bumping the pinned commit.

## Project layout

```
macos-app/
  README.md              this file
  src-tauri/
    Cargo.toml            tauri + tauri-plugin-web-bluetooth dependencies
    tauri.conf.json        window/bundle config; frontendDist points at ../../app
    capabilities/default.json   grants core + core:event + web-bluetooth:default
    Info.plist              NSBluetoothAlwaysUsageDescription, merged into the app bundle
    icons/                 app icon set (placeholder — see above)
    src/
      lib.rs               registers the plugin with a native device picker, boots the window
      main.rs               binary entry point
```
