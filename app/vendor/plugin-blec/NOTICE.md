# Vendored: @mnlphlp/plugin-blec

`index.js` is the unmodified `dist-js/index.js` build of
[@mnlphlp/plugin-blec](https://www.npmjs.com/package/@mnlphlp/plugin-blec)
v0.12.0 (the JS bindings for the
[tauri-plugin-blec](https://github.com/MnlPhlp/tauri-plugin-blec) Rust BLE
plugin), fetched from the npm registry tarball. Licensed MIT OR Apache-2.0;
see the upstream repository for full license text.

Vendored (not an npm dependency) for the same reason Leaflet is vendored in
`app/vendor/leaflet/`: this is a no-build static app, and the file is used
as-is via a native ESM import — no bundler involved.

To update: download the new version's tarball from
`https://registry.npmjs.org/@mnlphlp/plugin-blec/-/plugin-blec-<version>.tgz`
and replace `index.js` with `dist-js/index.js` from it.
