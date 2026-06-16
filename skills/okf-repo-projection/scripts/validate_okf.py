#!/usr/bin/env python3
"""Validate hard OKF v0.1 conformance for a bundle directory."""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

try:
    import yaml  # type: ignore
except Exception:  # pragma: no cover - optional dependency
    yaml = None


FRONTMATTER_DELIMITER = "---"
DATE_HEADING_RE = re.compile(r"^##\s+(\d{4}-\d{2}-\d{2})(?:\s*)$")
ANY_DATE_HEADING_RE = re.compile(r"^##\s+(.+?)\s*$")
MARKDOWN_LINK_RE = re.compile(r"(?<!!)\[[^\]]+\]\(([^)]+)\)")
LOCAL_SCHEMES = {"", None}
SKIP_DIRS = {".git", ".hg", ".svn", "node_modules", ".venv", "venv", "__pycache__"}


@dataclass
class Finding:
    level: str
    path: Path
    message: str


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate an OKF bundle directory.")
    parser.add_argument("bundle", type=Path, help="Path to the OKF bundle directory")
    args = parser.parse_args()

    bundle = args.bundle.resolve()
    findings: list[Finding] = []

    if not bundle.exists():
        print(f"ERROR: bundle does not exist: {bundle}", file=sys.stderr)
        return 2
    if not bundle.is_dir():
        print(f"ERROR: bundle is not a directory: {bundle}", file=sys.stderr)
        return 2

    markdown_files = sorted(iter_markdown_files(bundle))
    for path in markdown_files:
        rel = path.relative_to(bundle)
        text = read_text(path, findings)
        if text is None:
            continue

        if path.name == "index.md":
            validate_index(bundle, path, rel, text, findings)
        elif path.name == "log.md":
            validate_log(path, rel, text, findings)
        else:
            validate_concept(path, rel, text, findings)

        validate_links(bundle, path, rel, text, findings)

    errors = [finding for finding in findings if finding.level == "error"]
    warnings = [finding for finding in findings if finding.level == "warning"]

    for finding in findings:
        location = finding.path.as_posix()
        print(f"{finding.level.upper()}: {location}: {finding.message}")

    if errors:
        print(f"\nOKF validation failed: {len(errors)} error(s), {len(warnings)} warning(s).")
        return 1

    print(f"OKF validation passed: 0 error(s), {len(warnings)} warning(s).")
    return 0


def iter_markdown_files(bundle: Path) -> list[Path]:
    files: list[Path] = []
    for path in bundle.rglob("*.md"):
        if any(part in SKIP_DIRS for part in path.relative_to(bundle).parts):
            continue
        files.append(path)
    return files


def read_text(path: Path, findings: list[Finding]) -> str | None:
    try:
        return path.read_text(encoding="utf-8-sig")
    except UnicodeDecodeError as exc:
        findings.append(Finding("error", path, f"file is not valid UTF-8: {exc}"))
    except OSError as exc:
        findings.append(Finding("error", path, f"could not read file: {exc}"))
    return None


def split_frontmatter(text: str) -> tuple[str, str] | None:
    lines = text.splitlines()
    if not lines or lines[0].strip() != FRONTMATTER_DELIMITER:
        return None

    for index in range(1, len(lines)):
        if lines[index].strip() == FRONTMATTER_DELIMITER:
            frontmatter = "\n".join(lines[1:index])
            body = "\n".join(lines[index + 1 :])
            return frontmatter, body
    return None


def parse_frontmatter(frontmatter: str, path: Path, findings: list[Finding]) -> dict[str, Any] | None:
    if yaml is not None:
        try:
            parsed = yaml.safe_load(frontmatter) if frontmatter.strip() else {}
        except Exception as exc:
            findings.append(Finding("error", path, f"frontmatter is not parseable YAML: {exc}"))
            return None
        if parsed is None:
            return {}
        if not isinstance(parsed, dict):
            findings.append(Finding("error", path, "frontmatter must be a YAML mapping."))
            return None
        return parsed

    return parse_simple_yaml_mapping(frontmatter, path, findings)


