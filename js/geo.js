export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function pixelDistance(ax, ay, bx, by) {
  return Math.hypot(bx - ax, by - ay);
}

export function pixelDistanceMeters(a, b, metersPerPixel) {
  return pixelDistance(a.x, a.y, b.x, b.y) * metersPerPixel;
}

export function formatDistanceMeters(meters) {
  if (!Number.isFinite(meters)) return "\u2014";
  return `${Math.round(meters)} m`;
}
