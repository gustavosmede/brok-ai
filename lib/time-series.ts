export type TimedPoint = { created_at: string };

export function timeSeriesGapThreshold(points: TimedPoint[]): number {
  const deltas = points
    .slice(1)
    .map((point, index) => Date.parse(point.created_at) - Date.parse(points[index].created_at))
    .filter((delta) => Number.isFinite(delta) && delta > 0)
    .sort((a, b) => a - b);
  if (!deltas.length) return 15 * 60_000;
  const typical = deltas[Math.floor((deltas.length - 1) / 2)];
  return Math.max(15 * 60_000, typical * 4);
}

export function splitTimeSeriesAtGaps<T extends TimedPoint>(points: T[]): T[][] {
  if (!points.length) return [];
  const threshold = timeSeriesGapThreshold(points);
  const segments: T[][] = [[points[0]]];
  for (let index = 1; index < points.length; index += 1) {
    const delta = Date.parse(points[index].created_at) - Date.parse(points[index - 1].created_at);
    if (delta > threshold) segments.push([]);
    segments.at(-1)!.push(points[index]);
  }
  return segments;
}