def parse_simple_yaml_mapping(frontmatter: str, path: Path, findings: list[Finding]) -> dict[str, Any] | None:
    parsed: dict[str, Any] = {}
    lines = frontmatter.splitlines()
    index = 0

    while index < len(lines):
        raw_line = lines[index]
        stripped = raw_line.strip()
        index += 1

        if not stripped or stripped.startswith("#"):
            continue
        if raw_line[:1].isspace():
            findings.append(Finding("error", path, f"unsupported indented frontmatter line without PyYAML: {raw_line!r}"))
            return None

        match = re.match(r"^([A-Za-z0-9_.-]+):(?:\s*(.*))?$", stripped)
        if not match:
            findings.append(Finding("error", path, f"frontmatter line is not a simple YAML key/value pair: {raw_line!r}"))
            return None

        key = match.group(1)
        value = match.group(2) or ""

        if value == "":
            block_values: list[str] = []
            while index < len(lines):
                next_line = lines[index]
                next_stripped = next_line.strip()
                if not next_stripped or next_stripped.startswith("#"):
                    index += 1
                    continue
                if not next_line[:1].isspace():
                    break
                item = next_stripped
                if item.startswith("- "):
                    block_values.append(parse_scalar(item[2:].strip()))
                    index += 1
                    continue
                findings.append(
                    Finding("error", path, f"unsupported nested frontmatter line without PyYAML: {next_line!r}")
                )
                return None
            parsed[key] = block_values if block_values else ""
            continue

        parsed[key] = parse_scalar(value)

    return parsed


def parse_scalar(value: str) -> Any:
    value = value.strip()
    if not value:
        return ""
    if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
        return value[1:-1]
    if value.startswith("[") and value.endswith("]"):
        inner = value[1:-1].strip()
        if not inner:
            return []
        return [parse_scalar(part.strip()) for part in inner.split(",")]
    if value.lower() == "true":
        return True
    if value.lower() == "false":
        return False
    if value.lower() in {"null", "~"}:
        return None
    return value


def validate_concept(path: Path, rel: Path, text: str, findings: list[Finding]) -> None:
    parts = split_frontmatter(text)
    if parts is None:
        findings.append(Finding("error", rel, "concept document must start with YAML frontmatter."))
        return

    frontmatter, _body = parts
    parsed = parse_frontmatter(frontmatter, rel, findings)
    if parsed is None:
        return

    concept_type = parsed.get("type")
    if not isinstance(concept_type, str) or not concept_type.strip():
        findings.append(Finding("error", rel, "concept frontmatter must contain a non-empty string `type`."))


def validate_index(bundle: Path, path: Path, rel: Path, text: str, findings: list[Finding]) -> None:
    parts = split_frontmatter(text)
    if parts is None:
        return

    is_root_index = path.parent.resolve() == bundle.resolve()
    if not is_root_index:
        findings.append(Finding("error", rel, "`index.md` must not contain frontmatter outside the bundle root."))
        return

    frontmatter, _body = parts
    parsed = parse_frontmatter(frontmatter, rel, findings)
    if parsed is None:
        return
    extra_keys = sorted(key for key in parsed.keys() if key != "okf_version")
    if extra_keys:
        findings.append(
            Finding(
                "error",
                rel,
                f"root `index.md` frontmatter may only declare `okf_version`; found: {', '.join(extra_keys)}",
            )
        )


def validate_log(path: Path, rel: Path, text: str, findings: list[Finding]) -> None:
    if split_frontmatter(text) is not None:
        findings.append(Finding("error", rel, "`log.md` must not contain frontmatter."))

    for line_number, line in enumerate(text.splitlines(), start=1):
        match = ANY_DATE_HEADING_RE.match(line)
        if match and DATE_HEADING_RE.match(line) is None:
            findings.append(
                Finding(
                    "error",
                    rel,
                    f"`log.md` level-2 heading on line {line_number} must use YYYY-MM-DD.",
                )
            )


def validate_links(bundle: Path, path: Path, rel: Path, text: str, findings: list[Finding]) -> None:
    for raw_target in MARKDOWN_LINK_RE.findall(text):
        target = normalize_link_target(raw_target)
        if target is None:
            continue

        if target.startswith("/"):
            candidate = bundle / target.lstrip("/")
        else:
            candidate = path.parent / target

        candidate = candidate.resolve()
        try:
            candidate.relative_to(bundle)
        except ValueError:
            continue

        if candidate.exists():
            continue
        if candidate.suffix == "" and (candidate / "index.md").exists():
            continue

        findings.append(Finding("warning", rel, f"local link target does not exist: {raw_target}"))


def normalize_link_target(raw_target: str) -> str | None:
    target = raw_target.strip()
    if not target or target.startswith("#"):
        return None

    target = target.split("#", 1)[0].split("?", 1)[0].strip()
    if not target:
        return None

    parsed = urlparse(target)
    if parsed.scheme not in LOCAL_SCHEMES:
        return None
    if parsed.netloc:
        return None

    return unquote(target)


if __name__ == "__main__":
    raise SystemExit(main())
