import { createMapController } from "./map.js";
import { byId, clear, create, hide, show } from "./ui.js";

const state = {
  regions: [],
  photos: [],
  pending: [],
  validatedCount: 0,
  currentPhoto: null,
  selectedRegion: null,
  selectedSubRegion: null,
  mapController: null,
  guess: null,
  view: "photo",
  selectionMode: "regions",
  selectionRegion: null,
  mapRequestId: 0,
  saving: false,
  heading: 0,
  headingMarker: null,
};

const elements = {};

function cacheElements() {
  const ids = [
    "devStage",
    "devPhotoView",
    "devPhotoViewport",
    "devPhoto",
    "devPhotoFallback",
    "devPhotoPipButton",
    "devMapView",
    "devMap",
    "devMapLoading",
    "devMapPipButton",
    "devMapTitle",
    "devMapsButton",
    "devBackButton",
    "devSelectionOverlay",
    "devSelectionBackButton",
    "devSelectionEyebrow",
    "devSelectionTitle",
    "devSelectionHint",
    "devChoiceList",
    "devCurrentPhoto",
    "devCurrentMap",
    "devCoords",
    "devHeading",
    "devHeadingValue",
    "devSaveButton",
    "devRefreshButton",
    "devStatus",
    "devQueue",
    "devCount",
  ];
  for (const id of ids) {
    elements[id] = byId(id);
  }
}

