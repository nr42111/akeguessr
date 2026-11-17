#!/usr/bin/env node
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const warnings = [];
const referencedAssets = new Set();

const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);

async function readJson(relativePath) {
  const absolutePath = path.join(root, relativePath);
  const raw = await readFile(absolutePath, "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${relativePath} is not valid JSON: ${error.message}`);
  }
}

async function fileExists(relativePath) {
  try {
    const info = await stat(path.join(root, relativePath));
    return info.isFile();
  } catch (error) {
    return false;
  }
}

async function listFiles(directory) {
  const absoluteDirectory = path.join(root, directory);
  let entries;

  try {
    entries = await readdir(absoluteDirectory, { withFileTypes: true });
  } catch (error) {
    return [];
  }

  const files = [];
  for (const entry of entries) {
    const relativePath = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(relativePath)));
    } else {
      files.push(relativePath);
    }
  }
  return files;
}

function checkMapSize(subRegionId, mapSize) {
  if (!mapSize || typeof mapSize !== "object") {
    errors.push(`sub-region "${subRegionId}" is missing mapSize.`);
    return false;
  }

  let valid = true;
  for (const key of ["width", "height"]) {
    if (!isFiniteNumber(mapSize[key]) || mapSize[key] <= 0) {
      errors.push(`sub-region "${subRegionId}" mapSize.${key} must be a positive number.`);
      valid = false;
    }
  }
  return valid;
}

function checkLayerRect(subRegionId, layer) {
  let valid = true;
  for (const key of ["offsetX", "offsetY", "width", "height"]) {
    if (!isFiniteNumber(layer[key])) {
      errors.push(
        `sub-region "${subRegionId}" layer "${layer.id}" ${key} must be a finite number.`
      );
      valid = false;
    }
  }
  if (!valid) return null;
  if (layer.offsetX < 0 || layer.offsetY < 0) {
    errors.push(`sub-region "${subRegionId}" layer "${layer.id}" offsets must be non-negative.`);
    valid = false;
  }
  if (layer.width <= 0 || layer.height <= 0) {
    errors.push(`sub-region "${subRegionId}" layer "${layer.id}" size must be positive.`);
    valid = false;
  }
  return valid ? layer : null;
}

async function checkAsset(relativePath, label) {
  if (typeof relativePath !== "string" || relativePath.trim() === "") {
    errors.push(`${label} must be a non-empty path.`);
    return;
  }
  referencedAssets.add(relativePath);
  if (!(await fileExists(relativePath))) {
    errors.push(`${label} points to a missing file: ${relativePath}`);
  }
}

