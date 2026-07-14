// Photo auto-ID: OCR the card name (top band) and collector number (bottom
// strip) with Tesseract.js, entirely on-device. This module is dynamically
// imported so the ~3MB OCR engine only loads the first time it's needed.
import { createWorker, PSM, type Worker } from 'tesseract.js'
import { findCardBounds } from './cardDetect'

export interface CardTextReading {
  name?: string
  number?: string // collector number, e.g. "58" from "58/102"
  total?: string // set size, e.g. "102" from "58/102" — pinpoints the set
}

export type StatusFn = (status: string) => void

let workerPromise: Promise<Worker> | null = null
function getWorker(onStatus?: StatusFn): Promise<Worker> {
  workerPromise ??= createWorker('eng', undefined, {
    logger: (m) => {
      if (m.status?.includes('loading') || m.status?.includes('download')) {
        onStatus?.('Downloading card reader (first time, ~3 MB)…')
      }
    },
  })
  return workerPromise
}

// Words that appear near the name on various card layouts but are never part of it.
const NOISE = new Set([
  'basic', 'stage', 'stage1', 'stage2', 'evolves', 'from', 'hp', 'lv', 'ex',
  'put', 'onto', 'the', 'pokemon', 'pokémon', 'mega', 'evolution', 'item',
  'trainer', 'supporter', 'energy', 'tera', 'no', 'evolve',
])
// ...but these suffixes ARE part of modern names ("Charizard ex", "Pikachu V").
const NAME_SUFFIXES = /\b(ex|EX|GX|V|VMAX|VSTAR)\b\s*$/

function cleanName(raw: string): string | undefined {
  const lines = raw
    .split('\n')
    .map((l) => l.replace(/[^A-Za-zÀ-ÿ'&.\- ]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((l) => l.length >= 3)
  let best = ''
  for (const line of lines) {
    const kept = line
      .split(' ')
      .filter((w) => w.length >= 2 && !NOISE.has(w.toLowerCase()))
      .join(' ')
    if (kept.length > best.length) best = kept
  }
  // keep "ex"/"V" style suffixes from the raw line if the filter ate them
  const suffix = raw.match(NAME_SUFFIXES)?.[1]
  if (suffix && !best.endsWith(suffix)) best = `${best} ${suffix}`.trim()
  return best.length >= 3 ? best : undefined
}

// Grayscale + percentile contrast stretch; invert if text is light-on-dark.
// Card fonts over artwork are low-contrast for OCR without this.
function preprocess(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d')!
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const d = img.data
  const n = canvas.width * canvas.height
  const lums = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    lums[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]
  }
  const sorted = Uint8Array.from(lums).sort()
  const lo = sorted[Math.floor(n * 0.05)]
  const hi = sorted[Math.floor(n * 0.95)]
  const range = Math.max(1, hi - lo)
  let sum = 0
  for (let i = 0; i < n; i++) sum += lums[i]
  const invert = sum / n < 118 // dark background → light text → flip for OCR
  for (let i = 0; i < n; i++) {
    let v = Math.max(0, Math.min(255, ((lums[i] - lo) * 255) / range))
    if (invert) v = 255 - v
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v
  }
  ctx.putImageData(img, 0, 0)
}

function crop(
  bitmap: ImageBitmap,
  x: number,
  y: number,
  w: number,
  h: number,
  enhance: boolean,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  // normalize crop height — tesseract reads best around 30-60px glyph height
  const scale = Math.min(3, Math.max(0.4, 380 / h))
  canvas.width = Math.round(w * scale)
  canvas.height = Math.round(h * scale)
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, x, y, w, h, 0, 0, canvas.width, canvas.height)
  if (enhance) preprocess(canvas)
  return canvas
}

// Run OCR on the ORIGINAL capture (full camera resolution) — never the
// compressed copy stored for display; small collector numbers need the detail.
export async function readCardText(front: Blob, onStatus?: StatusFn): Promise<CardTextReading> {
  const bitmap = await createImageBitmap(front)

  // find the card at analysis scale, then map the rect back to full resolution
  const scale = Math.min(1, 800 / Math.max(bitmap.width, bitmap.height))
  const small = document.createElement('canvas')
  small.width = Math.round(bitmap.width * scale)
  small.height = Math.round(bitmap.height * scale)
  const sctx = small.getContext('2d')!
  sctx.drawImage(bitmap, 0, 0, small.width, small.height)
  const found = findCardBounds(sctx.getImageData(0, 0, small.width, small.height))

  const r = found
    ? {
        x0: found.rect.x0 / scale,
        y0: found.rect.y0 / scale,
        x1: found.rect.x1 / scale,
        y1: found.rect.y1 / scale,
      }
    : { x0: 0, y0: 0, x1: bitmap.width, y1: bitmap.height } // fall back to whole image
  const w = r.x1 - r.x0
  const h = r.y1 - r.y0

  // name: top band (skip the outermost border), full width to survive tilt
  const nameCanvas = crop(bitmap, r.x0 + w * 0.04, r.y0 + h * 0.025, w * 0.92, h * 0.115, true)
  // collector number: bottom strip ("58/102" bottom-right on old cards,
  // "025/165" bottom-left on modern ones); enhanced + raw variants because
  // preprocessing helps some prints and hurts others
  const numArgs = [r.x0 + w * 0.02, r.y1 - h * 0.09, w * 0.96, h * 0.08] as const
  const numCanvasRaw = crop(bitmap, ...numArgs, false)
  const numCanvasEnh = crop(bitmap, ...numArgs, true)
  bitmap.close()

  const worker = await getWorker(onStatus)
  onStatus?.('Reading card text…')

  await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO })
  const nameRes = await worker.recognize(nameCanvas)

  const NUM_RE = /(\d{1,3})\s*[/|\\]\s*(\d{1,3})/
  let numMatch = (await worker.recognize(numCanvasRaw)).data.text.match(NUM_RE)
  numMatch ??= (await worker.recognize(numCanvasEnh)).data.text.match(NUM_RE)

  const name = cleanName(nameRes.data.text)
  return {
    name,
    number: numMatch ? String(parseInt(numMatch[1], 10)) : undefined,
    total: numMatch ? String(parseInt(numMatch[2], 10)) : undefined,
  }
}

// Similarity for ranking candidates against the OCR'd name (0..1).
export function nameSimilarity(a: string, b: string): number {
  const s = a.toLowerCase().trim()
  const t = b.toLowerCase().trim()
  if (s === t) return 1
  const m = s.length
  const n = t.length
  if (m === 0 || n === 0) return 0
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return 1 - prev[n] / Math.max(m, n)
}
