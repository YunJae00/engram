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
  reason: string
}

const GB = 1e9
// Full offload only when the machine stays comfortable afterwards.
const FULL_HEADROOM = 7 * GB
// Partial offload: the model fits, the rest of the day does not — a larger
// reserved padding makes llama.cpp keep more weights on the evictable side.
const LEAN_HEADROOM = 4.5 * GB
// An offloaded load costs more than the file: KV cache, compute buffers and
// the driver's working set ride along, all pinned right beside the weights —
// measured 1.8GB over the file's size at ctx 4096. Planning from the file
// alone approved a load that left the machine 2GB short and frozen.
const OFFLOAD_OVERHEAD = 2 * GB
// Even an mmap'd model needs real RAM for KV cache, compute buffers and page
// cache to be usable at all.
const CPU_FLOOR = 3 * GB

export function planModelLoad(modelBytes: number, freeBytes = os.freemem()): LoadPlan {
  const freeGB = (freeBytes / GB).toFixed(1)
  const offloadBytes = modelBytes + OFFLOAD_OVERHEAD
  if (freeBytes >= offloadBytes + FULL_HEADROOM)
    return { mode: 'gpu', gpuLayers: 'auto', vramPadding: 2.5 * GB, reason: `${freeGB}GB free — full offload` }
  if (freeBytes >= offloadBytes + LEAN_HEADROOM)
    return { mode: 'lean', gpuLayers: 'auto', vramPadding: 5 * GB, reason: `${freeGB}GB free — partial offload` }
  if (freeBytes >= modelBytes * 0.6 + CPU_FLOOR)
    return { mode: 'cpu', gpuLayers: 0, vramPadding: 0, reason: `${freeGB}GB free — CPU only, weights stay evictable` }
  return {
    mode: 'none',
    gpuLayers: 0,
    vramPadding: 0,
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
