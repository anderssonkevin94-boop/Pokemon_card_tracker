import { useEffect, useRef, useState } from 'react'
import { db, getSetting, todayFromDate, type CardSide, type SellStatus, type Variant } from '../db'
import { searchCards, availableVariants, priceForVariant, bestPrice, type ApiCard } from '../api/pokemonTcg'
import { compressImage } from '../lib/imageUtils'
import { estimateGrade } from '../lib/grading'
import CameraCapture from '../components/CameraCapture'

const VARIANT_LABELS: Record<string, string> = {
  normal: 'Normal',
  holofoil: 'Holofoil',
  reverseHolofoil: 'Reverse Holo',
  '1stEditionHolofoil': '1st Ed. Holo',
  '1stEditionNormal': '1st Edition',
  unlimited: 'Unlimited',
  unlimitedHolofoil: 'Unlimited Holo',
}

export default function AddCard({ onSaved }: { onSaved: (cardId: number) => void }) {
  const [photos, setPhotos] = useState<{ front?: Blob; back?: Blob }>({})
  const [cameraFor, setCameraFor] = useState<CardSide | null>(null)
  const [name, setName] = useState('')
  const [number, setNumber] = useState('')
  const [results, setResults] = useState<ApiCard[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<ApiCard | null>(null)
  const [variant, setVariant] = useState<Variant>('normal')
  const [sellStatus, setSellStatus] = useState<SellStatus>('undecided')
  const [saving, setSaving] = useState(false)
  const previews = useRef<Map<Blob, string>>(new Map())

  useEffect(() => {
    const map = previews.current
    return () => map.forEach((url) => URL.revokeObjectURL(url))
  }, [])

  function previewUrl(blob: Blob): string {
    let url = previews.current.get(blob)
    if (!url) {
      url = URL.createObjectURL(blob)
      previews.current.set(blob, url)
    }
    return url
  }

  async function onCaptured(side: CardSide, raw: Blob) {
    setCameraFor(null)
    const compressed = await compressImage(raw)
    setPhotos((p) => ({ ...p, [side]: compressed }))
  }

  async function doSearch() {
    setSearching(true)
    setError(null)
    setResults(null)
    try {
      const apiKey = await getSetting('apiKey')
      const found = await searchCards({ name, number, apiKey })
      setResults(found)
      if (found.length === 0) setError('No matches — check spelling, or try just the card number.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Search failed — are you online?')
    } finally {
      setSearching(false)
    }
  }

  function pick(card: ApiCard) {
    setPicked(card)
    const variants = availableVariants(card)
    setVariant(variants[0])
  }

  async function save() {
    if (!picked) return
    setSaving(true)
    try {
      const prices = priceForVariant(picked, variant)
      const cardId = (await db.cards.add({
        tcgApiCardId: picked.id,
        name: picked.name,
        setId: picked.set.id,
        setName: picked.set.name,
        number: picked.number,
        rarity: picked.rarity ?? 'Unknown',
        variant,
        sellStatus,
        currentValue: bestPrice(prices),
        imageSmall: picked.images.small,
        imageLarge: picked.images.large,
        addedAt: Date.now(),
      })) as number
      const now = Date.now()
      if (photos.front) await db.photos.add({ cardId, side: 'front', blob: photos.front, capturedAt: now })
      if (photos.back) await db.photos.add({ cardId, side: 'back', blob: photos.back, capturedAt: now })
      if (bestPrice(prices) != null) {
        await db.priceSnapshots.add({
          cardId,
          date: todayFromDate(new Date()),
          market: prices.market,
          low: prices.low,
          mid: prices.mid,
          high: prices.high,
        })
      }
      // Grade in the background — the card is already saved.
      if (photos.front) {
        estimateGrade(photos.front)
          .then((grade) => db.cards.update(cardId, { gradeEstimate: grade }))
          .catch(() => {})
      }
      onSaved(cardId)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
      setSaving(false)
    }
  }

  const variants = picked ? availableVariants(picked) : []
  const pickedPrice = picked ? bestPrice(priceForVariant(picked, variant)) : undefined

  return (
    <div className="page">
      <h1>Add Card</h1>

      <h2>1. Photos</h2>
      <div className="row" style={{ alignItems: 'stretch' }}>
        {(['front', 'back'] as const).map((side) => (
          <button key={side} className="photo-slot" onClick={() => setCameraFor(side)}>
            {photos[side] ? (
              <img src={previewUrl(photos[side]!)} alt={`${side} of card`} />
            ) : (
              <>
                <span style={{ fontSize: 28 }}>📷</span>
                <span>{side === 'front' ? 'Front (used for grading)' : 'Back (optional)'}</span>
              </>
            )}
          </button>
        ))}
      </div>

      <h2>2. Identify</h2>
      <div className="row">
        <input
          placeholder="Card name, e.g. Charizard"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && doSearch()}
        />
        <input
          placeholder="No."
          value={number}
          style={{ width: 90, flexShrink: 0 }}
          onChange={(e) => setNumber(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && doSearch()}
        />
      </div>
      <button className="btn btn-primary btn-block" onClick={doSearch} disabled={searching || (!name.trim() && !number.trim())}>
        {searching ? 'Searching…' : 'Search'}
      </button>
      {error && <p className="error-text">{error}</p>}

      {results && results.length > 0 && !picked && (
        <div style={{ marginTop: 12 }}>
          {results.map((c) => (
            <button key={c.id} className="list-row" onClick={() => pick(c)}>
              <img src={c.images.small} alt="" loading="lazy" />
              <div>
                <div style={{ fontWeight: 600 }}>{c.name} <span className="dim">#{c.number}</span></div>
                <div className="dim">{c.set.name} · {c.rarity ?? 'Unknown rarity'}</div>
              </div>
            </button>
          ))}
        </div>
      )}

      {picked && (
        <>
          <div className="list-row" style={{ cursor: 'default' }}>
            <img src={picked.images.small} alt="" />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>{picked.name} <span className="dim">#{picked.number}</span></div>
              <div className="dim">{picked.set.name}</div>
              {pickedPrice != null && <div style={{ color: 'var(--green)', fontWeight: 700 }}>${pickedPrice.toFixed(2)}</div>}
            </div>
            <button className="btn" onClick={() => setPicked(null)}>Change</button>
          </div>

          {variants.length > 1 && (
            <>
              <label>Variant</label>
              <select value={variant} onChange={(e) => setVariant(e.target.value as Variant)}>
                {variants.map((v) => (
                  <option key={v} value={v}>{VARIANT_LABELS[v] ?? v}</option>
                ))}
              </select>
            </>
          )}

          <label>Willing to sell?</label>
          <div className="segmented">
            {(['keep', 'undecided', 'sell'] as const).map((s) => (
              <button key={s} className={sellStatus === s ? 'active' : ''} onClick={() => setSellStatus(s)}>
                {s === 'keep' ? 'Keep' : s === 'sell' ? 'Sell' : 'Undecided'}
              </button>
            ))}
          </div>

          <button className="btn btn-primary btn-block" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save to collection'}
          </button>
          {!photos.front && <p className="notice">No front photo — the card will be saved without a grade estimate.</p>}
        </>
      )}

      {cameraFor && (
        <CameraCapture onCapture={(b) => onCaptured(cameraFor, b)} onCancel={() => setCameraFor(null)} />
      )}
    </div>
  )
}
