import { useEffect, useState } from 'react'
import { db, getSetting, setSetting } from '../db'
import { refreshPrices } from '../lib/priceRefresh'

export default function Settings() {
  const [apiKey, setApiKey] = useState('')
  const [saved, setSaved] = useState(false)
  const [lastRefresh, setLastRefresh] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null)
  const [storage, setStorage] = useState<string | null>(null)

  useEffect(() => {
    getSetting('apiKey').then((k) => setApiKey(k ?? ''))
    getSetting('lastPriceRefresh').then((t) =>
      setLastRefresh(t ? new Date(Number(t)).toLocaleString() : null),
    )
    navigator.storage?.estimate?.().then((e) => {
      if (e.usage != null) setStorage(`${(e.usage / 1024 / 1024).toFixed(1)} MB used`)
    })
  }, [])

  async function saveKey() {
    await setSetting('apiKey', apiKey.trim())
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  async function manualRefresh() {
    setRefreshMsg(null)
    setProgress({ done: 0, total: 1 })
    try {
      const res = await refreshPrices((done, total) => setProgress({ done, total }))
      setRefreshMsg(
        res.total === 0
          ? 'No cards to refresh yet.'
          : `Updated ${res.updated} of ${res.total} cards.`,
      )
      const t = await getSetting('lastPriceRefresh')
      if (t) setLastRefresh(new Date(Number(t)).toLocaleString())
    } catch (e) {
      setRefreshMsg(e instanceof Error ? e.message : 'Refresh failed')
    } finally {
      setProgress(null)
    }
  }

  async function wipe() {
    if (!confirm('Delete ALL cards, photos and price history? This cannot be undone.')) return
    if (!confirm('Really sure? Everything will be gone.')) return
    await Promise.all([db.cards.clear(), db.photos.clear(), db.priceSnapshots.clear()])
  }

  return (
    <div className="page">
      <h1>Settings</h1>

      <h2>pokemontcg.io API key</h2>
      <p className="dim">
        Free key from <b>dev.pokemontcg.io</b> — raises your limit to 20,000 requests/day.
        Search works without one, but a key is strongly recommended.
      </p>
      <label>API key</label>
      <input
        placeholder="Paste your API key"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        autoCapitalize="none"
        autoCorrect="off"
      />
      <button className="btn btn-primary btn-block" onClick={saveKey}>
        {saved ? 'Saved ✓' : 'Save key'}
      </button>

      <h2>Prices</h2>
      <p className="dim">
        Prices refresh automatically when you open the app (at most once a day).
        Last refresh: {lastRefresh ?? 'never'}
      </p>
      <button className="btn btn-block" onClick={manualRefresh} disabled={progress != null}>
        {progress ? `Refreshing… ${progress.done}/${progress.total}` : 'Refresh prices now'}
      </button>
      {progress && (
        <div className="progress-bar">
          <div style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
        </div>
      )}
      {refreshMsg && <p className="dim" style={{ marginTop: 8 }}>{refreshMsg}</p>}

      <h2>About</h2>
      <p className="dim">
        All data lives on this device (IndexedDB). {storage && <>Storage: {storage}. </>}
        Grade estimates cover centering and corners only and are not a substitute
        for professional grading. Values are TCGplayer market prices for raw cards
        via the free pokemontcg.io API.
      </p>

      <h2>Danger zone</h2>
      <button className="btn btn-danger btn-block" onClick={wipe}>
        Delete all data
      </button>
    </div>
  )
}
