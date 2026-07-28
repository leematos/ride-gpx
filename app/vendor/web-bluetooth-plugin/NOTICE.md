# Hand-ported: tauri-plugin-web-bluetooth-api guest bindings

`index.js` is a manual, behavior-preserving port to plain JS of
`guest-js/index.ts` (+ `guest-js/types.ts` for the shapes, types dropped)
from [tauri-plugin-web-bluetooth-api](https://github.com/ParticleG/tauri-plugin-web-bluetooth-api)
at commit `742b6b6210ee1e979f3fc133e7bbdf9a626da31f`.

This is **not** a byte-for-byte vendor of a published build, unlike
Leaflet (`app/vendor/leaflet/`) or `@tauri-apps/api`
(`app/vendor/tauri-api/`): as of the pinned commit, this plugin has no
release on crates.io or npm — the Rust crate is depended on via a
git + `rev` dependency in `macos-app/src-tauri/Cargo.toml`, and the
TypeScript `guest-js/` is meant to be linked or copied into a consuming
project, not imported from a package. It's a thin, mechanical IPC wrapper
(command names, `invoke()` argument shapes, and event names only) with no
logic worth reimplementing differently, so it's ported here 1:1 rather
than reinvented.

To update: bump the `rev` in `macos-app/src-tauri/Cargo.toml`, then diff
`guest-js/index.ts`/`guest-js/types.ts` at the new commit against this file
and `app/trainer/tauri-ble-shim.mjs` for any API changes.
