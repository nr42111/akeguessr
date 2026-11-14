import { clamp, formatDistanceMeters } from "./geo.js";
import {
  advanceGame,
  createGame,
  evaluateGuess,
  getCurrentRound,
  recordResult,
  totalScore,
} from "./game.js";
import { createMapController } from "./map.js";
import { loadBestScore, updateBestScore } from "./storage.js";
import { byId, clear, create, formatNumber, hide, show } from "./ui.js";

const state = {
  regions: [],
  subRegionById: new Map(),
  locations: [],
  game: null,
  bestScore: 0,
  selectedRegion: null,
  selectedSubRegion: null,
  currentRound: null,
  roundResult: null,
  mapController: null,
  guess: null,
  view: "photo",
  selectionMode: null,
  selectionRegion: null,
  heading: null,
  mapTarget: null,
  reviewMapController: null,
  reviewRequestId: 0,
};

const photoView = {
  scale: 1,
  x: 0,
  y: 0,
  dragging: false,
  pointerId: null,
  lastX: 0,
  lastY: 0,
};

const elements = {};
const preloadedPhotos = [];
let mapRequestId = 0;
let toastTimer = null;

function cacheElements() {
  const ids = [
    "startScreen",
    "gameScreen",
    "summaryScreen",
    "bestScoreStart",
    "playButton",
    "dataError",
    "hud",
    "roundLabel",
    "scoreLabel",
    "quitButton",
    "playStage",
    "photoView",
    "photoViewport",
    "photo",
    "photoFallback",
    "photoToolbar",
    "zoomOutButton",
    "zoomResetButton",
    "zoomInButton",
    "fullscreenButton",
    "photoPipButton",
    "compass",
    "compassWindow",
    "compassTape",
    "compassReadout",
    "compassCardinal",
    "mapView",
    "map",
    "mapLoading",
    "mapPipButton",
    "mapTitle",
    "mapsButton",
    "mapBackButton",
    "mapActions",
    "confirmButton",
    "nextButton",
    "resultPanel",
    "resultBadge",
    "resultPoints",
    "resultDetail",
    "guessLegend",
    "selectionOverlay",
    "selectionBackButton",
    "selectionEyebrow",
    "selectionTitle",
    "selectionHint",
    "choiceList",
    "finalScore",
    "bestLine",
    "roundBreakdown",
    "shareButton",
    "playAgainButton",
    "homeButton",
    "reviewOverlay",
    "reviewBackButton",
    "reviewTitle",
    "reviewDetail",
    "reviewPhoto",
    "reviewPhotoFallback",
    "reviewMap",
    "reviewMapLoading",
    "toast",
    "quitDialog",
  ];

  for (const id of ids) {
    elements[id] = byId(id);
  }
}

function showScreen(name) {
  const screens = {
    start: elements.startScreen,
    game: elements.gameScreen,
    summary: elements.summaryScreen,
  };

  for (const [key, element] of Object.entries(screens)) {
    element.classList.toggle("hidden", key !== name);
  }
  elements.hud.classList.toggle("hidden", name !== "game");
}

function renderBestScore() {
  elements.bestScoreStart.textContent = formatNumber(state.bestScore);
}

function showToast(message) {
  elements.toast.textContent = message;
  show(elements.toast);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => hide(elements.toast), 3600);
}

