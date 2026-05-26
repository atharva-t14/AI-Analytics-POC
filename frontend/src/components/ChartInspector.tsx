'use client'

import { useState } from 'react'
import { AnalyticsDSL, QueryLineage } from '../types/analytics'
import { showToast } from '../lib/toast'

interface Props {
  lineage?: QueryLineage | null
  dsl?: AnalyticsDSL | null
  sql?: string | null
  plannerSource?: string | null
  rowCount?: number | null
  accountId?: number
}

type Tab = 'lineage' | 'dsl' | 'sql'

/**
 * Collapsible inspector panel attached to a chart result.
 *
 * Shows three tabs:
 *  - Lineage: metric_id, base table, joined tables, dimensions, filters
 *  - DSL: the deterministic plan (JSON)
 *  - SQL: the generated query (read-only)
 */
export default function ChartInspector({ lineage, dsl, sql, plannerSource, rowCount, accountId }: Props) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('lineage')

  const plannerBadgeClass =
    plannerSource === 'llm'
      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
      : plannerSource === 'fallback'
        ? 'bg-amber-500/10 border-amber-500/30 text-amber-300'
        : 'bg-primary/10 border-primary/25 text-accent-strong'

  const handleCopyCurl = async () => {
    if (!dsl || !Number.isFinite(accountId)) return
    const payload = {
      dsl,
      account_id: accountId,
    }
    const command = [
      'curl -X POST "http://127.0.0.1:8000/execute"',
      '  -H "Content-Type: application/json"',
      `  -d '${JSON.stringify(payload)}'`,
    ].join(' \\\n')

    try {
      await navigator.clipboard.writeText(command)
      showToast({ type: 'success', title: 'Copied as cURL' })
    } catch {
      showToast({ type: 'error', title: 'Failed to copy cURL command' })
    }
  }

  if (!lineage && !dsl && !sql) return null

  return (
    <div className="mt-3 border border-border/60 rounded-xl bg-secondary/40 overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-2 text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors"
      >
        <span className="flex items-center gap-2 flex-wrap">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-primary" />
          Inspector
          {plannerSource && (
            <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${plannerBadgeClass}`}>
              {plannerSource}
            </span>
          )}
          {typeof rowCount === 'number' && (
            <span className="text-[10px] text-muted-foreground">{rowCount} rows</span>
          )}
          {dsl && Number.isFinite(accountId) && (
            <button
              type="button"
              onClick={e => {
                e.stopPropagation()
                void handleCopyCurl()
              }}
              className="text-[10px] px-1.5 py-0.5 rounded border border-border hover:border-primary/40 text-muted-foreground hover:text-foreground transition-colors"
              title="Copy request as cURL"
            >
              Copy as cURL
            </button>
          )}
        </span>
        <span className="text-[10px]">{open ? 'Hide' : 'Show'}</span>
      </button>

      {open && (
        <div className="border-t border-border/60">
          <div className="flex gap-1 px-3 pt-2">
            {(['lineage', 'dsl', 'sql'] as Tab[]).map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`text-[11px] uppercase tracking-wider px-2 py-1 rounded-md transition-colors ${
                  tab === t
                    ? 'bg-primary/15 text-accent-strong'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          <div className="p-4 text-xs">
            {tab === 'lineage' && lineage && (
              <dl className="grid grid-cols-[120px_1fr] gap-y-2 gap-x-3">
                <dt className="text-muted-foreground">Metric</dt>
                <dd className="font-mono text-foreground">{lineage.metric_id ?? '—'}</dd>

                <dt className="text-muted-foreground">Intent</dt>
                <dd className="font-mono text-foreground">{lineage.intent_family}</dd>

                <dt className="text-muted-foreground">Base table</dt>
                <dd className="font-mono text-foreground">{lineage.base_table ?? '—'}</dd>

                <dt className="text-muted-foreground">Joined tables</dt>
                <dd className="font-mono text-foreground">
                  {lineage.joined_tables.length ? lineage.joined_tables.join(', ') : '—'}
                </dd>

                <dt className="text-muted-foreground">Dimensions</dt>
                <dd className="font-mono text-foreground">
                  {lineage.dimensions.length ? lineage.dimensions.join(', ') : '—'}
                </dd>

                <dt className="text-muted-foreground">Filters</dt>
                <dd className="font-mono text-foreground">
                  {lineage.filters.length
                    ? lineage.filters.map((f, i) => (
                        <div key={i}>
                          {f.field} {f.operator} {JSON.stringify(f.value)}
                        </div>
                      ))
                    : '—'}
                </dd>
              </dl>
            )}

            {tab === 'dsl' && (
              <pre className="overflow-x-auto bg-background/60 rounded-md p-3 text-[11px] leading-relaxed text-foreground/90 max-h-80">
{JSON.stringify(dsl ?? {}, null, 2)}
              </pre>
            )}

            {tab === 'sql' && (
              <pre className="overflow-x-auto bg-background/60 rounded-md p-3 text-[11px] leading-relaxed text-foreground/90 max-h-80 whitespace-pre-wrap">
{sql ?? ''}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
