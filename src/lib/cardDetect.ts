// Shared card-boundary detection, used by both grading and photo auto-ID.
export interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
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

// Foreground mask: pixels that differ from the background (sampled at the 4
// image corners). Shared by bounds and quad detection.
function buildMask(img: ImageData): { xs: number[]; ys: number[]; coverage: number } {
  const { data, width, height } = img
  const p = Math.max(4, Math.floor(Math.min(width, height) * 0.04))
  const corners = [
    patchColor(img, 0, 0, p),
    patchColor(img, width - p, 0, p),
    patchColor(img, 0, height - p, p),
    patchColor(img, width - p, height - p, p),
  ]
  const THRESH = 90
  const xs: number[] = []
  const ys: number[] = []
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const i = (y * width + x) * 4
      const isBg = corners.some((c) => colorDist(data, i, c) < THRESH)
      if (!isBg) {
        xs.push(x)
        ys.push(y)
      }
    }
  }
  return { xs, ys, coverage: xs.length / ((width / 2) * (height / 2)) }
}

// Bounds use 1st/99th percentiles to resist stray noise.
export function findCardBounds(img: ImageData): { rect: Rect; coverage: number } | null {
  const { xs, ys, coverage } = buildMask(img)
  if (coverage < 0.08) return null
  const sx = [...xs].sort((a, b) => a - b)
  const sy = [...ys].sort((a, b) => a - b)
  const pct = (arr: number[], q: number) => arr[Math.floor(arr.length * q)]
  return {
    rect: { x0: pct(sx, 0.01), y0: pct(sy, 0.01), x1: pct(sx, 0.99), y1: pct(sy, 0.99) },
    coverage,
  }
}

// Card corners for perspective correction: extremes of x+y / x−y over the
// mask (valid for convex shapes). Each corner is the average of the 12 most
// extreme points so a stray noise pixel can't hijack it.
export function findCardQuad(img: ImageData): Quad | null {
  const { xs, ys, coverage } = buildMask(img)
  if (coverage < 0.08) return null
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
