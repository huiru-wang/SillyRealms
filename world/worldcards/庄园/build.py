#!/usr/bin/env python3
"""Build the manor world card as an offline SR ZIP, with resumable image downloads."""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
import zipfile

BASE = Path(__file__).resolve().parent
SOURCE = BASE.parent / "manor-world-card.json"
URL_RE = re.compile(r"https?://[^\s<>\"'\x60\\]+")
ASSET_RE = re.compile(r"sr-asset://[^\s<>\"'\x60\\)]+")
MAX_ZIP_BYTES = 256 * 1024 * 1024
MAX_UNPACKED_BYTES = 1024 * 1024 * 1024


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    temporary.replace(path)


def strings(value):
    if isinstance(value, dict):
        for child in value.values():
            yield from strings(child)
    elif isinstance(value, list):
        for child in value:
            yield from strings(child)
    elif isinstance(value, str):
        yield value


def digest(path: Path) -> str:
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def inspect_image(path: Path) -> dict:
    from PIL import Image
    with Image.open(path) as image:
        info = {
            "format": image.format, "width": image.width, "height": image.height,
            "frames": getattr(image, "n_frames", 1),
        }
        image.verify()
    return info


def download_one(url: str, cache: Path, offline: bool) -> dict:
    key = hashlib.sha256(url.encode()).hexdigest()
    target = cache / (key + ".image")
    record = {"url": url, "cache_file": str(target)}
    if target.exists():
        try:
            info = inspect_image(target)
            return {**record, **info, "bytes": target.stat().st_size,
                    "sha256": digest(target), "cached": True, "status": "ok"}
        except Exception:
            if offline:
                raise
            target.unlink()
    if offline:
        raise RuntimeError("Missing cached image: " + key)
    partial = target.with_suffix(".part")
    candidates = [url]
    prefix = "https://cdn.jsdelivr.net/gh/"
    if url.startswith(prefix):
        repository, sep, resource = url[len(prefix):].partition("@")
        revision, slash, resource_path = resource.partition("/")
        if sep and slash:
            candidates.append("https://raw.githubusercontent.com/" + repository
                              + "/" + revision + "/" + resource_path)
    last_error = ""
    for candidate in candidates:
        result = subprocess.run(
            ["curl", "--http1.1", "--fail", "--location", "--silent", "--show-error",
             "--connect-timeout", "12", "--max-time", "100", "--retry", "2",
             "--retry-delay", "1", "--retry-max-time", "180",
             "--output", str(partial), candidate],
            capture_output=True, text=True,
        )
        if result.returncode:
            last_error = result.stderr.strip()[-700:]
            partial.unlink(missing_ok=True)
            continue
        try:
            info = inspect_image(partial)
        except Exception as error:
            last_error = "Downloaded body is not a valid image: " + str(error)
            partial.unlink(missing_ok=True)
            continue
        partial.replace(target)
        return {**record, **info, "bytes": target.stat().st_size,
                "sha256": digest(target), "cached": False, "status": "ok",
                "download_source": candidate}
    raise RuntimeError(last_error or "Image download failed")


def download_all(urls: list[str], cache: Path, workers: int, offline: bool) -> list[dict]:
    cache.mkdir(parents=True, exist_ok=True)
    records = []
    started = time.monotonic()
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        pending = {executor.submit(download_one, url, cache, offline): url for url in urls}
        for future in concurrent.futures.as_completed(pending):
            url = pending[future]
            try:
                record = future.result()
            except Exception as error:
                record = {"url": url, "status": "failed", "error": str(error)}
            records.append(record)
            if len(records) % 20 == 0 or len(records) == len(urls) or record["status"] != "ok":
                ok = [item for item in records if item["status"] == "ok"]
                progress = {"downloaded": len(ok), "finished": len(records),
                            "total": len(urls), "failed": len(records) - len(ok),
                            "original_mib": round(sum(item["bytes"] for item in ok) / 1024**2, 2),
                            "elapsed_seconds": round(time.monotonic() - started)}
                print(json.dumps(progress, ensure_ascii=False), flush=True)
                write_json(BASE / "download-manifest.json", {
                    "source_sha256": digest(SOURCE), "progress": progress,
                    "images": sorted(records, key=lambda item: item["url"]),
                })
    records.sort(key=lambda item: item["url"])
    failed = [item for item in records if item["status"] != "ok"]
    if failed:
        raise RuntimeError(f"{len(failed)} image downloads failed; rerun to retry from cache.")
    return records


