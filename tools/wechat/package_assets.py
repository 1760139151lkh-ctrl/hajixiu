"""Pack the original WebP bytes into native WeChat modules."""
import base64
import io
import json
from pathlib import Path
import sys
from PIL import Image


# Leave space for the module wrapper and the native subpackage entry.
MAX_PAYLOAD = 1_985_000
BOOTSTRAP = "art-start"
TOUR_COVERS = {
    "princess", "inkfairy", "hero", "shoujo", "neon", "dragon",
    "peranakan", "magical", "hkfilm", "robot", "anime", "tarot",
    "figure", "handdrawn", "gothic", "clay", "wuxia", "ccd",
}


def poster_variants(folder, name):
    return [f"{folder}/{name}{suffix}.webp" for suffix in ("", "-m", "-t")]


def artwork(manifest):
    people = [name for who in manifest["people"] for name in poster_variants("people", who)]
    posters = [
        name
        for style, sitters in manifest["styles"].items()
        for who in sitters
        for name in poster_variants(f"styles/{style}", who)
    ]
    scene_art = [
        f"{folder}/{name}.webp"
        for folder in ("bg", "stickers", "scenes")
        for name in manifest[folder]
    ]
    return people + scene_art + [p for p in posters if p.endswith(("-m.webp", "-t.webp"))] + [
        p for p in posters if not p.endswith(("-m.webp", "-t.webp"))
    ]


def startup_art(name):
    return name in ("people/mei.webp", "styles/princess/mei.webp", "bg/brand.webp", "bg/princess.webp")


def tour_cover(name):
    parts = name.split("/")
    return len(parts) == 3 and parts[0] == "styles" and parts[1] in TOUR_COVERS and parts[2] == "mei.webp"


def pack_webp(path, max_size, quality):
    with Image.open(path) as raw:
        im = raw.convert("RGB")
        if im.size[0] > max_size[0] or im.size[1] > max_size[1]:
            im = im.resize(max_size, Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, "WEBP", quality=quality, method=6)
        return buf.getvalue()


def encode(source, name, remote_originals=False):
    path = source / name
    # When studio originals are served remotely after pairing, pack crisp 768x1152
    # covers for onboarding / empty showcase so the mini program stays < 20 MB while
    # looking sharp offline, and still upgrade to full 1024x1536 originals once paired.
    if remote_originals and (tour_cover(name) or (name.startswith("people/") and not name.endswith(("-m.webp", "-t.webp")))):
        data = pack_webp(path, (768, 1152), 85)
    else:
        data = path.read_bytes()
    # Standard Base85 packs every four bytes into five JS-safe characters.
    # The original WebP data is never decoded or resampled.
    value = base64.b85encode(data, pad=True).decode("ascii")
    return len(data), value


def write_module(path, records):
    path.write_text(
        "module.exports = " + json.dumps(records, separators=(",", ":")) + "\n",
        encoding="ascii",
    )


def package(source, target, remote_originals=False):
    manifest = json.loads((source / "manifest.json").read_text(encoding="utf-8"))
    index, bootstrap, roots = {}, {}, []
    records, payload_size = {}, 0
    target.mkdir(parents=True, exist_ok=True)

    def emit_pack():
        pack = f"art{len(roots) + 1:02}"
        directory = target / pack
        directory.mkdir(exist_ok=True)
        write_module(directory / "assets.js", records)
        (directory / "entry.js").write_text("Page({});\n", encoding="ascii")
        (directory / "entry.wxml").write_text("<view />\n", encoding="ascii")
        index.update((name, pack) for name in records)
        roots.append(pack)

    for name in dict.fromkeys(artwork(manifest)):
        if remote_originals and name.startswith("styles/") and not name.endswith(("-m.webp", "-t.webp")) and not startup_art(name) and not tour_cover(name):
            continue
        key = "/img/" + name
        record = encode(source, name, remote_originals)
        if startup_art(name):
            bootstrap[key] = record
            continue
        size = len(record[1]) + len(key) + 32
        if size > MAX_PAYLOAD:
            raise ValueError(f"Artwork is too large for a WeChat subpackage: {name}")
        if payload_size + size > MAX_PAYLOAD:
            emit_pack()
            records, payload_size = {}, 0
        records[key] = record
        payload_size += size

    if records:
        emit_pack()
    write_module(target / f"{BOOTSTRAP}.js", bootstrap)
    index.update((name, BOOTSTRAP) for name in bootstrap)
    return {"index": index, "roots": roots, "bootstrap": BOOTSTRAP}


if __name__ == "__main__":
    source, target = map(Path, sys.argv[1:3])
    print(json.dumps(package(source, target, "--remote-originals" in sys.argv[3:]), separators=(",", ":")))
