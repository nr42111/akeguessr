const BEST_SCORE_KEY = "akeguessr.bestScore.v1";
const SEEN_LOCATIONS_KEY = "akeguessr.seenLocations.v1";

export function loadBestScore() {
  try {
    const value = Number(localStorage.getItem(BEST_SCORE_KEY));
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch (error) {
    return 0;
  }
}

export function saveBestScore(score) {
  try {
    localStorage.setItem(BEST_SCORE_KEY, String(score));
    return true;
  } catch (error) {
    return false;
  }
}

export function updateBestScore(score) {
  const best = loadBestScore();
  if (score > best) {
    saveBestScore(score);
    return { best: score, isNew: true };
  }
  return { best, isNew: false };
}

export function loadSeenLocations() {
  try {
    const raw = localStorage.getItem(SEEN_LOCATIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id) => typeof id === "string" && id);
  } catch (error) {
    return [];
  }
}

export function saveSeenLocations(ids) {
  try {
    localStorage.setItem(SEEN_LOCATIONS_KEY, JSON.stringify(ids));
    return true;
  } catch (error) {
    return false;
  }
}
