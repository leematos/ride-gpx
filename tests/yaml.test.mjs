import assert from "node:assert/strict";
import test from "node:test";
import { parseYaml, parseScalar } from "../app/core/yaml.mjs";

test("scalars: strings, numbers, booleans, null, infinity", () => {
  assert.equal(parseScalar('"#57b877"'), "#57b877");
  assert.equal(parseScalar("'single'"), "single");
  assert.equal(parseScalar("bare string"), "bare string");
  assert.equal(parseScalar("42"), 42);
  assert.equal(parseScalar("-0.35"), -0.35);
  assert.equal(parseScalar("1.5e3"), 1500);
  assert.equal(parseScalar("true"), true);
  assert.equal(parseScalar("false"), false);
  assert.equal(parseScalar("null"), null);
  assert.equal(parseScalar(".inf"), Infinity);
  assert.equal(parseScalar("-.inf"), -Infinity);
});

test("block maps with comments and nesting", () => {
  const doc = parseYaml(`
# full-line comment
A: 1
B: "two"  # trailing comment
NESTED:
  x: 1.5
  y: "#not-a-comment"
  deeper:
    z: true
C: -3
`);
  assert.deepEqual(doc, {
    A: 1,
    B: "two",
    NESTED: { x: 1.5, y: "#not-a-comment", deeper: { z: true } },
    C: -3,
  });
});

test("block sequences of scalars and of maps", () => {
  const doc = parseYaml(`
ORDER:
  - speed
  - ascentLeft
  - eta
ZONES:
  - name: Recovery
    color: "#8b949e"
  - name: Endurance
    color: "#4f9bff"
`);
  assert.deepEqual(doc.ORDER, ["speed", "ascentLeft", "eta"]);
  assert.deepEqual(doc.ZONES, [
    { name: "Recovery", color: "#8b949e" },
    { name: "Endurance", color: "#4f9bff" },
  ]);
});

test("flow sequences and maps, nested, with infinity", () => {
  const doc = parseYaml(`
SPANS:
  - [2300, 3900]
  - [10400, .inf]
TABLE:
  - { min: 0, label: XS }
  - { min: 20, label: "S" }
INLINE: [1, [2, 3], { a: 4 }]
`);
  assert.deepEqual(doc.SPANS, [[2300, 3900], [10400, Infinity]]);
  assert.deepEqual(doc.TABLE, [{ min: 0, label: "XS" }, { min: 20, label: "S" }]);
  assert.deepEqual(doc.INLINE, [1, [2, 3], { a: 4 }]);
});

test("colors and colons survive quoting rules", () => {
  const doc = parseYaml(`
COLOR: "#ff2d2d"
RGBA: "rgba(255, 255, 255, 0.72)"
RATIO: "16:9"
`);
  assert.equal(doc.COLOR, "#ff2d2d");
  assert.equal(doc.RGBA, "rgba(255, 255, 255, 0.72)");
  assert.equal(doc.RATIO, "16:9");
});

test("unparsed garbage throws instead of silently mis-reading", () => {
  assert.throws(() => parseYaml("KEY value with no colon"));
  assert.throws(() => parseScalar('"unterminated'));
});
