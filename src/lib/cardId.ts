// Photo auto-ID: OCR the card name (top band) and collector number (bottom
// strip) with Tesseract.js, entirely on-device. This module is dynamically
// imported so the ~3MB OCR engine only loads the first time it's needed.
import { createWorker, PSM, type Worker } from 'tesseract.js'
import { extractFlatCard } from './cardExtract'
import { orientedBitmap } from './imageUtils'

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
  bitmap: CanvasImageSource,
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

// Run OCR on the perspective-corrected card extracted from the ORIGINAL
// capture (never the compressed copy stored for display). Falls back to the
// raw frame when the card couldn't be flattened cleanly.
export async function readCardText(front: Blob, onStatus?: StatusFn): Promise<CardTextReading> {
  const flat = await extractFlatCard(front, 700)

  // OCR sources, best first: the flattened card, then the raw frame.
  const sources: { src: CanvasImageSource; w: number; h: number; close?: () => void }[] = [
    { src: flat.canvas, w: flat.canvas.width, h: flat.canvas.height },
  ]
  if (flat.quadFound) {
    const bitmap = await orientedBitmap(front)
    sources.push({ src: bitmap, w: bitmap.width, h: bitmap.height, close: () => bitmap.close() })
  }

  const worker = await getWorker(onStatus)
  onStatus?.('Reading card text…')
  await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO })

  const NUM_RE = /(\d{1,3})\s*[/|\\]\s*(\d{1,3})/
  let name: string | undefined
  let nameConf = 0
  let numMatch: RegExpMatchArray | null = null

  for (const { src, w, h } of sources) {
    if (!name || nameConf < 60) {
      // name: top band (skip the outermost border), full width to survive tilt
      const res = await worker.recognize(
        crop(src, w * 0.04, h * 0.025, w * 0.92, h * 0.115, true),
      )
      const cleaned = cleanName(res.data.text)
      if (cleaned && res.data.confidence > nameConf) {
        name = cleaned
        nameConf = res.data.confidence
      }
    }
    if (!numMatch) {
      // collector number: bottom strip ("58/102" bottom-right on old cards,
      // "025/165" bottom-left on modern ones); enhanced + raw variants because
      // preprocessing helps some prints and hurts others
      const numArgs = [w * 0.02, h * 0.91, w * 0.96, h * 0.08] as const
      numMatch = (await worker.recognize(crop(src, ...numArgs, false))).data.text.match(NUM_RE)
      numMatch ??= (await worker.recognize(crop(src, ...numArgs, true))).data.text.match(NUM_RE)
    }
    if (name && nameConf >= 60 && numMatch) break
  }
  sources.forEach((s) => s.close?.())

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
