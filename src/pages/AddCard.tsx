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
  const [candidates, setCandidates] = useState<ApiCard[] | null>(null)
  const [picked, setPicked] = useState<ApiCard | null>(null)
  const [identifying, setIdentifying] = useState<string | null>(null) // status text while auto-ID runs
  const [ocrHint, setOcrHint] = useState<string | null>(null)
  const [showManual, setShowManual] = useState(false)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [variant, setVariant] = useState<Variant>('normal')
  const [sellStatus, setSellStatus] = useState<SellStatus>('undecided')
  const [saving, setSaving] = useState(false)
  const previews = useRef<Map<Blob, string>>(new Map())
  const identifiedBlob = useRef<Blob | null>(null)

  useEffect(() => {
    const map = previews.current
    return () => map.forEach((url) => URL.revokeObjectURL(url))
  }, [])

  // Auto-identify whenever a new front photo lands.
  useEffect(() => {
    if (photos.front && photos.front !== identifiedBlob.current) {
      identifiedBlob.current = photos.front
      identify(photos.front)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photos.front])

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

  async function identify(front: Blob) {
    setError(null)
    setPicked(null)
    setCandidates(null)
    setOcrHint(null)
    setShowManual(false)
    try {
      setIdentifying('Reading card text…')
      const { readCardText, nameSimilarity } = await import('../lib/cardId')
      const reading = await readCardText(front)
      if (!reading.name && !reading.number) {
        setOcrHint('Couldn’t read the card — search manually below.')
        setShowManual(true)
        return
      }
      setOcrHint(
        `Read: ${reading.name ?? '(no name)'}${reading.number ? ` · #${reading.number}` : ''}`,
      )
      setIdentifying('Finding matches…')
      const apiKey = await getSetting('apiKey')
      // Precise pass first (name + collector number), then name-only to fill
      // out alternates — the name-only page holds only the ~24 newest prints.
      const exact = reading.number
        ? await searchCards({ name: reading.name, number: reading.number, apiKey })
        : []
      const broad = await searchCards({ name: reading.name, apiKey })
      const seen = new Set<string>()
      const found = [...exact, ...broad].filter((c) => !seen.has(c.id) && seen.add(c.id))
      if (found.length === 0) {
        setOcrHint(`Read "${reading.name ?? reading.number}" but found no matches — search manually below.`)
        setShowManual(true)
        return
      }
      const scored = found
        .map((c, i) => {
          let score = reading.name ? nameSimilarity(reading.name, c.name) : 0
          if (reading.number && parseInt(c.number, 10) === parseInt(reading.number, 10)) score += 2
          return { c, score, i }
        })
        .sort((a, b) => b.score - a.score || a.i - b.i)
      const ranked = scored.map((s) => s.c)
      setCandidates(ranked.slice(0, 6))
      pick(ranked[0]) // most likely match, preselected — user approves before saving
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Identification failed')
      setShowManual(true)
    } finally {
      setIdentifying(null)
    }
  }

  async function doSearch() {
    setSearching(true)
    setError(null)
    setCandidates(null)
    setPicked(null)
    try {
      const apiKey = await getSetting('apiKey')
      const found = await searchCards({ name, number, apiKey })
      setCandidates(found.slice(0, 24))
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
  const alternates = candidates?.filter((c) => c.id !== picked?.id) ?? []

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
                <span>{side === 'front' ? 'Front (identifies + grades)' : 'Back (optional)'}</span>
              </>
            )}
          </button>
        ))}
      </div>

      <h2>2. Identify</h2>
      {identifying && <p className="dim">⏳ {identifying}</p>}
      {ocrHint && !identifying && <p className="dim">{ocrHint}</p>}

      {picked && (
        <>
          <div className="list-row" style={{ cursor: 'default', borderColor: 'var(--accent)' }}>
            <img src={picked.images.small} alt="" />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>{picked.name} <span className="dim">#{picked.number}</span></div>
              <div className="dim">{picked.set.name} · {picked.rarity ?? 'Unknown rarity'}</div>
              {pickedPrice != null && <div style={{ color: 'var(--green)', fontWeight: 700 }}>${pickedPrice.toFixed(2)}</div>}
            </div>
            <span className="badge keep">best match</span>
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
            {saving ? 'Saving…' : '✓ Approve & add to collection'}
          </button>
          {!photos.front && <p className="notice">No front photo — the card will be saved without a grade estimate.</p>}
        </>
      )}

      {alternates.length > 0 && (
        <>
          <h2>{picked ? 'Not this card? Tap the right one:' : 'Matches'}</h2>
          {alternates.map((c) => (
            <button key={c.id} className="list-row" onClick={() => pick(c)}>
              <img src={c.images.small} alt="" loading="lazy" />
              <div>
                <div style={{ fontWeight: 600 }}>{c.name} <span className="dim">#{c.number}</span></div>
                <div className="dim">{c.set.name} · {c.rarity ?? 'Unknown rarity'}</div>
              </div>
            </button>
          ))}
        </>
      )}

      {error && <p className="error-text">{error}</p>}

      {(showManual || candidates || picked) && !identifying ? (
        !showManual && (
          <button className="btn btn-block" onClick={() => setShowManual(true)}>
            Search manually instead
          </button>
        )
      ) : null}

      {(showManual || (!photos.front && !identifying)) && (
        <div style={{ marginTop: 8 }}>
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
        </div>
      )}

      {cameraFor && (
        <CameraCapture onCapture={(b) => onCaptured(cameraFor, b)} onCancel={() => setCameraFor(null)} />
      )}
    </div>
  )
}
