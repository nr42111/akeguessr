# akeguessr

A no-moving, no-panning GeoGuessr-style game for custom regions built as a static site. Each round shows one static photo; there is no walking, panning, or 360° view. Five photos per game: open the map, choose a region and sub-region, then drop a pin. Close guesses score points; the wrong sub-region scores zero.

No build step, no backend, no accounts. The game runs on GitHub Pages as plain HTML, CSS, and ES modules, with Leaflet loaded from a CDN.

## Features

- Five rounds per game with no repeated locations.
- A photo is cached as seen once a guess reveals the location; unguessed photos stay in the pool. The pool resets when fewer than five unseen photos remain.
- Static-photo gameplay with no moving or panning.
- Photo-first round flow with a semi-opaque **Maps** button.
- Region -> sub-region selection with a **Back** button.
- Full-screen sub-region maps with the photo in a bottom-left thumbnail.
- Click the photo thumbnail to swap the photo to full-screen and the map to a bottom-right thumbnail.
- Each map always has **Back** in the top-left to reopen sub-region selection.
- Scoring: wrong sub-region = 0; correct sub-region = distance score up to 5,000 per round (25,000 total).
- Zoomable/pannable photo viewer.
- Confirmed guesses can be submitted with the Space key.
- Round results with guess and answer pins connected by a line.
- Per-round breakdown and a personal best stored in `localStorage`.
- Per-photo look direction with an on-screen compass.
- Optional map layer switching (`b1`–`b4`, `l1`–`l4`) where a sub-region has layer content.
- Perfect 5,000-point guesses play `assets/sounds/YAAHHO.mp3`.
- Map images are prefetched into the browser HTTP cache after a game starts, without keeping decoded images in memory.
- Region and sub-region choices always show every map, even when some have no photos yet.
- Local coordinate validator for new photos, with an automatic queue.

## Project structure

```
/
├─ index.html
├─ dev.html           # coordinate validator
├─ .nojekyll
├─ css/styles.css
├─ js/
│  ├─ app.js          # game screens, round flow, photo viewer
│  ├─ dev.js          # coordinate validator
│  ├─ game.js         # rounds, selections, scoring flow
│  ├─ map.js          # Leaflet image-overlay map + pins
│  ├─ geo.js          # pixel distances and map scales
│  ├─ scoring.js      # pure scoring function
│  ├─ storage.js      # localStorage personal best
│  └─ ui.js           # DOM helpers
├─ data/
│  ├─ regions.json
│  └─ photo-coordinates.json
├─ assets/
│  ├─ photos/         # p_0001, p_0002, ...
│  ├─ sounds/         # YAAHHO.mp3 for perfect rounds
│  └─ maps/
│     └─ layers/      # transparent b1..b4/l1..l4 overlays
└─ tools/
   ├─ dev-server.mjs  # static server + photo/coordinate API
   ├─ validate-data.mjs
   ├─ geo.test.mjs
   ├─ annotate_subregions.py
   ├─ endfield_layers.py
   └─ tilemap.py
```

The Endfield maps are generated from the Open Endfield Map tileset. The photos and coordinates are placeholders until real in-game screenshots are added.

## Run locally

The coordinate validator needs the small Node development server so it can scan the photos folder and write coordinates back to disk:

```powershell
npm run dev
```

Then open:

- Game: <http://localhost:8787/>
- Coordinate validator: <http://localhost:8787/dev.html>

A plain static server also works for the game only:

```powershell
python -m http.server 8000
```

## Map coordinates and scale

Each sub-region map is a north-up image. Coordinates are pixel positions measured from the top-left corner of that image:

- `x` increases to the right.
- `y` increases downward.
- A map square is 500 pixels.
- One square is 55 metres in Valley IV and 62 metres in Wuling.

The game converts pixel distance to metres with `squareMeters / squarePixels` and scores directly in metres. Guesses within 2 metres score the full 5,000; the exponential falloff is calibrated so a 60-metre miss scores 4,000.

## Adding photos

Put photos in `assets/photos/` and name them `p_0001`, `p_0002`, `p_0003`, and so on. Keep the original extension (`.jpg`, `.webp`, `.png`, etc.). The validator only queues files that follow the `p_####` pattern.

Run the coordinate validator, choose a sub-region map, click the matching spot, set the look direction, and save. Coordinates and heading are written to `data/photo-coordinates.json`.

## Adding maps

Put one standalone map image per sub-region in `assets/maps/`, for example `assets/maps/valley-iv-the-hub.webp`. Map images should be north-up and unrotated. The `mapSize` in `data/regions.json` must match the image dimensions.

## Map layers

Sub-regions can have optional transparent overlays for the Open Endfield Map layers (`b1`–`b4`, `l1`–`l4`). The base map is always available; the layer selector shows **Base** plus only the layers that have real content for that sub-region.

