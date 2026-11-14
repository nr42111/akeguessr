function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not load map image: ${src}`));
    image.src = src;
  });
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

export async function createMapController(container, { imageUrl, mapSize, locked = false }) {
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

  L.imageOverlay(imageUrl, mapBounds).addTo(map);
  map.fitBounds(mapBounds, { padding: [12, 12] });
  map.setMaxBounds(mapBounds);

  let guess = null;
  let guessMarker = null;
  let answerMarker = null;
  let line = null;
  let isLocked = Boolean(locked);
  let guessChangeHandler = null;

  function toCrs(px, py) {
    return L.latLng(height - py, px);
  }

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
    fit,
    destroy: () => {
      if (line) line.remove();
      if (answerMarker) answerMarker.remove();
      if (guessMarker) guessMarker.remove();
      map.remove();
    },
    map,
    width,
    height,
  };
}
