import { useEffect, useRef, useState } from 'react'

export const FALLBACK_RATIO = 16 / 10
export const EXIT_MS = 160
export const HOLD_MS = 1200
const MEMORY_LIMIT = 48
export type StageSize = { id: string; width: number; height: number }
export type Painted = { size: StageSize | null; image?: string }
export type Gone<T> = { item: T; until: number }
const memory = new Map<string, Painted>()

export function recordStageSize(previous: StageSize | null, id: string, width: number, height: number): StageSize | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return previous
  if (previous && previous.id === id && previous.width === width && previous.height === height) return previous
  return { id, width, height }
}

export function stageRatio(size: StageSize | null, id: string): number {
  return size && size.id === id ? size.width / size.height : FALLBACK_RATIO
}

export function rememberPaint(lane: string, id: string, width: number, height: number, image?: string): boolean {
  const key = `${lane}\n${id}`
  const previous = memory.get(key)
  const size = recordStageSize(previous?.size ?? null, id, width, height)
  // Only data URLs are kept: the picture is later placed in a CSS url().
  const kept = image?.startsWith('data:image/') ? image : previous?.image
  memory.delete(key)
  memory.set(key, { size, image: kept })
  for (const oldest of memory.keys()) {
    if (memory.size <= MEMORY_LIMIT) break
    memory.delete(oldest)
  }
  return size !== (previous?.size ?? null)
}

export function recallPaint(lane: string, id: string): Painted | undefined {
  return memory.get(`${lane}\n${id}`)
}

export function shownRatio(size: StageSize | null | undefined, id: string, held: number): number {
  return size && size.id === id ? stageRatio(size, id) : held
}

export function heldLayers(phase: string, front: 'img' | 'canvas' | 'none', own?: string, previous?: string): Array<{ key: 'previous' | 'own'; image: string }> {
  if (phase !== 'ready' && phase !== 'delayed' && phase !== 'waiting') return []
  const layers: Array<{ key: 'previous' | 'own'; image: string }> = []
  if (front !== 'none' && previous && previous !== own) layers.push({ key: 'previous', image: previous })
  if (own && front !== 'img') layers.push({ key: 'own', image: own })
  return layers
}

export function lingerStep<T extends { key: string }>(gone: Array<Gone<T>>, last: T[], items: T[], now: number, ms: number): Array<Gone<T>> {
  const present = new Set(items.map(item => item.key))
  const next = gone.filter(one => !present.has(one.item.key))
  for (const item of last) if (!present.has(item.key) && !gone.some(one => one.item.key === item.key)) next.push({ item, until: now + ms })
  const kept = next.filter(one => one.until > now)
  return kept.length === gone.length && kept.every((one, index) => one === gone[index]) ? gone : kept
}

export function useLinger<T extends { key: string }>(items: T[], ms: number): Array<T & { leaving?: boolean }> {
  const last = useRef(items)
  const [gone, setGone] = useState<Array<Gone<T>>>([])
  const next = lingerStep(gone, last.current, items, Date.now(), ms)
  if (next !== gone) setGone(next)
  useEffect(() => { last.current = items })
  const due = next.length ? Math.min(...next.map(one => one.until)) : 0
  useEffect(() => {
    if (!due) return
    // An early timer still expires its entry, otherwise `due` would never change again.
    const timer = setTimeout(() => setGone(list => lingerStep(list, [], [], Math.max(Date.now(), due), ms)), Math.max(0, due - Date.now()) + 1)
    return () => clearTimeout(timer)
  }, [due, ms])
  return [...items, ...next.map(one => ({ ...one.item, leaving: true }))]
}

export function exitMs(): number {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : EXIT_MS
}
