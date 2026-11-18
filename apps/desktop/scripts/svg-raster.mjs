const ALLOWED = {
  svg: ['xmlns', 'viewBox'],
  defs: [],
  linearGradient: ['id', 'x1', 'y1', 'x2', 'y2', 'gradientUnits'],
  radialGradient: ['id', 'cx', 'cy', 'r', 'gradientUnits'],
  stop: ['offset', 'stop-color', 'stop-opacity'],
  rect: ['id', 'x', 'y', 'width', 'height', 'rx', 'fill', 'fill-opacity'],
  circle: ['cx', 'cy', 'r', 'fill', 'fill-opacity'],
}

function num(attrs, name, element, fallback) {
  if (attrs[name] === undefined && fallback !== undefined) return fallback
  const value = Number(attrs[name])
  if (attrs[name] === undefined || attrs[name].trim() === '' || !Number.isFinite(value)) throw new Error(`svg-raster: bad ${name} on ${element}`)
  return value
}

function hex(value, element) {
  if (!/^#[0-9a-fA-F]{6}$/.test(value ?? '')) throw new Error(`svg-raster: bad color on ${element}`)
  return [1, 3, 5].map((at) => Number.parseInt(value.slice(at, at + 2), 16))
}

function parse(svgText) {
  const gradients = new Map()
  const shapes = []
  let size = 0
  let gradient = null
  const rest = svgText.replace(/<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>/g, (_, close, name, raw) => {
    if (!(name in ALLOWED)) throw new Error(`svg-raster: unsupported <${name}>`)
    if (close) {
      if (name.endsWith('Gradient')) gradient = null
      return ''
    }
    const attrs = {}
    for (const [, key, value] of raw.matchAll(/([\w:-]+)="([^"]*)"/g)) {
      if (!ALLOWED[name].includes(key)) throw new Error(`svg-raster: unsupported attribute ${key} on ${name}`)
      attrs[key] = value
    }
    if (name === 'svg') {
      const box = (attrs.viewBox ?? '').trim().split(/\s+/).map(Number)
      if (box.length !== 4 || box[0] !== 0 || box[1] !== 0 || !(box[2] > 0) || box[2] !== box[3]) throw new Error('svg-raster: viewBox must be "0 0 N N"')
      size = box[2]
    } else if (name.endsWith('Gradient')) {
      if (attrs.gradientUnits !== 'userSpaceOnUse' || !attrs.id) throw new Error(`svg-raster: ${name} needs an id and gradientUnits="userSpaceOnUse"`)
      gradient = name === 'radialGradient'
        ? { radial: true, cx: num(attrs, 'cx', name), cy: num(attrs, 'cy', name), r: num(attrs, 'r', name), stops: [] }
        : { radial: false, x1: num(attrs, 'x1', name), y1: num(attrs, 'y1', name), x2: num(attrs, 'x2', name), y2: num(attrs, 'y2', name), stops: [] }
      gradients.set(attrs.id, gradient)
    } else if (name === 'stop') {
      if (!gradient) throw new Error('svg-raster: stop outside a gradient')
      gradient.stops.push([num(attrs, 'offset', name), ...hex(attrs['stop-color'], name), num(attrs, 'stop-opacity', name, 1)])
    } else if (name === 'rect' || name === 'circle') {
      const url = /^url\(#([\w-]+)\)$/.exec(attrs.fill ?? '')
      const paint = url ? url[1] : hex(attrs.fill, name)
      const shape = name === 'circle'
        ? { cx: num(attrs, 'cx', name), cy: num(attrs, 'cy', name), r: num(attrs, 'r', name) }
        : { x: num(attrs, 'x', name, 0), y: num(attrs, 'y', name, 0), w: num(attrs, 'width', name), h: num(attrs, 'height', name), rx: num(attrs, 'rx', name, 0) }
      shapes.push({ ...shape, id: attrs.id, paint, opacity: num(attrs, 'fill-opacity', name, 1) })
    }
    return ''
  })
  if (rest.trim() !== '') throw new Error('svg-raster: unsupported content')
  if (!size) throw new Error('svg-raster: missing <svg viewBox>')
  for (const shape of shapes) {
    if (typeof shape.paint !== 'string') continue
    const found = gradients.get(shape.paint)
    if (!found || found.stops.length < 2) throw new Error(`svg-raster: unknown gradient ${shape.paint}`)
    shape.paint = found
  }
  const body = shapes.find((shape) => shape.id === 'body' && shape.w !== undefined)
  if (!body || shapes[0] !== body) throw new Error('svg-raster: the first shape must be <rect id="body">')
  return { size, shapes }
}

function inside(shape, x, y) {
  if (shape.r !== undefined) return (x - shape.cx) ** 2 + (y - shape.cy) ** 2 <= shape.r * shape.r
  const hw = shape.w / 2, hh = shape.h / 2
  const dx = Math.abs(x - shape.x - hw), dy = Math.abs(y - shape.y - hh)
  if (dx > hw || dy > hh) return false
  const ix = hw - shape.rx, iy = hh - shape.rx
  return dx <= ix || dy <= iy || (dx - ix) ** 2 + (dy - iy) ** 2 <= shape.rx * shape.rx
}

const rgba = [0, 0, 0, 0]
function paintAt(paint, x, y) {
  if (Array.isArray(paint)) { rgba[0] = paint[0]; rgba[1] = paint[1]; rgba[2] = paint[2]; rgba[3] = 1; return }
  let t
  if (paint.radial) t = Math.sqrt((x - paint.cx) ** 2 + (y - paint.cy) ** 2) / paint.r
  else {
    const dx = paint.x2 - paint.x1, dy = paint.y2 - paint.y1
    t = ((x - paint.x1) * dx + (y - paint.y1) * dy) / (dx * dx + dy * dy)
  }
  const stops = paint.stops
  let k = 1
  while (k < stops.length - 1 && t > stops[k][0]) k++
  const a = stops[k - 1], b = stops[k]
  const f = b[0] === a[0] ? 1 : Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0])))
  for (let c = 0; c < 4; c++) rgba[c] = a[c + 1] + (b[c + 1] - a[c + 1]) * f
}

export function rasterize(svgText, px = 1024, ss = 2) {
  const { size, shapes } = parse(svgText)
  const body = shapes[0]
  const data = Buffer.alloc(px * px * 4)
  const step = size / (px * ss)
  for (let oy = 0; oy < px; oy++) {
    for (let ox = 0; ox < px; ox++) {
      let r = 0, g = 0, b = 0, n = 0
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (ox * ss + sx + 0.5) * step, y = (oy * ss + sy + 0.5) * step
          if (!inside(body, x, y)) continue
          let cr = 0, cg = 0, cb = 0
          for (const shape of shapes) {
            if (!inside(shape, x, y)) continue
            paintAt(shape.paint, x, y)
            const a = rgba[3] * shape.opacity
            cr += (rgba[0] - cr) * a; cg += (rgba[1] - cg) * a; cb += (rgba[2] - cb) * a
          }
          r += cr; g += cg; b += cb; n++
        }
      }
      if (n === 0) continue
      const o = (oy * px + ox) * 4
      data[o] = Math.round(r / n); data[o + 1] = Math.round(g / n); data[o + 2] = Math.round(b / n)
      data[o + 3] = Math.round((n * 255) / (ss * ss))
    }
  }
  return { width: px, height: px, data }
}
