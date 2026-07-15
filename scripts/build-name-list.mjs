// Builds public/card-names.json: every distinct card name, used to snap OCR
// output to the nearest real name.  Run alongside build-hash-db.mjs.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const OUT = fileURLToPath(new URL('../public/card-names.json', import.meta.url))
const API = 'https://api.pokemontcg.io/v2/cards'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const names = new Set()
for (let page = 1; ; page++) {
  let json
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${API}?select=name&pageSize=250&page=${page}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      json = await res.json()
      break
    } catch (e) {
      if (attempt >= 5) throw e
      console.log(`page ${page} failed (${e.message}), retry ${attempt}`)
      await sleep(3000 * attempt)
    }
  }
  json.data.forEach((c) => names.add(c.name))
  if (json.data.length < 250) break
  if (page % 10 === 0) console.log(`page ${page}, ${names.size} names…`)
  await sleep(120)
}

writeFileSync(OUT, JSON.stringify([...names].sort()))
console.log(`DONE: ${names.size} unique names`)
