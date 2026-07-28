#!/usr/bin/env python3
# Run only by .github/workflows/build-macos-app.yml, on the checkout that
# feeds macos-app/'s frontendDist (a copy of app/ that gets bundled into the
# .app — this never touches the committed app/app.html). Injects the Tauri
# Bluetooth bridge's import map + tauri-ble-shim.mjs <script> tag
# immediately before app.js, so the browser/GitHub Pages build and every
# local checkout never ship or even see this Tauri-only markup. See
# macos-app/README.md "How the Bluetooth bridge works".
import pathlib
import re

APP_HTML_PATH = pathlib.Path("app/app.html")
APP_JS_SCRIPT_LINE = '<script src="./app.js" type="module"></script>'
APP_JS_SCRIPT_PATTERN = re.compile(r"(?m)^([ \t]*)" + re.escape(APP_JS_SCRIPT_LINE) + r"[ \t]*$")

BRIDGE_SNIPPET = """<!-- Injected by .github/workflows/build-macos-app.yml — never present in
     the browser/GitHub Pages build. Loaded before app.js so
     navigator.bluetooth is polyfilled by the time trainer.mjs/heartrate.mjs
     use it. -->
<script type="importmap">
  {
    "imports": {
      "@tauri-apps/api/core": "./vendor/tauri-api/core.js",
      "@tauri-apps/api/event": "./vendor/tauri-api/event.js"
    }
  }
</script>
<script src="./trainer/tauri-ble-shim.mjs" type="module"></script>"""


def main():
    text = APP_HTML_PATH.read_text()
    match = APP_JS_SCRIPT_PATTERN.search(text)
    if not match:
        raise SystemExit(f"expected exactly one app.js <script> line in {APP_HTML_PATH}, found 0")

    indent = match.group(1)
    indented_snippet = "\n".join(f"{indent}{line}" for line in BRIDGE_SNIPPET.splitlines())

    updated, count = APP_JS_SCRIPT_PATTERN.subn(lambda m: f"{indented_snippet}\n{m.group(0)}", text, count=1)
    if count != 1:
        raise SystemExit(f"expected exactly one app.js <script> line in {APP_HTML_PATH}, found {count}")
    APP_HTML_PATH.write_text(updated)


if __name__ == "__main__":
    main()
