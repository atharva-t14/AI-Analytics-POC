'use client'

import { useEffect, useState } from 'react'
import { listCharts } from '@/src/lib/api'
import { useAccountId } from '@/src/lib/useAccountId'
import { SavedChart } from '@/src/types/analytics'
import SavedChartTile from '@/src/components/SavedChartTile'

export default function SavedChartsPage() {
  const [accountId] = useAccountId()
  const [charts, setCharts] = useState<SavedChart[]>([])
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<'newest' | 'oldest' | 'title'>('newest')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    listCharts(accountId)
      .then(cs => {
        if (!cancelled) setCharts(cs)
      })
      .catch(e => {
        if (!cancelled) setError(e?.response?.data?.detail || 'Failed to load charts')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [accountId])

  const handleDeleted = (id: string) => {
    setCharts(prev => prev.filter(c => c.id !== id))
  }

  const filtered = charts.filter(c => {
    const q = search.trim().toLowerCase()
    if (!q) return true
    return (
      c.title.toLowerCase().includes(q) ||
      (c.description || '').toLowerCase().includes(q) ||
      (c.natural_language_query || '').toLowerCase().includes(q)
    )
  })

  const sorted = [...filtered].sort((a, b) => {
    if (sort === 'title') return a.title.localeCompare(b.title)
    if (sort === 'oldest') return a.created_at - b.created_at
    return b.created_at - a.created_at
  })

  return (
    <div className="h-full overflow-y-auto custom-scrollbar">
      <div className="max-w-6xl mx-auto px-6 py-10">
        <div className="mb-8">
          <h1 className="text-2xl font-bold tracking-tight">Saved Charts</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Charts you've saved from the chat or builder. Each tile re-runs its stored plan against the live database.
          </p>
          <div className="mt-4 flex flex-col sm:flex-row gap-2 sm:items-center">
            <input
              type="text"
              placeholder="Search by title, description, or query"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full sm:max-w-sm bg-background border border-border rounded-md px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
            />
            <select
              value={sort}
              onChange={e => setSort(e.target.value as 'newest' | 'oldest' | 'title')}
              className="bg-background border border-border rounded-md px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="title">Title A-Z</option>
            </select>
            <span className="text-xs text-muted-foreground">{sorted.length} shown</span>
          </div>
        </div>

        {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {error && <p className="text-sm text-destructive">{error}</p>}
        {!loading && !error && charts.length === 0 && (
          <div className="border border-dashed border-border rounded-2xl p-12 text-center">
            <p className="text-sm text-muted-foreground">
              No saved charts yet. Run a query in the chat or builder and click <span className="text-accent-strong">+ Save chart</span>.
            </p>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {sorted.map(c => (
            <SavedChartTile
              key={c.id}
              chart={c}
              accountId={accountId}
              onDeleted={handleDeleted}
              onDuplicated={duplicated => setCharts(prev => [duplicated, ...prev])}
              onUpdated={updated =>
                setCharts(prev => prev.map(x => (x.id === updated.id ? updated : x)))
              }
            />
          ))}
        </div>
      </div>
    </div>
  )
}
