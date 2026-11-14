#!/usr/bin/env python3
"""Assemble a web-map tileset and build numbered tile atlases.

The tiles are expected to be square images named ``x_y.webp`` (or another
image extension passed via ``--extension``). Y increases downward and X
increases to the right.

Examples:
    python tools/tilemap.py assemble --tiles "E:/maps/Valley/3" --out "E:/maps/Valley/assembled"

    python tools/tilemap.py subregions --tiles "E:/maps/Valley/3" \
        --index "E:/maps/Valley/assembled/Valley_tiles.json" \
        --config subregions.json --out "E:/maps/Valley/subregions"

Requires Pillow:  python -m pip install pillow
"""

from __future__ import annotations

import argparse
import gc
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

Image.MAX_IMAGE_PIXELS = None

TILE_RE = re.compile(r"^(-?\d+)_(-?\d+)$")
WEBP_MAX_DIMENSION = 16383
DEFAULT_TILE_SIZE = 500
ACCENT = (61, 220, 151)


@dataclass
class TileInfo:
    x: int
    y: int
    path: Path
    empty: bool = False
    tile_id: int | None = None


def parse_tile_name(path: Path) -> tuple[int, int] | None:
    match = TILE_RE.match(path.stem)
    if not match:
        return None
    return int(match.group(1)), int(match.group(2))


def find_tiles(tile_dir: Path, extension: str) -> list[TileInfo]:
    tiles: list[TileInfo] = []
    for path in tile_dir.glob(f"*.{extension}"):
        coords = parse_tile_name(path)
        if coords is None:
            continue
        x, y = coords
        tiles.append(TileInfo(x=x, y=y, path=path))
    tiles.sort(key=lambda tile: (tile.y, tile.x))
    return tiles


def tile_has_content(path: Path) -> bool:
    with Image.open(path) as image:
        if image.mode == "RGBA":
            return image.getchannel("A").getextrema()[1] > 5
        return True


def mark_empty_tiles(tiles: list[TileInfo]) -> None:
    for tile in tiles:
        tile.empty = not tile_has_content(tile.path)


def assign_content_ids(tiles: list[TileInfo]) -> None:
    next_id = 1
    for tile in tiles:
        if tile.empty:
            tile.tile_id = None
        else:
            tile.tile_id = next_id
            next_id += 1


def load_font(size: int, bold: bool) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        "C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf",
        "C:/Windows/Fonts/segoeuib.ttf" if bold else "C:/Windows/Fonts/segoeui.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
        if bold
        else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
        if bold
        else "/System/Library/Fonts/Supplemental/Arial.ttf",
    ]
    for candidate in candidates:
        try:
            return ImageFont.truetype(candidate, size)
        except OSError:
            continue
    return ImageFont.load_default()


def tile_to_rgb(path: Path, size: int, background: tuple[int, int, int]) -> Image.Image:
    with Image.open(path) as source:
        image = source.convert("RGBA")
        if image.size != (size, size):
            image = image.resize((size, size), Image.Resampling.LANCZOS)
        base = Image.new("RGBA", (size, size), (*background, 255))
        return Image.alpha_composite(base, image).convert("RGB")


def build_mosaic(
    tiles: list[TileInfo],
    min_x: int,
    min_y: int,
    max_x: int,
    max_y: int,
    tile_px: int,
    background: tuple[int, int, int],
    include: set[tuple[int, int]] | None = None,
    exclude: set[tuple[int, int]] | None = None,
    progress_every: int = 500,
) -> Image.Image:
    cols = max_x - min_x + 1
    rows = max_y - min_y + 1
    canvas = Image.new("RGB", (cols * tile_px, rows * tile_px), background)

    count = 0
    for tile in tiles:
        if tile.empty:
            continue
        if not (min_x <= tile.x <= max_x and min_y <= tile.y <= max_y):
            continue
        if include is not None and (tile.x, tile.y) not in include:
            continue
        if exclude is not None and (tile.x, tile.y) in exclude:
            continue
        tile_image = tile_to_rgb(tile.path, tile_px, background)
        canvas.paste(tile_image, ((tile.x - min_x) * tile_px, (tile.y - min_y) * tile_px))
        count += 1
        if progress_every and count % progress_every == 0:
            print(f"  composited {count} tiles...", flush=True)

    return canvas


