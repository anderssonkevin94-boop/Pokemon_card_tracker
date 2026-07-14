// Daily price refresh: batched pokemontcg.io lookups for every owned card,
// one snapshot per card per day. Runs on app open when stale (>20h) — iOS PWAs
// can't do true background refresh, so refresh-on-open is the design.
import { db, getSetting, setSetting, todayFromDate } from '../db'
import { fetchCardsByIds, priceForVariant, bestPrice } from '../api/pokemonTcg'

const STALE_MS = 20 * 60 * 60 * 1000

export function todayKey(): string {
  return todayFromDate(new Date())
}

export async function isRefreshDue(): Promise<boolean> {
  const last = await getSetting('lastPriceRefresh')
  if (!last) return (await db.cards.count()) > 0
  return Date.now() - Number(last) > STALE_MS
}

export async function refreshPrices(
  onProgress?: (done: number, total: number) => void,
): Promise<{ updated: number; total: number }> {
  const apiKey = await getSetting('apiKey')
  const cards = await db.cards.toArray()
  if (cards.length === 0) return { updated: 0, total: 0 }

  const ids = [...new Set(cards.map((c) => c.tcgApiCardId))]
  const date = todayKey()
  let updated = 0
  let done = 0

  // Process in chunks so an interrupted refresh still lands partial snapshots;
  // re-running the same day just overwrites that day's snapshots (idempotent).
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    const apiCards = await fetchCardsByIds(chunk, apiKey)
    const byId = new Map(apiCards.map((c) => [c.id, c]))

    for (const card of cards.filter((c) => chunk.includes(c.tcgApiCardId))) {
      const apiCard = byId.get(card.tcgApiCardId)
      if (!apiCard || card.id == null) continue
      const prices = priceForVariant(apiCard, card.variant)
      const value = bestPrice(prices)
      if (value != null) {
        await db.cards.update(card.id, { currentValue: value })
        const existing = await db.priceSnapshots.where('[cardId+date]').equals([card.id, date]).first()
        const snap = { cardId: card.id, date, market: prices.market, low: prices.low, mid: prices.mid, high: prices.high }
        if (existing?.id != null) await db.priceSnapshots.update(existing.id, snap)
        else await db.priceSnapshots.add(snap)
        updated++
      }
      done++
      onProgress?.(done, cards.length)
    }
  }

  await setSetting('lastPriceRefresh', String(Date.now()))
  return { updated, total: cards.length }
}
