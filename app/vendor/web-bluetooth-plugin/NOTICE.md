# Hand-ported: tauri-plugin-web-bluetooth-api guest bindings

`index.js` is a manual, behavior-preserving port to plain JS of
`guest-js/index.ts` (+ `guest-js/types.ts` for the shapes, types dropped)
from [tauri-plugin-web-bluetooth-api](https://github.com/ParticleG/tauri-plugin-web-bluetooth-api)
at commit `742b6b6210ee1e979f3fc133e7bbdf9a626da31f`. The one exception is
`getAdapterState()` — not part of the upstream API at all, see below.

This is **not** a byte-for-byte vendor of a published build, unlike
Leaflet (`app/vendor/leaflet/`) or `@tauri-apps/api`
(`app/vendor/tauri-api/`): as of the pinned commit, this plugin has no
release on crates.io or npm. It's a thin, mechanical IPC wrapper (command
names, `invoke()` argument shapes, and event names only) with no logic
worth reimplementing differently, so it's ported here 1:1 rather than
reinvented.

The Rust side is pinned to the same commit but goes further: rather than a
plain `git` dependency, `macos-app/src-tauri/vendor/tauri-plugin-web-bluetooth/`
is that commit's full source, checked in and **patched**:

1. `request_device` scanned with `ScanFilter::default()` (empty services),
   which macOS's CoreBluetooth turns into a `nil` services list — and macOS
   has a bug where that silently stops delivering any advertisement data at
   all (found the hard way: real hardware, Bluetooth permission granted,
   scan running, adapter present, zero devices ever found). Patched to scan
   with the union of every filter's requested service UUIDs instead.
2. Added a `get_adapter_state` command (`commands.rs` + `permissions/`
   entries) exposing btleplug's actual `CentralState`
   (`PoweredOn`/`PoweredOff`/`Unknown`) — `getAvailability()` only reports
   whether adapter hardware exists, not whether its radio is on, so there
   was no way to distinguish "Bluetooth is off" from "no devices nearby."
   `getAdapterState()` in this file is the JS side of that addition.

See `macos-app/src-tauri/Cargo.toml`'s `[patch]` section and the comments
in `vendor/tauri-plugin-web-bluetooth/src/desktop.rs` for the patches
themselves.

Note: as of the pinned commit, the upstream repository declares no license
(no `LICENSE` file, no `license` field in its `Cargo.toml`/`package.json`).

To update: bump the pinned commit in both
`macos-app/src-tauri/vendor/tauri-plugin-web-bluetooth/` (re-clone at the
new commit, then re-apply the two patches above — diff against this
version's `desktop.rs`/`commands.rs`/`permissions/` to see exactly what
changed) and the `rev` comment here, then diff `guest-js/index.ts`/
`guest-js/types.ts` at the new commit against this file and
`app/trainer/tauri-ble-shim.mjs` for any upstream API changes.