def parse_crop_box(value: object) -> tuple[float, float, float, float]:
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        raise ValueError("crop box must be [left, top, right, bottom]")
    box = tuple(float(part) for part in value)
    if box[2] <= box[0] or box[3] <= box[1]:
        raise ValueError("crop box must have positive width and height")
    return box


def paste_crops(
    canvas: Image.Image,
    crops: list[dict],
    available: dict[tuple[int, int], TileInfo],
    min_x: int,
    min_y: int,
    tile_px: int,
    background: tuple[int, int, int],
) -> None:
    for crop in crops:
        coord = crop["coord"]
        tile = available.get(coord)
        if tile is None or tile.empty:
            continue
        with Image.open(tile.path) as source:
            image = source.convert("RGBA")
            base = Image.new("RGBA", image.size, (*background, 255))
            image = Image.alpha_composite(base, image).convert("RGB")
            left, top, right, bottom = crop["box"]
            box = (
                max(0, min(image.width, round(left))),
                max(0, min(image.height, round(top))),
                max(0, min(image.width, round(right))),
                max(0, min(image.height, round(bottom))),
            )
            if box[2] <= box[0] or box[3] <= box[1]:
                continue
            part = image.crop(box)
            scale = tile_px / image.width
            part = part.resize(
                (max(1, round(part.width * scale)), max(1, round(part.height * scale))),
                Image.Resampling.LANCZOS,
            )
            dest_x = (coord[0] - min_x) * tile_px + round(box[0] * scale)
            dest_y = (coord[1] - min_y) * tile_px + round(box[1] * scale)
            canvas.paste(part, (dest_x, dest_y))


def save_image(image: Image.Image, path: Path, format_name: str, quality: int = 90) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    if format_name == "webp":
        if image.width > WEBP_MAX_DIMENSION or image.height > WEBP_MAX_DIMENSION:
            fallback = path.with_suffix(".png")
            print(
                f"  WebP size limit exceeded ({image.width}x{image.height}); saving PNG instead: {fallback}",
                flush=True,
            )
            image.save(fallback, compress_level=6)
            return fallback
        try:
            image.save(path, quality=quality, method=4)
            return path
        except ValueError as error:
            fallback = path.with_suffix(".png")
            print(f"  WebP encoding failed ({error}); saving PNG instead: {fallback}", flush=True)
            image.save(fallback, compress_level=6)
            return fallback
    image.save(path, compress_level=6)
    return path


def build_numbered(
    tiles: list[TileInfo],
    min_x: int,
    min_y: int,
    max_x: int,
    max_y: int,
    tile_px: int,
    background: tuple[int, int, int],
) -> Image.Image:
    canvas = build_mosaic(tiles, min_x, min_y, max_x, max_y, tile_px, background)

    draw = ImageDraw.Draw(canvas)
    id_font = load_font(max(9, round(tile_px * 0.30)), bold=True)
    coord_font = load_font(max(7, round(tile_px * 0.12)), bold=False)
    outline_width = max(1, round(tile_px * 0.016))
    id_stroke = max(1, round(tile_px * 0.016))
    coord_stroke = max(1, round(tile_px * 0.008))

    for tile in tiles:
        if tile.empty or tile.tile_id is None:
            continue
        px = (tile.x - min_x) * tile_px
        py = (tile.y - min_y) * tile_px
        draw.rectangle(
            [px, py, px + tile_px - 1, py + tile_px - 1],
            outline=ACCENT,
            width=outline_width,
        )
        center_x = px + tile_px / 2
        center_y = py + tile_px / 2
        draw.text(
            (center_x, center_y - tile_px * 0.10),
            str(tile.tile_id),
            font=id_font,
            fill=(255, 255, 255),
            anchor="mm",
            stroke_width=id_stroke,
            stroke_fill=(0, 0, 0),
        )
        draw.text(
            (center_x, center_y + tile_px * 0.18),
            f"{tile.x}_{tile.y}",
            font=coord_font,
            fill=ACCENT,
            anchor="mm",
            stroke_width=coord_stroke,
            stroke_fill=(0, 0, 0),
        )

    return canvas


