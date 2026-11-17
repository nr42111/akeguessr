import { clear, create, hide, show } from "./ui.js";

const LAYER_ORDER = ["b1", "b2", "b3", "b4", "l1", "l2", "l3", "l4"];

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not load map image: ${src}`));
    image.src = src;
  });
}

function layerRank(id) {
  const index = LAYER_ORDER.indexOf(id);
  return index === -1 ? LAYER_ORDER.length : index;
}

function guessIcon() {
  return L.divIcon({
    className: "gp-pin gp-pin-guess",
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });
}

function answerIcon() {
  return L.divIcon({
    className: "gp-pin gp-pin-answer",
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });
}

export async function createMapController(
  container,
  {
    imageUrl,
    mapSize,
    locked = false,
    layers = [],
    layerContainer = null,
    onLayerError = null,
  }
) {
  if (!window.L) {
    throw new Error("Leaflet failed to load. Check your connection and reload.");
  }

  const image = await loadImage(imageUrl);
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;

  if (!width || !height) {
    throw new Error("The map image has no usable dimensions.");
  }

  if (mapSize && (width !== mapSize.width || height !== mapSize.height)) {
    throw new Error(
      `The map image is ${width}\u00d7${height}, but the data says ${mapSize.width}\u00d7${mapSize.height}.`
    );
  }

  const map = L.map(container, {
    crs: L.CRS.Simple,
    attributionControl: false,
    zoomControl: true,
    minZoom: -5,
    maxZoom: 5,
    zoomSnap: 0.25,
    maxBoundsViscosity: 0.85,
  });

  const mapBounds = L.latLngBounds([
    [0, 0],
    [height, width],
  ]);

  const baseOverlay = L.imageOverlay(imageUrl, mapBounds).addTo(map);
  map.fitBounds(mapBounds, { padding: [12, 12] });
  map.setMaxBounds(mapBounds);

  const layerById = new Map(
    (Array.isArray(layers) ? layers : [])
      .filter((layer) => layer && typeof layer.id === "string")
      .map((layer) => [layer.id, layer])
  );
  let currentLayerId = "base";
  let activeLayerOverlay = null;
  let layerRequestId = 0;

  let guess = null;
  let guessMarker = null;
  let answerMarker = null;
  let line = null;
  let isLocked = Boolean(locked);
  let guessChangeHandler = null;

  function toCrs(px, py) {
    return L.latLng(height - py, px);
  }

  function sortedLayers() {
    return [...layerById.values()].sort((a, b) => layerRank(a.id) - layerRank(b.id));
  }

  function updateLayerButtons() {
    if (!layerContainer) return;
    for (const button of layerContainer.querySelectorAll(".layer-button")) {
      const active = button.dataset.layer === currentLayerId;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    }
  }

  async function applyLayer(layerId) {
    const target = layerId || "base";
    if (target === currentLayerId) return;

    const requestId = ++layerRequestId;

    if (target === "base") {
      if (activeLayerOverlay) {
        activeLayerOverlay.remove();
        activeLayerOverlay = null;
      }
      baseOverlay.setOpacity(1);
      currentLayerId = "base";
      updateLayerButtons();
      return;
    }

    const layer = layerById.get(target);
    if (!layer) {
      throw new Error(`Unknown map layer: ${target}`);
    }

    const offsetX = Number(layer.offsetX);
    const offsetY = Number(layer.offsetY);
    const layerWidth = Number(layer.width);
    const layerHeight = Number(layer.height);
    if (
      ![offsetX, offsetY, layerWidth, layerHeight].every(Number.isFinite) ||
      offsetX < 0 ||
      offsetY < 0 ||
      layerWidth <= 0 ||
      layerHeight <= 0 ||
      (mapSize &&
        (offsetX + layerWidth > mapSize.width || offsetY + layerHeight > mapSize.height))
    ) {
      throw new Error(`The layer "${target}" has invalid bounds.`);
    }

    const image = await loadImage(layer.image);
    if (requestId !== layerRequestId) return;

    const naturalWidth = image.naturalWidth || image.width;
    const naturalHeight = image.naturalHeight || image.height;
    if (naturalWidth !== layerWidth || naturalHeight !== layerHeight) {
      throw new Error(
        `The layer image is ${naturalWidth}\u00d7${naturalHeight}, but the data says ${layerWidth}\u00d7${layerHeight}.`
      );
    }

    const layerBounds = L.latLngBounds([
      [height - (offsetY + layerHeight), offsetX],
      [height - offsetY, offsetX + layerWidth],
    ]);

    const overlay = L.imageOverlay(layer.image, layerBounds, {
      opacity: 1,
      zIndex: 2,
      interactive: false,
      className: "map-layer-overlay",
    });

    overlay.on("error", () => {
      if (activeLayerOverlay !== overlay) return;
      overlay.remove();
      activeLayerOverlay = null;
      baseOverlay.setOpacity(1);
      currentLayerId = "base";
      updateLayerButtons();
      if (onLayerError) onLayerError(new Error(`Could not load layer "${target}".`));
    });

    if (activeLayerOverlay) activeLayerOverlay.remove();
    overlay.addTo(map);
    activeLayerOverlay = overlay;
    baseOverlay.setOpacity(0.5);
    currentLayerId = target;
    updateLayerButtons();
  }

  function renderLayerButtons() {
    if (!layerContainer) return;
    clear(layerContainer);

    if (layerById.size === 0) {
      hide(layerContainer);
      return;
    }

    const entries = [
      { id: "base", name: "Base" },
      ...sortedLayers().map((layer) => ({
        id: layer.id,
        name: layer.name || layer.id.toUpperCase(),
      })),
    ];

    for (const entry of entries) {
      const button = create("button", {
        className: "layer-button",
        text: entry.name,
        attrs: {
          type: "button",
          "data-layer": entry.id,
          "aria-pressed": "false",
          title: `Show ${entry.name}`,
        },
      });
      button.addEventListener("click", async () => {
        if (button.disabled || currentLayerId === entry.id) return;
        button.disabled = true;
        button.classList.add("loading");
        try {
          await applyLayer(entry.id);
        } catch (error) {
          if (onLayerError) onLayerError(error);
          else console.error(error);
        } finally {
          button.disabled = false;
          button.classList.remove("loading");
        }
      });
      layerContainer.append(button);
    }

    show(layerContainer);
    updateLayerButtons();
  }

  renderLayerButtons();

  function setGuess(x, y) {
    if (isLocked) return;

    const px = Math.min(width, Math.max(0, x));
    const py = Math.min(height, Math.max(0, y));
    guess = { x: px, y: py };

    if (!guessMarker) {
      guessMarker = L.marker(toCrs(px, py), {
        icon: guessIcon(),
        draggable: true,
        keyboard: false,
        autoPan: true,
      }).addTo(map);
      guessMarker.on("dragend", () => {
        if (!guessMarker) return;
        applyGuess(guessMarker.getLatLng());
      });
    } else {
      guessMarker.setLatLng(toCrs(px, py));
    }

    if (guessChangeHandler) guessChangeHandler(guess);
  }

  function applyGuess(latlng) {
    if (isLocked) return;
    setGuess(latlng.lng, height - latlng.lat);
  }

  function onMapClick(event) {
    applyGuess(event.latlng);
  }

  map.on("click", onMapClick);

  if (isLocked) {
    container.classList.add("map-locked");
  }

  function addAnswer(x, y) {
    const answerLatLng = toCrs(x, y);

    answerMarker = L.marker(answerLatLng, {
      icon: answerIcon(),
      interactive: false,
      keyboard: false,
    }).addTo(map);

    if (guessMarker) {
      line = L.polyline([guessMarker.getLatLng(), answerLatLng], {
        color: "#ffffff",
        weight: 2.5,
        opacity: 0.85,
        dashArray: "6 8",
      }).addTo(map);

      map.fitBounds(L.latLngBounds([guessMarker.getLatLng(), answerLatLng]), {
        padding: [70, 70],
        maxZoom: 1,
      });
    } else {
      map.setView(answerLatLng, Math.max(map.getZoom(), 0));
    }
  }

  function lock() {
    isLocked = true;
    map.off("click", onMapClick);
    container.classList.add("map-locked");
    if (guessMarker && guessMarker.dragging) {
      guessMarker.dragging.disable();
    }
  }

  function clearGuess() {
    if (guessMarker) {
      guessMarker.remove();
      guessMarker = null;
    }
    if (line) {
      line.remove();
      line = null;
    }
    guess = null;
    if (guessChangeHandler) guessChangeHandler(null);
  }

  function fit() {
    map.invalidateSize();
    map.fitBounds(mapBounds, { padding: [12, 12] });
  }

  return {
    getGuess: () => guess,
    onGuessChange: (handler) => {
      guessChangeHandler = handler;
    },
    addAnswer,
    lock,
    clearGuess,
    setGuess,
    setLayer: applyLayer,
    getLayer: () => currentLayerId,
    layers: sortedLayers(),
    fit,
    destroy: () => {
      layerRequestId += 1;
      if (line) line.remove();
      if (answerMarker) answerMarker.remove();
      if (guessMarker) guessMarker.remove();
      if (activeLayerOverlay) activeLayerOverlay.remove();
      if (layerContainer) {
        clear(layerContainer);
        hide(layerContainer);
      }
      map.remove();
    },
    map,
    width,
    height,
  };
}
