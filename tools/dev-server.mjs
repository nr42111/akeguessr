#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const coordinatesPath = path.join(root, "data", "photo-coordinates.json");
const regionsPath = path.join(root, "data", "regions.json");
const photosDir = path.join(root, "assets", "photos");
const port = Number(process.env.PORT) || 8787;
const photoPattern = /^p_\d{4}\.(png|jpe?g|webp|svg|avif|gif)$/i;

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".avif", "image/avif"],
  [".gif", "image/gif"],
  [".ico", "image/x-icon"],
]);

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(body);
}

async function readCoordinates() {
  try {
    return JSON.parse(await readFile(coordinatesPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function writeCoordinates(coordinates) {
  await writeFile(
    coordinatesPath,
    `${JSON.stringify(coordinates, null, 2)}\n`,
    "utf8"
  );
}

async function listPhotos() {
  const entries = await readdir(photosDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && photoPattern.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

async function readRegions() {
  return JSON.parse(await readFile(regionsPath, "utf8"));
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) {
      throw new Error("Request body is too large.");
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function handlePhotos(response) {
  const [photos, coordinates] = await Promise.all([
    listPhotos(),
    readCoordinates(),
  ]);
  const entries = photos.map((name) => {
    const entry = coordinates[name] ?? null;
    const complete =
      entry != null &&
      Number.isFinite(entry.x) &&
      Number.isFinite(entry.y) &&
      Number.isFinite(entry.heading);
    return {
      name,
      url: `assets/photos/${name}`,
      coordinates: entry,
      complete,
    };
  });
  sendJson(response, 200, {
    photos: entries,
    pending: entries.filter((photo) => !photo.complete).map((photo) => photo.name),
    validatedCount: entries.filter((photo) => photo.complete).length,
  });
}

async function handleSaveCoordinates(request, response) {
  const body = await readBody(request);
  const photo = String(body.photo ?? "").trim();
  const regionId = String(body.regionId ?? "").trim();
  const subRegionId = String(body.subRegionId ?? "").trim();
  const x = Number(body.x);
  const y = Number(body.y);
  const heading = Number(body.heading);

  if (!photoPattern.test(photo)) {
    sendJson(response, 400, { error: "Photo must be named p_#### with an image extension." });
    return;
  }

  const photos = await listPhotos();
  if (!photos.includes(photo)) {
    sendJson(response, 404, { error: `Photo not found: ${photo}` });
    return;
  }

  const regions = await readRegions();
  const region = (regions.regions ?? []).find((item) => item.id === regionId);
  const subRegion = region?.subRegions?.find((item) => item.id === subRegionId);
  if (!region || !subRegion) {
    sendJson(response, 400, { error: "Unknown region or sub-region." });
    return;
  }

  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < 0 ||
    y < 0 ||
    x > subRegion.mapSize.width ||
    y > subRegion.mapSize.height
  ) {
    sendJson(response, 400, { error: "Coordinates are outside the map." });
    return;
  }

  if (!Number.isFinite(heading) || heading < 0 || heading >= 360) {
    sendJson(response, 400, { error: "Look direction must be between 0 and 359 degrees." });
    return;
  }

  const coordinates = await readCoordinates();
  coordinates[photo] = {
    regionId,
    subRegionId,
    x: Math.round(x),
    y: Math.round(y),
    heading: Math.round(heading),
  };
  await writeCoordinates(coordinates);
  sendJson(response, 200, { saved: true, photo, coordinates: coordinates[photo] });
}

async function serveFile(response, pathname, method) {
  const filePath = path.resolve(root, `.${pathname}`);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  const info = await stat(filePath);
  if (!info.isFile()) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  const data = await readFile(filePath);
  const contentType = mimeTypes.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream";
  response.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": data.length,
    "Cache-Control": "no-store",
  });
  if (method === "HEAD") {
    response.end();
  } else {
    response.end(data);
  }
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (url.pathname === "/api/photos" && request.method === "GET") {
      await handlePhotos(response);
      return;
    }
    if (url.pathname === "/api/coordinates" && request.method === "POST") {
      await handleSaveCoordinates(request, response);
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405);
      response.end("Method not allowed");
      return;
    }

    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") pathname = "/index.html";
    if (pathname === "/dev") pathname = "/dev.html";
    await serveFile(response, pathname, request.method);
  } catch (error) {
    if (error.code === "ENOENT") {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    console.error(error);
    response.writeHead(500);
    response.end("Internal server error");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`akeguessr dev server`);
  console.log(`  game:      http://localhost:${port}/`);
  console.log(`  validator: http://localhost:${port}/dev.html`);
});