def write_tile_index(
    path: Path,
    name: str,
    tiles: list[TileInfo],
    min_x: int,
    min_y: int,
    max_x: int,
    max_y: int,
    tile_size: int,
) -> None:
    content_tiles = [tile for tile in tiles if not tile.empty]
    index = {
        "region": name,
        "tileSize": tile_size,
        "tileBounds": {"minX": min_x, "maxX": max_x, "minY": min_y, "maxY": max_y},
        "fullSize": {
            "width": (max_x - min_x + 1) * tile_size,
            "height": (max_y - min_y + 1) * tile_size,
        },
        "contentTileCount": len(content_tiles),
        "emptyTileCount": len(tiles) - len(content_tiles),
        "tiles": [
            {
                "id": tile.tile_id,
                "x": tile.x,
                "y": tile.y,
                "file": tile.path.name,
            }
            for tile in content_tiles
        ],
        "emptyTiles": [f"{tile.x}_{tile.y}" for tile in tiles if tile.empty],
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(index, indent=2) + "\n", encoding="utf-8")


def parse_color(value: str) -> tuple[int, int, int]:
    value = value.strip().lstrip("#")
    if len(value) == 3:
        value = "".join(character * 2 for character in value)
    if len(value) != 6:
        raise argparse.ArgumentTypeError("background must be a hex color like #000000")
    return tuple(int(value[index : index + 2], 16) for index in (0, 2, 4))


def command_assemble(args: argparse.Namespace) -> None:
    tile_dir = Path(args.tiles)
    out_dir = Path(args.out)
    extension = args.extension.lower().lstrip(".")
    background = parse_color(args.background)

    tiles = find_tiles(tile_dir, extension)
    if not tiles:
        raise SystemExit(f"No *.{extension} tiles found in {tile_dir}")

    min_x = min(tile.x for tile in tiles)
    max_x = max(tile.x for tile in tiles)
    min_y = min(tile.y for tile in tiles)
    max_y = max(tile.y for tile in tiles)
    name = args.name or tile_dir.parent.name

    print(f"Region: {name}", flush=True)
    print(f"Tiles: {len(tiles)}", flush=True)
    print(f"Bounds: x {min_x}..{max_x}, y {min_y}..{max_y}", flush=True)

    print("Checking tile alpha...", flush=True)
    mark_empty_tiles(tiles)
    assign_content_ids(tiles)
    content_count = sum(1 for tile in tiles if not tile.empty)
    empty_count = len(tiles) - content_count
    print(f"Content tiles: {content_count}; empty/transparent tiles: {empty_count}", flush=True)

    out_dir.mkdir(parents=True, exist_ok=True)

    if not args.skip_index:
        index_path = out_dir / f"{name}_tiles.json"
        write_tile_index(
            index_path,
            name,
            tiles,
            min_x,
            min_y,
            max_x,
            max_y,
            args.tile_size,
        )
        print(f"Wrote {index_path}", flush=True)

    if not args.skip_full:
        full_tile_px = max(1, round(args.tile_size * args.full_scale))
        print(f"Building full map at {full_tile_px}px/tile...", flush=True)
        full = build_mosaic(
            tiles,
            min_x,
            min_y,
            max_x,
            max_y,
            full_tile_px,
            background,
        )
        full_path = out_dir / f"{name}_full.png"
        print(f"Saving {full_path} ({full.width}x{full.height})...", flush=True)
        full.save(full_path, compress_level=6)
        print(f"Wrote {full_path} ({full_path.stat().st_size / 1024 / 1024:.1f} MB)", flush=True)
        del full
        gc.collect()

    if not args.skip_overview:
        overview_tile_px = max(1, round(args.tile_size * args.overview_scale))
        print(f"Building overview at {overview_tile_px}px/tile...", flush=True)
        overview = build_mosaic(
            tiles,
            min_x,
            min_y,
            max_x,
            max_y,
            overview_tile_px,
            background,
        )
        overview_path = save_image(
            overview,
            out_dir / f"{name}_overview.webp",
            "webp",
            quality=args.overview_quality,
        )
        print(
            f"Wrote {overview_path} ({overview.width}x{overview.height}, "
            f"{overview_path.stat().st_size / 1024 / 1024:.1f} MB)",
            flush=True,
        )
        del overview
        gc.collect()

    if not args.skip_numbered:
        numbered_tile_px = max(1, round(args.tile_size * args.numbered_scale))
        print(f"Building numbered tile atlas at {numbered_tile_px}px/tile...", flush=True)
        numbered = build_numbered(
            tiles,
            min_x,
            min_y,
            max_x,
            max_y,
            numbered_tile_px,
            background,
        )
        numbered_path = save_image(
            numbered,
            out_dir / f"{name}_numbered.webp",
            "webp",
            quality=args.numbered_quality,
        )
        print(
            f"Wrote {numbered_path} ({numbered.width}x{numbered.height}, "
            f"{numbered_path.stat().st_size / 1024 / 1024:.1f} MB)",
            flush=True,
        )
        del numbered
        gc.collect()


