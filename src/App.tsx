import { useEffect, useState } from 'react'
import Collection from './pages/Collection'
import CardDetail from './pages/CardDetail'
import AddCard from './pages/AddCard'
import Stats from './pages/Stats'
import Settings from './pages/Settings'
import { isRefreshDue, refreshPrices } from './lib/priceRefresh'

type Tab = 'collection' | 'add' | 'stats' | 'settings'

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'collection', label: 'Collection', icon: '🗂️' },
  { id: 'add', label: 'Add Card', icon: '📷' },
  { id: 'stats', label: 'Stats', icon: '📈' },
  { id: 'settings', label: 'Settings', icon: '⚙️' },
]

export default function App() {
  const [tab, setTab] = useState<Tab>('collection')
  const [openCardId, setOpenCardId] = useState<number | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  // Daily price refresh on open (iOS PWAs have no background refresh).
  useEffect(() => {
    let cancelled = false
    isRefreshDue().then(async (due) => {
      if (!due || cancelled) return
      setRefreshing(true)
      try {
        await refreshPrices()
      } catch {
        // offline or rate-limited — try again next open
      } finally {
        if (!cancelled) setRefreshing(false)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  function openCard(id: number) {
    setOpenCardId(id)
    setTab('collection')
  }

  return (
    <div className="app">
      {refreshing && (
        <div style={{ background: 'var(--bg-raised)', textAlign: 'center', padding: 6, fontSize: 12, color: 'var(--text-dim)' }}>
          Updating prices…
        </div>
      )}

      {tab === 'collection' &&
        (openCardId != null ? (
          <CardDetail cardId={openCardId} onBack={() => setOpenCardId(null)} />
        ) : (
          <Collection onOpenCard={openCard} />
        ))}
      {tab === 'add' && <AddCard onSaved={openCard} />}
      {tab === 'stats' && <Stats onOpenCard={openCard} />}
      {tab === 'settings' && <Settings />}

      <nav className="tabbar">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? 'active' : ''}
            onClick={() => {
              setTab(t.id)
              if (t.id === 'collection') setOpenCardId(null)
            }}
          >
            <span className="icon">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  )
}
