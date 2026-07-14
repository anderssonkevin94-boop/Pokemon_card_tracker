// Builds public/card-hashes.json: a perceptual-hash fingerprint of every
// card's official image, used by the app for photo identification.
// Run occasionally to pick up new sets:  node scripts/build-hash-db.mjs
// Resumable — progress is checkpointed to scripts/.hash-progress.json.
import sharp from 'sharp'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const OUT = fileURLToPath(new URL('../public/card-hashes.json', import.meta.url))
const PROGRESS = fileURLToPath(new URL('.hash-progress.json', import.meta.url))
const API = 'https://api.pokemontcg.io/v2/cards'
const CONCURRENCY = 16
const onlyIds = process.argv.includes('--only')
  ? process.argv[process.argv.indexOf('--only') + 1].split(',')
  : null

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function fetchAllIds() {
  const ids = []
  for (let page = 1; ; page++) {
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(`${API}?select=id&pageSize=250&page=${page}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = await res.json()
        ids.push(...json.data.map((c) => c.id))
        if (json.data.length < 250) return ids
        break
      } catch (e) {
        if (attempt >= 5) throw e
        console.log(`page ${page} failed (${e.message}), retry ${attempt}`)
        await sleep(3000 * attempt)
      }
    }
    if (page % 10 === 0) console.log(`ids: ${ids.length}…`)
    await sleep(120) // stay well under the keyless rate limit
  }
}

function imageUrl(id) {
  const i = id.lastIndexOf('-')
  return `https://images.pokemontcg.io/${id.slice(0, i)}/${id.slice(i + 1)}.png`
}

// dHash pair from a 9x9 grid of block means (resize to 90x90, average 10x10
// blocks). Block averaging keeps node/sharp and browser/canvas hashes in
// agreement — direct tiny resizes differ too much between resamplers.
// Horizontal: grid[y][x] > grid[y][x+1] (8 rows x 8 gradients).
// Vertical:   grid[y][x] > grid[y+1][x] (8 gradients x 8 cols).
async function hashImage(buf) {
  const raw = await sharp(buf).resize(90, 90, { fit: 'fill' }).grayscale().raw().toBuffer()
  const grid = new Float64Array(81)
  for (let gy = 0; gy < 9; gy++) {
    for (let gx = 0; gx < 9; gx++) {
      let sum = 0
      for (let y = gy * 10; y < gy * 10 + 10; y++)
        for (let x = gx * 10; x < gx * 10 + 10; x++) sum += raw[y * 90 + x]
      grid[gy * 9 + gx] = sum
    }
  }
  let h = 0n
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) h = (h << 1n) | (grid[y * 9 + x] > grid[y * 9 + x + 1] ? 1n : 0n)
  let v = 0n
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) v = (v << 1n) | (grid[y * 9 + x] > grid[(y + 1) * 9 + x] ? 1n : 0n)
  return [h.toString(16).padStart(16, '0'), v.toString(16).padStart(16, '0')]
}

async function hashCard(id) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(imageUrl(id))
      if (res.status === 404) return null // a few ids have no image
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      return await hashImage(buf)
    } catch (e) {
      if (attempt === 4) {
        console.log(`SKIP ${id}: ${e.message}`)
        return null
      }
      await sleep(2000 * attempt)
    }
  }
}

async function main() {
  const done = existsSync(PROGRESS) ? JSON.parse(readFileSync(PROGRESS, 'utf8')) : {}
  const ids = onlyIds ?? (await fetchAllIds())
  console.log(`${ids.length} cards, ${Object.keys(done).length} already hashed`)
  const todo = ids.filter((id) => !(id in done))

  let processed = 0
  async function worker() {
    for (;;) {
      const id = todo.shift()
      if (!id) return
      done[id] = await hashCard(id)
      processed++
      if (processed % 250 === 0) {
        writeFileSync(PROGRESS, JSON.stringify(done))
        console.log(`${processed}/${todo.length + processed} hashed`)
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  writeFileSync(PROGRESS, JSON.stringify(done))

  const cards = ids.filter((id) => done[id]).map((id) => [id, ...done[id]])
  writeFileSync(OUT, JSON.stringify({ version: new Date().toISOString().slice(0, 10), cards }))
  console.log(`DONE: wrote ${cards.length} fingerprints to ${OUT}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
