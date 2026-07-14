import { useMemo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import PriceChart from '../components/PriceChart'

export default function Stats({ onOpenCard }: { onOpenCard: (id: number) => void }) {
  const cards = useLiveQuery(() => db.cards.toArray(), [])
  const snapshots = useLiveQuery(() => db.priceSnapshots.toArray(), [])

  const stats = useMemo(() => {
    if (!cards) return null
    const total = cards.reduce((s, c) => s + (c.currentValue ?? 0), 0)
    const pile = (status: string) =>
      cards.filter((c) => c.sellStatus === status).reduce((s, c) => s + (c.currentValue ?? 0), 0)
    const top = [...cards]
      .filter((c) => c.currentValue != null)
      .sort((a, b) => b.currentValue! - a.currentValue!)
      .slice(0, 10)
    return {
      total,
      keep: pile('keep'),
      sell: pile('sell'),
      keepCount: cards.filter((c) => c.sellStatus === 'keep').length,
      sellCount: cards.filter((c) => c.sellStatus === 'sell').length,
      top,
    }
  }, [cards])

  // Collection value over time: sum of each day's snapshots, only for days
  // where a full refresh covered most of the collection.
  const history = useMemo(() => {
    if (!snapshots || !cards || cards.length === 0) return []
    const byDate = new Map<string, { sum: number; count: number }>()
    for (const s of snapshots) {
      const v = s.market ?? s.mid ?? s.low
      if (v == null) continue
      const e = byDate.get(s.date) ?? { sum: 0, count: 0 }
      e.sum += v
      e.count++
      byDate.set(s.date, e)
    }
    return [...byDate.entries()]
      .filter(([, e]) => e.count >= cards.length * 0.5)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, e]) => ({ date, value: e.sum }))
  }, [snapshots, cards])

  if (!cards || !stats) return null

  return (
    <div className="page">
      <h1>Stats</h1>

      <div className="stat-row">
        <div className="stat-tile" style={{ gridColumn: '1 / -1' }}>
          <div className="label">Total collection value (raw)</div>
          <div className="value" style={{ color: 'var(--green)', fontSize: 30 }}>
            ${stats.total.toFixed(2)}
          </div>
          <div className="label">{cards.length} cards</div>
        </div>
        <div className="stat-tile">
          <div className="label">Keep pile ({stats.keepCount})</div>
          <div className="value">${stats.keep.toFixed(2)}</div>
        </div>
        <div className="stat-tile">
          <div className="label">For sale ({stats.sellCount})</div>
          <div className="value" style={{ color: 'var(--green)' }}>${stats.sell.toFixed(2)}</div>
        </div>
      </div>

      <h2>Collection value over time</h2>
      <PriceChart points={history} />

      <h2>Most valuable</h2>
      {stats.top.map((c, i) => (
        <button key={c.id} className="list-row" onClick={() => onOpenCard(c.id!)}>
          <span className="dim" style={{ width: 18 }}>{i + 1}</span>
          <img src={c.imageSmall} alt="" loading="lazy" />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600 }}>{c.name}</div>
            <div className="dim">{c.setName}</div>
          </div>
          <b style={{ color: 'var(--green)' }}>${c.currentValue!.toFixed(2)}</b>
        </button>
      ))}
      {stats.top.length === 0 && <p className="dim">Add cards to see your top 10.</p>}
    </div>
  )
}
