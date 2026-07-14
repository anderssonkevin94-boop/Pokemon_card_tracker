import { useEffect, useRef, useState } from 'react'
import { db, getSetting, todayFromDate, type CardSide, type SellStatus, type Variant } from '../db'
import {
  searchCards,
  searchByNumberTotal,
  fetchCardsByIds,
  availableVariants,
  priceForVariant,
  bestPrice,
  type ApiCard,
} from '../api/pokemonTcg'
import { compressImage } from '../lib/imageUtils'
import { estimateGrade } from '../lib/grading'

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
  // Full-resolution captures — OCR and grading read these; only the
  // compressed copies are stored.
  const originals = useRef<{ front?: Blob; back?: Blob }>({})
  const pendingSide = useRef<CardSide>('front')
  const cameraInput = useRef<HTMLInputElement>(null)
  const libraryInput = useRef<HTMLInputElement>(null)

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

  function openCamera(side: CardSide) {
    pendingSide.current = side
    cameraInput.current?.click()
  }

  function openLibrary(side: CardSide) {
    pendingSide.current = side
    libraryInput.current?.click()
  }

  async function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file
    if (!file) return
    const side = pendingSide.current
    originals.current[side] = file
    const compressed = await compressImage(file, 2048, 0.85)
    setPhotos((p) => ({ ...p, [side]: compressed }))
    if (side === 'front') identify(file)
  }

  async function identify(front: Blob) {
    setError(null)
    setPicked(null)
    setCandidates(null)
    setOcrHint(null)
    setShowManual(false)
    try {
      setIdentifying('Analyzing photo…')
      const [{ readCardText, nameSimilarity }, { matchCardImage }] = await Promise.all([
        import('../lib/cardId'),
        import('../lib/imageMatch'),
      ])
      // Two independent engines in parallel: perceptual image match against
      // every card's official image, and OCR of the name/collector number.
      const [ocrRes, hashRes] = await Promise.allSettled([
        readCardText(front, (s) => setIdentifying(s)),
        matchCardImage(front),
      ])
      const reading = ocrRes.status === 'fulfilled' ? ocrRes.value : {}
      const hashMatches = hashRes.status === 'fulfilled' ? hashRes.value : []
      // beyond ~46/128 bits a hash "match" is noise — don't let it vote
      const usableHashes = hashMatches.filter((m) => m.distance <= 46)

      if (!reading.name && !reading.number && usableHashes.length === 0) {
        setOcrHint('Couldn’t identify the card — search manually below.')
        setShowManual(true)
        return
      }
      const readPart = reading.name || reading.number
        ? `Read: ${reading.name ?? '(no name)'}${reading.number ? ` · #${reading.number}${reading.total ? `/${reading.total}` : ''}` : ''}`
        : 'Text unreadable'
      const matchPart = usableHashes.length > 0 ? ' · image matched' : ''
      setOcrHint(readPart + matchPart)

      setIdentifying('Finding matches…')
      const apiKey = await getSetting('apiKey')

      // Candidate passes, strongest signal first:
      // 1. image fingerprint matches (distance-weighted)
      // 2. number + set size ("58/102" is nearly unique across all sets)
      // 3. name + number
      // 4. name only (newest prints) — fills out the alternates
      const passes: { cards: ApiCard[]; boost: number | ((c: ApiCard) => number) }[] = []
      if (usableHashes.length > 0) {
        const byDist = new Map(usableHashes.map((m) => [m.id, m.distance]))
        const cards = await fetchCardsByIds([...byDist.keys()], apiKey)
        passes.push({ cards, boost: (c) => Math.max(0, (46 - (byDist.get(c.id) ?? 46)) / 8) })
      }
      if (reading.number && reading.total) {
        passes.push({ cards: await searchByNumberTotal(reading.number, reading.total, apiKey), boost: 3 })
      }
      if (reading.name && reading.number) {
        passes.push({ cards: await searchCards({ name: reading.name, number: reading.number, apiKey }), boost: 2 })
      }
      if (reading.name) {
        let broad = await searchCards({ name: reading.name, apiKey })
        // OCR often mangles one word — retry with the first word alone
        if (broad.length === 0 && reading.name.includes(' ')) {
          broad = await searchCards({ name: reading.name.split(' ')[0], apiKey })
        }
        passes.push({ cards: broad, boost: 0 })
      }

      // Scores add up across passes: a card that both looks right and reads
      // right beats one that only matches a single signal.
      const scoreById = new Map<string, { c: ApiCard; score: number; order: number }>()
      let order = 0
      for (const pass of passes) {
        for (const c of pass.cards) {
          const passBoost = typeof pass.boost === 'function' ? pass.boost(c) : pass.boost
          const nameScore = reading.name ? nameSimilarity(reading.name, c.name) : 0
          const numScore =
            reading.number && parseInt(c.number, 10) === parseInt(reading.number, 10) ? 1 : 0
          const score = passBoost + nameScore + numScore
          const existing = scoreById.get(c.id)
          if (existing) {
            existing.score += passBoost // signals stack across passes
          } else {
            scoreById.set(c.id, { c, score, order: order++ })
          }
        }
      }
      const ranked = [...scoreById.values()]
        .sort((a, b) => b.score - a.score || a.order - b.order)
        .map((s) => s.c)

      if (ranked.length === 0) {
        setOcrHint(`${readPart} — no matches found, search manually below.`)
        setShowManual(true)
        return
      }
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
      // Grade in the background from the full-res capture — card is already saved.
      const gradeSource = originals.current.front ?? photos.front
      if (gradeSource) {
        estimateGrade(gradeSource)
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
          <div key={side} className="photo-wrap">
            <button className="photo-slot" onClick={() => openCamera(side)}>
              {photos[side] ? (
                <img src={previewUrl(photos[side]!)} alt={`${side} of card`} />
              ) : (
                <>
                  <span style={{ fontSize: 28 }}>📷</span>
                  <span>{side === 'front' ? 'Front (identifies + grades)' : 'Back (optional)'}</span>
                </>
              )}
            </button>
            <button className="photo-lib" title="Choose from library" onClick={() => openLibrary(side)}>
              🖼️
            </button>
          </div>
        ))}
      </div>
      {/* native camera app — full photo quality, no permission prompts */}
      <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden onChange={onFilePicked} />
      <input ref={libraryInput} type="file" accept="image/*" hidden onChange={onFilePicked} />
      <p className="dim" style={{ marginTop: 6 }}>
        Tip: shoot straight-on in portrait, card filling most of the frame, on a plain contrasting background.
      </p>

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
    </div>
  )
}
