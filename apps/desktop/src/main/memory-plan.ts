import os from 'node:os'

// Why a plan instead of just loading: on an iGPU machine the GPU's memory IS
// system RAM, and pages the driver takes are pinned — unswappable. Loading
// 6GB into it on a busy day can freeze the whole machine, not just the app
// (measured: two hard freezes with forced power-offs, both during memory
// peaks with the model resident). So every load first measures what is
// actually free and picks the largest footprint the system can absorb.
export type LoadMode = 'gpu' | 'lean' | 'cpu' | 'none'

export interface LoadPlan {
  mode: LoadMode
  // 'auto' lets llama.cpp fit as many layers as the padding allows; 0 keeps
  // every weight on the CPU side, where mmap makes them evictable clean pages
  // the OS can reclaim under pressure instead of dying.
  gpuLayers: 'auto' | 0
  // Reserved headroom llama.cpp must leave free when it plans its offload —
  // on shared-memory iGPUs this directly reserves system RAM.
  vramPadding: number
  // Hold the CPU-side weights as the process's own memory rather than as
  // mapped file cache. Cache was the safe default, and on a machine whose
  // standby cache is full it is also seven seconds a token: every token
  // re-reads weights the system just dropped (measured). With real room to
  // spare, holding them is what makes the model usable; without it, they
  // stay evictable and slow. Never a hard lock: that can freeze a machine.
  lock: boolean
  reason: string
}

const GB = 1e9

// Room somebody else has spoken for. A browser is admitted against the
// memory it is about to spend, not the memory it has spent: the model left to
// make room for it and was back before the first page had loaded, and the two
// then sat side by side (measured). Spoken-for room is planned around until
// it is handed back.
let spokenFor = 0
export function reserveRoom(bytes: number): () => void {
  spokenFor += bytes
  let released = false
  return () => {
    if (released) return
    released = true
    spokenFor -= bytes
  }
}
export function roomNow(): number {
  return Math.max(0, os.freemem() - spokenFor)
}
// Full offload only when the machine stays comfortable afterwards.
const FULL_HEADROOM = 7 * GB
// Partial offload: the model fits, the rest of the day does not — a larger
// reserved padding makes llama.cpp keep more weights on the evictable side.
// Sized for the offload's own growth, not for a browser beside it: admitted
// at 9.6GB free next to an open browser, one heavy page took the machine to
// the critical floor in eight seconds (measured). So the two take turns
// instead - the model leaves before a browser launches, and an idle browser
// closes before any load that is not a full offload - and this headroom only
// has to cover the pressure floor under the model itself.
const LEAN_HEADROOM = 4.5 * GB
// An offloaded load costs more than the file: KV cache, compute buffers and
// the driver's working set ride along, all pinned right beside the weights —
// measured 1.8GB over the file's size at ctx 4096. Planning from the file
// alone approved a load that left the machine 2GB short and frozen.
const OFFLOAD_OVERHEAD = 2 * GB
// Even an mmap'd model needs real RAM for KV cache, compute buffers and page
// cache to be usable at all.
const CPU_FLOOR = 3 * GB
// Held weights are the process's own memory, and none of it can be dropped,
// only paged: measured 4.4GB private for a 3.1GB file once the context had
// arrived, and a machine that admitted it at 9.4GB free was at the critical
// floor minutes later with the browser and the embedder beside it. So holding
// is planned from the full cost, plus the companions that work next to the
// model, plus the pressure floor under all of it - and only where no GPU
// offers the lighter, faster path.
const HELD_OVERHEAD = 1.5 * GB
const COMPANIONS = 3 * GB

export function planModelLoad(modelBytes: number, freeBytes = roomNow(), gpu = true): LoadPlan {
  const freeGB = (freeBytes / GB).toFixed(1)
  const offloadBytes = modelBytes + OFFLOAD_OVERHEAD
  if (gpu && freeBytes >= offloadBytes + FULL_HEADROOM)
    return { mode: 'gpu', gpuLayers: 'auto', vramPadding: 2.5 * GB, lock: false, reason: `${freeGB}GB free — full offload` }
  if (gpu && freeBytes >= offloadBytes + LEAN_HEADROOM)
    return { mode: 'lean', gpuLayers: 'auto', vramPadding: 5 * GB, lock: false, reason: `${freeGB}GB free — partial offload` }
  if (!gpu && freeBytes >= modelBytes + HELD_OVERHEAD + PRESSURE_FLOOR + COMPANIONS)
    return { mode: 'cpu', gpuLayers: 0, vramPadding: 0, lock: true, reason: `${freeGB}GB free — CPU only, weights held in memory` }
  if (freeBytes >= modelBytes * 0.6 + CPU_FLOOR)
    return { mode: 'cpu', gpuLayers: 0, vramPadding: 0, lock: false, reason: `${freeGB}GB free — CPU only, weights stay evictable` }
  return {
    mode: 'none',
    gpuLayers: 0,
    vramPadding: 0,
    lock: false,
    reason: `only ${freeGB}GB free — needs ~${((modelBytes * 0.6 + CPU_FLOOR) / GB).toFixed(1)}GB`,
  }
}

// While the model sits idle, the machine's needs keep changing. Below this
// the resident model is what pushes the system into thrash, so it leaves.
export const PRESSURE_FLOOR = 4 * GB

// Below this the machine is already failing: pinned offload pages cannot be
// swapped out, so the system has nothing left to reclaim and stops responding
// entirely rather than slowing down. Reaching it means killing the worker
// outright — mid-load or mid-answer — because a lost answer costs a minute
// and a hard power-off costs the session (measured twice, both while the
// model was resident and something large started beside it).
export const CRITICAL_FLOOR = 3.5 * GB

// A browser and a model are the two heavyweights, and starting one next to
// the other is what actually tips a machine over — the model's footprint was
// measured against a machine that no longer exists by the time the browser
// finishes opening. Under this, the model steps aside first.
export const ROOM_FOR_BROWSER = 8 * GB

// The embedder is the small one - a few hundred megabytes - and it is what
// tells one subject from another. Judging it by the room a browser needs left
// it asleep exactly when the language model was resident, which is every time
// it was actually wanted.
export const ROOM_FOR_EMBEDDER = 5 * GB