def replace_urls(value, replacements: dict[str, str]):
    if isinstance(value, dict):
        return {key: replace_urls(child, replacements) for key, child in value.items()}
    if isinstance(value, list):
        return [replace_urls(child, replacements) for child in value]
    if isinstance(value, str):
        return URL_RE.sub(lambda match: replacements.get(match.group(), match.group()), value)
    return value


def build(source_card: dict, records: list[dict], quality: int, lossless: bool) -> dict:
    from PIL import Image
    from prepare_card import prepare_card

    staging = Path(tempfile.mkdtemp(prefix="package-build-", dir=BASE))
    (staging / "assets" / "images").mkdir(parents=True)
    (staging / "components").mkdir()
    replacements = {}
    assets = {}
    try:
        unique = {record["sha256"]: record for record in records}
        def encode_item(item):
            sha256, record = item
            original = Path(record["cache_file"])
            if record["frames"] > 1:
                extension = {"PNG": ".png", "GIF": ".gif", "WEBP": ".webp"}[record["format"]]
                relative = "assets/images/" + sha256[:24] + extension
                shutil.copyfile(original, staging / relative)
            else:
                relative = "assets/images/" + sha256[:24] + ".webp"
                encoded_cache = original.parent / ("webp-q" + str(quality) + "-m4-" + str(lossless))
                encoded_cache.mkdir(exist_ok=True)
                encoded = encoded_cache / (sha256 + ".webp")
                if not encoded.exists():
                    with Image.open(original) as image:
                        image.load()
                        if image.mode not in ("RGB", "RGBA"):
                            image = image.convert("RGBA" if "transparency" in image.info else "RGB")
                        options = {"quality": quality, "method": 4, "lossless": lossless, "exact": True}
                        for key in ("icc_profile", "exif"):
                            if image.info.get(key):
                                options[key] = image.info[key]
                        temporary = encoded.with_suffix(".tmp")
                        image.save(temporary, "WEBP", **options)
                        inspect_image(temporary)
                        temporary.replace(encoded)
                shutil.copyfile(encoded, staging / relative)
            verified = inspect_image(staging / relative)
            if (verified["width"], verified["height"]) != (record["width"], record["height"]):
                raise RuntimeError("Image dimensions changed: " + relative)
            return sha256, {"path": relative, "source_sha256": sha256,
                            "sha256": digest(staging / relative),
                            "bytes": (staging / relative).stat().st_size,
                            "width": verified["width"], "height": verified["height"]}
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(6, os.cpu_count() or 2)) as encoder:
            pending = [encoder.submit(encode_item, item) for item in sorted(unique.items())]
            for index, future in enumerate(concurrent.futures.as_completed(pending), 1):
                sha256, asset = future.result()
                assets[sha256] = asset
                if index % 50 == 0 or index == len(unique):
                    print(json.dumps({"encoded": index, "unique_images": len(unique)}), flush=True)
        for record in records:
            replacements[record["url"]] = "sr-asset://" + assets[record["sha256"]]["path"]
        card = replace_urls(prepare_card(source_card), replacements)
        for component in card["data"]["components"]:
            code = component.pop("component")
            relative = "components/" + component["id"] + ".tsx"
            (staging / relative).write_text(code)
            component["path"] = "sr-asset://" + relative
        write_json(staging / "world.json", card)
        text_files = [staging / "world.json", *(staging / "components").glob("*.tsx")]
        unresolved_remote = []
        referenced = set()
        for path in text_files:
            contents = path.read_text()
            unresolved_remote.extend(URL_RE.findall(contents))
            referenced.update(ASSET_RE.findall(contents))
        if unresolved_remote:
            raise RuntimeError(f"{len(set(unresolved_remote))} external URLs remain in package.")
        missing = [uri for uri in referenced if not (staging / uri.removeprefix("sr-asset://")).is_file()]
        if missing:
            raise RuntimeError("Missing local resources: " + repr(missing[:10]))
        files = sorted(path for path in staging.rglob("*") if path.is_file())
        unpacked = sum(path.stat().st_size for path in files)
        if unpacked > MAX_UNPACKED_BYTES or len(files) > 10000:
            raise RuntimeError("Package exceeds the server extraction limits.")
        archive = BASE / "manor-world.zip.tmp"
        with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as z:
            for path in files:
                z.write(path, path.relative_to(staging).as_posix())
        with zipfile.ZipFile(archive) as z:
            corrupt = z.testzip()
            if corrupt:
                raise RuntimeError("ZIP CRC verification failed: " + corrupt)
        if archive.stat().st_size > MAX_ZIP_BYTES:
            archive.unlink()
            raise RuntimeError("ZIP exceeds 256 MiB; rerun with lower --quality.")
        package = BASE / "package"
        if package.exists():
            shutil.rmtree(package)
        staging.replace(package)
        archive.replace(BASE / "manor-world.zip")
        report = {
            "source": str(SOURCE), "source_sha256": digest(SOURCE),
            "world_name": card["data"]["name"], "state_schema_version": card["data"]["state"]["schema_version"],
            "url_count": len(records), "unique_images": len(assets),
            "characters": len(card["data"]["characters"]), "openings": len(card["data"]["openings"]),
            "lore_entries": len(card["data"]["lorebook"]["entries"]),
            "components": len(card["data"]["components"]), "archive_entries": len(files),
            "original_image_bytes": sum(item["bytes"] for item in records),
            "packaged_image_bytes": sum(item["bytes"] for item in assets.values()),
            "unpacked_bytes": unpacked, "zip_bytes": (BASE / "manor-world.zip").stat().st_size,
            "zip_sha256": digest(BASE / "manor-world.zip"),
            "encoding": {"format": "WebP", "quality": quality, "method": 4, "lossless": lossless, "dimensions_preserved": True},
            "remaining_external_urls": 0, "missing_local_resources": 0, "zip_crc_verified": True,
            "images": [{**item, "resource": replacements[item["url"]]} for item in records],
            "assets": sorted(assets.values(), key=lambda item: item["path"]),
        }
        write_json(BASE / "build-report.json", report)
        print(json.dumps({key: value for key, value in report.items() if key not in ("images", "assets")}, ensure_ascii=False, indent=2), flush=True)
        return report
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--download-only", action="store_true")
    parser.add_argument("--offline", action="store_true", help="Use cached images without network requests.")
    parser.add_argument("--quality", type=int, default=90)
    parser.add_argument("--lossless", action="store_true")
    parser.add_argument("--cache", type=Path, default=Path.home() / "Library/Caches/SillyRealms/manor-world-card")
    args = parser.parse_args()
    if not 1 <= args.workers <= 24 or not 1 <= args.quality <= 100:
        parser.error("workers must be 1..24 and quality must be 1..100")
    source_card = json.loads(SOURCE.read_text())
    urls = sorted({url for text in strings(source_card) for url in URL_RE.findall(text)})
    print(json.dumps({"unique_image_urls": len(urls), "cache": str(args.cache), "workers": args.workers}), flush=True)
    records = download_all(urls, args.cache, args.workers, args.offline)
    if not args.download_only:
        build(source_card, records, args.quality, args.lossless)


if __name__ == "__main__":
    main()
