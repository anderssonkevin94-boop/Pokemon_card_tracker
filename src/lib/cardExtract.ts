// Flatten the card out of a photo: find its corners, perspective-correct it
// to an upright 63:88 rect, then run detection once more *inside* the result
// so a card in a sleeve or toploader gets cropped down to the card itself.
// Both image matching and OCR read from this canvas.
import { findCardQuad, quadArea, type Quad } from './cardDetect'
import { orientedBitmap } from './imageUtils'

const CARD_ASPECT = 63 / 88

// Homography mapping the corners of a W×H rect onto `quad` (DLT, 4 points).
function rectToQuadHomography(w: number, h: number, q: Quad): number[] {
  const src = [
    [0, 0], [w, 0], [w, h], [0, h],
  ]
  const dst = [
    [q.tl.x, q.tl.y], [q.tr.x, q.tr.y], [q.br.x, q.br.y], [q.bl.x, q.bl.y],
  ]
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

// Sample the source quad into an upright W×H canvas (inverse mapping).
export function unwarpQuad(srcImg: ImageData, quad: Quad, w: number, h: number): HTMLCanvasElement {
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

export interface FlatCard {
  canvas: HTMLCanvasElement
  quadFound: boolean
  refined: boolean // true when a card was found inside a sleeve/toploader
}

export async function extractFlatCard(photo: Blob, outW = 540): Promise<FlatCard> {
  const outH = Math.round(outW / CARD_ASPECT)
  const bitmap = await orientedBitmap(photo)
  const scale = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height))
  const work = document.createElement('canvas')
  work.width = Math.round(bitmap.width * scale)
  work.height = Math.round(bitmap.height * scale)
  const wctx = work.getContext('2d')!
  wctx.drawImage(bitmap, 0, 0, work.width, work.height)
  bitmap.close()
  const img = wctx.getImageData(0, 0, work.width, work.height)

  const fullFrame = (): HTMLCanvasElement => {
    const c = document.createElement('canvas')
    c.width = outW
    c.height = outH
    c.getContext('2d')!.drawImage(work, 0, 0, outW, outH)
    return c
  }

  const quad = findCardQuad(img)
  if (!quad) return { canvas: fullFrame(), quadFound: false, refined: false }

  let flat: HTMLCanvasElement
  try {
    flat = unwarpQuad(img, quad, outW, outH)
  } catch {
    return { canvas: fullFrame(), quadFound: false, refined: false }
  }

  // Second pass inside the flattened result: if a clearly smaller convex
  // region is found (card inside sleeve/toploader), crop down to it.
  let refined = false
  try {
    const flatImg = flat.getContext('2d')!.getImageData(0, 0, outW, outH)
    const inner = findCardQuad(flatImg)
    if (inner) {
      const frac = quadArea(inner) / (outW * outH)
      if (frac > 0.45 && frac < 0.96) {
        flat = unwarpQuad(flatImg, inner, outW, outH)
        refined = true
      }
    }
  } catch {
    // keep the single-pass result
  }
  return { canvas: flat, quadFound: true, refined }
}
