export function shouldDismissSheet(dx: number, dy: number, elapsed: number): boolean {
  return dy > Math.abs(dx) && (dy >= 72 || (dy >= 24 && dy / Math.max(1, elapsed) >= 0.6))
}
