import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type SellStatus } from '../db'

type SortKey = 'value' | 'name' | 'newest'

export default function Collection({ onOpenCard }: { onOpenCard: (id: number) => void }) {
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<SellStatus | 'all'>('all')
  const [setFilter, setSetFilter] = useState<string>('all')
  const [sort, setSort] = useState<SortKey>('newest')

  const cards = useLiveQuery(() => db.cards.toArray(), [])

  const sets = useMemo(() => {
    if (!cards) return []
    const m = new Map<string, string>()
    cards.forEach((c) => m.set(c.setId, c.setName))
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [cards])

  const filtered = useMemo(() => {
    if (!cards) return []
    const q = query.trim().toLowerCase()
    let list = cards.filter(
      (c) =>
        (statusFilter === 'all' || c.sellStatus === statusFilter) &&
        (setFilter === 'all' || c.setId === setFilter) &&
        (!q || c.name.toLowerCase().includes(q) || c.number.includes(q)),
    )
    if (sort === 'value') list = list.sort((a, b) => (b.currentValue ?? 0) - (a.currentValue ?? 0))
    else if (sort === 'name') list = list.sort((a, b) => a.name.localeCompare(b.name))
    else list = list.sort((a, b) => b.addedAt - a.addedAt)
    return list
  }, [cards, query, statusFilter, setFilter, sort])

  if (!cards) return null

  return (
    <div className="page">
      <h1>Collection <span className="dim" style={{ fontSize: 15 }}>({cards.length} cards)</span></h1>

      {cards.length === 0 ? (
        <div className="notice">
          Your collection is empty. Go to <b>Add Card</b> to photograph and catalog your first card.
          Don&apos;t forget to paste your free pokemontcg.io API key in <b>Settings</b> first.
        </div>
      ) : (
        <>
          <input placeholder="Search name or number…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <div className="filter-row">
            {(['all', 'keep', 'sell', 'undecided'] as const).map((s) => (
              <button
                key={s}
                className={`chip ${statusFilter === s ? 'active' : ''}`}
                onClick={() => setStatusFilter(s)}
              >
                {s === 'all' ? 'All' : s === 'keep' ? 'Keeping' : s === 'sell' ? 'For sale' : 'Undecided'}
              </button>
            ))}
          </div>
          <div className="row">
            <select value={setFilter} onChange={(e) => setSetFilter(e.target.value)}>
              <option value="all">All sets</option>
              {sets.map(([id, name]) => (
                <option key={id} value={id}>{name}</option>
              ))}
            </select>
            <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} style={{ width: 130, flexShrink: 0 }}>
              <option value="newest">Newest</option>
              <option value="value">Value ↓</option>
              <option value="name">Name</option>
            </select>
          </div>

          <div className="card-grid" style={{ marginTop: 12 }}>
            {filtered.map((c) => (
              <button key={c.id} className="card-tile" onClick={() => onOpenCard(c.id!)}>
                <img src={c.imageSmall} alt={c.name} loading="lazy" />
                <div className="meta">
                  <div className="name">{c.name}</div>
                  <div className="sub">{c.setName} · #{c.number}</div>
                  <div className="row" style={{ marginTop: 4 }}>
                    {c.currentValue != null && <span className="price">${c.currentValue.toFixed(2)}</span>}
                    <span className="spacer" />
                    <span className={`badge ${c.sellStatus}`}>{c.sellStatus}</span>
                  </div>
                </div>
              </button>
            ))}
          </div>
          {filtered.length === 0 && <p className="dim" style={{ marginTop: 16 }}>No cards match the current filters.</p>}
        </>
      )}
    </div>
  )
}