def load_tile_index(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def resolve_tile_ref(ref: object, by_id: dict[int, tuple[int, int]]) -> tuple[int, int]:
    if isinstance(ref, int):
        if ref not in by_id:
            raise ValueError(f"Tile id {ref} is not in the index.")
        return by_id[ref]

    text = str(ref).strip()
    match = TILE_RE.match(text)
    if match:
        return int(match.group(1)), int(match.group(2))

    if text.isdigit():
        tile_id = int(text)
        if tile_id not in by_id:
            raise ValueError(f"Tile id {tile_id} is not in the index.")
        return by_id[tile_id]

    raise ValueError(f"Unrecognized tile reference: {ref!r}")


def command_subregions(args: argparse.Namespace) -> None:
    tile_dir = Path(args.tiles)
    out_dir = Path(args.out)
    extension = args.extension.lower().lstrip(".")
    background = parse_color(args.background)
    config = json.loads(Path(args.config).read_text(encoding="utf-8"))

    if isinstance(config, list):
        subregions = config
    else:
        subregions = config.get("subregions", [])
    if not subregions:
        raise SystemExit("The config has no subregions.")

    by_id: dict[int, tuple[int, int]] = {}
    if args.index:
        index = load_tile_index(Path(args.index))
        by_id = {int(tile["id"]): (int(tile["x"]), int(tile["y"])) for tile in index["tiles"]}

    tiles = find_tiles(tile_dir, extension)
    if not tiles:
        raise SystemExit(f"No *.{extension} tiles found in {tile_dir}")
    mark_empty_tiles(tiles)
    available = {(tile.x, tile.y): tile for tile in tiles}

    out_dir.mkdir(parents=True, exist_ok=True)
    summary = []

    for entry in subregions:
        subregion_id = str(entry.get("id", "")).strip()
        if not subregion_id:
            raise SystemExit("Every subregion needs an id.")
        if any(separator in subregion_id for separator in ("/", "\\", "..")):
            raise SystemExit(f"Subregion id is not a safe filename: {subregion_id!r}")

        name = entry.get("name") or subregion_id
        only_listed = bool(entry.get("onlyListed", args.only_listed))
        scale = float(entry.get("scale", args.scale))
        tile_px = max(1, round(args.tile_size * scale))

        listed: list[tuple[int, int]] = []
        for ref in entry.get("tiles", []):
            try:
                coord = resolve_tile_ref(ref, by_id)
            except ValueError as error:
                raise SystemExit(f"{subregion_id}: {error}") from error
            if coord not in available:
                print(f"  warning: {subregion_id}: tile {coord[0]}_{coord[1]} is missing", flush=True)
                continue
            if coord not in listed:
                listed.append(coord)

        crops: list[dict] = []
        for item in entry.get("crops", []):
            try:
                coord = resolve_tile_ref(item.get("tile"), by_id)
            except ValueError as error:
                raise SystemExit(f"{subregion_id}: {error}") from error
            try:
                box = parse_crop_box(item.get("box"))
            except ValueError as error:
                raise SystemExit(f"{subregion_id}: {error}") from error
            if coord not in available:
                print(f"  warning: {subregion_id}: tile {coord[0]}_{coord[1]} is missing", flush=True)
                continue
            crops.append({"coord": coord, "box": box})

        if not listed and not crops:
            print(f"  warning: {subregion_id}: no usable tiles; skipping", flush=True)
            continue

        coords = listed + [crop["coord"] for crop in crops]
        min_x = min(coord[0] for coord in coords)
        max_x = max(coord[0] for coord in coords)
        min_y = min(coord[1] for coord in coords)
        max_y = max(coord[1] for coord in coords)
        include = set(listed) if only_listed else None
        exclude = {crop["coord"] for crop in crops}

        print(
            f"Building {subregion_id} ({name}): x {min_x}..{max_x}, y {min_y}..{max_y}, "
            f"{len(listed)} listed tiles, {len(crops)} crops",
            flush=True,
        )
        image = build_mosaic(
            tiles,
            min_x,
            min_y,
            max_x,
            max_y,
            tile_px,
            background,
            include=include,
            exclude=exclude,
        )
        paste_crops(image, crops, available, min_x, min_y, tile_px, background)
        image_path = save_image(
            image,
            out_dir / f"{subregion_id}.{args.format}",
            args.format,
            quality=args.quality,
        )
        print(
            f"  wrote {image_path} ({image.width}x{image.height}, "
            f"{image_path.stat().st_size / 1024 / 1024:.1f} MB)",
            flush=True,
        )

        metadata = {
            "id": subregion_id,
            "name": name,
            "source": str(tile_dir),
            "tileBounds": {"minX": min_x, "maxX": max_x, "minY": min_y, "maxY": max_y},
            "imageSize": {"width": image.width, "height": image.height},
            "scale": scale,
            "onlyListed": only_listed,
            "tiles": [f"{x}_{y}" for x, y in listed],
            "crops": [
                {
                    "tile": f"{crop['coord'][0]}_{crop['coord'][1]}",
                    "box": list(crop["box"]),
                }
                for crop in crops
            ],
            "includedTiles": [
                f"{tile.x}_{tile.y}"
                for tile in tiles
                if not tile.empty
                and min_x <= tile.x <= max_x
                and min_y <= tile.y <= max_y
                and (include is None or (tile.x, tile.y) in include)
                and (tile.x, tile.y) not in exclude
            ],
        }
        metadata_path = out_dir / f"{subregion_id}.json"
        metadata_path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
        summary.append(
            {
                "id": subregion_id,
                "name": name,
                "image": image_path.name,
                "metadata": metadata_path.name,
                "imageSize": metadata["imageSize"],
                "tileBounds": metadata["tileBounds"],
                "tiles": metadata["tiles"],
                "crops": metadata["crops"],
            }
        )
        del image
        gc.collect()

    summary_path = out_dir / "subregions.json"
    summary_path.write_text(json.dumps({"subregions": summary}, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {summary_path}", flush=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    subparsers = parser.add_subparsers(dest="command", required=True)

    assemble = subparsers.add_parser("assemble", help="Assemble full/overview/numbered maps")
    assemble.add_argument("--tiles", required=True, help="Directory containing x_y.webp tiles")
    assemble.add_argument("--out", required=True, help="Output directory")
    assemble.add_argument("--name", help="Region name used in output filenames")
    assemble.add_argument("--extension", default="webp", help="Tile file extension (default: webp)")
    assemble.add_argument("--tile-size", type=int, default=DEFAULT_TILE_SIZE, help="Source tile size in px")
    assemble.add_argument("--full-scale", type=float, default=1.0, help="Full map scale (default: 1.0)")
    assemble.add_argument("--overview-scale", type=float, default=0.25, help="Overview scale (default: 0.25)")
    assemble.add_argument("--numbered-scale", type=float, default=0.25, help="Numbered atlas scale (default: 0.25)")
    assemble.add_argument("--overview-quality", type=int, default=90, help="Overview WebP quality")
    assemble.add_argument("--numbered-quality", type=int, default=92, help="Numbered WebP quality")
    assemble.add_argument("--background", default="#000000", help="Background color (default: #000000)")
    assemble.add_argument("--skip-index", action="store_true")
    assemble.add_argument("--skip-full", action="store_true")
    assemble.add_argument("--skip-overview", action="store_true")
    assemble.add_argument("--skip-numbered", action="store_true")
    assemble.set_defaults(func=command_assemble)

    subregions = subparsers.add_parser("subregions", help="Crop subregion maps from tile lists")
    subregions.add_argument("--tiles", required=True, help="Directory containing x_y.webp tiles")
    subregions.add_argument("--config", required=True, help="JSON file listing subregions and tiles")
    subregions.add_argument("--out", required=True, help="Output directory")
    subregions.add_argument("--index", help="Tile index JSON from the assemble command (for numeric ids)")
    subregions.add_argument("--extension", default="webp", help="Tile file extension (default: webp)")
    subregions.add_argument("--tile-size", type=int, default=DEFAULT_TILE_SIZE, help="Source tile size in px")
    subregions.add_argument("--scale", type=float, default=1.0, help="Output scale (default: 1.0)")
    subregions.add_argument("--format", choices=("webp", "png"), default="webp", help="Output format")
    subregions.add_argument("--quality", type=int, default=92, help="WebP quality")
    subregions.add_argument("--only-listed", action="store_true", help="Only include listed tiles, leaving others blank")
    subregions.add_argument("--background", default="#000000", help="Background color (default: #000000)")
    subregions.set_defaults(func=command_subregions)

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