The generated overlays live in `assets/maps/layers/` and are cropped to their visible content. Each entry stores the overlay rect in sub-region pixels:

```json
{
  "id": "valley-iv-the-hub",
  "layers": [
    {
      "id": "b1",
      "name": "B1",
      "image": "assets/maps/layers/valley-iv-the-hub-b1.webp",
      "offsetX": 78,
      "offsetY": 2040,
      "width": 6095,
      "height": 2536
    }
  ]
}
```

Layer tiles are fetched and composited from the Open Endfield Map CDN. The raw tiles are kept outside the site in `E:/dev/mapdl/endfield_maps/<Region>/layers/<suffix>/`:

```powershell
python -m pip install pillow requests
python tools/endfield_layers.py fetch
python tools/endfield_layers.py build
```

`fetch` uses the clip coverage published by the map site, verifies the existing base tile cache, and downloads only real layer tiles. `build` recomposites each layer using the same tile list and edge crops as the base sub-region image, crops the transparent margins, writes the WebP files, and updates `data/regions.json`. The build refuses to run if the base images do not match the mapdl sub-region outputs.

Marker Stone is an intentional exception: its layer overlays include the unassigned content tiles `6_55` and `7_55`, which live inside its existing map bounds, so no coordinates shift.

## Regions

Edit `data/regions.json`. Each region defines its square scale and any number of sub-regions:

```json
{
  "regions": [
    {
      "id": "valley-iv",
      "name": "Valley IV",
      "squareMeters": 55,
      "squarePixels": 500,
      "subRegions": [
        {
          "id": "valley-iv-the-hub",
          "code": "HB",
          "name": "The Hub",
          "mapImage": "assets/maps/valley-iv-the-hub.webp",
          "mapSize": { "width": 9000, "height": 6500 }
        }
      ]
    }
  ]
}
```

- `id` must be unique. Sub-region IDs must be unique across the whole file.
- `squareMeters` and `squarePixels` define the map scale for every sub-region in the region.
- `mapImage` is relative to the site root.
- `mapSize` is the pixel size of the map image.
- `layers` is optional; when present it is a list of overlay entries as described under **Map layers**.

## Photo coordinates

`data/photo-coordinates.json` is an object keyed by photo filename:

```json
{
  "p_0001.webp": {
    "regionId": "valley-iv",
    "subRegionId": "valley-iv-the-hub",
    "x": 4340,
    "y": 3020,
    "heading": 90
  }
}
```

Every photo must fall inside its sub-region's `mapSize`. `heading` is the camera look direction in degrees clockwise from north: `0` = north, `90` = east, `180` = south, `270` = west. The validator queues photos missing coordinates or a look direction. If coordinates exist but the heading is missing, the map and pin are prefilled so you only need to set the direction.

## Validate

```powershell
npm run validate
```

The validator checks duplicate IDs, broken references, missing image files, invalid map sizes or scales, layer rects and layer assets, coordinates outside their maps, heading ranges, photo naming, and unreferenced assets. Missing look directions and sub-regions without photos are warnings so partial content can still be tested.

## Scoring

Wrong sub-region:

```
points = 0
```

Correct sub-region:

```
distanceMeters = pixelDistance * (squareMeters / squarePixels)

if distanceMeters <= 2:
    points = 5000
else:
    k = ln(5000 / 4000) / 58
    points = min(5000, round(5000 * e^(-k * (distanceMeters - 2))))
```

The 2-metre grace gives a full 5,000 points, and the exponential is calibrated so a 60-metre miss scores 4,000.

## Tests

```powershell
npm test
```

This runs the built-in Node test suite for the geo, scoring, and game logic. `npm run check` runs both the tests and the data validator.

## Deploy to GitHub Pages

1. Push these files to the repository.
2. Open **Settings -> Pages**.
3. Choose **Deploy from a branch**, select `main`, and choose the `/ (root)` folder.
4. Save. The site will be available at `https://<user>.github.io/<repo>/`.

The site uses relative asset paths and includes `.nojekyll`, so it works under a project subpath without extra configuration. Leaflet is loaded from unpkg, so the browser needs internet access for the map UI and styles.

## Notes and limitations

- The coordinate validator only runs under `npm run dev`; the deployed game is static.
- The local dev server serves files with `Cache-Control: no-store`; map prefetching is intended for the deployed site/CDN.
- Photos are static images. This is intentionally a no-moving, no-panning variant of GeoGuessr; there is no 360° viewer.
- Photo coordinate data is visible in the client-side JSON. That is fine for a casual game but is not cheat-proof.
- The `localStorage` best score and seen-photo cache are per browser and per origin.
- There is no timer, account system, or global leaderboard.
- Photo and map files are only preloaded on demand; the current round's photo loads when the round starts.