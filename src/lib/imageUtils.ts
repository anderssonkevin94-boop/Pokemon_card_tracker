// iPhone photos are stored rotated with an EXIF flag — always honor it or
// every downstream crop (OCR bands, grading corners) lands in the wrong place.
export async function orientedBitmap(source: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(source, { imageOrientation: 'from-image' })
  } catch {
    return await createImageBitmap(source) // older browsers without the option
  }
}

// Downscale + compress a photo to JPEG before storing in IndexedDB.
// ~2048px keeps enough detail for re-analysis while staying ~300-600KB.
export async function compressImage(source: Blob, maxDim = 2048, quality = 0.85): Promise<Blob> {
  const bitmap = await orientedBitmap(source)
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height))
  const w = Math.round(bitmap.width * scale)
  const h = Math.round(bitmap.height * scale)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close()
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', quality),
  )
  if (!blob) throw new Error('Image compression failed')
  return blob
}

export async function blobToImageData(blob: Blob, maxDim = 800): Promise<ImageData> {
  const bitmap = await orientedBitmap(blob)
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height))
  const w = Math.round(bitmap.width * scale)
  const h = Math.round(bitmap.height * scale)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close()
  return ctx.getImageData(0, 0, w, h)
}