async function fetchJson(path) {
  const response = await fetch(path, { cache: "no-cache" });
  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}.`);
  }
  return response.json();
}

function prepareData(regionsDoc, coordinatesDoc) {
  const regions = Array.isArray(regionsDoc?.regions) ? regionsDoc.regions : [];
  const coordinates =
    coordinatesDoc && typeof coordinatesDoc === "object" && !Array.isArray(coordinatesDoc)
      ? Object.entries(coordinatesDoc)
      : [];

  state.regions = regions;
  state.subRegionById = new Map();

  for (const region of regions) {
    const metersPerPixel = region.squareMeters / region.squarePixels;
    if (!Number.isFinite(metersPerPixel) || metersPerPixel <= 0) {
      throw new Error(`Region "${region.id}" has an invalid map scale.`);
    }
    for (const subRegion of region.subRegions ?? []) {
      state.subRegionById.set(subRegion.id, {
        ...subRegion,
        region,
        metersPerPixel,
      });
    }
  }

  state.locations = coordinates
    .map(([photoName, entry]) => ({
      id: photoName.replace(/\.[^.]+$/, ""),
      image: `assets/photos/${photoName}`,
      x: entry.x,
      y: entry.y,
      regionId: entry.regionId,
      subRegionId: entry.subRegionId,
      heading: Number.isFinite(entry.heading) ? entry.heading : null,
    }))
    .filter((location) => {
      const subRegion = state.subRegionById.get(location.subRegionId);
      return (
        subRegion &&
        subRegion.region.id === location.regionId &&
        Number.isFinite(location.x) &&
        Number.isFinite(location.y)
      );
    });

  if (state.regions.length === 0) {
    throw new Error("No regions were found in data/regions.json.");
  }
  if (state.locations.length === 0) {
    throw new Error("No playable locations were found in data/photo-coordinates.json.");
  }
}

async function loadData() {
  try {
    const [regionsDoc, coordinatesDoc] = await Promise.all([
      fetchJson("data/regions.json"),
      fetchJson("data/photo-coordinates.json"),
    ]);
    prepareData(regionsDoc, coordinatesDoc);
    elements.playButton.disabled = false;
    elements.playButton.textContent = "New game";
    hide(elements.dataError);
  } catch (error) {
    console.error(error);
    elements.playButton.disabled = true;
    elements.playButton.textContent = "Unavailable";
    elements.dataError.textContent = `Could not load the game data. ${error.message} If you opened index.html directly from disk, serve the folder over HTTP instead.`;
    show(elements.dataError);
  }
}

function selectableRegions() {
  return state.regions.filter((region) => (region.subRegions ?? []).length > 0);
}

function selectableSubRegions(region) {
  return (region.subRegions ?? [])
    .map((subRegion) => state.subRegionById.get(subRegion.id))
    .filter(Boolean);
}

function hasMap() {
  return Boolean(state.selectedSubRegion);
}

function syncStage() {
  const mapSelected = hasMap();
  elements.mapsButton.classList.toggle("hidden", mapSelected);
  elements.mapBackButton.classList.toggle("hidden", !mapSelected);
  elements.mapView.classList.toggle("hidden", !mapSelected);
  elements.mapTitle.classList.toggle("hidden", !mapSelected || state.view === "photo");
  elements.photoPipButton.classList.toggle(
    "hidden",
    !(mapSelected && state.view === "map")
  );
  elements.mapPipButton.classList.toggle(
    "hidden",
    !(mapSelected && state.view === "photo")
  );
  elements.photoToolbar.classList.toggle(
    "hidden",
    state.view !== "photo" || Boolean(state.roundResult)
  );
  elements.compass.classList.toggle(
    "hidden",
    state.view !== "photo" || state.heading == null || Boolean(state.roundResult)
  );

  const showConfirm = mapSelected && state.view === "map" && !state.roundResult;
  elements.confirmButton.classList.toggle("hidden", !showConfirm);
  elements.confirmButton.disabled = !state.guess;
  elements.nextButton.classList.toggle("hidden", !state.roundResult);
  elements.mapActions.classList.toggle(
    "hidden",
    !(mapSelected && (showConfirm || state.roundResult))
  );
  elements.resultPanel.classList.toggle("hidden", !state.roundResult);
  elements.mapTitle.textContent = mapSelected
    ? `${state.selectedRegion.name} \u2014 ${state.selectedSubRegion.name}`
    : "";
}

const COMPASS_PX_PER_DEGREE = 2.6;
const COMPASS_LABELS = [
  "N",
  "NNE",
  "NE",
  "ENE",
  "E",
  "ESE",
  "SE",
  "SSE",
  "S",
  "SSW",
  "SW",
  "WSW",
  "W",
  "WNW",
  "NW",
  "NNW",
];

function compassLabel(heading) {
  const index = Math.round(heading / 22.5) % COMPASS_LABELS.length;
  return COMPASS_LABELS[index];
}

function buildCompassTape() {
  const tape = elements.compassTape;
  clear(tape);
  for (let degree = -360; degree <= 720; degree += 30) {
    const normalized = ((degree % 360) + 360) % 360;
    const label = document.createElement("span");
    label.className =
      normalized % 90 === 0 ? "compass-label cardinal" : "compass-label";
    label.textContent = compassLabel(normalized);
    label.style.left = `${(degree + 360) * COMPASS_PX_PER_DEGREE}px`;
    tape.append(label);
  }
  tape.style.width = `${1080 * COMPASS_PX_PER_DEGREE}px`;
}

function updateCompassTape(heading) {
  const width = elements.compassWindow.clientWidth;
  if (!width || !Number.isFinite(heading)) return;
  const offset = width / 2 - (heading + 360) * COMPASS_PX_PER_DEGREE;
  elements.compassTape.style.transform = `translateX(${offset}px)`;
}

function setCompass(heading) {
  const value = Number.isFinite(heading) ? ((heading % 360) + 360) % 360 : null;
  state.heading = value;
  if (value == null) {
    hide(elements.compass);
    return;
  }
  elements.compassReadout.textContent = `${String(Math.round(value)).padStart(3, "0")}\u00b0`;
  elements.compassCardinal.textContent = compassLabel(value);
  syncStage();
  window.requestAnimationFrame(() => updateCompassTape(value));
}

function setGameView(mode) {
  state.view = mode === "map" ? "map" : "photo";
  elements.playStage.dataset.view = state.view;
  resetPhotoView();
  syncStage();

  if (state.mapController) {
    window.setTimeout(() => state.mapController?.fit(), 260);
  }
  if (state.heading != null) {
    window.requestAnimationFrame(() => updateCompassTape(state.heading));
  }
}

function resetMapState() {
  mapRequestId += 1;
  if (state.mapController) {
    state.mapController.destroy();
    state.mapController = null;
  }
  state.guess = null;
  state.mapTarget = null;
  state.selectedRegion = null;
  state.selectedSubRegion = null;
  state.roundResult = null;
  state.view = "photo";
  elements.playStage.dataset.view = "photo";
  clear(elements.map);
  hide(elements.mapLoading);
  hide(elements.selectionOverlay);
  syncStage();
}

function resetMapLoading() {
  elements.mapLoading.classList.remove("error");
  clear(elements.mapLoading);
  elements.mapLoading.textContent = "Loading map\u2026";
}

async function loadMap(subRegion, options = {}) {
  const requestId = ++mapRequestId;

  if (state.mapController) {
    state.mapController.destroy();
    state.mapController = null;
  }

  state.selectedRegion = subRegion.region;
  state.selectedSubRegion = subRegion;
  state.guess = null;
  state.view = "map";
  elements.playStage.dataset.view = "map";
  resetPhotoView();
  elements.mapView.classList.remove("hidden");
  clear(elements.map);
  resetMapLoading();
  show(elements.mapLoading);
  state.mapTarget = { subRegion, options };
  syncStage();

  try {
    const controller = await createMapController(elements.map, {
      imageUrl: subRegion.mapImage,
      mapSize: subRegion.mapSize,
      locked: Boolean(options.locked),
    });

    if (requestId !== mapRequestId) {
      controller.destroy();
      return;
    }

    state.mapController = controller;

    if (!options.locked) {
      controller.onGuessChange((guess) => {
        if (requestId !== mapRequestId) return;
        state.guess = guess;
        syncStage();
      });
    }

    hide(elements.mapLoading);
    syncStage();
    controller.fit();

    if (options.answer) {
      controller.addAnswer(options.answer.x, options.answer.y);
    } else {
      window.setTimeout(() => {
        if (!state.roundResult) controller.fit();
      }, 280);
    }
  } catch (error) {
    if (requestId !== mapRequestId) return;
    showMapError(error);
  }
}

function showMapError(error) {
  console.error(error);
  elements.mapLoading.classList.add("error");
  clear(elements.mapLoading);
  elements.mapLoading.append(
    create("p", { text: "The map image could not be loaded." }),
    create("p", { className: "small-text", text: error.message }),
    create("button", {
      className: "primary",
      text: "Retry",
      attrs: { type: "button" },
      on: {
        click: () => {
          if (state.mapTarget) {
            loadMap(state.mapTarget.subRegion, state.mapTarget.options);
          }
        },
      },
    })
  );
  show(elements.mapLoading);
}

function setPhoto(src) {
  resetPhotoView();
  elements.photo.style.visibility = "hidden";
  hide(elements.photoFallback);
  elements.photo.src = src;
}

function resetPhotoView() {
  photoView.scale = 1;
  photoView.x = 0;
  photoView.y = 0;
  photoView.dragging = false;
  photoView.pointerId = null;
  applyPhotoTransform();
}

function preloadNextPhoto() {
  const nextLocation = state.game?.rounds[state.game.currentIndex + 1];
  if (!nextLocation?.image) return;

  const image = new Image();
  image.src = nextLocation.image;
  preloadedPhotos.push(image);
}

function applyPhotoTransform() {
  elements.photo.style.transform = `translate(${photoView.x}px, ${photoView.y}px) scale(${photoView.scale})`;
}

function clampPhotoPan() {
  const viewport = elements.photoViewport.getBoundingClientRect();
  const scaledWidth = elements.photo.offsetWidth * photoView.scale;
  const scaledHeight = elements.photo.offsetHeight * photoView.scale;
  const maxX = Math.max(0, (scaledWidth - viewport.width) / 2);
  const maxY = Math.max(0, (scaledHeight - viewport.height) / 2);

  photoView.x = clamp(photoView.x, -maxX, maxX);
  photoView.y = clamp(photoView.y, -maxY, maxY);
}

function setPhotoScale(nextScale) {
  const clamped = clamp(nextScale, 1, 5);
  if (clamped === photoView.scale) return;
  photoView.scale = clamped;
  clampPhotoPan();
  applyPhotoTransform();
}

function endPhotoDrag() {
  if (photoView.pointerId != null) {
    try {
      if (elements.photoViewport.hasPointerCapture(photoView.pointerId)) {
        elements.photoViewport.releasePointerCapture(photoView.pointerId);
      }
    } catch (error) {
      // Ignore capture errors when the pointer already ended.
    }
  }
  photoView.dragging = false;
  photoView.pointerId = null;
  elements.photoViewport.classList.remove("dragging");
}

function updateHud() {
  if (!state.game) return;
  const roundNumber = Math.min(state.game.currentIndex + 1, state.game.rounds.length);
  elements.roundLabel.textContent = `Round ${roundNumber} of ${state.game.rounds.length}`;
  elements.scoreLabel.textContent = `${formatNumber(totalScore(state.game))} pts`;
}

function hideSelection() {
  hide(elements.selectionOverlay);
}

function renderRegionChoices() {
  state.selectionMode = "regions";
  state.selectionRegion = null;
  elements.selectionBackButton.textContent = "Back";
  elements.selectionEyebrow.textContent = "Step 1";
  elements.selectionTitle.textContent = "Choose a region";
  elements.selectionHint.textContent = "Which region is this photo from?";
  clear(elements.choiceList);

  const regions = selectableRegions();
  if (regions.length === 0) {
    elements.choiceList.append(
      create("p", { className: "hint", text: "No regions were found." })
    );
    return;
  }

  for (const region of regions) {
    const subCount = selectableSubRegions(region).length;
    elements.choiceList.append(
      create(
        "button",
        {
          className: "choice-button",
          attrs: { type: "button" },
          on: { click: () => renderSubRegionChoices(region) },
        },
        [
          create("span", { className: "choice-name", text: region.name }),
          create("span", {
            className: "choice-meta",
            text: `${subCount} sub-region${subCount === 1 ? "" : "s"}`,
          }),
        ]
      )
    );
  }
}

function renderSubRegionChoices(region) {
  state.selectionMode = "subregions";
  state.selectionRegion = region;
  elements.selectionBackButton.textContent = "Back";
  elements.selectionEyebrow.textContent = "Step 2";
  elements.selectionTitle.textContent = region.name;
  elements.selectionHint.textContent = "Choose the sub-region shown on the map.";
  clear(elements.choiceList);

  const subRegions = selectableSubRegions(region);
  if (subRegions.length === 0) {
    elements.choiceList.append(
      create("p", { className: "hint", text: "No sub-regions were found." })
    );
    return;
  }

  for (const subRegion of subRegions) {
    const button = create("button", {
      className: "choice-button",
      attrs: { type: "button" },
      on: { click: () => selectSubRegion(subRegion) },
    });
    button.append(create("span", { className: "choice-name", text: subRegion.name }));
    elements.choiceList.append(button);
  }
}

function openSelection(mode = "regions") {
  if (!state.game) return;
  if (state.roundResult) {
    showToast("This round is already scored.");
    return;
  }

  show(elements.selectionOverlay);
  if (mode === "subregions" && state.selectedRegion) {
    renderSubRegionChoices(state.selectedRegion);
  } else {
    renderRegionChoices();
  }
}

function selectSubRegion(subRegion) {
  if (state.roundResult) {
    showToast("This round is already scored.");
    return;
  }
  hideSelection();
  state.selectedRegion = subRegion.region;
  state.selectedSubRegion = subRegion;
  state.guess = null;
  loadMap(subRegion);
}

function startGame() {
  closeReview();
  if (state.locations.length === 0) {
    showToast("No playable locations are available.");
    return;
  }

  resetMapState();
  preloadedPhotos.length = 0;
  state.game = createGame(state.locations);
  state.bestScore = loadBestScore();
  renderBestScore();
  showScreen("game");
  updateHud();
  startRound();
}

function startRound() {
  const location = getCurrentRound(state.game);

  if (!location) {
    finishGame();
    return;
  }

  resetMapState();
  state.currentRound = location;
  state.roundResult = null;
  state.view = "photo";
  elements.playStage.dataset.view = "photo";
  setPhoto(location.image);
  setCompass(location.heading);
  preloadNextPhoto();
  syncStage();
  updateHud();
}

function confirmGuess() {
  if (
    !state.game ||
    !state.currentRound ||
    !state.selectedRegion ||
    !state.selectedSubRegion ||
    !state.guess ||
    state.roundResult
  ) {
    return;
  }

  const result = {
    ...evaluateGuess(
      state.currentRound,
      state.selectedRegion.id,
      state.selectedSubRegion.id,
      state.guess,
      state.selectedSubRegion
    ),
    selectedRegionId: state.selectedRegion.id,
    selectedSubRegionId: state.selectedSubRegion.id,
  };

  state.roundResult = result;
  recordResult(state.game, state.currentRound, result, state.guess);
  updateHud();
  showRoundResult(result);
}

function showRoundResult(result) {
  elements.nextButton.textContent =
    state.game.results.length >= state.game.rounds.length ? "See results" : "Next round";
  syncStage();

  const location = state.currentRound;
  const correctSubRegion = state.subRegionById.get(location.subRegionId);

  if (result.correctSubRegion) {
    show(elements.guessLegend);
    elements.resultBadge.className = "badge good";
    elements.resultBadge.textContent = "Correct sub-region";
    elements.resultPoints.textContent = `${formatNumber(result.points)} pts`;
    elements.resultDetail.textContent = `Your pin landed ${formatDistanceMeters(result.distanceMeters)} from the exact location.`;

    if (state.mapController) {
      state.mapController.lock();
      state.mapController.addAnswer(location.x, location.y);
    }
    return;
  }

  hide(elements.guessLegend);
  elements.resultBadge.className = "badge bad";
  elements.resultBadge.textContent = "Wrong sub-region";
  elements.resultPoints.textContent = "0 pts";

  if (correctSubRegion) {
    elements.resultDetail.textContent = `You picked ${state.selectedRegion.name} \u2014 ${state.selectedSubRegion.name}. The correct answer is ${correctSubRegion.region.name} \u2014 ${correctSubRegion.name}.`;
    loadMap(correctSubRegion, { locked: true, answer: location });
  } else {
    elements.resultDetail.textContent = "You picked the wrong sub-region.";
  }
}

function goToNextRound() {
  if (!state.game) return;

  const hasMoreRounds = advanceGame(state.game);
  resetMapState();
  hideSelection();

  if (hasMoreRounds) {
    startRound();
  } else {
    finishGame();
  }
}

function renderBreakdown() {
  clear(elements.roundBreakdown);

  state.game.results.forEach((entry, index) => {
    const correctSubRegion = state.subRegionById.get(entry.location.subRegionId);
    const placeName = correctSubRegion
      ? `${correctSubRegion.region.name} \u2014 ${correctSubRegion.name}`
      : "Unknown location";
    const detail = entry.correctSubRegion
      ? `${formatDistanceMeters(entry.distanceMeters)} away`
      : "Wrong sub-region";

    elements.roundBreakdown.append(
      create(
        "button",
        {
          className: "breakdown-row",
          attrs: { type: "button", title: "Review this round" },
          on: { click: () => openReview(entry) },
        },
        [
          create("span", { className: "breakdown-round", text: `Round ${index + 1}` }),
          create("span", { className: "breakdown-place" }, [
            create("strong", { text: placeName }),
            create("span", { text: detail }),
          ]),
          create("span", { className: "breakdown-result" }, [
            create("strong", { text: `${formatNumber(entry.points)} pts` }),
            create("span", { text: entry.correctSubRegion ? "Correct" : "Miss" }),
          ]),
          create("span", { className: "breakdown-chevron", text: "›" }),
        ]
      )
    );
  });
}

function resetReviewLoading() {
  elements.reviewMapLoading.classList.remove("error");
  clear(elements.reviewMapLoading);
  elements.reviewMapLoading.textContent = "Loading map\u2026";
}

function closeReview() {
  state.reviewRequestId += 1;
  if (state.reviewMapController) {
    state.reviewMapController.destroy();
    state.reviewMapController = null;
  }
  hide(elements.reviewOverlay);
  clear(elements.reviewMap);
  hide(elements.reviewMapLoading);
  elements.reviewPhoto.removeAttribute("src");
}

function setReviewPhoto(src) {
  elements.reviewPhoto.style.visibility = "hidden";
  hide(elements.reviewPhotoFallback);
  elements.reviewPhoto.src = src;
}

async function loadReviewMap(entry, subRegion) {
  const requestId = ++state.reviewRequestId;
  if (state.reviewMapController) {
    state.reviewMapController.destroy();
    state.reviewMapController = null;
  }
  clear(elements.reviewMap);
  resetReviewLoading();
  show(elements.reviewMapLoading);

  try {
    const controller = await createMapController(elements.reviewMap, {
      imageUrl: subRegion.mapImage,
      mapSize: subRegion.mapSize,
    });

    if (requestId !== state.reviewRequestId) {
      controller.destroy();
      return;
    }

    state.reviewMapController = controller;

    if (entry.correctSubRegion && entry.guess) {
      controller.setGuess(entry.guess.x, entry.guess.y);
      controller.lock();
      controller.addAnswer(entry.location.x, entry.location.y);
    } else {
      controller.lock();
      controller.addAnswer(entry.location.x, entry.location.y);
      window.setTimeout(() => controller.fit(), 80);
    }

    hide(elements.reviewMapLoading);
  } catch (error) {
    if (requestId !== state.reviewRequestId) return;
    console.error(error);
    elements.reviewMapLoading.classList.add("error");
    elements.reviewMapLoading.textContent = `Map failed to load: ${error.message}`;
    show(elements.reviewMapLoading);
  }
}

function openReview(entry) {
  if (!state.game) return;
  const location = entry.location;
  const subRegion = state.subRegionById.get(location.subRegionId);
  if (!subRegion) {
    showToast("The map for this round is unavailable.");
    return;
  }

  const picked = entry.selectedSubRegionId
    ? state.subRegionById.get(entry.selectedSubRegionId)
    : null;

  elements.reviewTitle.textContent = `${subRegion.region.name} — ${subRegion.name}`;
  let detail = entry.correctSubRegion
    ? `${formatDistanceMeters(entry.distanceMeters)} from target · ${formatNumber(entry.points)} pts`
    : "Wrong sub-region · 0 pts";
  if (!entry.correctSubRegion && picked) {
    detail += ` · picked ${picked.region.name} — ${picked.name}`;
  }
  elements.reviewDetail.textContent = detail;

  setReviewPhoto(location.image);
  show(elements.reviewOverlay);
  loadReviewMap(entry, subRegion);
}

function downloadBlob(blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "akeguessr-results.png";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function roundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

function fitText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let value = text;
  while (value.length > 1 && ctx.measureText(`${value}\u2026`).width > maxWidth) {
    value = value.slice(0, -1);
  }
  return `${value}\u2026`;
}

function buildResultsBlob() {
  const results = state.game?.results ?? [];
  const padding = 56;
  const width = 1100;
  const rowHeight = 84;
  const rowGap = 12;
  const headerHeight = 270;
  const height =
    padding + headerHeight + results.length * (rowHeight + rowGap) - rowGap + padding;
  const scale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);

  const background = ctx.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, "#13202d");
  background.addColorStop(1, "#080d13");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, width - 2, height - 2);

  ctx.fillStyle = "#3ddc97";
  ctx.font = '800 20px "Segoe UI", Arial, sans-serif';
  ctx.fillText("akeguessr", padding, padding + 22);

  ctx.fillStyle = "#93a8ba";
  ctx.font = '800 12px "Segoe UI", Arial, sans-serif';
  ctx.fillText("GAME COMPLETE", padding, padding + 58);

  ctx.fillStyle = "#edf4fa";
  ctx.font = '800 44px "Segoe UI", Arial, sans-serif';
  ctx.fillText("Final score", padding, padding + 108);

  const total = formatNumber(totalScore(state.game));
  ctx.fillStyle = "#edf4fa";
  ctx.font = '900 72px "Segoe UI", Arial, sans-serif';
  ctx.fillText(total, padding, padding + 188);
  const scoreWidth = ctx.measureText(total).width;
  ctx.fillStyle = "#93a8ba";
  ctx.font = '600 22px "Segoe UI", Arial, sans-serif';
  ctx.fillText("/ 25,000", padding + scoreWidth + 14, padding + 188);

  ctx.fillStyle = "#93a8ba";
  ctx.font = '500 18px "Segoe UI", Arial, sans-serif';
  ctx.fillText(elements.bestLine.textContent, padding, padding + 228);

  let y = padding + headerHeight;
  results.forEach((entry, index) => {
    const subRegion = state.subRegionById.get(entry.location.subRegionId);
    const placeName = subRegion
      ? `${subRegion.region.name} \u2014 ${subRegion.name}`
      : "Unknown location";
    const detail = entry.correctSubRegion
      ? `${formatDistanceMeters(entry.distanceMeters)} away`
      : "Wrong sub-region";

    roundedRect(ctx, padding, y, width - padding * 2, rowHeight, 14);
    ctx.fillStyle = "#101923";
    ctx.fill();
    ctx.strokeStyle = "#223243";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.textAlign = "left";
    ctx.fillStyle = "#93a8ba";
    ctx.font = '700 12px "Segoe UI", Arial, sans-serif';
    ctx.fillText(`ROUND ${index + 1}`, padding + 20, y + 23);

    ctx.fillStyle = "#edf4fa";
    ctx.font = '700 20px "Segoe UI", Arial, sans-serif';
    ctx.fillText(
      fitText(ctx, placeName, width - padding * 2 - 320),
      padding + 20,
      y + 51
    );

    ctx.fillStyle = "#93a8ba";
    ctx.font = '500 13px "Segoe UI", Arial, sans-serif';
    ctx.fillText(detail, padding + 20, y + 71);

    ctx.textAlign = "right";
    ctx.fillStyle = "#edf4fa";
    ctx.font = '800 22px "Segoe UI", Arial, sans-serif';
    ctx.fillText(`${formatNumber(entry.points)} pts`, width - padding - 20, y + 47);

    ctx.fillStyle = entry.correctSubRegion ? "#3ddc97" : "#ff8f8f";
    ctx.font = '700 12px "Segoe UI", Arial, sans-serif';
    ctx.fillText(
      entry.correctSubRegion ? "Correct" : "Miss",
      width - padding - 20,
      y + 69
    );

    y += rowHeight + rowGap;
  });

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Could not create the results image."));
    }, "image/png");
  });
}

async function shareResults() {
  if (!state.game) return;

  const originalLabel = elements.shareButton.textContent;
  elements.shareButton.disabled = true;
  elements.shareButton.textContent = "Preparing\u2026";

  try {
    const blob = await buildResultsBlob();
    const file = new File([blob], "akeguessr-results.png", { type: "image/png" });
    const canNativeShare =
      Boolean(navigator.canShare && navigator.share) &&
      window.matchMedia("(pointer: coarse)").matches &&
      navigator.canShare({ files: [file] });

    if (canNativeShare) {
      try {
        await navigator.share({
          files: [file],
          title: "akeguessr results",
        });
        showToast("Results shared.");
      } catch (error) {
        if (error.name !== "AbortError") {
          downloadBlob(blob);
          showToast("Results screenshot downloaded.");
        }
      }
    } else {
      downloadBlob(blob);
      showToast("Results screenshot downloaded.");
    }
  } catch (error) {
    console.error(error);
    showToast("Could not create the results screenshot.");
  } finally {
    elements.shareButton.disabled = false;
    elements.shareButton.textContent = originalLabel;
  }
}

function finishGame() {
  if (!state.game) return;

  closeReview();
  const total = totalScore(state.game);
  const { best, isNew } = updateBestScore(total);
  state.bestScore = best;

  elements.finalScore.textContent = formatNumber(total);
  elements.bestLine.textContent = isNew
    ? `New personal best: ${formatNumber(best)} / 25,000`
    : `Personal best: ${formatNumber(best)} / 25,000`;
  elements.bestLine.classList.toggle("new-best", isNew);

  renderBreakdown();
  resetMapState();
  showScreen("summary");
  renderBestScore();
}

function quitToStart() {
  closeReview();
  resetMapState();
  state.game = null;
  state.currentRound = null;
  state.roundResult = null;
  state.bestScore = loadBestScore();
  renderBestScore();
  showScreen("start");
}

function bindEvents() {
  elements.playButton.addEventListener("click", startGame);
  elements.playAgainButton.addEventListener("click", startGame);
  elements.homeButton.addEventListener("click", quitToStart);
  elements.quitButton.addEventListener("click", () => elements.quitDialog.showModal());
  elements.quitDialog.addEventListener("close", () => {
    if (elements.quitDialog.returnValue === "quit") quitToStart();
  });
  elements.quitDialog.addEventListener("click", (event) => {
    if (event.target === elements.quitDialog) elements.quitDialog.close("cancel");
  });

  elements.mapsButton.addEventListener("click", () => openSelection("regions"));
  elements.mapBackButton.addEventListener("click", () => {
    if (state.roundResult) {
      showToast("This round is already scored.");
      return;
    }
    openSelection("subregions");
  });
  elements.photoPipButton.addEventListener("click", () => setGameView("photo"));
  elements.mapPipButton.addEventListener("click", () => setGameView("map"));
  elements.selectionBackButton.addEventListener("click", () => {
    if (state.selectionMode === "subregions" && state.selectedRegion) {
      renderRegionChoices();
    } else {
      hideSelection();
    }
  });
  elements.selectionOverlay.addEventListener("click", (event) => {
    if (event.target === elements.selectionOverlay) hideSelection();
  });

  elements.confirmButton.addEventListener("click", confirmGuess);
  elements.nextButton.addEventListener("click", goToNextRound);
  elements.shareButton.addEventListener("click", shareResults);
  elements.reviewBackButton.addEventListener("click", closeReview);
  elements.reviewOverlay.addEventListener("click", (event) => {
    if (event.target === elements.reviewOverlay) closeReview();
  });
  elements.reviewPhoto.addEventListener("load", () => {
    elements.reviewPhoto.style.visibility = "visible";
    hide(elements.reviewPhotoFallback);
  });
  elements.reviewPhoto.addEventListener("error", () => {
    elements.reviewPhoto.style.visibility = "hidden";
    show(elements.reviewPhotoFallback);
  });

  document.addEventListener("keydown", (event) => {
    if (
      event.key === "Escape" &&
      !elements.reviewOverlay.classList.contains("hidden")
    ) {
      closeReview();
      return;
    }
    if (event.code !== "Space" || event.repeat) return;
    if (event.code !== "Space" || event.repeat) return;
    if (elements.gameScreen.classList.contains("hidden")) return;
    if (elements.quitDialog.open) return;
    if (!elements.selectionOverlay.classList.contains("hidden")) return;
    if (elements.confirmButton.classList.contains("hidden")) return;
    if (elements.confirmButton.disabled) return;

    const target = event.target;
    if (
      target instanceof Element &&
      target.closest(
        "button, a, input, textarea, select, summary, [contenteditable='true']"
      )
    ) {
      return;
    }

    event.preventDefault();
    confirmGuess();
  });

  elements.zoomInButton.addEventListener("click", () => setPhotoScale(photoView.scale * 1.25));
  elements.zoomOutButton.addEventListener("click", () => setPhotoScale(photoView.scale / 1.25));
  elements.zoomResetButton.addEventListener("click", () => setPhotoScale(1));

  elements.photoViewport.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      setPhotoScale(photoView.scale * (event.deltaY < 0 ? 1.15 : 1 / 1.15));
    },
    { passive: false }
  );

  elements.photoViewport.addEventListener("pointerdown", (event) => {
    if (photoView.scale <= 1 || event.button !== 0) return;
    photoView.dragging = true;
    photoView.pointerId = event.pointerId;
    photoView.lastX = event.clientX;
    photoView.lastY = event.clientY;
    elements.photoViewport.classList.add("dragging");
    elements.photoViewport.setPointerCapture(event.pointerId);
  });

  elements.photoViewport.addEventListener("pointermove", (event) => {
    if (!photoView.dragging || event.pointerId !== photoView.pointerId) return;
    photoView.x += event.clientX - photoView.lastX;
    photoView.y += event.clientY - photoView.lastY;
    photoView.lastX = event.clientX;
    photoView.lastY = event.clientY;
    clampPhotoPan();
    applyPhotoTransform();
  });

  elements.photoViewport.addEventListener("pointerup", endPhotoDrag);
  elements.photoViewport.addEventListener("pointercancel", endPhotoDrag);

  elements.photo.addEventListener("load", () => {
    elements.photo.style.visibility = "visible";
    hide(elements.photoFallback);
    window.requestAnimationFrame(() => {
      clampPhotoPan();
      applyPhotoTransform();
    });
  });

  elements.photo.addEventListener("error", () => {
    elements.photo.style.visibility = "hidden";
    show(elements.photoFallback);
  });

  elements.fullscreenButton.addEventListener("click", async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await elements.photoView.requestFullscreen();
      }
    } catch (error) {
      showToast("Fullscreen is not available in this browser.");
    }
  });

  document.addEventListener("fullscreenchange", () => {
    elements.fullscreenButton.textContent = document.fullscreenElement
      ? "Exit fullscreen"
      : "Fullscreen";
    window.requestAnimationFrame(() => {
      clampPhotoPan();
      applyPhotoTransform();
    });
  });

  window.addEventListener("resize", () => {
    clampPhotoPan();
    applyPhotoTransform();
    state.mapController?.map.invalidateSize();
    if (state.heading != null) updateCompassTape(state.heading);
  });
}

function boot() {
  cacheElements();
  buildCompassTape();
  bindEvents();
  state.bestScore = loadBestScore();
  renderBestScore();
  showScreen("start");
  loadData();
}

boot();
