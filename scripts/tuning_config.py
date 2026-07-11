"""Reader for app/core/tuning.yaml — the shared JS/Python configuration.

Implements the same deliberately small YAML subset as app/core/yaml.mjs (see
the header of tuning.yaml for the format definition), with no third-party
dependencies, so the generator scripts read the exact same file the app does
instead of mirroring values by hand. If you extend the subset here, extend
yaml.mjs and the shared tests too.
"""

import pathlib
import re

TUNING_YAML = pathlib.Path(__file__).resolve().parent.parent / "app" / "core" / "tuning.yaml"

_NUMBER_RE = re.compile(r"^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$")


def load_tuning(path=TUNING_YAML):
    """Parse tuning.yaml into a dict of plain Python values."""
    return parse_yaml(pathlib.Path(path).read_text(encoding="utf-8"))


def parse_yaml(text):
    lines = []
    for raw in text.split("\n"):
        stripped = _strip_comment(raw)
        if not stripped.strip():
            continue
        indent = len(stripped) - len(stripped.lstrip(" "))
        lines.append((indent, stripped.strip()))
    if not lines:
        return {}
    value, nxt = _parse_block(lines, 0, lines[0][0])
    if nxt != len(lines):
        raise ValueError(f'YAML: unparsed content starting at "{lines[nxt][1]}"')
    return value


def _strip_comment(line):
    quote = None
    for i, ch in enumerate(line):
        if quote:
            if ch == quote:
                quote = None
            continue
        if ch in ('"', "'"):
            quote = ch
        elif ch == "#" and (i == 0 or line[i - 1] in (" ", "\t")):
            return line[:i]
    return line


def _parse_block(lines, start, indent):
    if lines[start][1].startswith("- ") or lines[start][1] == "-":
        return _parse_sequence(lines, start, indent)
    return _parse_map(lines, start, indent)


def _parse_map(lines, start, indent):
    out = {}
    i = start
    while i < len(lines) and lines[i][0] == indent and not lines[i][1].startswith("- "):
        text = lines[i][1]
        colon = _find_colon(text)
        if colon == -1:
            raise ValueError(f'YAML: expected "key: value", got "{text}"')
        key = parse_scalar(text[:colon].strip())
        rest = text[colon + 1:].strip()
        if rest:
            out[key] = parse_scalar(rest)
            i += 1
        elif i + 1 < len(lines) and lines[i + 1][0] > indent:
            out[key], i = _parse_block(lines, i + 1, lines[i + 1][0])
        else:
            out[key] = None
            i += 1
    return out, i


def _parse_sequence(lines, start, indent):
    out = []
    i = start
    while i < len(lines) and lines[i][0] == indent and (lines[i][1].startswith("- ") or lines[i][1] == "-"):
        rest = lines[i][1][1:].strip()
        if not rest:
            if i + 1 < len(lines) and lines[i + 1][0] > indent:
                value, i = _parse_block(lines, i + 1, lines[i + 1][0])
                out.append(value)
            else:
                out.append(None)
                i += 1
            continue
        colon = _find_colon(rest)
        if colon != -1 and not rest.startswith(("[", "{")):
            # `- key: value` starts a block map; its other keys follow, indented.
            item_indent = indent + 2
            injected = [(item_indent, rest)]
            j = i + 1
            while (
                j < len(lines)
                and lines[j][0] >= item_indent
                and not (lines[j][0] == indent and lines[j][1].startswith("- "))
            ):
                injected.append(lines[j])
                j += 1
            value, _ = _parse_map(injected, 0, item_indent)
            out.append(value)
            i = j
        else:
            out.append(parse_scalar(rest))
            i += 1
    return out, i


def _find_colon(text):
    quote = None
    depth = 0
    for i, ch in enumerate(text):
        if quote:
            if ch == quote:
                quote = None
            continue
        if ch in ('"', "'"):
            quote = ch
        elif ch in "[{":
            depth += 1
        elif ch in "]}":
            depth -= 1
        elif ch == ":" and depth == 0 and (i + 1 == len(text) or text[i + 1] == " "):
            return i
    return -1


def parse_scalar(text):
    if text.startswith(("[", "{")):
        value, nxt = _parse_flow(text, 0)
        if text[nxt:].strip():
            raise ValueError(f"YAML: trailing content after {text}")
        return value
    if text.startswith(('"', "'")):
        quote = text[0]
        if len(text) < 2 or not text.endswith(quote):
            raise ValueError(f"YAML: unterminated string {text}")
        return text[1:-1]
    if text == "true":
        return True
    if text == "false":
        return False
    if text in ("null", "~"):
        return None
    if text in (".inf", "Infinity"):
        return float("inf")
    if text in ("-.inf", "-Infinity"):
        return float("-inf")
    if _NUMBER_RE.match(text):
        number = float(text)
        return int(number) if number.is_integer() and "." not in text and "e" not in text.lower() else number
    return text  # bare string


def _parse_flow(text, at):
    is_seq = text[at] == "["
    close = "]" if is_seq else "}"
    out = [] if is_seq else {}
    i = at + 1

    def skip_spaces(i):
        while i < len(text) and text[i] == " ":
            i += 1
        return i

    def read_token(i):
        quote = None
        depth = 0
        start = i
        while i < len(text):
            ch = text[i]
            if quote:
                if ch == quote:
                    quote = None
            elif ch in ('"', "'"):
                quote = ch
            elif ch in "[{":
                depth += 1
            elif ch in "]}":
                if depth == 0:
                    break
                depth -= 1
            elif ch == "," and depth == 0:
                break
            elif ch == ":" and depth == 0 and not is_seq and i + 1 < len(text) and text[i + 1] == " ":
                break
            i += 1
        return text[start:i].strip(), i

    i = skip_spaces(i)
    while i < len(text) and text[i] != close:
        if text[i] in "[{":
            value, i = _parse_flow(text, i)
        else:
            value, i = read_token(i)
        i = skip_spaces(i)
        if not is_seq:
            if i >= len(text) or text[i] != ":":
                raise ValueError(f'YAML: expected ":" in flow map {text}')
            i = skip_spaces(i + 1)
            if text[i] in "[{":
                inner, i = _parse_flow(text, i)
            else:
                token, i = read_token(i)
                inner = parse_scalar(token)
            out[parse_scalar(value) if isinstance(value, str) else value] = inner
        else:
            out.append(parse_scalar(value) if isinstance(value, str) else value)
        i = skip_spaces(i)
        if i < len(text) and text[i] == ",":
            i = skip_spaces(i + 1)
    if i >= len(text) or text[i] != close:
        raise ValueError(f"YAML: unterminated flow collection in {text}")
    return out, i + 1
