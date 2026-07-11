// Minimal YAML-subset parser for tuning.yaml — hand-rolled (like fit.mjs and
// the GLB generator) because this no-build app takes no dependencies, and the
// config only needs a small, well-defined slice of YAML. The same subset is
// implemented in scripts/tuning_config.py for the Python generators; if you
// extend one, extend the other and the shared tests.
//
// Supported subset (documented at the top of tuning.yaml too):
//   - `#` comments: full-line, or trailing after whitespace (outside quotes)
//   - block maps nested by indentation (2 spaces per level)
//   - block sequences (`- item`), items may be scalars, flow collections, or
//     nested block maps
//   - flow sequences `[a, b, [c]]` and flow maps `{ k: v }`, nestable
//   - scalars: double/single-quoted strings, bare strings, numbers
//     (int/float/exponent), true/false/null, and .inf/-.inf/Infinity
// NOT supported (not needed by the config): anchors/aliases, multi-line block
// scalars (| and >), multi-document streams, tags, flow keys.

export function parseYaml(text) {
  const lines = [];
  for (const raw of text.split("\n")) {
    const withoutComment = stripComment(raw);
    if (!withoutComment.trim()) continue;
    const indent = withoutComment.length - withoutComment.trimStart().length;
    lines.push({ indent, text: withoutComment.trim() });
  }
  if (!lines.length) return {};
  const [value, next] = parseBlock(lines, 0, lines[0].indent);
  if (next !== lines.length) {
    throw new Error(`YAML: unparsed content starting at "${lines[next].text}"`);
  }
  return value;
}

// Remove a trailing comment: a `#` at line start or preceded by whitespace,
// outside single/double quotes.
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#" && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) {
      return line.slice(0, i);
    }
  }
  return line;
}

// Parse a run of lines at exactly `indent` into a map or sequence.
function parseBlock(lines, start, indent) {
  if (lines[start].text.startsWith("- ") || lines[start].text === "-") {
    return parseSequence(lines, start, indent);
  }
  return parseMap(lines, start, indent);
}

function parseMap(lines, start, indent) {
  const map = {};
  let i = start;
  while (i < lines.length && lines[i].indent === indent && !lines[i].text.startsWith("- ")) {
    const line = lines[i].text;
    const colon = findColon(line);
    if (colon === -1) throw new Error(`YAML: expected "key: value", got "${line}"`);
    const key = parseScalar(line.slice(0, colon).trim());
    const rest = line.slice(colon + 1).trim();
    if (rest) {
      map[key] = parseScalar(rest);
      i += 1;
    } else {
      // Value is the nested block on the following deeper-indented lines.
      if (i + 1 < lines.length && lines[i + 1].indent > indent) {
        const [value, next] = parseBlock(lines, i + 1, lines[i + 1].indent);
        map[key] = value;
        i = next;
      } else {
        map[key] = null;
        i += 1;
      }
    }
  }
  return [map, i];
}

function parseSequence(lines, start, indent) {
  const seq = [];
  let i = start;
  while (i < lines.length && lines[i].indent === indent && (lines[i].text.startsWith("- ") || lines[i].text === "-")) {
    const rest = lines[i].text.slice(1).trim();
    if (!rest) {
      // Item is a nested block on the following deeper-indented lines.
      if (i + 1 < lines.length && lines[i + 1].indent > indent) {
        const [value, next] = parseBlock(lines, i + 1, lines[i + 1].indent);
        seq.push(value);
        i = next;
      } else {
        seq.push(null);
        i += 1;
      }
      continue;
    }
    // `- key: value` starts an inline block map whose remaining keys sit on
    // the following lines, indented past the dash.
    const colon = findColon(rest);
    if (colon !== -1 && !isFlowStart(rest)) {
      const itemIndent = lines[i].indent + 2;
      const injected = { indent: itemIndent, text: rest };
      const tail = [];
      let j = i + 1;
      while (j < lines.length && lines[j].indent >= itemIndent && !(lines[j].indent === indent && lines[j].text.startsWith("- "))) {
        tail.push(lines[j]);
        j += 1;
      }
      const [value] = parseMap([injected, ...tail], 0, itemIndent);
      seq.push(value);
      i = j;
    } else {
      seq.push(parseScalar(rest));
      i += 1;
    }
  }
  return [seq, i];
}

// Index of the first `:` that separates key from value (followed by a space
// or end of line, outside quotes/flow) — colons inside values don't count.
function findColon(text) {
  let quote = null;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[" || ch === "{") depth += 1;
    else if (ch === "]" || ch === "}") depth -= 1;
    else if (ch === ":" && depth === 0 && (i + 1 === text.length || text[i + 1] === " ")) return i;
  }
  return -1;
}

function isFlowStart(text) {
  return text.startsWith("[") || text.startsWith("{");
}

export function parseScalar(text) {
  if (isFlowStart(text)) {
    const [value, next] = parseFlow(text, 0);
    if (text.slice(next).trim()) throw new Error(`YAML: trailing content after ${text}`);
    return value;
  }
  if (text.startsWith('"') || text.startsWith("'")) {
    const quote = text[0];
    if (!text.endsWith(quote) || text.length < 2) throw new Error(`YAML: unterminated string ${text}`);
    return text.slice(1, -1);
  }
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null" || text === "~") return null;
  if (text === ".inf" || text === "Infinity") return Infinity;
  if (text === "-.inf" || text === "-Infinity") return -Infinity;
  if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(text)) return Number(text);
  return text; // bare string
}

// Flow collections: JSON-like `[...]` / `{...}` with optional quoting.
function parseFlow(text, at) {
  const open = text[at];
  const close = open === "[" ? "]" : "}";
  const isSeq = open === "[";
  const out = isSeq ? [] : {};
  let i = at + 1;

  const skipSpaces = () => { while (text[i] === " ") i += 1; };
  const readToken = () => {
    // A scalar token runs to the next `,`/closer at depth 0 (quotes respected).
    let quote = null;
    let depth = 0;
    const start = i;
    for (; i < text.length; i += 1) {
      const ch = text[i];
      if (quote) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "[" || ch === "{") depth += 1;
      else if (ch === "]" || ch === "}") { if (depth === 0) break; depth -= 1; }
      else if (ch === "," && depth === 0) break;
      else if (ch === ":" && depth === 0 && !isSeq && text[i + 1] === " ") break;
    }
    return text.slice(start, i).trim();
  };

  skipSpaces();
  while (i < text.length && text[i] !== close) {
    let value;
    if (text[i] === "[" || text[i] === "{") {
      [value, i] = parseFlow(text, i);
    } else {
      value = readToken();
    }
    skipSpaces();
    if (!isSeq) {
      // `value` was the key; expect `: ` then the value.
      if (text[i] !== ":") throw new Error(`YAML: expected ":" in flow map ${text}`);
      i += 1;
      skipSpaces();
      let inner;
      if (text[i] === "[" || text[i] === "{") {
        [inner, i] = parseFlow(text, i);
      } else {
        inner = parseScalar(readToken());
      }
      out[typeof value === "string" ? parseScalar(value) : value] = inner;
    } else {
      out.push(typeof value === "string" ? parseScalar(value) : value);
    }
    skipSpaces();
    if (text[i] === ",") { i += 1; skipSpaces(); }
  }
  if (text[i] !== close) throw new Error(`YAML: unterminated flow collection in ${text}`);
  return [out, i + 1];
}
