#!/usr/bin/env python3
"""Color-code assembled Endfield map tiles by sub-region and label them.

The map site (Open Endfield Map) publishes sub-region polygons in map units
where one 500px source tile spans 200 units. This tool rasterizes those
polygons over the numbered tile atlas and writes:

- ``<Region>_subregions.webp``: numbered tile atlas tinted by sub-region.
- ``<Region>_subregions_map.webp``: clean overview with the same tints.
- ``<Region>_subregions.json``: per-tile sub-region assignments.
- ``<Region>_subregions_tilemap.json``: config for ``tilemap.py subregions``.

Example:
    python tools/annotate_subregions.py --assembled "E:/dev/mapdl/endfield_maps"

Requires Pillow:  python -m pip install pillow
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

Image.MAX_IMAGE_PIXELS = None

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_DEFINITIONS = SCRIPT_DIR / "endfield_subregions.json"
SAMPLE_GRID = 8
MIN_ASSIGN_OVERLAP = 0.05


def load_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
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


def parse_hex(color: str) -> tuple[int, int, int]:
    value = color.lstrip("#")
    return tuple(int(value[index : index + 2], 16) for index in (0, 2, 4))


def point_in_ring(point: tuple[float, float], ring: list[list[float]]) -> bool:
    x, y = point
    inside = False
    count = len(ring)
    previous = count - 1
    for index in range(count):
        xi, yi = ring[index]
        xj, yj = ring[previous]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        previous = index
    return inside


def point_in_polygon(point: tuple[float, float], polygon: list[list[list[float]]]) -> bool:
    return any(point_in_ring(point, ring) for ring in polygon)


def overlap_fraction(
    x0: float,
    y0: float,
    x1: float,
    y1: float,
    polygon: list[list[list[float]]],
    grid: int = SAMPLE_GRID,
) -> float:
    hits = 0
    for ix in range(grid):
        for iy in range(grid):
            px = x0 + (ix + 0.5) * (x1 - x0) / grid
            py = y0 + (iy + 0.5) * (y1 - y0) / grid
            if point_in_polygon((px, py), polygon):
                hits += 1
    return hits / (grid * grid)


def load_tiles(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def assign_tiles(
    data: dict,
    subregions: list[dict],
    units_per_tile: float,
    overrides: dict[int, str] | None = None,
) -> tuple[list[dict], dict, list[dict]]:
    overrides = overrides or {}
    assignments: list[dict] = []
    per_subregion: dict[str, dict] = {
        subregion["id"]: {"tiles": [], "coreTiles": [], "edgeTiles": []}
        for subregion in subregions
    }
    by_id = {subregion["id"]: subregion for subregion in subregions}
    ambiguous: list[dict] = []

    for tile in data["tiles"]:
        x0 = tile["x"] * units_per_tile
        y0 = tile["y"] * units_per_tile
        x1 = x0 + units_per_tile
        y1 = y0 + units_per_tile
        center = ((x0 + x1) / 2, (y0 + y1) / 2)

        fractions: dict[str, float] = {}
        center_hits: list[str] = []
        for subregion in subregions:
            polygon = subregion["polygon"]
            fraction = overlap_fraction(x0, y0, x1, y1, polygon)
            if fraction > 0:
                fractions[subregion["id"]] = fraction
            if point_in_polygon(center, polygon):
                center_hits.append(subregion["id"])

        override = overrides.get(int(tile["id"]))
        if override is not None and override not in by_id:
            raise SystemExit(
                f"Tile {tile['id']} override references unknown sub-region {override!r}"
            )

        chosen = None
        reason = "none"
        chosen_fraction = 0.0
        if override is not None:
            chosen = override
            chosen_fraction = fractions.get(override, 0.0)
            reason = "override"
        elif fractions:
            best_fraction = max(fractions.values())
            if best_fraction >= MIN_ASSIGN_OVERLAP:
                tied = [
                    subregion["id"]
                    for subregion in subregions
                    if abs(fractions.get(subregion["id"], 0.0) - best_fraction) < 1e-9
                ]
                if len(tied) > 1:
                    ambiguous.append(
                        {
                            "id": tile["id"],
                            "tile": f"{tile['x']}_{tile['y']}",
                            "candidates": tied,
                            "chosen": tied[0],
                        }
                    )
                chosen = tied[0]
                chosen_fraction = best_fraction
                reason = "overlap"

        if chosen:
            entry = per_subregion[chosen]
            reference = f"{tile['x']}_{tile['y']}"
            entry["tiles"].append(reference)
            if chosen in center_hits:
                entry["coreTiles"].append(reference)
            else:
                entry["edgeTiles"].append(reference)

        assignments.append(
            {
                "id": tile["id"],
                "x": tile["x"],
                "y": tile["y"],
                "file": tile["file"],
                "subRegionId": chosen,
                "overlap": round(chosen_fraction, 4),
                "centerInside": chosen if chosen in center_hits else None,
                "assignment": reason,
            }
        )

    return assignments, per_subregion, ambiguous


def draw_tile_atlas(
    base: Image.Image,
    data: dict,
    definitions: dict,
    assignments: list[dict],
    *,
    numbered: bool,
) -> Image.Image:
    image = base.convert("RGBA")
    width, height = image.size
    bounds = data["tileBounds"]
    columns = bounds["maxX"] - bounds["minX"] + 1
    rows = bounds["maxY"] - bounds["minY"] + 1
    tile_px = width / columns
    units_per_tile = definitions["unitsPerTile"]
    scale = tile_px / units_per_tile
    offset_x = bounds["minX"] * units_per_tile
    offset_y = bounds["minY"] * units_per_tile
    assert math.isclose(tile_px, height / rows, rel_tol=1e-6)

    subregions = definitions["subRegions"]
    by_id = {subregion["id"]: subregion for subregion in subregions}
    assignment_by_tile = {(entry["x"], entry["y"]): entry for entry in assignments}

    tint = Image.new("RGBA", image.size, (0, 0, 0, 0))
    tint_draw = ImageDraw.Draw(tint)
    for tile in data["tiles"]:
        entry = assignment_by_tile[(tile["x"], tile["y"])]
        if not entry["subRegionId"]:
            continue
        color = parse_hex(by_id[entry["subRegionId"]]["color"])
        alpha = 70 + round(90 * entry["overlap"])
        px = (tile["x"] - bounds["minX"]) * tile_px
        py = (tile["y"] - bounds["minY"]) * tile_px
        tint_draw.rectangle([px, py, px + tile_px - 1, py + tile_px - 1], fill=(*color, alpha))
    image = Image.alpha_composite(image, tint).convert("RGB")

    draw = ImageDraw.Draw(image)
    id_font = load_font(max(9, round(tile_px * 0.30)), bold=True)
    coord_font = load_font(max(7, round(tile_px * 0.12)), bold=False)
    outline_width = max(1, round(tile_px * 0.025))
    id_stroke = max(1, round(tile_px * 0.016))
    coord_stroke = max(1, round(tile_px * 0.008))

    for tile in data["tiles"]:
        entry = assignment_by_tile[(tile["x"], tile["y"])]
        if not entry["subRegionId"]:
            continue
        color = parse_hex(by_id[entry["subRegionId"]]["color"])
        px = (tile["x"] - bounds["minX"]) * tile_px
        py = (tile["y"] - bounds["minY"]) * tile_px
        draw.rectangle(
            [px, py, px + tile_px - 1, py + tile_px - 1],
            outline=color,
            width=outline_width,
        )

    if numbered:
        for tile in data["tiles"]:
            px = (tile["x"] - bounds["minX"]) * tile_px
            py = (tile["y"] - bounds["minY"]) * tile_px
            center_x = px + tile_px / 2
            center_y = py + tile_px / 2
            draw.text(
                (center_x, center_y - tile_px * 0.10),
                str(tile["id"]),
                font=id_font,
                fill=(255, 255, 255),
                anchor="mm",
                stroke_width=id_stroke,
                stroke_fill=(0, 0, 0),
            )
            draw.text(
                (center_x, center_y + tile_px * 0.18),
                f"{tile['x']}_{tile['y']}",
                font=coord_font,
                fill=(235, 245, 238),
                anchor="mm",
                stroke_width=coord_stroke,
                stroke_fill=(0, 0, 0),
            )

    for subregion in subregions:
        color = parse_hex(subregion["color"])
        for ring in subregion["polygon"]:
            points = [((x - offset_x) * scale, (y - offset_y) * scale) for x, y in ring]
            draw.line(points + [points[0]], fill=(0, 0, 0), width=max(3, round(tile_px * 0.06)))
            draw.line(points + [points[0]], fill=color, width=max(1, round(tile_px * 0.03)))

    return image


def draw_labels(
    image: Image.Image,
    definitions: dict,
    assignments: list[dict],
) -> Image.Image:
    width, height = image.size
    data_bounds = definitions["_tileBounds"]
    units_per_tile = definitions["unitsPerTile"]
    columns = data_bounds["maxX"] - data_bounds["minX"] + 1
    tile_px = width / columns
    scale = tile_px / units_per_tile
    offset_x = data_bounds["minX"] * units_per_tile
    offset_y = data_bounds["minY"] * units_per_tile

    counts: dict[str, int] = {}
    for entry in assignments:
        if entry["subRegionId"]:
            counts[entry["subRegionId"]] = counts.get(entry["subRegionId"], 0) + 1

    size_scale = max(1.0, math.sqrt(width / 4625))
    stroke_width = max(2, round(3 * size_scale))
    label_font = load_font(max(18, round(tile_px * 0.38 * size_scale)), bold=True)
    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    for subregion in definitions["subRegions"]:
        color = parse_hex(subregion["color"])
        point = subregion["labelPoint"]
        x = (point[0] - offset_x) * scale
        y = (point[1] - offset_y) * scale
        count = counts.get(subregion["id"], 0)
        text = f"{subregion['code']}  {subregion['name']}"
        if count:
            text += f"  ·  {count} tiles"
        else:
            text += "  ·  no surface tiles"
        bbox = draw.textbbox((0, 0), text, font=label_font, stroke_width=stroke_width)
        text_width = bbox[2] - bbox[0]
        text_height = bbox[3] - bbox[1]
        padding = max(6, round(tile_px * 0.08 * size_scale))
        margin = max(16, round(16 * size_scale))
        box_x = min(
            max(margin, x - text_width / 2),
            width - text_width - margin - padding * 2,
        )
        box_y = min(
            max(margin, y - text_height / 2),
            height - text_height - margin - padding * 2,
        )
        draw.rounded_rectangle(
            [
                box_x - padding,
                box_y - padding,
                box_x + text_width + padding * 2,
                box_y + text_height + padding * 2,
            ],
            radius=padding,
            fill=(0, 0, 0, 210),
            outline=(*color, 255),
            width=max(2, round(tile_px * 0.03 * size_scale)),
        )
        draw.text(
            (box_x, box_y - bbox[1]),
            text,
            font=label_font,
            fill=(255, 255, 255, 255),
            stroke_width=stroke_width,
            stroke_fill=(0, 0, 0, 255),
        )
    return Image.alpha_composite(image.convert("RGBA"), overlay).convert("RGB")


def draw_legend(
    image: Image.Image,
    title: str,
    definitions: dict,
    assignments: list[dict],
) -> Image.Image:
    width, height = image.size
    tile_px = width / (
        definitions["_tileBounds"]["maxX"] - definitions["_tileBounds"]["minX"] + 1
    )
    size_scale = max(1.0, math.sqrt(width / 4625))
    title_font = load_font(max(20, round(tile_px * 0.32 * size_scale)), bold=True)
    row_font = load_font(max(16, round(tile_px * 0.24 * size_scale)), bold=False)
    row_height = max(24, round(tile_px * 0.34 * size_scale))
    swatch = max(14, round(tile_px * 0.22 * size_scale))
    padding = max(10, round(tile_px * 0.16 * size_scale))
    margin = max(12, round(tile_px * 0.16 * size_scale))

    counts: dict[str, int] = {}
    for entry in assignments:
        if entry["subRegionId"]:
            counts[entry["subRegionId"]] = counts.get(entry["subRegionId"], 0) + 1
    unassigned_count = sum(1 for entry in assignments if not entry["subRegionId"])

    title_bbox = title_font.getbbox(title) if hasattr(title_font, "getbbox") else (0, 0, 0, 0)
    title_width = title_bbox[2] - title_bbox[0]
    rows: list[tuple[dict | None, str]] = []
    for subregion in definitions["subRegions"]:
        count = counts.get(subregion["id"], 0)
        suffix = f"{count}" if count else "no surface tiles"
        rows.append((subregion, f"{subregion['code']}  {subregion['name']}  ·  {suffix}"))
    rows.append((None, f"—  Outside sub-region polygons  ·  {unassigned_count}"))
    row_texts = [text for _, text in rows]
    row_widths = []
    for text in row_texts:
        bbox = row_font.getbbox(text) if hasattr(row_font, "getbbox") else (0, 0, 0, 0)
        row_widths.append(bbox[2] - bbox[0])
    panel_width = max([title_width, *row_widths]) + padding * 2 + swatch + padding * 2
    panel_height = padding * 2 + row_height * (len(row_texts) + 1)
    panel_height += max(4, row_height // 4)

    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    draw.rounded_rectangle(
        [margin, margin, margin + panel_width, margin + panel_height],
        radius=padding,
        fill=(0, 0, 0, 205),
        outline=(255, 255, 255, 140),
        width=2,
    )
    text_x = margin + padding
    draw.text((text_x, margin + padding), title, font=title_font, fill=(255, 255, 255, 255))
    y = margin + padding + row_height + max(4, row_height // 4)
    for subregion, text in rows:
        color = parse_hex(subregion["color"]) if subregion else (120, 120, 120)
        draw.rounded_rectangle(
            [text_x, y + (row_height - swatch) / 2, text_x + swatch, y + (row_height + swatch) / 2],
            radius=max(2, swatch // 4),
            fill=(*color, 255),
        )
        draw.text(
            (text_x + swatch + padding, y),
            text,
            font=row_font,
            fill=(255, 255, 255, 255),
        )
        y += row_height
    return Image.alpha_composite(image.convert("RGBA"), overlay).convert("RGB")


def build_tilemap_config(
    region: str,
    display_name: str,
    subregions: list[dict],
    per_subregion: dict[str, dict],
    crop_records: list[tuple[str, str, list[float]]] | None = None,
) -> dict:
    crops_by_region: dict[str, list[dict]] = {}
    for subregion_id, reference, box in crop_records or []:
        crops_by_region.setdefault(subregion_id, []).append(
            {"tile": reference, "box": box}
        )

    entries = []
    for subregion in subregions:
        entry = per_subregion[subregion["id"]]
        crops = crops_by_region.get(subregion["id"], [])
        crop_tiles = {crop["tile"] for crop in crops}
        config_entry = {
            "id": subregion["code"].lower(),
            "name": f"{display_name} - {subregion['name']}",
            "tiles": [reference for reference in entry["tiles"] if reference not in crop_tiles],
            "onlyListed": True,
            "scale": 1.0,
        }
        if crops:
            config_entry["crops"] = crops
        entries.append(config_entry)
    return {"region": region, "subregions": entries}


def write_outputs(region_root: Path, region: str, definitions: dict, results: dict) -> None:
    data = results["data"]
    assignments = results["assignments"]
    per_subregion = results["per_subregion"]
    display_name = definitions["displayName"]

    tile_refs = {
        int(tile["id"]): f"{tile['x']}_{tile['y']}" for tile in data["tiles"]
    }
    crop_records: list[tuple[str, str, list[float]]] = []
    partial_by_region: dict[str, list[dict]] = {}
    for crop in definitions.get("tileCrops", []):
        tile_id = int(crop["tile"])
        reference = tile_refs.get(tile_id)
        if reference is None:
            raise SystemExit(f"{region}: crop references unknown tile id {tile_id}")
        for subregion_id, box in crop.get("regions", {}).items():
            crop_box = [float(value) for value in box]
            crop_records.append((subregion_id, reference, crop_box))
            partial_by_region.setdefault(subregion_id, []).append(
                {"tile": reference, "box": crop_box}
            )

    mapping = {
        "region": region,
        "displayName": display_name,
        "unitsPerTile": definitions["unitsPerTile"],
        "sourceIndex": definitions["index"],
        "subRegions": [],
        "tiles": assignments,
    }
    for subregion in definitions["subRegions"]:
        entry = per_subregion[subregion["id"]]
        mapping["subRegions"].append(
            {
                "id": subregion["id"],
                "code": subregion["code"],
                "name": subregion["name"],
                "color": subregion["color"],
                "labelPoint": subregion["labelPoint"],
                "tileCount": len(entry["tiles"]),
                "bounds": subregion.get("bounds"),
                "tiles": entry["tiles"],
                "coreTiles": entry["coreTiles"],
                "edgeTiles": entry["edgeTiles"],
                "partialTiles": partial_by_region.get(subregion["id"], []),
            }
        )
    mapping["unassignedTileIds"] = [
        entry["id"] for entry in assignments if not entry["subRegionId"]
    ]

    seen_tiles: dict[str, str] = {}
    for subregion in mapping["subRegions"]:
        for reference in subregion["tiles"]:
            if reference in seen_tiles:
                raise SystemExit(
                    f"{region}: tile {reference} is assigned to both "
                    f"{seen_tiles[reference]} and {subregion['code']}"
                )
            seen_tiles[reference] = subregion["code"]
    assigned_count = sum(1 for entry in assignments if entry["subRegionId"])
    if len(seen_tiles) != assigned_count:
        raise SystemExit(
            f"{region}: {assigned_count} assigned tiles but {len(seen_tiles)} "
            "tile references in sub-region lists"
        )

    output_dir = region_root / "assembled"
    output_dir.mkdir(parents=True, exist_ok=True)
    mapping_path = output_dir / f"{region}_subregions.json"
    mapping_path.write_text(json.dumps(mapping, indent=2) + "\n", encoding="utf-8")

    config_path = output_dir / f"{region}_subregions_tilemap.json"
    config_path.write_text(
        json.dumps(
            build_tilemap_config(
                region,
                display_name,
                definitions["subRegions"],
                per_subregion,
                crop_records,
            ),
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    numbered_path = region_root / "assembled" / definitions["numberedImage"]
    overview_path = region_root / "assembled" / definitions["overviewImage"]
    definitions_numbered = dict(definitions, _tileBounds=data["tileBounds"])
    definitions_numbered["_tileBounds"] = data["tileBounds"]

    if numbered_path.exists():
        base = Image.open(numbered_path)
        image = draw_tile_atlas(base, data, definitions, assignments, numbered=True)
        image = draw_labels(image, definitions_numbered, assignments)
        image = draw_legend(image, f"{display_name} · {len(definitions['subRegions'])} sub-regions", definitions_numbered, assignments)
        numbered_out = output_dir / f"{region}_subregions.webp"
        image.convert("RGB").save(numbered_out, quality=90, method=4)
        print(f"Wrote {numbered_out} ({image.width}x{image.height})", flush=True)

    if overview_path.exists():
        base = Image.open(overview_path)
        image = draw_tile_atlas(base, data, definitions, assignments, numbered=False)
        image = draw_labels(image, definitions_numbered, assignments)
        image = draw_legend(image, f"{display_name} · {len(definitions['subRegions'])} sub-regions", definitions_numbered, assignments)
        overview_out = output_dir / f"{region}_subregions_map.webp"
        image.convert("RGB").save(overview_out, quality=90, method=4)
        print(f"Wrote {overview_out} ({image.width}x{image.height})", flush=True)

    print(f"Wrote {mapping_path}", flush=True)
    print(f"Wrote {config_path}", flush=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--assembled",
        required=True,
        help="Root directory containing <Region>/assembled tile JSON and atlases",
    )
    parser.add_argument(
        "--definitions",
        default=str(DEFAULT_DEFINITIONS),
        help="Sub-region definitions JSON (default: tools/endfield_subregions.json)",
    )
    parser.add_argument(
        "--region",
        action="append",
        dest="regions",
        help="Region key to process (repeatable; default: all in definitions)",
    )
    return parser


def main() -> None:
    args = build_parser().parse_args()
    definitions_path = Path(args.definitions)
    definitions_doc = json.loads(definitions_path.read_text(encoding="utf-8"))
    assembled_root = Path(args.assembled)
    regions = args.regions or list(definitions_doc["regions"])

    for region in regions:
        if region not in definitions_doc["regions"]:
            raise SystemExit(f"Region {region!r} is not in {definitions_path}")
        region_root = assembled_root / region
        definitions = definitions_doc["regions"][region]
        index_path = region_root / "assembled" / definitions["index"]
        data = load_tiles(index_path)
        overrides = {
            int(tile_id): subregion_id
            for tile_id, subregion_id in definitions.get("tileOverrides", {}).items()
        }
        assignments, per_subregion, ambiguous = assign_tiles(
            data,
            definitions["subRegions"],
            definitions_doc["unitsPerTile"],
            overrides,
        )
        results = {
            "data": data,
            "assignments": assignments,
            "per_subregion": per_subregion,
        }
        definitions_with_info = dict(definitions)
        definitions_with_info["overviewImage"] = definitions.get(
            "overviewImage", f"{region}_overview.webp"
        )
        definitions_with_info["unitsPerTile"] = definitions_doc["unitsPerTile"]
        definitions_with_info["_tileBounds"] = data["tileBounds"]
        write_outputs(
            region_root,
            region,
            definitions_with_info,
            results,
        )
        counts = {}
        for entry in assignments:
            if entry["subRegionId"]:
                counts[entry["subRegionId"]] = counts.get(entry["subRegionId"], 0) + 1
        print(
            f"{region}: {len(data['tiles'])} tiles, "
            + ", ".join(f"{s['code']}={counts.get(s['id'], 0)}" for s in definitions["subRegions"]),
            flush=True,
        )
        print(
            f"  applied {len(overrides)} tile overrides; "
            f"{len(ambiguous)} boundary ties auto-resolved",
            flush=True,
        )


if __name__ == "__main__":
    main()
