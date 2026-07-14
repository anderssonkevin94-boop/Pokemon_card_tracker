// Client for the free pokemontcg.io v2 API.
// Kept behind this module so the price source can be swapped later
// (PriceCharting / Scrydex) without touching UI code.
import type { Variant } from '../db'

const BASE = 'https://api.pokemontcg.io/v2'

export interface VariantPrices {
  low?: number
  mid?: number
  high?: number
  market?: number
}

export interface ApiCard {
  id: string
  name: string
  number: string
  rarity?: string
  set: { id: string; name: string; series: string; releaseDate?: string }
  images: { small: string; large: string }
  tcgplayer?: { url: string; prices?: Record<string, VariantPrices> }
  cardmarket?: { prices?: { averageSellPrice?: number; trendPrice?: number } }
}

async function request(path: string, apiKey?: string): Promise<Response> {
  const headers: Record<string, string> = {}
  if (apiKey) headers['X-Api-Key'] = apiKey
  const res = await fetch(`${BASE}${path}`, { headers })
  if (res.status === 429) throw new Error('Rate limited by pokemontcg.io — try again in a minute')
  if (!res.ok) throw new Error(`pokemontcg.io error ${res.status}`)
  return res
}

export async function searchCards(
  opts: { name?: string; number?: string; apiKey?: string },
): Promise<ApiCard[]> {
  const parts: string[] = []
  if (opts.name?.trim()) parts.push(`name:"${opts.name.trim().replace(/"/g, '')}*"`)
  if (opts.number?.trim()) parts.push(`number:${opts.number.trim().replace(/\s/g, '')}`)
  if (parts.length === 0) return []
  const q = encodeURIComponent(parts.join(' '))
  const res = await request(
    `/cards?q=${q}&pageSize=24&orderBy=-set.releaseDate&select=id,name,number,rarity,set,images,tcgplayer,cardmarket`,
    opts.apiKey,
  )
  const json = await res.json()
  return json.data ?? []
}

// Batched lookup for the daily price refresh. ~100 ids per request keeps URLs
// well under length limits; 3000 cards ≈ 30 requests.
export async function fetchCardsByIds(ids: string[], apiKey?: string): Promise<ApiCard[]> {
  const out: ApiCard[] = []
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100)
    const q = encodeURIComponent(batch.map((id) => `id:"${id}"`).join(' OR '))
    const res = await request(
      `/cards?q=(${q})&pageSize=250&select=id,name,number,rarity,set,images,tcgplayer,cardmarket`,
      apiKey,
    )
    const json = await res.json()
    out.push(...(json.data ?? []))
  }
  return out
}

export function availableVariants(card: ApiCard): Variant[] {
  const keys = Object.keys(card.tcgplayer?.prices ?? {})
  return (keys.length > 0 ? keys : ['normal']) as Variant[]
}

// Best price for a variant: TCGplayer market → mid → CardMarket trend fallback.
export function priceForVariant(card: ApiCard, variant: Variant): VariantPrices {
  const p = card.tcgplayer?.prices?.[variant]
  if (p && (p.market ?? p.mid ?? p.low) != null) return p
  const cm = card.cardmarket?.prices
  if (cm?.trendPrice != null || cm?.averageSellPrice != null) {
    return { market: cm.trendPrice ?? cm.averageSellPrice }
  }
  return {}
}

export function bestPrice(prices: VariantPrices): number | undefined {
  return prices.market ?? prices.mid ?? prices.low
}