async function main() {
  let regionsDoc;
  let coordinatesDoc;

  try {
    regionsDoc = await readJson("data/regions.json");
  } catch (error) {
    errors.push(error.message);
  }
  try {
    coordinatesDoc = await readJson("data/photo-coordinates.json");
  } catch (error) {
    errors.push(error.message);
  }

  const regions = Array.isArray(regionsDoc?.regions) ? regionsDoc.regions : [];
  if (!Array.isArray(regionsDoc?.regions) || regions.length === 0) {
    errors.push('data/regions.json must contain a non-empty "regions" array.');
  }

  const photoPattern = /^p_\d{4}\.(png|jpe?g|webp|svg|avif|gif)$/i;
  let locations = [];
  if (!coordinatesDoc || typeof coordinatesDoc !== "object" || Array.isArray(coordinatesDoc)) {
    errors.push("data/photo-coordinates.json must contain an object keyed by photo filename.");
  } else {
    locations = Object.entries(coordinatesDoc).map(([photoName, entry]) => ({
      id: photoName,
      image: `assets/photos/${photoName}`,
      ...entry,
    }));
    for (const location of locations) {
      if (!photoPattern.test(location.id)) {
        errors.push(`photo "${location.id}" must be named p_#### with an image extension.`);
      }
    }
  }

  const regionById = new Map();
  const subRegionById = new Map();

  for (const region of regions) {
    if (typeof region.id !== "string" || region.id.trim() === "") {
      errors.push("a region is missing a non-empty id.");
      continue;
    }
    if (regionById.has(region.id)) {
      errors.push(`duplicate region id: "${region.id}".`);
      continue;
    }
    if (typeof region.name !== "string" || region.name.trim() === "") {
      errors.push(`region "${region.id}" is missing a non-empty name.`);
    }
    if (!isFiniteNumber(region.squareMeters) || region.squareMeters <= 0) {
      errors.push(`region "${region.id}" squareMeters must be a positive number.`);
    }
    if (!isFiniteNumber(region.squarePixels) || region.squarePixels <= 0) {
      errors.push(`region "${region.id}" squarePixels must be a positive number.`);
    }

    regionById.set(region.id, region);

    const subRegions = Array.isArray(region.subRegions) ? region.subRegions : [];
    if (subRegions.length === 0) {
      errors.push(`region "${region.id}" must contain at least one sub-region.`);
      continue;
    }

    for (const subRegion of subRegions) {
      if (typeof subRegion.id !== "string" || subRegion.id.trim() === "") {
        errors.push(`a sub-region in region "${region.id}" is missing a non-empty id.`);
        continue;
      }
      if (subRegionById.has(subRegion.id)) {
        errors.push(`duplicate sub-region id: "${subRegion.id}". Sub-region ids must be unique.`);
        continue;
      }
      if (typeof subRegion.name !== "string" || subRegion.name.trim() === "") {
        errors.push(`sub-region "${subRegion.id}" is missing a non-empty name.`);
      }

      subRegionById.set(subRegion.id, { ...subRegion, regionId: region.id });
      checkMapSize(subRegion.id, subRegion.mapSize);
      await checkAsset(subRegion.mapImage, `sub-region "${subRegion.id}" mapImage`);

      if (subRegion.layers != null) {
        if (!Array.isArray(subRegion.layers)) {
          errors.push(`sub-region "${subRegion.id}" layers must be an array.`);
        } else {
          const layerIds = new Set();
          for (const layer of subRegion.layers) {
            if (!layer || typeof layer !== "object") {
              errors.push(`sub-region "${subRegion.id}" has an invalid layer entry.`);
              continue;
            }
            if (typeof layer.id !== "string" || layer.id.trim() === "") {
              errors.push(`sub-region "${subRegion.id}" has a layer without an id.`);
              continue;
            }
            if (layerIds.has(layer.id)) {
              errors.push(
                `sub-region "${subRegion.id}" has duplicate layer id "${layer.id}".`
              );
              continue;
            }
            layerIds.add(layer.id);
            if (typeof layer.name !== "string" || layer.name.trim() === "") {
              errors.push(
                `sub-region "${subRegion.id}" layer "${layer.id}" is missing a name.`
              );
            }
            const rect = checkLayerRect(subRegion.id, layer);
            if (
              rect &&
              subRegion.mapSize &&
              isFiniteNumber(subRegion.mapSize.width) &&
              isFiniteNumber(subRegion.mapSize.height) &&
              (rect.offsetX + rect.width > subRegion.mapSize.width ||
                rect.offsetY + rect.height > subRegion.mapSize.height)
            ) {
              errors.push(
                `sub-region "${subRegion.id}" layer "${layer.id}" is outside the map bounds.`
              );
            }
            await checkAsset(
              layer.image,
              `sub-region "${subRegion.id}" layer "${layer.id}" image`
            );
          }
        }
      }
    }
  }

  const locationIds = new Set();
  const locationsPerSubRegion = new Map();

  for (const location of locations) {
    if (typeof location.id !== "string" || location.id.trim() === "") {
      errors.push("a location is missing a non-empty id.");
      continue;
    }
    if (locationIds.has(location.id)) {
      errors.push(`duplicate location id: "${location.id}".`);
      continue;
    }
    locationIds.add(location.id);

    if (!isFiniteNumber(location.x) || !isFiniteNumber(location.y)) {
      errors.push(`location "${location.id}" must have numeric x and y.`);
      continue;
    }
    if (!isFiniteNumber(location.heading)) {
      warnings.push(`photo "${location.id}" has no look direction yet.`);
    } else if (location.heading < 0 || location.heading >= 360) {
      errors.push(`photo "${location.id}" heading must be between 0 and 359 degrees.`);
    }

    await checkAsset(location.image, `location "${location.id}" image`);

    const subRegion = subRegionById.get(location.subRegionId);
    const region = regionById.get(location.regionId);

    if (!region) {
      errors.push(`location "${location.id}" references unknown region "${location.regionId}".`);
    }
    if (!subRegion) {
      errors.push(`location "${location.id}" references unknown sub-region "${location.subRegionId}".`);
      continue;
    }
    if (subRegion.regionId !== location.regionId) {
      errors.push(
        `location "${location.id}" regionId "${location.regionId}" does not match sub-region "${subRegion.id}" (region "${subRegion.regionId}").`
      );
    }

    if (subRegion.mapSize) {
      const { width, height } = subRegion.mapSize;
      if (
        location.x < 0 ||
        location.x > width ||
        location.y < 0 ||
        location.y > height
      ) {
        errors.push(
          `location "${location.id}" (${location.x}, ${location.y}) is outside the map of sub-region "${subRegion.id}".`
        );
      }
    }

    locationsPerSubRegion.set(subRegion.id, (locationsPerSubRegion.get(subRegion.id) ?? 0) + 1);
  }

  for (const [subRegionId] of subRegionById) {
    if (!locationsPerSubRegion.has(subRegionId)) {
      warnings.push(`sub-region "${subRegionId}" has no photos yet.`);
    }
  }

  if (locations.length < 5) {
    warnings.push(
      `only ${locations.length} location(s) found; a full game uses up to 5. The game still works with fewer.`
    );
  }

  const photoFiles = (await listFiles("assets/photos")).filter((file) =>
    photoPattern.test(path.posix.basename(file))
  );
  for (const file of photoFiles) {
    if (!referencedAssets.has(file)) {
      warnings.push(`photo "${file}" has no coordinates yet.`);
    }
  }

  for (const directory of ["assets/photos", "assets/maps"]) {
    const files = await listFiles(directory);
    for (const file of files) {
      if (
        directory === "assets/photos" &&
        photoPattern.test(path.posix.basename(file))
      ) {
        continue;
      }
      if (!referencedAssets.has(file)) {
        warnings.push(`unreferenced asset: ${file}`);
      }
    }
  }

  for (const warning of warnings) {
    console.warn(`warning: ${warning}`);
  }
  for (const error of errors) {
    console.error(`error: ${error}`);
  }

  const subRegionCount = subRegionById.size;
  if (errors.length > 0) {
    console.error(`\nValidation failed with ${errors.length} error(s).`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `Validation passed: ${regions.length} region(s), ${subRegionCount} sub-region(s), ${locations.length} location(s).`
  );
  if (warnings.length > 0) {
    console.log(`${warnings.length} warning(s).`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
