// Photo identification by perceptual hash: fingerprint the card crop of the
// photo and find the nearest official card images. Fingerprints for every
// card ship in /card-hashes.json (built by scripts/build-hash-db.mjs).
// Robust to lighting/print noise where OCR fails; OCR covers sets newer than
// the fingerprint file. Both run and their scores are merged.
import { findCardBounds, findCardQuad, type Quad } from './cardDetect'
import { orientedBitmap } from './imageUtils'

export interface HashMatch {
  id: string
  distance: number // hamming distance, 0..128 (lower = closer)
}

// Homography mapping the corners of a W×H rect onto `quad` (DLT, 4 points).
// Returns the 3x3 matrix as a flat array; used for inverse-mapping the photo's
// tilted card onto a flat canvas before fingerprinting.
function rectToQuadHomography(w: number, h: number, q: Quad): number[] {
  const src = [
    [0, 0], [w, 0], [w, h], [0, h],
  ]
  const dst = [
    [q.tl.x, q.tl.y], [q.tr.x, q.tr.y], [q.br.x, q.br.y], [q.bl.x, q.bl.y],
  ]
  // build the 8x9 system A·h = 0 solved with h33 = 1 → 8x8 linear system
  const A: number[][] = []
  const b: number[] = []
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i]
    const [u, v] = dst[i]
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y])
    b.push(u)
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y])
    b.push(v)
  }
  // gaussian elimination with partial pivoting
  for (let col = 0; col < 8; col++) {
    let piv = col
    for (let r = col + 1; r < 8; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r
    ;[A[col], A[piv]] = [A[piv], A[col]]
    ;[b[col], b[piv]] = [b[piv], b[col]]
    const d = A[col][col]
    if (Math.abs(d) < 1e-10) throw new Error('degenerate quad')
    for (let r = 0; r < 8; r++) {
      if (r === col) continue
      const f = A[r][col] / d
      for (let c = col; c < 8; c++) A[r][c] -= f * A[col][c]
      b[r] -= f * b[col]
    }
  }
  const hm = b.map((v, i) => v / A[i][i])
  return [...hm, 1]
}

// Flatten the card: sample the source quad into an upright W×H canvas.
function unwarpQuad(srcImg: ImageData, quad: Quad, w: number, h: number): HTMLCanvasElement {
  const H = rectToQuadHomography(w, h, quad)
  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  const ctx = out.getContext('2d')!
  const dest = ctx.createImageData(w, h)
  const sd = srcImg.data
  const sw = srcImg.width
  const sh = srcImg.height
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const den = H[6] * x + H[7] * y + H[8]
      const sx = (H[0] * x + H[1] * y + H[2]) / den
      const sy = (H[3] * x + H[4] * y + H[5]) / den
      const xi = Math.max(0, Math.min(sw - 1, Math.round(sx)))
      const yi = Math.max(0, Math.min(sh - 1, Math.round(sy)))
      const si = (yi * sw + xi) * 4
      const di = (y * w + x) * 4
      dest.data[di] = sd[si]
      dest.data[di + 1] = sd[si + 1]
      dest.data[di + 2] = sd[si + 2]
      dest.data[di + 3] = 255
    }
  }
  ctx.putImageData(dest, 0, 0)
  return out
}

interface HashDb {
  ids: string[]
  bits: Uint32Array // 4 words per card: hHi, hLo, vHi, vLo
}

let dbPromise: Promise<HashDb> | null = null

function loadDb(): Promise<HashDb> {
  dbPromise ??= (async () => {
    const res = await fetch('/card-hashes.json')
    if (!res.ok) throw new Error('Fingerprint database unavailable')
    const json = (await res.json()) as { cards: [string, string, string][] }
    const ids = new Array<string>(json.cards.length)
    const bits = new Uint32Array(json.cards.length * 4)
    json.cards.forEach(([id, h, v], i) => {
      ids[i] = id
      bits[i * 4] = parseInt(h.slice(0, 8), 16)
      bits[i * 4 + 1] = parseInt(h.slice(8), 16)
      bits[i * 4 + 2] = parseInt(v.slice(0, 8), 16)
      bits[i * 4 + 3] = parseInt(v.slice(8), 16)
    })
    return { ids, bits }
  })()
  return dbPromise
}