async function fetchJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}.`);
  }
  return response.json();
}

function setStatus(message, tone = "") {
  elements.devStatus.textContent = message;
  elements.devStatus.className = `dev-status${tone ? ` ${tone}` : ""}`;
}

function prepareRegions(regionsDoc) {
  state.regions = Array.isArray(regionsDoc?.regions) ? regionsDoc.regions : [];
  for (const region of state.regions) {
    for (const subRegion of region.subRegions ?? []) {
      subRegion.region = region;
    }
  }
}

function findSubRegion(regionId, subRegionId) {
  const region = state.regions.find((item) => item.id === regionId);
  return region?.subRegions?.find((item) => item.id === subRegionId) ?? null;
}

function headingArrowIcon(heading) {
  return L.divIcon({
    className: "dev-arrow-marker",
    html: `<div class="dev-arrow" style="transform: translate(-50%, -100%) rotate(${heading}deg)"></div>`,
    iconSize: [160, 160],
    iconAnchor: [80, 80],
  });
}

function updateHeadingArrow() {
  const controller = state.mapController;
  if (!controller || !state.guess) {
    if (state.headingMarker) {
      state.headingMarker.remove();
      state.headingMarker = null;
    }
    return;
  }

  const latlng = [controller.height - state.guess.y, state.guess.x];
  if (!state.headingMarker) {
    state.headingMarker = L.marker(latlng, {
      icon: headingArrowIcon(state.heading),
      interactive: false,
      keyboard: false,
      zIndexOffset: -100,
    }).addTo(controller.map);
  } else {
    state.headingMarker.setLatLng(latlng);
  }

  const element = state.headingMarker
    .getElement()
    ?.querySelector(".dev-arrow");
  if (element) {
    element.style.transform = `translate(-50%, -100%) rotate(${state.heading}deg)`;
  }
}

function updateHeading(value) {
  const number = Number(value);
  const heading = Number.isFinite(number)
    ? ((Math.round(number) % 360) + 360) % 360
    : 0;
  state.heading = heading;
  elements.devHeading.value = String(heading);
  elements.devHeadingValue.textContent = `${heading}\u00b0`;
  updateHeadingArrow();
}

function setPhoto(photo) {
  state.currentPhoto = photo;
  state.guess = null;
  elements.devPhoto.style.visibility = "hidden";
  hide(elements.devPhotoFallback);

  if (!photo) {
    elements.devPhoto.removeAttribute("src");
    elements.devPhoto.style.visibility = "hidden";
    elements.devPhotoFallback.textContent = "All photos validated";
    show(elements.devPhotoFallback);
    updateHeading(0);
    if (state.mapController) state.mapController.clearGuess();
    syncUi();
    return;
  }

  elements.devPhoto.src = photo.url;
  updateHeading(photo.coordinates?.heading ?? 0);
  if (state.mapController) state.mapController.clearGuess();

  const coords = photo.coordinates;
  if (coords && Number.isFinite(coords.x) && Number.isFinite(coords.y)) {
    const subRegion = findSubRegion(coords.regionId, coords.subRegionId);
    if (subRegion) {
      if (!state.selectedSubRegion || state.selectedSubRegion.id !== subRegion.id) {
        loadMap(subRegion, { guess: { x: coords.x, y: coords.y }, view: "photo" });
      } else if (state.mapController) {
        state.mapController.setGuess(coords.x, coords.y);
      }
    }
  }

  syncUi();
}

function syncUi() {
  const hasMap = Boolean(state.selectedSubRegion);
  const hasPhoto = Boolean(state.currentPhoto);
  elements.devMapsButton.classList.toggle("hidden", hasMap);
  elements.devBackButton.classList.toggle("hidden", !hasMap);
  elements.devMapView.classList.toggle("hidden", !hasMap);
  elements.devMapTitle.classList.toggle("hidden", !hasMap);
  elements.devPhotoPipButton.classList.toggle(
    "hidden",
    !(hasMap && hasPhoto && state.view === "map")
  );
  elements.devMapPipButton.classList.toggle(
    "hidden",
    !(hasMap && hasPhoto && state.view === "photo")
  );

  elements.devMapTitle.textContent = hasMap
    ? `${state.selectedRegion.name} \u2014 ${state.selectedSubRegion.name}`
    : "";
  elements.devCurrentPhoto.textContent = state.currentPhoto?.name ?? "No photo queued";
  elements.devCurrentMap.textContent = hasMap
    ? `${state.selectedRegion.name} \u2014 ${state.selectedSubRegion.name}`
    : "Not selected";

  if (!hasMap) {
    elements.devCoords.textContent = "Pick a sub-region map";
  } else if (!state.guess) {
    elements.devCoords.textContent = "Click the map";
  } else {
    elements.devCoords.textContent = `${Math.round(state.guess.x)}, ${Math.round(state.guess.y)}`;
  }

  elements.devSaveButton.disabled =
    !hasPhoto || !hasMap || !state.guess || state.saving;
  updateHeadingArrow();
}

function setView(mode) {
  state.view = mode === "map" ? "map" : "photo";
  elements.devStage.dataset.view = state.view;
  syncUi();
  if (state.mapController) {
    window.setTimeout(() => state.mapController?.fit(), 260);
  }
}

function renderQueue() {
  clear(elements.devQueue);
  elements.devCount.textContent = `${state.pending.length} pending \u00b7 ${state.validatedCount} validated`;

  if (state.pending.length === 0) {
    elements.devQueue.append(
      create("p", { className: "hint", text: "All photos validated." })
    );
    return;
  }

  for (const name of state.pending) {
    const isActive = state.currentPhoto?.name === name;
    const button = create("button", {
      className: isActive ? "active" : "",
      text: name,
      attrs: { type: "button" },
      on: {
        click: () => {
          const photo = state.photos.find((item) => item.name === name);
          if (photo) setPhoto(photo);
        },
      },
    });
    elements.devQueue.append(button);
  }
}

function selectFirstPending() {
  const first = state.pending[0];
  if (!first) {
    setPhoto(null);
    return;
  }
  const photo = state.photos.find((item) => item.name === first);
  setPhoto(photo ?? null);
}

async function loadPhotos({ keepCurrent = false } = {}) {
  const payload = await fetchJson("/api/photos");
  const currentName = keepCurrent ? state.currentPhoto?.name : null;
  state.photos = payload.photos;
  state.pending = payload.pending;
  state.validatedCount = payload.validatedCount;

  const current = currentName
    ? state.photos.find((photo) => photo.name === currentName && !photo.complete)
    : null;

  renderQueue();
  if (current) {
    setPhoto(current);
  } else {
    selectFirstPending();
  }
}

function resetMapLoading() {
  elements.devMapLoading.classList.remove("error");
  clear(elements.devMapLoading);
  elements.devMapLoading.textContent = "Loading map\u2026";
}

async function loadMap(subRegion, options = {}) {
  const requestId = ++state.mapRequestId;

  if (state.mapController) {
    state.mapController.destroy();
    state.mapController = null;
  }
  state.headingMarker = null;

  state.selectedRegion = subRegion.region;
  state.selectedSubRegion = subRegion;
  state.guess = null;
  state.view = options.view === "photo" ? "photo" : "map";
  elements.devStage.dataset.view = state.view;
  elements.devMapView.classList.remove("hidden");
  clear(elements.devMap);
  resetMapLoading();
  show(elements.devMapLoading);
  syncUi();

  try {
    const controller = await createMapController(elements.devMap, {
      imageUrl: subRegion.mapImage,
      mapSize: subRegion.mapSize,
    });

    if (requestId !== state.mapRequestId) {
      controller.destroy();
      return;
    }

    state.mapController = controller;
    controller.onGuessChange((guess) => {
      if (requestId !== state.mapRequestId) return;
      state.guess = guess;
      syncUi();
    });

    hide(elements.devMapLoading);
    if (options.guess) {
      controller.setGuess(options.guess.x, options.guess.y);
    }
    syncUi();
    controller.fit();
    window.setTimeout(() => controller.fit(), 280);
  } catch (error) {
    if (requestId !== state.mapRequestId) return;
    console.error(error);
    elements.devMapLoading.classList.add("error");
    elements.devMapLoading.textContent = `Map failed to load: ${error.message}`;
    show(elements.devMapLoading);
  }
}

function hideSelection() {
  hide(elements.devSelectionOverlay);
}

function renderRegions() {
  state.selectionMode = "regions";
  state.selectionRegion = null;
  elements.devSelectionBackButton.textContent = "Back";
  elements.devSelectionEyebrow.textContent = "Step 1";
  elements.devSelectionTitle.textContent = "Choose a region";
  elements.devSelectionHint.textContent = "Select the region for this photo.";
  clear(elements.devChoiceList);

  for (const region of state.regions) {
    elements.devChoiceList.append(
      create(
        "button",
        {
          className: "choice-button",
          attrs: { type: "button" },
          on: { click: () => renderSubRegions(region) },
        },
        [
          create("span", { className: "choice-name", text: region.name }),
          create("span", {
            className: "choice-meta",
            text: `${region.subRegions.length} sub-regions`,
          }),
        ]
      )
    );
  }
}

function renderSubRegions(region) {
  state.selectionMode = "subregions";
  state.selectionRegion = region;
  elements.devSelectionBackButton.textContent = "Back";
  elements.devSelectionEyebrow.textContent = "Step 2";
  elements.devSelectionTitle.textContent = region.name;
  elements.devSelectionHint.textContent = "Choose the map for this photo.";
  clear(elements.devChoiceList);

  for (const subRegion of region.subRegions) {
    const button = create("button", {
      className: "choice-button",
      attrs: { type: "button" },
      on: {
        click: () => {
          hideSelection();
          loadMap(subRegion);
        },
      },
    });
    button.append(create("span", { className: "choice-name", text: subRegion.name }));
    elements.devChoiceList.append(button);
  }
}

function openSelection(mode = "regions") {
  show(elements.devSelectionOverlay);
  if (mode === "subregions" && state.selectedRegion) {
    renderSubRegions(state.selectedRegion);
  } else {
    renderRegions();
  }
}

async function saveCoordinates() {
  if (!state.currentPhoto || !state.selectedRegion || !state.selectedSubRegion || !state.guess) {
    return;
  }

  state.saving = true;
  syncUi();
  setStatus("Saving\u2026");

  try {
    const response = await fetch("/api/coordinates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        photo: state.currentPhoto.name,
        regionId: state.selectedRegion.id,
        subRegionId: state.selectedSubRegion.id,
        x: state.guess.x,
        y: state.guess.y,
        heading: state.heading,
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error ?? `HTTP ${response.status}`);
    }

    setStatus(`Saved ${payload.photo} at ${payload.coordinates.x}, ${payload.coordinates.y}.`, "ok");
    await loadPhotos({ keepCurrent: false });
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    state.saving = false;
    syncUi();
  }
}

function bindEvents() {
  elements.devMapsButton.addEventListener("click", () => openSelection("regions"));
  elements.devBackButton.addEventListener("click", () => openSelection("subregions"));
  elements.devPhotoPipButton.addEventListener("click", () => setView("photo"));
  elements.devMapPipButton.addEventListener("click", () => setView("map"));
  elements.devSelectionBackButton.addEventListener("click", () => {
    if (state.selectionMode === "subregions" && state.selectedRegion) {
      renderRegions();
    } else {
      hideSelection();
    }
  });
  elements.devSelectionOverlay.addEventListener("click", (event) => {
    if (event.target === elements.devSelectionOverlay) hideSelection();
  });
  elements.devHeading.addEventListener("input", () => updateHeading(elements.devHeading.value));
  elements.devSaveButton.addEventListener("click", saveCoordinates);
  elements.devRefreshButton.addEventListener("click", async () => {
    try {
      setStatus("Refreshing\u2026");
      await loadPhotos({ keepCurrent: true });
      setStatus("Refreshed.", "ok");
    } catch (error) {
      setStatus(error.message, "error");
    }
  });

  elements.devPhoto.addEventListener("load", () => {
    elements.devPhoto.style.visibility = "visible";
    hide(elements.devPhotoFallback);
  });

  elements.devPhoto.addEventListener("error", () => {
    elements.devPhoto.style.visibility = "hidden";
    elements.devPhotoFallback.textContent = "Photo unavailable";
    show(elements.devPhotoFallback);
  });

  window.addEventListener("resize", () => {
    state.mapController?.map.invalidateSize();
  });
}

async function boot() {
  cacheElements();
  bindEvents();

  try {
    const regionsDoc = await fetchJson("data/regions.json");
    prepareRegions(regionsDoc);
    await loadPhotos();
    syncUi();
    setStatus("Ready. Set the look direction and save. If a photo has no coordinates yet, choose its map and click the location.");
  } catch (error) {
    setStatus(
      `Could not load the dev data. Run "npm run dev" and open http://localhost:8787/dev.html. ${error.message}`,
      "error"
    );
    elements.devCount.textContent = "Unavailable";
  }
}

boot();
