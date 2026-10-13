export function quickCometBounds(point: { x: number; y: number }, area: { x: number; y: number; width: number; height: number }) {
  const margin = 12
  const width = Math.min(400, area.width - margin * 2)
  const height = Math.min(96, area.height - margin * 2)
  return {
    x: Math.round(Math.max(area.x + margin, Math.min(point.x + 16, area.x + area.width - width - margin))),
    y: Math.round(Math.max(area.y + margin, Math.min(point.y + 16, area.y + area.height - height - margin))),
    width, height,
  }
}