function popcount32(x: number): number {
  x -= (x >> 1) & 0x55555555
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333)
  x = (x + (x >> 4)) & 0x0f0f0f0f
  return (x * 0x01010101) >> 24
}

// dHash pair from a 9x9 grid of block means — must mirror
// scripts/build-hash-db.mjs exactly (resize to 90x90, average 10x10 blocks).
export function hashCanvas(source: CanvasImageSource, sx: number, sy: number, sw: number, sh: number): Uint32Array {
  const c = document.createElement('canvas')
  c.width = 90
  c.height = 90
  const ctx = c.getContext('2d')!
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, 90, 90)
  const d = ctx.getImageData(0, 0, 90, 90).data

  const grid = new Float64Array(81)
  for (let gy = 0; gy < 9; gy++) {
    for (let gx = 0; gx < 9; gx++) {
      let sum = 0
      for (let y = gy * 10; y < gy * 10 + 10; y++) {
        for (let x = gx * 10; x < gx * 10 + 10; x++) {
          const i = (y * 90 + x) * 4
          sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
        }
      }
      grid[gy * 9 + gx] = sum
    }
  }

  const out = new Uint32Array(4)
  const setBit = (offset: number, n: number) => {
    if (n < 32) out[offset] |= (1 << (31 - n)) >>> 0
    else out[offset + 1] |= (1 << (63 - n)) >>> 0
  }
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const n = y * 8 + x
      if (grid[y * 9 + x] > grid[y * 9 + x + 1]) setBit(0, n) // horizontal
      if (grid[y * 9 + x] > grid[(y + 1) * 9 + x]) setBit(2, n) // vertical
    }
  }
  return out
}

export async function matchCardImage(photo: Blob, topN = 8): Promise<HashMatch[]> {
  const [db, bitmap] = await Promise.all([loadDb(), orientedBitmap(photo)])

  // analysis copy — bounds/quad detection and unwarp sampling read from this
  const scale = Math.min(1, 1000 / Math.max(bitmap.width, bitmap.height))
  const small = document.createElement('canvas')
  small.width = Math.round(bitmap.width * scale)
  small.height = Math.round(bitmap.height * scale)
  const sctx = small.getContext('2d')!
  sctx.drawImage(bitmap, 0, 0, small.width, small.height)
  const img = sctx.getImageData(0, 0, small.width, small.height)

  // Several probes of the same photo — perspective-corrected card, plain
  // bounding box, full frame. A card is scored by its best probe, so whichever
  // interpretation of the photo is right wins.
  const probes: Uint32Array[] = []
  const quad = findCardQuad(img)
  if (quad) {
    try {
      const flat = unwarpQuad(img, quad, 180, 252) // 63:88 card aspect
      probes.push(hashCanvas(flat, 0, 0, 180, 252))
    } catch {
      // degenerate quad — skip this probe
    }
  }
  const found = findCardBounds(img)
  if (found) {
    const { x0, y0, x1, y1 } = found.rect
    probes.push(hashCanvas(small, x0, y0, x1 - x0, y1 - y0))
  }
  probes.push(hashCanvas(bitmap, 0, 0, bitmap.width, bitmap.height))
  bitmap.close()

  const best: HashMatch[] = []
  for (let i = 0; i < db.ids.length; i++) {
    let dist = 128
    for (const probe of probes) {
      const d =
        popcount32(db.bits[i * 4] ^ probe[0]) +
        popcount32(db.bits[i * 4 + 1] ^ probe[1]) +
        popcount32(db.bits[i * 4 + 2] ^ probe[2]) +
        popcount32(db.bits[i * 4 + 3] ^ probe[3])
      if (d < dist) dist = d
    }
    if (best.length < topN || dist < best[best.length - 1].distance) {
      best.push({ id: db.ids[i], distance: dist })
      best.sort((a, b) => a.distance - b.distance)
      if (best.length > topN) best.pop()
    }
  }
  return best
}
