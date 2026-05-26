'use client'

import { useEffect, useRef, useState } from 'react'
import { Check, Copy, Pencil, X } from 'lucide-react'
import { deleteChart, runChart, saveChart, updateChart } from '../lib/api'
import { showToast } from '../lib/toast'
import { ExecuteResponse, SavedChart } from '../types/analytics'
import ChartRenderer from './ChartRenderer'
import ChartInspector from './ChartInspector'
import ChartDownloads from './ChartDownloads'

interface Props {
  chart: SavedChart
  accountId: number
  onDeleted?: (id: string) => void
  onUpdated?: (chart: SavedChart) => void
  onDuplicated?: (chart: SavedChart) => void
}

/**
 * Self-contained tile that re-runs a saved chart's stored DSL on mount and
 * renders it with the same ChartRenderer used in chat. Used on /charts and
 * /dashboard.
 */
export default function SavedChartTile({ chart, accountId, onDeleted, onUpdated, onDuplicated }: Props) {
  const [result, setResult] = useState<ExecuteResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [titleDraft, setTitleDraft] = useState(chart.title)
  const [savingTitle, setSavingTitle] = useState(false)
  const [duplicating, setDuplicating] = useState(false)
  const [lastRunAt, setLastRunAt] = useState<number | null>(null)
  const [sqlDiff, setSqlDiff] = useState<string | null>(null)
  const chartRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    runChart(chart.id, accountId)
      .then(res => {
        if (!cancelled) {
          setResult(res)
          setLastRunAt(Date.now())

          const key = `analytics_prev_sql_${accountId}_${chart.id}`
          const previous = localStorage.getItem(key)
          if (previous && previous !== res.sql) {
            const before = previous.split('\n').slice(0, 4).join('\n')
            const after = res.sql.split('\n').slice(0, 4).join('\n')
            setSqlDiff(`- ${before}\n+ ${after}`)
          } else {
            setSqlDiff(null)
          }
          localStorage.setItem(key, res.sql)
        }
      })
      .catch(e => {
        if (!cancelled) {
          setError(e?.response?.data?.detail || 'Failed to run chart')
          showToast({ type: 'error', title: 'Chart run failed', detail: chart.title })
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [chart.id, accountId])

  const handleDelete = async () => {
    if (!confirm(`Delete "${chart.title}"?`)) return
    setDeleting(true)
    try {
      await deleteChart(chart.id, accountId)
      onDeleted?.(chart.id)
      showToast({ type: 'success', title: 'Chart deleted', detail: chart.title })
    } catch {
      setDeleting(false)
      showToast({ type: 'error', title: 'Delete failed', detail: chart.title })
    }
  }

  const handleDuplicate = async () => {
    setDuplicating(true)
    try {
      const duplicated = await saveChart({
        account_id: accountId,
        title: `${chart.title} (copy)`,
        description: chart.description ?? null,
        natural_language_query: chart.natural_language_query ?? null,
        dsl: chart.dsl,
        visualization_type: chart.visualization_type ?? null,
        viz_config: chart.viz_config ?? null,
        lineage: chart.lineage ?? null,
      })
      onDuplicated?.(duplicated)
      showToast({ type: 'success', title: 'Chart duplicated', detail: duplicated.title })
      localStorage.setItem(
        'analytics_builder_seed',
        JSON.stringify({
          metricId: duplicated.dsl.metrics?.[0] || '',
          dimensions: duplicated.dsl.dimensions || [],
          filters: duplicated.dsl.filters || [],
          vizType: duplicated.visualization_type || duplicated.dsl.visualization_plan?.type || 'bar',
          intentFamily: duplicated.dsl.intent_family || 'ranking',
        }),
      )
      window.location.href = '/builder'
    } catch {
      showToast({ type: 'error', title: 'Duplicate failed', detail: chart.title })
    } finally {
      setDuplicating(false)
    }
  }

  const handleRename = async () => {
    const next = titleDraft.trim()
    if (!next || next === chart.title) {
      setRenaming(false)
      setTitleDraft(chart.title)
      return
    }
    setSavingTitle(true)
    try {
      const updated = await updateChart(chart.id, accountId, { title: next })
      onUpdated?.(updated)
      setRenaming(false)
      showToast({ type: 'success', title: 'Title updated', detail: next })
    } catch {
      // Leave the editor open so the user can retry.
      showToast({ type: 'error', title: 'Rename failed', detail: chart.title })
    } finally {
      setSavingTitle(false)
    }
  }

  const vizType = result?.visualization_type || chart.visualization_type || 'bar'

  return (
    <div className="group bg-secondary/40 border border-border rounded-2xl p-5 flex flex-col gap-3 min-h-[380px]">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          {renaming ? (
            <div className="flex items-center gap-1">
              <input
                autoFocus
                type="text"
                value={titleDraft}
                disabled={savingTitle}
                onChange={e => setTitleDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') void handleRename()
                  if (e.key === 'Escape') {
                    setRenaming(false)
                    setTitleDraft(chart.title)
                  }
                }}
                className="flex-1 bg-background border border-border rounded px-2 py-1 text-sm font-semibold outline-none focus:ring-1 focus:ring-indigo-500"
              />
              <button
                onClick={handleRename}
                disabled={savingTitle}
                className="text-[11px] text-accent-strong hover:opacity-85 px-1"
                title="Save"
              >
                {savingTitle ? '...' : <Check size={14} />}
              </button>
              <button
                onClick={() => {
                  setRenaming(false)
                  setTitleDraft(chart.title)
                }}
                className="text-[11px] text-muted-foreground hover:text-foreground px-1"
                title="Cancel"
              >
                <X size={14} />
              </button>
            </div>
          ) : (
            <h3
              className="font-semibold text-sm text-foreground truncate cursor-text hover:text-accent-strong transition-colors"
              onDoubleClick={() => setRenaming(true)}
              title="Double-click to rename"
            >
              {chart.title}
            </h3>
          )}
          {chart.description && !renaming && (
            <p className="text-xs text-muted-foreground mt-0.5">{chart.description}</p>
          )}
          <div className="mt-1.5 opacity-0 group-hover:opacity-100 transition-opacity text-[10px] text-muted-foreground">
            Last run: {lastRunAt ? new Date(lastRunAt).toLocaleString() : 'Not yet'}
            {' · '}
            Rows: {result?.row_count ?? 0}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {!renaming && (
            <button
              onClick={handleDuplicate}
              disabled={duplicating}
              className="text-[11px] text-muted-foreground hover:text-accent-strong transition-colors px-2 py-1"
              title="Duplicate chart"
            >
              {duplicating ? '...' : <Copy size={14} />}
            </button>
          )}
          {!renaming && (
            <button
              onClick={() => {
                setTitleDraft(chart.title)
                setRenaming(true)
              }}
              className="text-[11px] text-muted-foreground hover:text-accent-strong transition-colors px-2 py-1"
              title="Rename chart"
            >
              <Pencil size={14} />
            </button>
          )}
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="text-[11px] text-muted-foreground hover:text-destructive transition-colors px-2 py-1"
            title="Delete chart"
          >
            {deleting ? '...' : <X size={14} />}
          </button>
        </div>
      </div>

      <div ref={chartRef} className="flex-1 bg-chart-surface rounded-xl p-3 border border-border/60 min-h-[260px] flex items-center justify-center">
        {loading && (
          <div className="text-xs text-muted-foreground animate-pulse">Running query…</div>
        )}
        {error && (
          <div className="text-xs text-destructive">{error}</div>
        )}
        {!loading && !error && result && (
          <div className="w-full">
            <ChartRenderer
              type={vizType}
              data={result.rows}
              config={{ xLabel: result.dsl.dimensions?.[0] || 'Category', yLabel: 'Value' }}
            />
          </div>
        )}
      </div>

      {result && !loading && !error && (
        <div className="flex items-center justify-end">
          <ChartDownloads
            rows={result.rows as Record<string, unknown>[]}
            chartRef={chartRef}
            filename={chart.title}
            metricName={result.lineage?.metric_id || chart.title}
            dsl={result.dsl}
          />
        </div>
      )}

      {sqlDiff && (
        <div className="rounded-md border border-amber-500/25 bg-amber-500/10 p-2">
          <p className="text-[10px] uppercase tracking-wider text-amber-300 font-semibold">SQL changed since last run</p>
          <pre className="mt-1 text-[10px] text-amber-100/90 whitespace-pre-wrap overflow-x-auto">{sqlDiff}</pre>
        </div>
      )}

      {result && (
        <ChartInspector
          lineage={result.lineage}
          dsl={result.dsl}
          sql={result.sql}
          rowCount={result.row_count}
          accountId={accountId}
        />
      )}
    </div>
  )
}
