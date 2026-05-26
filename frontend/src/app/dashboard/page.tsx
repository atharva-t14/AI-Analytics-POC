'use client'

import { useEffect, useMemo, useState } from 'react'
import { ChartNoAxesCombined, Gauge, LayoutDashboard, Sparkles } from 'lucide-react'
import {
  createDashboard,
  deleteDashboard,
  listCharts,
  listDashboards,
  updateDashboard,
} from '@/src/lib/api'
import { useAccountId } from '@/src/lib/useAccountId'
import { Dashboard, SavedChart } from '@/src/types/analytics'
import SavedChartTile from '@/src/components/SavedChartTile'

const ALL_CHARTS_ID = '__all__'

/**
 * Multi-dashboard manager.
 *
 * - Sidebar lists every dashboard for the current account + a built-in
 *   "All charts" pseudo-dashboard.
 * - "New dashboard" creates a named dashboard with chart_ids = [].
 * - Selected dashboard's tiles are shown in a 3-col grid.
 * - "Add charts" opens a picker of every SavedChart not already in the
 *   dashboard; click to add. Each tile has a "Remove" affordance to
 *   take it out (without deleting the chart itself).
 */
export default function DashboardPage() {
  const [accountId] = useAccountId()
  const [dashboards, setDashboards] = useState<Dashboard[]>([])
  const [charts, setCharts] = useState<SavedChart[]>([])
  const [selectedId, setSelectedId] = useState<string>(ALL_CHARTS_ID)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [renamingDashboard, setRenamingDashboard] = useState(false)
  const [renameDraft, setRenameDraft] = useState('')
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)

  // --- initial load ------------------------------------------------------
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.all([listDashboards(accountId), listCharts(accountId)])
      .then(([ds, cs]) => {
        if (cancelled) return
        setDashboards(ds)
        setCharts(cs)
      })
      .catch(e => {
        if (!cancelled) setError(e?.response?.data?.detail || 'Failed to load dashboards')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [accountId])

  const selected: Dashboard | null = useMemo(() => {
    if (selectedId === ALL_CHARTS_ID) return null
    return dashboards.find(d => d.id === selectedId) || null
  }, [selectedId, dashboards])

  const chartsById = useMemo(() => {
    const m = new Map<string, SavedChart>()
    for (const c of charts) m.set(c.id, c)
    return m
  }, [charts])

  const visibleCharts: SavedChart[] = useMemo(() => {
    if (selectedId === ALL_CHARTS_ID) return charts
    if (!selected) return []
    // Preserve dashboard order; skip ids that no longer exist (chart deleted).
    return selected.chart_ids
      .map(id => chartsById.get(id))
      .filter((c): c is SavedChart => !!c)
  }, [selectedId, selected, charts, chartsById])

  const addableCharts: SavedChart[] = useMemo(() => {
    if (!selected) return []
    const inSet = new Set(selected.chart_ids)
    return charts.filter(c => !inSet.has(c.id))
  }, [selected, charts])

  const latestVisibleChart = useMemo(() => {
    if (!visibleCharts.length) return null
    return [...visibleCharts].sort((a, b) => b.updated_at - a.updated_at)[0] || null
  }, [visibleCharts])

  const coverageRatio = useMemo(() => {
    if (!charts.length) return 0
    return Math.round((visibleCharts.length / charts.length) * 100)
  }, [visibleCharts.length, charts.length])

  const latestUpdatedLabel = useMemo(() => {
    if (!latestVisibleChart) return '—'
    const ts = latestVisibleChart.updated_at > 10_000_000_000
      ? latestVisibleChart.updated_at
      : latestVisibleChart.updated_at * 1000
    return new Date(ts).toLocaleDateString()
  }, [latestVisibleChart])

  // --- mutations ---------------------------------------------------------
  const handleCreate = async () => {
    const name = newName.trim()
    if (!name) return
    setBusy(true)
    try {
      const d = await createDashboard({
        account_id: accountId,
        name,
        description: null,
        chart_ids: [],
      })
      setDashboards(prev => [...prev, d])
      setSelectedId(d.id)
      setNewName('')
      setCreating(false)
    } catch (e: any) {
      setError(e?.response?.data?.detail || 'Failed to create dashboard')
    } finally {
      setBusy(false)
    }
  }

  const handleDeleteDashboard = async () => {
    if (!selected) return
    if (!confirm(`Delete dashboard "${selected.name}"? Saved charts are not affected.`)) return
    setBusy(true)
    try {
      await deleteDashboard(selected.id, accountId)
      setDashboards(prev => prev.filter(d => d.id !== selected.id))
      setSelectedId(ALL_CHARTS_ID)
    } catch (e: any) {
      setError(e?.response?.data?.detail || 'Failed to delete dashboard')
    } finally {
      setBusy(false)
    }
  }

  const handleRenameDashboard = async () => {
    if (!selected) return
    const next = renameDraft.trim()
    if (!next || next === selected.name) {
      setRenamingDashboard(false)
      return
    }
    setBusy(true)
    try {
      const updated = await updateDashboard(selected.id, accountId, { name: next })
      setDashboards(prev => prev.map(d => (d.id === updated.id ? updated : d)))
      setRenamingDashboard(false)
    } catch (e: any) {
      setError(e?.response?.data?.detail || 'Failed to rename dashboard')
    } finally {
      setBusy(false)
    }
  }

  const persistChartIds = async (next: string[]) => {
    if (!selected) return
    const prev = selected.chart_ids
    // Optimistic update
    setDashboards(ds =>
      ds.map(d => (d.id === selected.id ? { ...d, chart_ids: next } : d)),
    )
    try {
      const updated = await updateDashboard(selected.id, accountId, { chart_ids: next })
      setDashboards(ds => ds.map(d => (d.id === updated.id ? updated : d)))
    } catch (e: any) {
      // Rollback
      setDashboards(ds =>
        ds.map(d => (d.id === selected.id ? { ...d, chart_ids: prev } : d)),
      )
      setError(e?.response?.data?.detail || 'Failed to update dashboard')
    }
  }

  const handleAddChart = (chartId: string) => {
    if (!selected) return
    if (selected.chart_ids.includes(chartId)) return
    void persistChartIds([...selected.chart_ids, chartId])
  }

  const handleRemoveChart = (chartId: string) => {
    if (!selected) return
    void persistChartIds(selected.chart_ids.filter(id => id !== chartId))
  }

  const reorderChart = (fromId: string, toId: string) => {
    if (!selected || fromId === toId) return
    const ids = [...selected.chart_ids]
    const fromIndex = ids.indexOf(fromId)
    const toIndex = ids.indexOf(toId)
    if (fromIndex < 0 || toIndex < 0) return
    ids.splice(fromIndex, 1)
    ids.splice(toIndex, 0, fromId)
    void persistChartIds(ids)
  }

  return (
    <div className="h-full overflow-hidden">
      <div className="h-full max-w-[1400px] mx-auto px-6 py-6 grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-6">
        {/* --- Sidebar: dashboard list ----------------------------------- */}
        <aside className="bg-secondary/40 border border-border rounded-2xl p-4 flex flex-col gap-3 overflow-y-auto custom-scrollbar">
          <div className="flex items-center justify-between">
            <h2 className="text-xs uppercase tracking-wider text-muted-foreground font-bold">
              Dashboards
            </h2>
            <button
              onClick={() => setCreating(v => !v)}
              className="text-xs text-accent-strong hover:opacity-85"
              title="New dashboard"
            >
              + New
            </button>
          </div>

          {creating && (
            <div className="bg-background border border-border rounded-md p-2 space-y-2">
              <input
                autoFocus
                type="text"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') void handleCreate()
                  if (e.key === 'Escape') {
                    setCreating(false)
                    setNewName('')
                  }
                }}
                placeholder="Dashboard name"
                className="w-full bg-background border border-border rounded px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-indigo-500"
              />
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={() => {
                    setCreating(false)
                    setNewName('')
                  }}
                  className="text-[11px] text-muted-foreground hover:text-foreground"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreate}
                  disabled={busy || !newName.trim()}
                  className="text-[11px] bg-indigo-500 hover:bg-indigo-600 disabled:opacity-50 text-white px-2 py-1 rounded"
                >
                  Create
                </button>
              </div>
            </div>
          )}

          <SidebarItem
            label="All charts"
            count={charts.length}
            active={selectedId === ALL_CHARTS_ID}
            onClick={() => setSelectedId(ALL_CHARTS_ID)}
            subtle
          />

          {dashboards.length === 0 ? (
            <p className="text-[11px] text-muted-foreground px-2 py-1">
              No dashboards yet. Click <span className="text-accent-strong">+ New</span> to create one.
            </p>
          ) : (
            dashboards.map(d => (
              <SidebarItem
                key={d.id}
                label={d.name}
                count={d.chart_ids.length}
                active={selectedId === d.id}
                onClick={() => setSelectedId(d.id)}
              />
            ))
          )}
        </aside>

        {/* --- Main panel ----------------------------------------------- */}
        <main className="overflow-y-auto custom-scrollbar pr-1">
          <div className="mb-6 flex items-end justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              {selected && renamingDashboard ? (
                <div className="flex items-center gap-2">
                  <input
                    autoFocus
                    type="text"
                    value={renameDraft}
                    disabled={busy}
                    onChange={e => setRenameDraft(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') void handleRenameDashboard()
                      if (e.key === 'Escape') setRenamingDashboard(false)
                    }}
                    className="bg-background border border-border rounded px-2 py-1 text-xl font-bold tracking-tight outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                  <button
                    onClick={handleRenameDashboard}
                    disabled={busy || !renameDraft.trim()}
                    className="text-xs bg-indigo-500 hover:bg-indigo-600 disabled:opacity-50 text-white px-3 py-1.5 rounded"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => setRenamingDashboard(false)}
                    className="text-xs text-muted-foreground hover:text-foreground px-1"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <h1
                  className={`text-2xl font-bold tracking-tight ${selected ? 'cursor-text hover:text-accent-strong transition-colors' : ''}`}
                  onDoubleClick={() => {
                    if (!selected) return
                    setRenameDraft(selected.name)
                    setRenamingDashboard(true)
                  }}
                  title={selected ? 'Double-click to rename' : undefined}
                >
                  {selected ? selected.name : 'All charts'}
                </h1>
              )}
              <p className="text-sm text-muted-foreground mt-1">
                {selected
                  ? `${selected.chart_ids.length} chart${selected.chart_ids.length === 1 ? '' : 's'} in this dashboard`
                  : `Every saved chart for account ${accountId}`}
              </p>
            </div>
            {selected && (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPicking(v => !v)}
                  className="text-sm bg-indigo-500 hover:bg-indigo-600 text-white px-3 py-1.5 rounded-md"
                >
                  {picking ? 'Done' : '+ Add charts'}
                </button>
                {!renamingDashboard && (
                  <button
                    onClick={() => {
                      setRenameDraft(selected.name)
                      setRenamingDashboard(true)
                    }}
                    className="text-xs text-muted-foreground hover:text-accent-strong px-2 py-1"
                    title="Rename dashboard"
                  >
                    Rename
                  </button>
                )}
                <button
                  onClick={handleDeleteDashboard}
                  disabled={busy}
                  className="text-xs text-muted-foreground hover:text-destructive px-2 py-1"
                  title="Delete this dashboard"
                >
                  Delete dashboard
                </button>
              </div>
            )}
          </div>

          {!loading && !error && (
            <div className="mb-6 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
              <KpiCard
                title="Visible charts"
                value={String(visibleCharts.length)}
                subtitle={selected ? 'In selected dashboard' : 'Across all dashboards'}
                icon={<ChartNoAxesCombined size={14} />}
              />
              <KpiCard
                title="Coverage"
                value={`${coverageRatio}%`}
                subtitle={selected ? 'Of saved chart library shown' : 'Library coverage'}
                icon={<Gauge size={14} />}
              />
              <KpiCard
                title="Dashboards"
                value={String(dashboards.length)}
                subtitle="Custom dashboard collections"
                icon={<LayoutDashboard size={14} />}
              />
              <KpiCard
                title="Latest chart update"
                value={latestUpdatedLabel}
                subtitle={latestVisibleChart?.title || 'No visible charts yet'}
                icon={<Sparkles size={14} />}
              />
            </div>
          )}

          {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {error && <p className="text-sm text-destructive mb-3">{error}</p>}

          {/* Chart picker for the selected dashboard */}
          {selected && picking && (
            <div className="mb-6 bg-secondary/40 border border-border rounded-2xl p-4">
              <h3 className="text-xs uppercase tracking-wider text-muted-foreground font-bold mb-3">
                Add saved charts
              </h3>
              {addableCharts.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No more charts to add. Save a chart from the chat or builder to grow your library.
                </p>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                  {addableCharts.map(c => (
                    <button
                      key={c.id}
                      onClick={() => handleAddChart(c.id)}
                      className="text-left bg-background border border-border hover:border-indigo-500/50 rounded-md p-3 transition-colors"
                    >
                      <div className="text-sm font-medium text-foreground truncate">{c.title}</div>
                      {c.description && (
                        <div className="text-[11px] text-muted-foreground mt-0.5 truncate">
                          {c.description}
                        </div>
                      )}
                      <div className="text-[10px] text-accent-strong mt-1">+ Add to dashboard</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Empty state */}
          {!loading && !error && visibleCharts.length === 0 && (
            <div className="border border-dashed border-border rounded-2xl p-12 text-center">
              <p className="text-sm text-muted-foreground">
                {selected
                  ? 'This dashboard is empty. Click "+ Add charts" to add saved charts.'
                  : 'You have no saved charts yet. Save one from the chat or builder.'}
              </p>
            </div>
          )}

          {!loading && !error && selected && visibleCharts.length > 1 && (
            <p className="text-[11px] text-muted-foreground mb-3">
              Drag and drop chart cards to rearrange this dashboard.
            </p>
          )}

          {/* Chart grid */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {visibleCharts.map(c => (
              <div
                key={c.id}
                className={`relative group ${selected ? 'cursor-grab active:cursor-grabbing' : ''}`}
                draggable={!!selected}
                onDragStart={() => {
                  if (!selected) return
                  setDraggingId(c.id)
                }}
                onDragOver={e => {
                  if (!selected || !draggingId || draggingId === c.id) return
                  e.preventDefault()
                  setDropTargetId(c.id)
                }}
                onDragLeave={() => {
                  if (dropTargetId === c.id) setDropTargetId(null)
                }}
                onDrop={e => {
                  e.preventDefault()
                  if (!selected || !draggingId) return
                  reorderChart(draggingId, c.id)
                  setDraggingId(null)
                  setDropTargetId(null)
                }}
                onDragEnd={() => {
                  setDraggingId(null)
                  setDropTargetId(null)
                }}
              >
                {selected && dropTargetId === c.id && draggingId !== c.id && (
                  <div className="absolute inset-0 z-20 rounded-2xl border-2 border-dashed border-indigo-400/70 bg-indigo-500/10 pointer-events-none" />
                )}
                {selected && (
                  <button
                    onClick={() => handleRemoveChart(c.id)}
                    className="absolute top-3 right-12 z-10 text-[11px] text-muted-foreground hover:text-foreground bg-background/70 border border-border rounded px-2 py-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                    title="Remove from this dashboard"
                  >
                    Remove
                  </button>
                )}
                <SavedChartTile
                  chart={c}
                  accountId={accountId}
                  onDeleted={id => setCharts(prev => prev.filter(x => x.id !== id))}
                  onUpdated={updated =>
                    setCharts(prev => prev.map(x => (x.id === updated.id ? updated : x)))
                  }
                />
              </div>
            ))}
          </div>
        </main>
      </div>
    </div>
  )
}

function SidebarItem({
  label,
  count,
  active,
  onClick,
  subtle,
}: {
  label: string
  count: number
  active: boolean
  onClick: () => void
  subtle?: boolean
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md text-sm transition-colors ${
        active
          ? 'bg-primary/15 text-foreground border border-primary/40'
          : `border border-transparent hover:bg-background ${subtle ? 'text-muted-foreground' : 'text-foreground'}`
      }`}
    >
      <span className="truncate">{label}</span>
      <span className={`text-[10px] ${active ? 'text-accent-strong' : 'text-muted-foreground'}`}>
        {count}
      </span>
    </button>
  )
}

function KpiCard({
  title,
  value,
  subtitle,
  icon,
}: {
  title: string
  value: string
  subtitle: string
  icon: React.ReactNode
}) {
  return (
    <div className="rounded-xl border border-border bg-secondary/40 p-3 ring-hairline">
      <div className="flex items-center justify-between">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{title}</p>
        <span className="text-accent-strong">{icon}</span>
      </div>
      <p className="mt-2 text-2xl font-semibold tracking-tight">{value}</p>
      <p className="mt-1 text-[11px] text-muted-foreground truncate" title={subtitle}>{subtitle}</p>
    </div>
  )
}
