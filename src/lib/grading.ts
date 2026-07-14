// Best-effort grade estimation from a front photo. This is a heuristic to help
// narrow down value — NOT a substitute for PSA/BGS/CGC grading. It measures:
//  - centering: border widths on all 4 sides (PSA publishes centering tolerances)
//  - corners:   whitening at the 4 corner crops
// Surface and edge wear are intentionally out of scope: phone photos can't
// capture them reliably.
import type { GradeEstimate } from '../db'
import { blobToImageData } from './imageUtils'
import { findCardBounds, luminance, type Rect } from './cardDetect'

const CARD_ASPECT = 63 / 88 // standard card: 63mm x 88mm

// Border width on one side: scan inward along many lines perpendicular to the
// edge; the border ends at the first sustained luminance jump (border -> frame
// or artwork). Median across lines resists glare and print noise.
function borderWidth(
  img: ImageData,
  rect: Rect,
  side: 'left' | 'right' | 'top' | 'bottom',
): number {
  const { data, width } = img
  const horizontal = side === 'left' || side === 'right'
  const cardW = rect.x1 - rect.x0
  const cardH = rect.y1 - rect.y0
  const maxScan = Math.floor((horizontal ? cardW : cardH) * 0.16)
  const lines = 24
  const results: number[] = []
  for (let l = 0; l < lines; l++) {
    // scan lines spread across the middle 60% of the perpendicular dimension
    const t = 0.2 + 0.6 * (l / (lines - 1))
    const fixed = horizontal
      ? Math.round(rect.y0 + cardH * t)
      : Math.round(rect.x0 + cardW * t)
    let prev = -1
    for (let s = 2; s < maxScan; s++) {
      let x: number, y: number
      if (side === 'left') { x = rect.x0 + s; y = fixed }
      else if (side === 'right') { x = rect.x1 - s; y = fixed }
      else if (side === 'top') { x = fixed; y = rect.y0 + s }
      else { x = fixed; y = rect.y1 - s }
      const lum = luminance(data, (y * width + x) * 4)
      if (prev >= 0 && Math.abs(lum - prev) > 26) {
        results.push(s)
        break
      }
      prev = lum
    }
  }
  if (results.length < lines / 2) return -1
  results.sort((a, b) => a - b)
  return results[Math.floor(results.length / 2)]
}

function centeringGrade(worstRatio: number): number {
  // worstRatio: larger share of the border pair, 0.5 = perfect.
  // Thresholds follow published PSA front-centering tolerances.
  if (worstRatio <= 0.55) return 10
  if (worstRatio <= 0.6) return 9
  if (worstRatio <= 0.65) return 8
  if (worstRatio <= 0.7) return 7
  if (worstRatio <= 0.75) return 6
  if (worstRatio <= 0.8) return 5
  return 4
}

// Whitening at a corner: fraction of near-white, low-saturation pixels in a
// small crop just inside the card boundary.
function cornerWhitening(img: ImageData, cx: number, cy: number, size: number): number {
  const { data, width, height } = img
  let white = 0, total = 0
  for (let y = Math.max(0, cy); y < Math.min(height, cy + size); y++) {
    for (let x = Math.max(0, cx); x < Math.min(width, cx + size); x++) {
      const i = (y * width + x) * 4
      const r = data[i], g = data[i + 1], b = data[i + 2]
      const lum = luminance(data, i)
      const chroma = Math.max(r, g, b) - Math.min(r, g, b)
      if (lum > 215 && chroma < 28) white++
      total++
    }
  }
  return total > 0 ? white / total : 0
}

function cornerGrade(whitening: number): number {
  if (whitening < 0.02) return 10
  if (whitening < 0.05) return 9
  if (whitening < 0.1) return 8
  if (whitening < 0.18) return 7
  if (whitening < 0.3) return 6
  return 5
}

export async function estimateGrade(frontPhoto: Blob): Promise<GradeEstimate> {
  const img = await blobToImageData(frontPhoto, 800)
  const notes: string[] = []
  const found = findCardBounds(img)

  const fallback = (why: string): GradeEstimate => ({
    overallLow: 1,
    overallHigh: 9,
    centering: 0,
    corners: 0,
    centeringRatioLR: '?',
    centeringRatioTB: '?',
    notes: [why, 'Retake the photo on a plain, contrasting background with even lighting.'],
    analyzedAt: Date.now(),
  })

  if (!found) return fallback('Could not detect the card in the photo.')
  const { rect } = found
  const cardW = rect.x1 - rect.x0
  const cardH = rect.y1 - rect.y0
  const aspect = cardW / cardH
  if (Math.abs(aspect - CARD_ASPECT) > 0.14) {
    return fallback('Card outline looks skewed or partially detected (check angle and background).')
  }

  // --- centering ---
  const left = borderWidth(img, rect, 'left')
  const right = borderWidth(img, rect, 'right')
  const top = borderWidth(img, rect, 'top')
  const bottom = borderWidth(img, rect, 'bottom')
  let centering = 0
  let ratioLR = '?'
  let ratioTB = '?'
  if (left > 0 && right > 0 && top > 0 && bottom > 0) {
    const lr = Math.max(left, right) / (left + right)
    const tb = Math.max(top, bottom) / (top + bottom)
    ratioLR = `${Math.round((left / (left + right)) * 100)}/${Math.round((right / (left + right)) * 100)}`
    ratioTB = `${Math.round((top / (top + bottom)) * 100)}/${Math.round((bottom / (top + bottom)) * 100)}`
    centering = centeringGrade(Math.max(lr, tb))
  } else {
    notes.push('Borders were hard to measure — centering score is low-confidence.')
    centering = 7 // neutral assumption rather than punishing the card
    ratioLR = ratioTB = '~'
  }

  // --- corners ---
  const cs = Math.max(8, Math.floor(Math.min(cardW, cardH) * 0.07))
  const whitenings = [
    cornerWhitening(img, rect.x0, rect.y0, cs),
    cornerWhitening(img, rect.x1 - cs, rect.y0, cs),
    cornerWhitening(img, rect.x0, rect.y1 - cs, cs),
    cornerWhitening(img, rect.x1 - cs, rect.y1 - cs, cs),
  ]
  // worst corner dominates, like human graders
  const worst = Math.max(...whitenings)
  const avg = whitenings.reduce((a, b) => a + b, 0) / 4
  const corners = Math.min(cornerGrade(worst) + 1, cornerGrade((worst + avg) / 2))

  // --- combine ---
  // Weighted blend, capped near the weakest sub-score (a 10-centering card
  // with beat corners is not an 8).
  const base = Math.min(0.4 * centering + 0.6 * corners, Math.min(centering, corners) + 1.5)
  const overallLow = Math.max(1, Math.floor(base - 0.5))
  const overallHigh = Math.min(10, Math.ceil(base))
  notes.push('Estimate covers centering + corners only; surface and edges are not analyzed.')

  return {
    overallLow,
    overallHigh,
    centering,
    corners,
    centeringRatioLR: ratioLR,
    centeringRatioTB: ratioTB,
    notes,
    analyzedAt: Date.now(),
  }
}
