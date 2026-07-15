// Shared card-boundary detection, used by grading, photo auto-ID and image
// matching.
export interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface Point {
  x: number
  y: number
}

export interface Quad {
  tl: Point
  tr: Point
  br: Point
  bl: Point
}

export function luminance(d: Uint8ClampedArray, i: number): number {
  return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
}

function colorDist(d: Uint8ClampedArray, i: number, c: [number, number, number]): number {
  return Math.abs(d[i] - c[0]) + Math.abs(d[i + 1] - c[1]) + Math.abs(d[i + 2] - c[2])
}

// Average color of a small patch, used to sample the background at image corners.
function patchColor(img: ImageData, px: number, py: number, size: number): [number, number, number] {
  const { data, width } = img
  let r = 0, g = 0, b = 0, n = 0
  for (let y = py; y < py + size; y++) {
    for (let x = px; x < px + size; x++) {
      const i = (y * width + x) * 4
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n++
    }
  }
  return [r / n, g / n, b / n]
}

const STEP = 2

interface Mask {
  xs: number[]
  ys: number[]
  strong: boolean[] // strongly-colored pixels: card ink, never shadow/plastic
  strongCount: number
  bboxFrac: number // component bbox area / frame area
}

// Foreground mask reduced to one connected component. Components are ranked
// by how many strongly-COLORED cells they contain: shadows and sleeve plastic
// are dark or bright but colorless, card print is saturated — so the card
// wins even when a cast shadow covers more pixels.
function buildMask(img: ImageData): Mask | null {
  const { data, width, height } = img
  const p = Math.max(4, Math.floor(Math.min(width, height) * 0.04))
  const corners = [
    patchColor(img, 0, 0, p),
    patchColor(img, width - p, 0, p),
    patchColor(img, 0, height - p, p),
    patchColor(img, width - p, height - p, p),
  ]
  const bgChroma = Math.max(
    ...corners.map((c) => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2])),
  )
  const gw = Math.ceil(width / STEP)
  const gh = Math.ceil(height / STEP)
  const grid = new Uint8Array(gw * gh) // 0 bg, 1 fg, 2 strong fg, +8 visited
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const i = (gy * STEP * width + gx * STEP) * 4
      const dist = Math.min(...corners.map((c) => colorDist(data, i, c)))
      if (dist < 90) continue
      const chroma =
        Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2])
      grid[gy * gw + gx] = dist >= 120 && chroma >= Math.max(55, bgChroma + 30) ? 2 : 1
    }
  }

  // BFS components; reach-2 neighborhood bridges thin gaps (pale card areas
  // classified as background can otherwise split the card in two)
  let best: { cells: number[]; strongCount: number } | null = null
  const queue = new Int32Array(gw * gh)
  for (let start = 0; start < gw * gh; start++) {
    if (grid[start] === 0 || grid[start] & 8) continue
    let head = 0
    let tail = 0
    queue[tail++] = start
    grid[start] |= 8
    const cells: number[] = []
    let strongCount = 0
    while (head < tail) {
      const cell = queue[head++]
      cells.push(cell)
      if (grid[cell] & 2) strongCount++
      const cx = cell % gw
      const cy = (cell / gw) | 0
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = cx + dx
          const ny = cy + dy
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue
          const n = ny * gw + nx
          if (grid[n] !== 0 && !(grid[n] & 8)) {
            grid[n] |= 8
            queue[tail++] = n
          }
        }
      }
    }
    if (
      !best ||
      strongCount > best.strongCount ||
      (strongCount === best.strongCount && cells.length > best.cells.length)
    ) {
      best = { cells, strongCount }
    }
  }
  if (!best || best.cells.length < 150) return null

  const n = best.cells.length
  const xs = new Array<number>(n)
  const ys = new Array<number>(n)
  const strong = new Array<boolean>(n)
  let x0 = Infinity, y0 = Infinity, x1 = 0, y1 = 0
  best.cells.forEach((cell, i) => {
    const x = (cell % gw) * STEP
    const y = ((cell / gw) | 0) * STEP
    xs[i] = x
    ys[i] = y
    strong[i] = (grid[cell] & 2) !== 0
    if (x < x0) x0 = x
    if (y < y0) y0 = y
    if (x > x1) x1 = x
    if (y > y1) y1 = y
  })
  return {
    xs,
    ys,
    strong,
    strongCount: best.strongCount,
    bboxFrac: ((x1 - x0) * (y1 - y0)) / (width * height),
  }
}

// Bounds use 1st/99th percentiles to resist stray noise.
export function findCardBounds(img: ImageData): { rect: Rect; coverage: number } | null {
  const mask = buildMask(img)
  if (!mask || mask.bboxFrac < 0.12) return null
  const sx = [...mask.xs].sort((a, b) => a - b)
  const sy = [...mask.ys].sort((a, b) => a - b)
  const pct = (arr: number[], q: number) => arr[Math.floor(arr.length * q)]
  return {
    rect: { x0: pct(sx, 0.01), y0: pct(sy, 0.01), x1: pct(sx, 0.99), y1: pct(sy, 0.99) },
    coverage: mask.bboxFrac,
  }
}

// Card corners for perspective correction: extremes of x+y / x−y over the
// mask (valid for convex shapes). Prefers strongly-colored points (card ink)
// so shadows and sleeve plastic can't drag a corner outward. Each corner is
// the average of the 12 most extreme points so noise can't hijack it.
export function findCardQuad(img: ImageData): Quad | null {
  const mask = buildMask(img)
  if (!mask || mask.bboxFrac < 0.12) return null
  let { xs, ys } = mask
  if (mask.strongCount >= 300) {
    xs = xs.filter((_, i) => mask.strong[i])
    ys = ys.filter((_, i) => mask.strong[i])
  }
  const n = xs.length
  const bySum: number[] = Array.from({ length: n }, (_, i) => i)
  bySum.sort((a, b) => xs[a] + ys[a] - (xs[b] + ys[b]))
  const byDiff: number[] = Array.from({ length: n }, (_, i) => i)
  byDiff.sort((a, b) => xs[a] - ys[a] - (xs[b] - ys[b]))
  const avg = (idx: number[]): Point => ({
    x: idx.reduce((s, i) => s + xs[i], 0) / idx.length,
    y: idx.reduce((s, i) => s + ys[i], 0) / idx.length,
  })
  const k = Math.min(12, n)
  return {
    tl: avg(bySum.slice(0, k)),
    br: avg(bySum.slice(-k)),
    bl: avg(byDiff.slice(0, k)),
    tr: avg(byDiff.slice(-k)),
  }
}

export function quadArea(q: Quad): number {
  // shoelace over tl → tr → br → bl
  const pts = [q.tl, q.tr, q.br, q.bl]
  let area = 0
  for (let i = 0; i < 4; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % 4]
    area += a.x * b.y - b.x * a.y
  }
  return Math.abs(area) / 2
}
