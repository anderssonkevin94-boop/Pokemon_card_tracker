import Dexie, { type EntityTable } from 'dexie'

export type SellStatus = 'keep' | 'sell' | 'undecided'
export type CardSide = 'front' | 'back'
export type Variant =
  | 'normal'
  | 'holofoil'
  | 'reverseHolofoil'
  | '1stEditionHolofoil'
  | '1stEditionNormal'
  | 'unlimited'
  | 'unlimitedHolofoil'

export interface GradeEstimate {
  overallLow: number
  overallHigh: number
  centering: number
  corners: number
  centeringRatioLR: string // e.g. "58/42"
  centeringRatioTB: string
  notes: string[]
  analyzedAt: number
}

export interface Card {
  id?: number
  tcgApiCardId: string
  name: string
  setId: string
  setName: string
  number: string
  rarity: string
  variant: Variant
  sellStatus: SellStatus
  gradeEstimate?: GradeEstimate
  currentValue?: number // TCGplayer market price (USD, raw/ungraded)
  imageSmall?: string
  imageLarge?: string
  addedAt: number
}

export interface Photo {
  id?: number
  cardId: number
  side: CardSide
  blob: Blob
  capturedAt: number
}

export interface PriceSnapshot {
  id?: number
  cardId: number
  date: string // YYYY-MM-DD
  market?: number
  low?: number
  mid?: number
  high?: number
}

export interface Setting {
  key: string
  value: string
}

export const db = new Dexie('pokevault') as Dexie & {
  cards: EntityTable<Card, 'id'>
  photos: EntityTable<Photo, 'id'>
  priceSnapshots: EntityTable<PriceSnapshot, 'id'>
  settings: EntityTable<Setting, 'key'>
}

db.version(1).stores({
  cards: '++id, tcgApiCardId, name, setId, sellStatus, currentValue, addedAt',
  photos: '++id, cardId, [cardId+side]',
  priceSnapshots: '++id, cardId, date, [cardId+date]',
  settings: 'key',
})

export async function getSetting(key: string): Promise<string | undefined> {
  return (await db.settings.get(key))?.value
}

export async function setSetting(key: string, value: string): Promise<void> {
  await db.settings.put({ key, value })
}

export function todayFromDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}
