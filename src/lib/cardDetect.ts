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

// Locate the card: pixels that differ from the background (sampled at the 4
// image corners). Bounds use 1st/99th percentiles to resist stray noise.
export function findCardBounds(img: ImageData): { rect: Rect; coverage: number } | null {
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
  let maskCount = 0
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const i = (y * width + x) * 4
      const isBg = corners.some((c) => colorDist(data, i, c) < THRESH)
      if (!isBg) {
        xs.push(x)
        ys.push(y)
        maskCount++
      }
    }
  }
  const sampled = (width / 2) * (height / 2)
  if (maskCount < sampled * 0.08) return null
  xs.sort((a, b) => a - b)
  ys.sort((a, b) => a - b)
  const pct = (arr: number[], q: number) => arr[Math.floor(arr.length * q)]
  return {
    rect: { x0: pct(xs, 0.01), y0: pct(ys, 0.01), x1: pct(xs, 0.99), y1: pct(ys, 0.99) },
    coverage: maskCount / sampled,
  }
}
