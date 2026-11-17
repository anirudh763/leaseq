"""Prepare the public browser simulator for a GitHub Pages `/docs` source.

This copies only the dashboard shell and public static assets. It configures no
API, secrets, user data or worker service. Running it is a local build action;
it does not publish anything.
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "leaseq" / "dashboard"
OUTPUT = ROOT / "docs"


def update_source_worker_hashes() -> None:
    worker = SOURCE / "sw.js"
    text = worker.read_text()
    match = re.search(r"const REQUIRED = \[(.*?)\];", text, re.S)
    if not match:
        raise SystemExit("Could not read required service-worker asset list.")
    keys = re.findall(r"'([^']+)'", match.group(1))
    entries = []
    for key in keys:
        path = SOURCE / key.removeprefix("./") if key != "./" else SOURCE / "index.html"
        if not path.is_file():
            raise SystemExit(f"Required offline asset is missing: {path}")
        entries.append(f"  {json_quote(key)}: '{hashlib.sha256(path.read_bytes()).hexdigest()}',")
    block = "const SHA256 = Object.freeze({\n" + "\n".join(entries) + "\n});"
    text, changed = re.subn(r"const SHA256 = Object\.freeze\(\{[\s\S]*?\}\);", lambda _: block, text, count=1)
    if changed != 1:
        raise SystemExit("Could not update the service-worker digest manifest.")
    worker.write_text(text)


def json_quote(value: str) -> str:
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


def main() -> None:
    update_source_worker_hashes()
    OUTPUT.mkdir(exist_ok=True)
    for name in ("index.html", "manifest.webmanifest", "sw.js", "og-card.png", "supabase-leaseq-workspaces.sql", "pages", "assets"):
        source = SOURCE / name
        if not source.exists():
            continue
        target = OUTPUT / name
        if source.is_dir():
            shutil.copytree(source, target, dirs_exist_ok=True)
        else:
            shutil.copy2(source, target)

    index = OUTPUT / "index.html"
    html = index.read_text()
    html = html.replace("/dashboard/", "./")
    html, replaced = re.subn(r'(<meta\s+name="leaseq-api-base"\s+content=")[^"]*(">)', r'\1none\2', html, count=1)
    if replaced != 1:
        raise SystemExit("Expected exactly one LeaseQ API-origin meta setting in static output.")
    index.write_text(html)
    manifest = OUTPUT / "manifest.webmanifest"
    metadata = json.loads(manifest.read_text())
    metadata.update(id="./", scope="./", start_url="./#/")
    manifest.write_text(json.dumps(metadata, indent=2) + "\n")
    digest = hashlib.sha256(index.read_bytes()).hexdigest()
    worker = OUTPUT / "sw.js"
    source_text = worker.read_text()
    for key, path in (("./", index), ("./manifest.webmanifest", manifest)):
        pin = hashlib.sha256(path.read_bytes()).hexdigest()
        pattern = r"(" + re.escape(json_quote(key)) + r":\s*')[a-f0-9]{64}(')"
        source_text, changed = re.subn(pattern, lambda match: match[1] + pin + match[2], source_text, count=1)
        if changed != 1:
            raise SystemExit(f"Could not update the static {key} digest in the service worker.")
    worker.write_text(source_text)
    print(f"Prepared {index.relative_to(ROOT)} ({digest}); API disabled; nothing published.")


if __name__ == "__main__":
    main()
