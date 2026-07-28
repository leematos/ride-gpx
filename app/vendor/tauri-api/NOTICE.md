# Vendored: @tauri-apps/api (core module only)

`core.js` and `external/tslib/tslib.es6.js` are the unmodified `core.js` /
`external/tslib/tslib.es6.js` files from the
[@tauri-apps/api](https://www.npmjs.com/package/@tauri-apps/api) v2.11.1
npm package, fetched from the registry tarball. Licensed under
Apache-2.0 OR MIT (see `LICENSE_APACHE-2.0` / `LICENSE_MIT`).

Only the `core` submodule (`invoke` + `Channel`, used to call Tauri plugin
commands over IPC) is vendored — the rest of `@tauri-apps/api` is unused by
this app. Vendored rather than installed as an npm dependency for the same
reason Leaflet is vendored in `app/vendor/leaflet/`: this is a no-build
static app, so `@mnlphlp/plugin-blec` (also vendored, see
`app/vendor/plugin-blec/`) is loaded as a native ESM import resolved via an
import map in `app.html` — no bundler, no `node_modules`.

To update: download the new version's tarball from
`https://registry.npmjs.org/@tauri-apps/api/-/api-<version>.tgz` and replace
`core.js` / `external/tslib/tslib.es6.js` with the matching files from it.
