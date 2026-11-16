// The app icon artwork, computed per pixel: a charcoal plate and light, no sphere. Two identical arcs of one circle, top and bottom.
// Each arc is light in layers, not one blurred stroke: a hairline filament, a band (the body), a peach fringe outside the circle and a blue one inside,
// a faint refracted echo, a caustic bead caught off-centre, and an atmosphere that falls off slowly. A breath of air fills the circle.
// Plate, grain, smoke and arcs are all unchanged by a half turn.
// Pure arithmetic, so every machine gets the same pixels. gen-icon.mjs resamples these 1024 masters to every shipped size.
const SIZE = 1024
const C = SIZE / 2
const R = 330 // radius of the implied circle
const CORNER = 290
const CORNER_POWER = 2.8
const outside = (d) => Math.max(0, Math.abs(d) - (C - CORNER)) / CORNER

const clamp = (x) => (x < 0 ? 0 : x > 1 ? 1 : x)
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t) }
const bell = (x, w) => Math.exp(-(x * x) / (w * w))
const DEG = Math.PI / 180
// Signed shortest angle from b to a, radians.
const turn = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b))

const WHITE = [1, 1, 1]
const WARM = [1, 0.66, 0.4], COOL = [0.42, 0.68, 1]
const AMBER = [1, 0.5, 0.26], DEEP = [0.26, 0.46, 1]
const HAZE_OUT = [1, 0.86, 0.74], HAZE_IN = [0.72, 0.84, 1], AIR = [0.8, 0.88, 1], ECHO = [1, 0.93, 0.86]
const KNEE = 0.7
const tone = (c) => (c < KNEE ? Math.max(0, c) : KNEE + (1 - KNEE) * (1 - Math.exp(-(c - KNEE) / (1 - KNEE))))
const hash = (x, y) => { let n = Math.imul(x, 374761393) + Math.imul(y, 668265263) | 0; n = Math.imul(n ^ (n >>> 13), 1274126177); return ((n ^ (n >>> 16)) >>> 0) / 4294967296 }

const out = [0, 0, 0]
const add = (k, c) => { out[0] += k * c[0]; out[1] += k * c[1]; out[2] += k * c[2] }

function wisp(x, y) {
  const u = x + 0.42 * Math.sin(1.9 * y + 0.6), v = y + 0.34 * Math.sin(1.6 * x - 1.1)
  return 0.5 * Math.sin(1.5 * u - 3.4 * v + 0.8) + 0.3 * Math.sin(-2.6 * u - 4.6 * v + 2 + 1.2 * Math.sin(2.4 * u)) + 0.2 * Math.sin(5.3 * u - 6.2 * v + 4.1)
}

// Light at (x, y) in circle radii. h is the distance outside the circle: peach where it is positive, blue where it is negative.
// The small master draws heavier, longer arcs with less around them, so 16px still shows a broken ring and not two dashes.
function light(x, y, small) {
  const r = Math.hypot(x, y), th = Math.atan2(y, x), h = r - 1
  const half = (small ? 80 : 69) * DEG
  const smoke = small ? 0 : (wisp(1.3 * x, 1.3 * y) + wisp(-1.3 * x, -1.3 * y)) / 2
  for (const mid of [-Math.PI / 2, Math.PI / 2]) {
    const sd = turn(th, mid), s = sd / half
    // The atmosphere outlasts the arc's ends, so they dissolve instead of stopping.
    const wide = Math.cos(Math.min(1, Math.abs(sd) / (half + 16 * DEG)) * Math.PI / 2) ** 2
    if (wide < 0.001) continue
    const win = Math.abs(s) >= 1 ? 0 : Math.cos(Math.abs(s) ** (small ? 1.9 : 1.2) * Math.PI / 2) ** 2
    const p = (small ? 1.25 : 1) * win
    const w = (small ? 0.064 : 0.03) * (0.28 + 0.72 * win ** 0.7)
    // The caustic: a brighter bead, frozen a little before the crest.
    const bead = bell(sd + 0.3, 0.24)
    const lift = 1 + 0.5 * bead
    // A whisper of shift along the length: one end leans warm, the other cool.
    const warm = 1 + 0.24 * s, cool = 1 - 0.24 * s
    if (Math.abs(h) < 14 * w) {
      add((small ? 0.75 : 0.85) * p * lift * bell(h, (small ? 0.8 : 0.22) * w), WHITE) // filament
      add((small ? 0.6 : 0.26) * p * lift * bell(h, 1.3 * w), WHITE) // band
      add((small ? 0.36 : 0.46) * p * warm * bell(h - (small ? 1.35 : 1.7) * w, (small ? 1.1 : 1.6) * w), WARM)
      add((small ? 0.36 : 0.44) * p * cool * bell(h + (small ? 1.35 : 1.7) * w, (small ? 1.1 : 1.6) * w), COOL)
      if (!small) add(0.09 * p * warm * bell(h - 3.3 * w, 2.2 * w), AMBER)
      if (!small) add(0.07 * p * cool * bell(h + 3.3 * w, 2.2 * w), DEEP)
      if (!small) add(0.1 * p * win * bell(h - 5.2 * w, 0.36 * w), ECHO) // a faint refracted echo of the filament
      add(0.16 * p * bead * bell(h, 5 * w), WHITE) // the bead's own glow
    }
    const hz = h / (5.5 * w)
    add((small ? 0.05 : 0.1) * wide * (1 + 0.6 * smoke) / (1 + hz * hz) ** 1.25, h > 0 ? HAZE_OUT : HAZE_IN)
    // Light spilled into the circle, so the two arcs enclose something.
    if (h < 0) add(0.05 * wide * Math.exp(h / 0.45), AIR)
  }
  add(0.06 * (1 - smooth(0, 1.05, r)), AIR)
}

// Straight-alpha RGBA at 1024 x 1024. `small` is the simplified drawing for sizes where the regular one would vanish.
export function renderMaster({ small = false } = {}, ss = 2) {
  const data = Buffer.alloc(SIZE * SIZE * 4)
  const px = 1 / ss
  for (let oy = 0; oy < SIZE; oy++) {
    for (let ox = 0; ox < SIZE; ox++) {
      let cr = 0, cg = 0, cb = 0, n = 0
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const dx = ox + (sx + 0.5) * px - C, dy = oy + (sy + 0.5) * px - C
          if (outside(dx) ** CORNER_POWER + outside(dy) ** CORNER_POWER > 1) continue
          const far = Math.hypot(dx, dy) / C
          // Charcoal that lifts toward the edges and deepens, with no edge, behind the light.
          out[0] = out[1] = out[2] = (0.086 + 0.085 * smooth(0.5, 1.35, far)) * (1 - 0.12 * bell(far, 0.9))
          light(dx / R, dy / R, small)
          cr += tone(out[0]); cg += tone(out[1]); cb += tone(out[2]); n++
        }
      }
      if (n === 0) continue
      // Fine grain, about one level, so the dark gradients never band. Each pixel shares its grain with its half-turn twin.
      const grain = small ? 0 : (hash(ox, oy) + hash(SIZE - 1 - ox, SIZE - 1 - oy) - 1) * 0.005
      const o = (oy * SIZE + ox) * 4
      data[o] = Math.round(clamp(cr / n + grain) * 255); data[o + 1] = Math.round(clamp(cg / n + grain) * 255); data[o + 2] = Math.round(clamp(cb / n + grain) * 255)
      data[o + 3] = Math.round((n * 255) / (ss * ss))
    }
  }
  return { width: SIZE, height: SIZE, data }
}
