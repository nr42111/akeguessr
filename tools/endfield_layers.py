#!/usr/bin/env python3
"""Fetch and build Open Endfield Map layer overlays for akeguessr.

Commands:
    python tools/endfield_layers.py fetch
    python tools/endfield_layers.py build

The source site publishes clip coverage per region, zoom, and layer suffix.
Layer tiles are transparent overlays; a suffix is one of b1..b4/l1..l4. The
build command composites only the tiles that belong to each existing
sub-region, crops to the visible content, and writes assets/maps/layers/.

Requires Pillow and requests:
    python -m pip install pillow requests
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from io import BytesIO
from pathlib import Path

import requests
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
SITE_URL = "https://opendfieldmap.org"
CDN_BASE = "https://cdn.opendfieldmap.org/_dev/endfield/atlos/clips"
DEFAULT_MAPDL_ROOT = Path("E:/dev/mapdl/endfield_maps")
COVERAGE_SNAPSHOT = SCRIPT_DIR / "endfield_layer_coverage.json"

ZOOM = "3"
TILE_SIZE = 500
WORKERS = 8
LAYER_ORDER = ["b1", "b2", "b3", "b4", "l1", "l2", "l3", "l4"]
CROP_ALPHA = 2
CONTENT_ALPHA = 16
MIN_CONTENT_PIXELS = 64
WEBP_MAX_DIMENSION = 16383

REGION_FOLDERS = {
    "wuling": "Wuling",
    "valley-iv": "Valley_4",
}
MARKER_STONE_ID = "ms"
MARKER_STONE_EXTRA_TILES = {"6_54", "6_55", "7_54", "7_55"}

VERIFY_TILES = {
    ("Wuling", "ta", "b1"): ["28_40", "29_40", "29_41"],
    ("Wuling", "wl", "b4"): ["26_46", "26_47"],
    ("Wuling", "sp", "l1"): ["41_19"],
    ("Wuling", "ms", "l1"): ["6_55", "7_55"],
    ("Wuling", "ms", "l2"): ["6_55", "7_55"],
    ("Wuling", "ms", "l3"): ["6_55", "7_55"],
    ("Wuling", "ms", "l4"): ["6_55", "7_55"],
}

TILE_RE = re.compile(r"^(-?\d+)_(-?\d+)$")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def tile_set(layer_map: dict) -> set[tuple[int, int]]:
    tiles: set[tuple[int, int]] = set()
    for y_key, ranges in layer_map.items():
        y = int(y_key)
        for index in range(0, len(ranges), 2):
            for x in range(ranges[index], ranges[index + 1] + 1):
                tiles.add((x, y))
    return tiles


def resolve_bundle() -> tuple[str, str]:
    response = requests.get(SITE_URL, timeout=30)
    response.raise_for_status()
    match = re.search(
        r"https://cdn\.opendfieldmap\.org/[^\"']+/assets/index-[^\"']+-([0-9a-f]{12})\.js",
        response.text,
    )
    if not match:
        raise SystemExit("Could not find the current Open Endfield Map bundle URL.")
    return match.group(0), match.group(1)


def fetch_coverage() -> tuple[dict, str, str]:
    bundle_url, version = resolve_bundle()
    print(f"Fetching coverage from {bundle_url}", flush=True)
    response = requests.get(bundle_url, timeout=90)
    response.raise_for_status()
    bundle = response.text

    marker = "JSON.parse('"
    start = bundle.find(marker + '{"Dijiang"')
    if start < 0:
        start = bundle.find("TO=JSON.parse('")
        if start < 0:
            raise SystemExit("Could not find the clip coverage JSON in the bundle.")
        start += len("TO=JSON.parse('")
    else:
        start += len(marker)
    end = bundle.find("')", start)
    if end < 0:
        raise SystemExit("Could not find the end of the clip coverage JSON.")

    coverage = json.loads(bundle[start:end])
    return coverage, version, bundle_url


def load_coverage(args: argparse.Namespace) -> tuple[dict, str]:
    if args.coverage:
        payload = load_json(Path(args.coverage))
    elif args.offline:
        if not COVERAGE_SNAPSHOT.exists():
            raise SystemExit(f"Coverage snapshot not found: {COVERAGE_SNAPSHOT}")
        payload = load_json(COVERAGE_SNAPSHOT)
    else:
        coverage, version, bundle_url = fetch_coverage()
        payload = {
            "source": bundle_url,
            "version": version,
            "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "coverage": coverage,
        }
        COVERAGE_SNAPSHOT.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        print(f"Wrote {COVERAGE_SNAPSHOT}", flush=True)

    if "coverage" in payload:
        return payload["coverage"], str(payload.get("version", ""))
    return payload, str(payload.get("version", ""))


def layer_suffixes(region_coverage: dict) -> list[str]:
    zoom = region_coverage.get(ZOOM, {})
    available = {key.lstrip("_") for key in zoom if key}
    ordered = [suffix for suffix in LAYER_ORDER if suffix in available]
    ordered.extend(sorted(available.difference(LAYER_ORDER)))
    return ordered


def valid_tile(path: Path) -> bool:
    try:
        with Image.open(path) as image:
            image.load()
            return image.size == (TILE_SIZE, TILE_SIZE)
    except Exception:
        return False


def download_tile(
    region: str,
    suffix: str,
    x: int,
    y: int,
    output_dir: Path,
    version: str,
    force: bool,
) -> tuple[str, str | None]:
    filename = f"{x}_{y}.webp"
    path = output_dir / filename
    if path.exists() and not force and valid_tile(path):
        return filename, None

    query = f"?v={version}" if version else ""
    url = f"{CDN_BASE}/{region}/{ZOOM}/{x}_{y}_{suffix}.webp{query}"

    last_error = None
    for attempt in range(3):
        try:
            response = requests.get(url, timeout=30)
            if response.status_code != 200:
                last_error = f"HTTP {response.status_code}"
                if response.status_code == 404:
                    break
                time.sleep(0.5 + attempt)
                continue

            with Image.open(BytesIO(response.content)) as image:
                image.load()
                if image.size != (TILE_SIZE, TILE_SIZE):
                    last_error = f"unexpected size {image.size}"
                    break

            temporary = path.with_suffix(".tmp")
            temporary.write_bytes(response.content)
            os.replace(temporary, path)
            return filename, None
        except Exception as error:
            last_error = str(error)
            time.sleep(0.5 + attempt)

    return filename, last_error or "unknown error"


def verify_base_cache(
    mapdl_root: Path,
    region: str,
    coverage: dict,
    version: str,
) -> None:
    base_dir = mapdl_root / region / ZOOM
    expected = tile_set(coverage[region][ZOOM][""])
    files = [path for path in base_dir.glob("*.webp") if TILE_RE.match(path.stem)]
    print(
        f"{region}: base cache {len(files)} files, coverage {len(expected)} tiles",
        flush=True,
    )
    if len(files) != len(expected):
        raise SystemExit(
            f"{region}: base cache count does not match coverage; refusing to build misaligned layers."
        )

    sample = sorted(expected)
    sample = [sample[0], sample[len(sample) // 2], sample[-1]]
    query = f"?v={version}" if version else ""
    for x, y in sample:
        local = base_dir / f"{x}_{y}.webp"
        if not local.exists():
            raise SystemExit(f"{region}: missing base tile {local.name}")
        response = requests.get(
            f"{CDN_BASE}/{region}/{ZOOM}/{x}_{y}.webp{query}",
            timeout=30,
        )
        if response.status_code != 200:
            raise SystemExit(f"{region}: base verification failed for {x}_{y}")
        if sha256_file(local) != hashlib.sha256(response.content).hexdigest():
            raise SystemExit(
                f"{region}: base tile {x}_{y} differs from the CDN; refusing to build misaligned layers."
            )
    print(f"{region}: base hash sample verified", flush=True)


def command_fetch(args: argparse.Namespace) -> None:
    coverage, version = load_coverage(args)
    mapdl_root = Path(args.mapdl_root)

    total_downloaded = 0
    total_skipped = 0
    failures: list[str] = []

    for region in args.region or list(REGION_FOLDERS.values()):
        region_coverage = coverage.get(region)
        if not region_coverage:
            raise SystemExit(f"Coverage has no region: {region}")
        verify_base_cache(mapdl_root, region, coverage, version)

        for suffix in layer_suffixes(region_coverage):
            tiles = sorted(tile_set(region_coverage[ZOOM][f"_{suffix}"]), key=lambda t: (t[1], t[0]))
            if not tiles:
                continue
            output_dir = mapdl_root / region / "layers" / suffix
            output_dir.mkdir(parents=True, exist_ok=True)
            print(f"{region}/{suffix}: {len(tiles)} tiles", flush=True)

            completed: list[tuple[int, int]] = []
            with ThreadPoolExecutor(max_workers=args.workers) as executor:
                futures = [
                    executor.submit(
                        download_tile,
                        region,
                        suffix,
                        x,
                        y,
                        output_dir,
                        version,
                        args.force,
                    )
                    for x, y in tiles
                ]
                for index, future in enumerate(as_completed(futures), 1):
                    filename, error = future.result()
                    if error:
                        failures.append(f"{region}/{suffix}/{filename}: {error}")
                    else:
                        x, y = (int(part) for part in filename.removesuffix(".webp").split("_"))
                        completed.append((x, y))
                        if index % 50 == 0:
                            print(f"  {index}/{len(tiles)}", flush=True)

            manifest = {
                "region": region,
                "layer": suffix,
                "zoom": ZOOM,
                "tile_size": TILE_SIZE,
                "tiles": [
                    {"x": x, "y": y, "file": f"{x}_{y}.webp"}
                    for x, y in sorted(completed, key=lambda value: (value[1], value[0]))
                ],
            }
            (output_dir / "manifest.json").write_text(
                json.dumps(manifest, indent=2) + "\n",
                encoding="utf-8",
            )
            total_downloaded += len(completed)
            total_skipped += len(tiles) - len(completed)

    if failures:
        print("\nFailures:", file=sys.stderr)
        for failure in failures:
            print(f"  {failure}", file=sys.stderr)
        raise SystemExit(f"{len(failures)} layer tile(s) failed to download.")

    print(
        f"\nFetched {total_downloaded} layer tiles "
        f"({total_skipped} missing); coverage snapshot: {COVERAGE_SNAPSHOT}",
        flush=True,
    )


def paste_tile(canvas: Image.Image, path: Path, px: int, py: int) -> None:
    with Image.open(path) as source:
        image = source.convert("RGBA")
        if image.size != (TILE_SIZE, TILE_SIZE):
            image = image.resize((TILE_SIZE, TILE_SIZE), Image.Resampling.LANCZOS)
        canvas.alpha_composite(image, (px, py))


def paste_crop(
    canvas: Image.Image,
    path: Path,
    coord: tuple[int, int],
    box: list[float],
    min_x: int,
    min_y: int,
) -> None:
    with Image.open(path) as source:
        image = source.convert("RGBA")
        left, top, right, bottom = box
        box_pixels = (
            max(0, min(image.width, round(left))),
            max(0, min(image.height, round(top))),
            max(0, min(image.width, round(right))),
            max(0, min(image.height, round(bottom))),
        )
        if box_pixels[2] <= box_pixels[0] or box_pixels[3] <= box_pixels[1]:
            return
        part = image.crop(box_pixels)
        scale = TILE_SIZE / image.width
        part = part.resize(
            (max(1, round(part.width * scale)), max(1, round(part.height * scale))),
            Image.Resampling.LANCZOS,
        )
        dest_x = (coord[0] - min_x) * TILE_SIZE + round(box_pixels[0] * scale)
        dest_y = (coord[1] - min_y) * TILE_SIZE + round(box_pixels[1] * scale)
        canvas.alpha_composite(part, (dest_x, dest_y))


def parse_coord(reference: str) -> tuple[int, int]:
    match = TILE_RE.match(str(reference))
    if not match:
        raise ValueError(f"Unrecognized tile reference: {reference!r}")
    return int(match.group(1)), int(match.group(2))


def rect_intersects(bbox: tuple[int, int, int, int], px: int, py: int) -> bool:
    return (
        bbox[0] < px + TILE_SIZE
        and bbox[2] > px
        and bbox[1] < py + TILE_SIZE
        and bbox[3] > py
    )


def command_build(args: argparse.Namespace) -> None:
    coverage, _version = load_coverage(args)
    mapdl_root = Path(args.mapdl_root)
    regions_path = REPO_ROOT / "data" / "regions.json"
    regions_doc = load_json(regions_path)
    layers_dir = REPO_ROOT / "assets" / "maps" / "layers"
    layers_dir.mkdir(parents=True, exist_ok=True)
    for pattern in ("*.webp", "*.png"):
        for old in layers_dir.glob(pattern):
            old.unlink()

    built: dict[str, list[dict]] = {}
    verification_failures: list[str] = []
    total_bytes = 0

    for region_doc in regions_doc.get("regions", []):
        game_region = region_doc.get("id")
        mapdl_region = REGION_FOLDERS.get(game_region)
        if not mapdl_region:
            continue
        region_coverage = coverage.get(mapdl_region)
        if not region_coverage:
            raise SystemExit(f"Coverage has no region: {mapdl_region}")

        config_path = (
            mapdl_root / mapdl_region / "assembled" / f"{mapdl_region}_subregions_tilemap.json"
        )
        config_doc = load_json(config_path)
        config_by_id = {entry["id"]: entry for entry in config_doc.get("subregions", [])}

        subregions: dict[str, tuple[dict, dict]] = {}
        for subregion in region_doc.get("subRegions", []):
            config_id = str(subregion.get("code", "")).lower()
            config = config_by_id.get(config_id)
            if not config:
                raise SystemExit(
                    f"{mapdl_region}: no tilemap config for sub-region {subregion['id']}"
                )
            source_image = mapdl_root / mapdl_region / "subregions" / f"{config_id}.webp"
            asset_image = REPO_ROOT / subregion["mapImage"]
            if not source_image.exists():
                raise SystemExit(f"Missing source sub-region image: {source_image}")
            if sha256_file(source_image) != sha256_file(asset_image):
                raise SystemExit(
                    f"Base image mismatch for {subregion['id']}; rebuild the base map first."
                )
            subregions[subregion["id"]] = (subregion, config)

        print(f"\n=== {mapdl_region} ===", flush=True)
        for suffix in layer_suffixes(region_coverage):
            tile_dir = mapdl_root / mapdl_region / "layers" / suffix
            if not tile_dir.exists():
                print(f"  skipping {suffix}: {tile_dir} not found (run fetch first)", flush=True)
                continue
            tile_paths = {
                parse_coord(path.stem): path
                for path in tile_dir.glob("*.webp")
                if TILE_RE.match(path.stem)
            }
            if not tile_paths:
                print(f"  skipping {suffix}: no tiles", flush=True)
                continue

            print(f"  {suffix}: {len(tile_paths)} source tiles", flush=True)
            for subregion_id, (subregion, config) in subregions.items():
                listed_coords = {parse_coord(ref) for ref in config.get("tiles", [])}
                crops = config.get("crops", [])
                crop_coords = {parse_coord(crop["tile"]) for crop in crops}
                base_coords = listed_coords | crop_coords
                if not base_coords:
                    continue

                min_x = min(coord[0] for coord in base_coords)
                max_x = max(coord[0] for coord in base_coords)
                min_y = min(coord[1] for coord in base_coords)
                max_y = max(coord[1] for coord in base_coords)
                width = (max_x - min_x + 1) * TILE_SIZE
                height = (max_y - min_y + 1) * TILE_SIZE
                map_size = subregion.get("mapSize") or {}
                if map_size.get("width") != width or map_size.get("height") != height:
                    raise SystemExit(
                        f"{subregion_id}: geometry mismatch; computed {width}x{height}, "
                        f"data says {map_size.get('width')}x{map_size.get('height')}."
                    )

                allowed = set(listed_coords)
                if str(subregion.get("code", "")).lower() == MARKER_STONE_ID:
                    for extra in MARKER_STONE_EXTRA_TILES:
                        x, y = parse_coord(extra)
                        if not (min_x <= x <= max_x and min_y <= y <= max_y):
                            raise SystemExit(
                                f"{subregion_id}: marker stone extension {extra} falls outside "
                                "the existing map bounds; coordinates would shift."
                            )
                        allowed.add((x, y))

                canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
                for x, y in sorted(allowed, key=lambda coord: (coord[1], coord[0])):
                    path = tile_paths.get((x, y))
                    if path:
                        paste_tile(canvas, path, (x - min_x) * TILE_SIZE, (y - min_y) * TILE_SIZE)

                for crop in crops:
                    coord = parse_coord(crop["tile"])
                    path = tile_paths.get(coord)
                    if path:
                        paste_crop(canvas, path, coord, crop["box"], min_x, min_y)

                alpha = canvas.getchannel("A")
                crop_mask = alpha.point(lambda value: 255 if value > CROP_ALPHA else 0)
                bbox = crop_mask.getbbox()
                content_mask = alpha.point(lambda value: 255 if value > CONTENT_ALPHA else 0)
                content_count = content_mask.histogram()[255]

                if bbox is None or content_count < MIN_CONTENT_PIXELS:
                    continue

                layer_image = canvas.crop(bbox)
                filename = f"{subregion_id}-{suffix}.webp"
                output_path = layers_dir / filename
                if (
                    layer_image.width > WEBP_MAX_DIMENSION
                    or layer_image.height > WEBP_MAX_DIMENSION
                ):
                    output_path = output_path.with_suffix(".png")
                    layer_image.save(output_path, compress_level=6)
                else:
                    layer_image.save(output_path, quality=92, method=4)

                relative = output_path.relative_to(REPO_ROOT).as_posix()
                entry = {
                    "id": suffix,
                    "name": suffix.upper(),
                    "image": relative,
                    "offsetX": bbox[0],
                    "offsetY": bbox[1],
                    "width": layer_image.width,
                    "height": layer_image.height,
                }
                built.setdefault(subregion_id, []).append(entry)
                total_bytes += output_path.stat().st_size
                print(
                    f"    {subregion_id}: {filename} "
                    f"({layer_image.width}x{layer_image.height}, "
                    f"{output_path.stat().st_size / 1024:.1f} KB)",
                    flush=True,
                )

                subregion_code = str(subregion.get("code", "")).lower()
                for key, coords in VERIFY_TILES.items():
                    verify_region, verify_subregion, verify_suffix = key
                    if (
                        verify_region == mapdl_region
                        and verify_subregion == subregion_code
                        and verify_suffix == suffix
                    ):
                        for coord_ref in coords:
                            coord = parse_coord(coord_ref)
                            tile_path = tile_paths.get(coord)
                            px = (coord[0] - min_x) * TILE_SIZE
                            py = (coord[1] - min_y) * TILE_SIZE
                            if not tile_path:
                                verification_failures.append(
                                    f"{subregion_id}/{suffix}/{coord_ref}: source tile missing"
                                )
                            elif not rect_intersects(bbox, px, py):
                                verification_failures.append(
                                    f"{subregion_id}/{suffix}/{coord_ref}: not covered by overlay bbox"
                                )
                            else:
                                print(
                                    f"      verified {coord_ref} in {subregion_id}/{suffix}",
                                    flush=True,
                                )

    for region_doc in regions_doc.get("regions", []):
        for subregion in region_doc.get("subRegions", []):
            entries = built.get(subregion["id"], [])
            if entries:
                subregion["layers"] = entries
            else:
                subregion.pop("layers", None)

    regions_path.write_text(json.dumps(regions_doc, indent=2) + "\n", encoding="utf-8")
    print(
        f"\nWrote {sum(len(entries) for entries in built.values())} layer images "
        f"({total_bytes / 1024 / 1024:.1f} MB) and updated {regions_path}",
        flush=True,
    )
    if verification_failures:
        print("\nVerification failures:", file=sys.stderr)
        for failure in verification_failures:
            print(f"  {failure}", file=sys.stderr)
        raise SystemExit(1)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--mapdl-root",
        default=str(DEFAULT_MAPDL_ROOT),
        help="Folder containing Wuling/ and Valley_4/ (default: E:/dev/mapdl/endfield_maps)",
    )
    parser.add_argument(
        "--coverage",
        help="Use a saved coverage JSON instead of fetching the site bundle",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    fetch = subparsers.add_parser("fetch", help="Download missing layer tiles")
    fetch.add_argument("--region", action="append", help="Limit to a region folder (repeatable)")
    fetch.add_argument("--workers", type=int, default=WORKERS)
    fetch.add_argument("--force", action="store_true", help="Re-download existing tiles")
    fetch.add_argument("--offline", action="store_true", help="Use the saved coverage snapshot")
    fetch.set_defaults(func=command_fetch)

    build = subparsers.add_parser("build", help="Composite cropped layer overlays")
    build.add_argument("--offline", action="store_true", help="Use the saved coverage snapshot")
    build.set_defaults(func=command_build)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    try:
        args.func(args)
    except KeyboardInterrupt:
        print("\nInterrupted.", file=sys.stderr)
        raise SystemExit(130)


if __name__ == "__main__":
    main()
