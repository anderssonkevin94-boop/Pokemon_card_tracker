// Photo identification by perceptual hash: fingerprint the card crop of the
// photo and find the nearest official card images. Fingerprints for every
// card ship in /card-hashes.json (built by scripts/build-hash-db.mjs).
// Robust to lighting/print noise where OCR fails; OCR covers sets newer than
// the fingerprint file. Both run and their scores are merged.
import { extractFlatCard } from './cardExtract'
import { orientedBitmap } from './imageUtils'

export interface HashMatch {
  id: string
  distance: number // hamming distance, 0..128 (lower = closer)
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
  const [db, flat, bitmap] = await Promise.all([
    loadDb(),
    extractFlatCard(photo, 360),
    orientedBitmap(photo),
  ])

  // Several probes of the same photo — the flattened card, a slight inset of
  // it (absorbs leftover sleeve edges), and the full frame as a last resort.
  // A card is scored by its best probe, so whichever interpretation of the
  // photo is right wins.
  const fw = flat.canvas.width
  const fh = flat.canvas.height
  const probes: Uint32Array[] = [
    hashCanvas(flat.canvas, 0, 0, fw, fh),
    hashCanvas(flat.canvas, fw * 0.03, fh * 0.03, fw * 0.94, fh * 0.94),
  ]
  if (flat.quadFound) probes.push(hashCanvas(bitmap, 0, 0, bitmap.width, bitmap.height))
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
