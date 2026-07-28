# GPX Rider — macOS desktop app

A [Tauri](https://tauri.app/) shell that loads the same `app/` static site
served by the browser build, so it renders the exact same map, HUD, and ride
logic — the only thing this project adds is a native Bluetooth backend
([tauri-plugin-blec](https://github.com/MnlPhlp/tauri-plugin-blec), a
[btleplug](https://github.com/deviceplug/btleplug)-based BLE client) for
platforms where the embedded webview has no Web Bluetooth implementation
(WKWebView on macOS, in particular).

`app/` itself is unchanged: no build step, no bundler, no app-side
dependency on Tauri. The bridge is a small, self-contained shim —
see "How the Bluetooth bridge works" below.

## Prerequisites

- Rust (stable) — https://www.rust-lang.org/tools/install
- The Tauri CLI: `cargo install tauri-cli --version "^2.0.0" --locked`
- macOS + Xcode command line tools (`xcode-select --install`) to build or
  bundle a `.app`/`.dmg` — Tauri cannot cross-compile a macOS bundle from
  another OS.
- No Node.js/npm is required. The frontend (`app/`) is plain static files,
  and its two Tauri-facing JS dependencies
  (`@mnlphlp/plugin-blec`, `@tauri-apps/api/core`) are vendored as
  pre-built files under `app/vendor/`, the same way Leaflet is — see
  `app/vendor/plugin-blec/NOTICE.md` and `app/vendor/tauri-api/NOTICE.md`.

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
`src-tauri/target/release/bundle/`. This step was validated on Linux only
as far as `cargo check`/`cargo build --release` (the Rust code compiles and
the plugin registers correctly) — the actual `.app`/`.dmg` bundling and any
on-device Bluetooth testing needs to happen on macOS, which this development
environment does not have.

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
polyfills exactly that surface, backed by tauri-plugin-blec, when it detects
it's running inside Tauri (`window.__TAURI_INTERNALS__`). In a real browser
it's a no-op — `trainer.mjs`/`heartrate.mjs` are completely unmodified.

It's loaded via one added `<script type="module">` tag in `app/app.html`
(before `app.js`) plus an import map resolving the bare specifier
`@tauri-apps/api/core` to the vendored `app/vendor/tauri-api/core.js` — no
other change to `app/` was needed.

**Known limitation: one Bluetooth device at a time.** tauri-plugin-blec
(and btleplug underneath it) keeps a single active GATT connection for the
whole app — `connect()`/`disconnect()` are global, not per-device — unlike
Web Bluetooth, which lets a page hold independent connections to several
devices at once. In the browser build you can have a trainer *and* a
heart-rate strap connected simultaneously; in this desktop build, connecting
the second one disconnects the first (surfaced the same way a real
out-of-range disconnect would be, through the existing
`gattserverdisconnected` handling — no special-casing needed in
`trainer.mjs`/`heartrate.mjs`). If your trainer also broadcasts its own
heart-rate field over ANT+/BLE, prefer that over pairing a separate strap.

## Project layout

```
macos-app/
  README.md              this file
  src-tauri/
    Cargo.toml            tauri + tauri-plugin-blec dependencies
    tauri.conf.json        window/bundle config; frontendDist points at ../../app
    capabilities/default.json   grants core + blec:default permissions
    icons/                 app icon set (placeholder — see above)
    src/
      lib.rs               registers tauri-plugin-blec, boots the window
      main.rs               binary entry point
```
