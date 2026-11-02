#!/usr/bin/env python3
"""Build a portable XPI and a corresponding source archive, using only Python stdlib."""
import hashlib
import json
from pathlib import Path
import zipfile
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
manifest = json.loads((ROOT / "plugin/manifest.json").read_text())
settings = manifest["applications"]["zotero"]
for key in ["id", "update_url", "strict_min_version", "strict_max_version"]:
    if not settings.get(key):
        raise ValueError(f"Zotero requires applications.zotero.{key}")
if urlparse(settings["update_url"]).scheme != "https":
    raise ValueError("Zotero requires an HTTPS update_url, even for a manually updated plugin")
if settings["id"] == "litmatrix@bapungiri":
    raise ValueError("This plugin must not replace the upstream LitMatrix installation")
version = manifest["version"]
package = json.loads((ROOT / "package.json").read_text())
if package["version"] != version:
    raise ValueError("package.json and manifest.json versions must match")
dist = ROOT / "dist"
dist.mkdir(exist_ok=True)
target = dist / f"research-grid-{version}.xpi"
with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
    for path in sorted((ROOT / "plugin").rglob("*")):
        if path.is_file() and path.name != ".DS_Store":
            archive.write(path, path.relative_to(ROOT / "plugin").as_posix())
    for name in ["LICENSE", "NOTICE", "README.md"]:
        archive.write(ROOT / name, name)
source = dist / f"research-grid-{version}-source.zip"
with zipfile.ZipFile(source, "w", zipfile.ZIP_DEFLATED) as archive:
    # Explicit allowlist: never bundle local research exports or work logs.
    files = [ROOT / name for name in [
        ".gitignore", "package.json", "package-lock.json", "README.md",
        "LICENSE", "NOTICE", "VALIDATION.md", "CHANGELOG.md", "CONTRIBUTING.md",
    ]]
    for directory in ["plugin", "scripts", "tests", ".github"]:
        files.extend(p for p in (ROOT / directory).rglob("*") if p.is_file())
    for path in sorted(files):
        if not path.is_file() or path.name == ".DS_Store" or "__pycache__" in path.parts:
            continue
        archive.write(path, Path(f"research-grid-{version}") / path.relative_to(ROOT))
checksums = "".join(f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n" for p in [target, source])
(dist / "SHA256SUMS").write_text(checksums)
print(target)
print(source)
print(checksums, end="")
