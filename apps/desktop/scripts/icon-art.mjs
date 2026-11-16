// The app icon artwork, computed per pixel: a charcoal plate and light, no sphere. Two identical arcs of one circle, top and bottom
// (a soft white core, a peach fringe outside, a blue one inside, a smoky bloom). Plate, smoke and arcs are all unchanged by a half turn.
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
// Shortest angular distance, radians.
const apart = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)))

// 1 at the middle of an arc centred at `mid` degrees, easing to 0 `half` degrees either side.
const arcWin = (th, mid, half) => Math.cos(Math.min(1, apart(th, mid * DEG) / (half * DEG)) * Math.PI / 2) ** 2

const WHITE = [1, 1, 1]
const WARM = [1, 0.68, 0.42]
const COOL = [0.45, 0.7, 1]
const KNEE = 0.7
const tone = (c) => (c < KNEE ? Math.max(0, c) : KNEE + (1 - KNEE) * (1 - Math.exp(-(c - KNEE) / (1 - KNEE))))

const out = [0, 0, 0]
const add = (k, c) => { out[0] += k * c[0]; out[1] += k * c[1]; out[2] += k * c[2] }

function wisp(x, y) {
  const u = x + 0.42 * Math.sin(1.9 * y + 0.6), v = y + 0.34 * Math.sin(1.6 * x - 1.1)
  return 0.5 * Math.sin(1.5 * u - 3.4 * v + 0.8) + 0.3 * Math.sin(-2.6 * u - 4.6 * v + 2 + 1.2 * Math.sin(2.4 * u)) + 0.2 * Math.sin(5.3 * u - 6.2 * v + 4.1)
}

// The premium light recipe along a curve. h is the signed distance from the curve (warm side negative, cool side positive),
// w the core width, p the power. A soft white core dissolving into a peach fringe and a blue one, then a smoky bloom.
function light(h, w, p, smoke) {
  if (p < 0.002) return
  add(0.42 * p * bell(h, w), WHITE)
  add(0.3 * p * bell(h, 2.4 * w), WHITE)
  add(0.5 * p * bell(h + 1.9 * w, 1.8 * w), WARM)
  add(0.52 * p * bell(h - 2 * w, 1.9 * w), COOL)
  add(0.1 * p * bell(h, 4.2 * w), WHITE)
  add(0.15 * p * bell(h + 3.3 * w, 3.1 * w), [1, 0.8, 0.62])
  add(0.115 * p * bell(h - 3.5 * w, 3.3 * w), [0.62, 0.8, 1])
  add(0.028 * p * (1 + 0.7 * smoke) * bell(h, 9 * w), [0.9, 0.93, 1])
}

// Twin arcs of one circle: two identical arcs, top and bottom, peach outside the circle and blue inside it, each tapering evenly to both ends.
function draw(r, th, small, smoke) {
  for (const mid of [-90, 90]) {
    const win = arcWin(th, mid, 72)
    light(1 - r, (small ? 0.06 : 0.03) * (0.3 + 0.7 * win), (small ? 1.25 : 1) * win, smoke)
  }
}

// Straight-alpha RGBA at 1024 x 1024. `small` thickens the arcs for sizes where they would vanish.
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
          const x = dx / R, y = dy / R, r = Math.hypot(x, y)
          // Charcoal that lifts toward the edges and deepens, with no edge, behind the light.
          const v = (0.1 + 0.075 * smooth(0.55, 1.3, Math.hypot(dx, dy) / C)) * (1 - 0.16 * bell(r, 1.3))
          out[0] = out[1] = out[2] = v
          draw(r, Math.atan2(y, x), small, small ? 0 : (wisp(1.3 * x, 1.3 * y) + wisp(-1.3 * x, -1.3 * y)) / 2)
          cr += tone(out[0]); cg += tone(out[1]); cb += tone(out[2]); n++
        }
      }
      if (n === 0) continue
      const o = (oy * SIZE + ox) * 4
      data[o] = Math.round((cr / n) * 255); data[o + 1] = Math.round((cg / n) * 255); data[o + 2] = Math.round((cb / n) * 255)
      data[o + 3] = Math.round((n * 255) / (ss * ss))
    }
  }
  return { width: SIZE, height: SIZE, data }
}
