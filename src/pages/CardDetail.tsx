import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type SellStatus } from '../db'
import { estimateGrade } from '../lib/grading'
import PriceChart from '../components/PriceChart'

export default function CardDetail({ cardId, onBack }: { cardId: number; onBack: () => void }) {
  const card = useLiveQuery(() => db.cards.get(cardId), [cardId])
  const photos = useLiveQuery(() => db.photos.where('cardId').equals(cardId).toArray(), [cardId])
  const snapshots = useLiveQuery(
    () => db.priceSnapshots.where('cardId').equals(cardId).sortBy('date'),
    [cardId],
  )
  const [photoUrls, setPhotoUrls] = useState<{ side: string; url: string }[]>([])
  const [regrading, setRegrading] = useState(false)

  useEffect(() => {
    if (!photos) return
    const urls = photos.map((p) => ({ side: p.side, url: URL.createObjectURL(p.blob) }))
    setPhotoUrls(urls)
    return () => urls.forEach((u) => URL.revokeObjectURL(u.url))
  }, [photos])

  if (!card) return null

  async function setStatus(s: SellStatus) {
    await db.cards.update(cardId, { sellStatus: s })
  }

  async function regrade() {
    const front = photos?.find((p) => p.side === 'front')
    if (!front) return
    setRegrading(true)
    try {
      const grade = await estimateGrade(front.blob)
      await db.cards.update(cardId, { gradeEstimate: grade })
    } finally {
      setRegrading(false)
    }
  }

  async function remove() {
    if (!confirm(`Delete ${card!.name} from your collection?`)) return
    await db.photos.where('cardId').equals(cardId).delete()
    await db.priceSnapshots.where('cardId').equals(cardId).delete()
    await db.cards.delete(cardId)
    onBack()
  }

  const g = card.gradeEstimate
  const chartPoints = (snapshots ?? [])
    .filter((s) => (s.market ?? s.mid ?? s.low) != null)
    .map((s) => ({ date: s.date, value: (s.market ?? s.mid ?? s.low)! }))

  return (
    <div className="page">
      <button className="back-btn" onClick={onBack}>‹ Collection</button>
      <h1>{card.name} <span className="dim" style={{ fontSize: 15 }}>#{card.number}</span></h1>
      <p className="dim">{card.setName} · {card.rarity} · {card.variant}</p>

      <div className="row" style={{ marginTop: 12, alignItems: 'flex-start' }}>
        {photoUrls.length > 0 ? (
          photoUrls.map((p) => (
            <img key={p.side} src={p.url} alt={p.side} style={{ width: '48%', borderRadius: 12 }} />
          ))
        ) : (
          <img src={card.imageLarge ?? card.imageSmall} alt={card.name} style={{ width: '60%', borderRadius: 12 }} />
        )}
      </div>

      <h2>Value {card.currentValue != null && <span style={{ color: 'var(--green)' }}>· ${card.currentValue.toFixed(2)}</span>}</h2>
      <PriceChart points={chartPoints} />
      <p className="dim" style={{ marginTop: 4 }}>
        TCGplayer market price for a raw (ungraded) near-mint copy.
      </p>

      <h2>Grade estimate</h2>
      {g ? (
        <div className="grade-box">
          <div className="grade-big">{g.overallLow === g.overallHigh ? g.overallLow : `${g.overallLow}–${g.overallHigh}`}</div>
          <div className="grade-subs">
            {g.centering > 0 && (
              <div>Centering: <b>{g.centering}</b> (L/R {g.centeringRatioLR}, T/B {g.centeringRatioTB})</div>
            )}
            {g.corners > 0 && <div>Corners: <b>{g.corners}</b></div>}
            {g.notes.map((n, i) => (
              <div key={i}>{n}</div>
            ))}
          </div>
        </div>
      ) : (
        <p className="dim">No grade yet{photoUrls.some((p) => p.side === 'front') ? '' : ' — add a front photo to analyze'}.</p>
      )}
      {photos?.some((p) => p.side === 'front') && (
        <button className="btn btn-block" onClick={regrade} disabled={regrading}>
          {regrading ? 'Analyzing…' : g ? 'Re-analyze grade' : 'Analyze grade'}
        </button>
      )}

      <h2>Willing to sell?</h2>
      <div className="segmented">
        {(['keep', 'undecided', 'sell'] as const).map((s) => (
          <button key={s} className={card.sellStatus === s ? 'active' : ''} onClick={() => setStatus(s)}>
            {s === 'keep' ? 'Keep' : s === 'sell' ? 'Sell' : 'Undecided'}
          </button>
        ))}
      </div>

      <button className="btn btn-danger btn-block" style={{ marginTop: 24 }} onClick={remove}>
        Delete card
      </button>
    </div>
  )
}
