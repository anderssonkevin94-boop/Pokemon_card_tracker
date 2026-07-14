// Minimal SVG line chart for price history.
export interface ChartPoint {
  date: string
  value: number
}

export default function PriceChart({ points, height = 140 }: { points: ChartPoint[]; height?: number }) {
  if (points.length === 0) {
    return <p className="dim">No price history yet — values are snapshotted on each daily refresh.</p>
  }
  const W = 600
  const H = height
  const PAD = { top: 10, right: 8, bottom: 20, left: 44 }
  const values = points.map((p) => p.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || max * 0.1 || 1
  const lo = Math.max(0, min - span * 0.15)
  const hi = max + span * 0.15

  const x = (i: number) =>
    PAD.left + (points.length === 1 ? (W - PAD.left - PAD.right) / 2 : (i / (points.length - 1)) * (W - PAD.left - PAD.right))
  const y = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * (H - PAD.top - PAD.bottom)

  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ')
  const area = `${path} L${x(points.length - 1).toFixed(1)},${H - PAD.bottom} L${x(0).toFixed(1)},${H - PAD.bottom} Z`
  const fmt = (v: number) => (v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`)
  const last = points[points.length - 1]
  const first = points[0]

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', display: 'block' }}>
      {[lo, (lo + hi) / 2, hi].map((v) => (
        <g key={v}>
          <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeDasharray="3 4" />
          <text x={PAD.left - 6} y={y(v) + 4} textAnchor="end" fontSize="11" fill="var(--text-dim)">
            {fmt(v)}
          </text>
        </g>
      ))}
      <path d={area} fill="var(--accent)" opacity="0.12" />
      <path d={path} fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinejoin="round" />
      <circle cx={x(points.length - 1)} cy={y(last.value)} r="4" fill="var(--accent)" />
      <text x={PAD.left} y={H - 5} fontSize="11" fill="var(--text-dim)">{first.date}</text>
      <text x={W - PAD.right} y={H - 5} textAnchor="end" fontSize="11" fill="var(--text-dim)">{last.date}</text>
    </svg>
  )
}
