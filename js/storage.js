const BEST_SCORE_KEY = "akeguessr.bestScore.v1";

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
