'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { CircleHelp, Sparkles, X } from 'lucide-react'
import { executeDsl, getMetrics } from '@/src/lib/api'
import { useAccountId } from '@/src/lib/useAccountId'
import {
  AnalyticsDSL,
  ExecuteResponse,
  FilterClause,
  MetricSummary,
} from '@/src/types/analytics'
import ChartRenderer from '@/src/components/ChartRenderer'
import ChartInspector from '@/src/components/ChartInspector'
import SaveChartButton from '@/src/components/SaveChartButton'
import ChartDownloads from '@/src/components/ChartDownloads'

const VIZ_TYPES = [
  { id: 'bar', label: 'Compare categories', bestFor: 'Rankings, recruiter comparisons, stage counts' },
  { id: 'line', label: 'Trend over time', bestFor: 'Monthly or daily movement' },
  { id: 'funnel', label: 'Pipeline flow', bestFor: 'Stage progression and dropoff shape' },
  { id: 'pie', label: 'Share of total', bestFor: 'A small number of categories' },
  { id: 'donut', label: 'Share ring', bestFor: 'Compact share of total' },
  { id: 'stacked_bar', label: 'Stacked comparison', bestFor: 'Multiple values per category' },
  { id: 'table', label: 'Detailed table', bestFor: 'Lists and record-level inspection' },
]

const OPERATORS = [
  { id: 'eq', label: 'is' },
  { id: 'neq', label: 'is not' },
  { id: 'gt', label: 'greater than' },
  { id: 'lt', label: 'less than' },
  { id: 'gte', label: 'at least' },
  { id: 'lte', label: 'at most' },
  { id: 'contains', label: 'contains' },
  { id: 'like', label: 'matches text' },
]

const DIMENSION_COPY: Record<string, { label: string; description: string; useWhen: string }> = {
  label: {
    label: 'Pipeline stage / status',
    description: 'Groups the metric by the status label, such as Submitted, Interview, Rejected, or Placed.',
    useWhen: 'Use for funnel, bottleneck, and stage breakdown questions.',
  },
  firstname: {
    label: 'Recruiter',
    description: 'Groups the metric by the user who created or owns the recruiting action, depending on the metric.',
    useWhen: 'Use for leaderboards and productivity comparisons.',
  },
  month: {
    label: 'Month',
    description: 'Groups records into calendar months using the metric timestamp.',
    useWhen: 'Use for trends and performance over time.',
  },
  city: {
    label: 'City',
    description: 'Groups job-based metrics by job city.',
    useWhen: 'Use for location comparisons.',
  },
  country: {
    label: 'Country',
    description: 'Groups job-based metrics by job country.',
    useWhen: 'Use for regional comparisons.',
  },
  job_type: {
    label: 'Job type',
    description: 'Groups job-based metrics by job type.',
    useWhen: 'Use for comparing full-time, contract, or similar job groups.',
  },
}

const INTENT_FAMILIES = [
  { id: 'ranking', label: 'Ranking', description: 'Compare categories and find top or bottom performers.' },
  { id: 'trend', label: 'Trend', description: 'Show how a metric changes over time.' },
  { id: 'funnel_analysis', label: 'Funnel analysis', description: 'Understand stage movement, conversion, or dropoff.' },
  { id: 'recruiter_productivity', label: 'Recruiter productivity', description: 'Compare recruiter activity, output, or load.' },
  { id: 'time_efficiency', label: 'Time efficiency', description: 'Measure speed, delay, or time spent.' },
  { id: 'bottleneck_detection', label: 'Bottleneck detection', description: 'Find slow or overloaded stages and processes.' },
]

const FALLBACK_DIMENSIONS = ['label', 'firstname', 'month']
const FALLBACK_FILTERS = ['job_name', 'stage', 'recruiter', 'city', 'country']
const BUILDER_SEED_KEY = 'analytics_builder_seed'

export default function BuilderPage() {
  const [accountId] = useAccountId()
  const [metrics, setMetrics] = useState<MetricSummary[]>([])
  const [metricId, setMetricId] = useState<string>('')
  const [dimensions, setDimensions] = useState<string[]>([])
  const [filters, setFilters] = useState<FilterClause[]>([])
  const [vizType, setVizType] = useState<string>('bar')
  const [intentFamily, setIntentFamily] = useState<string>('ranking')
  const [customDimension, setCustomDimension] = useState('')

  const [result, setResult] = useState<ExecuteResponse | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const chartRef = useRef<HTMLDivElement | null>(null)
  const hydratedSeedRef = useRef(false)

  useEffect(() => {
    getMetrics().then(ms => {
      setMetrics(ms)
      if (!metricId && ms.length) {
        applyMetricDefaults(ms[0])
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (hydratedSeedRef.current || metrics.length === 0) return
    hydratedSeedRef.current = true
    const raw = localStorage.getItem(BUILDER_SEED_KEY)
    if (!raw) return
    try {
      const seed = JSON.parse(raw) as {
        metricId?: string
        dimensions?: string[]
        filters?: FilterClause[]
        vizType?: string
        intentFamily?: string
      }
      if (seed.metricId) setMetricId(seed.metricId)
      if (seed.dimensions) setDimensions(seed.dimensions)
      if (seed.filters) setFilters(seed.filters)
      if (seed.vizType) setVizType(seed.vizType)
      if (seed.intentFamily) setIntentFamily(seed.intentFamily)
      localStorage.removeItem(BUILDER_SEED_KEY)
    } catch {
      localStorage.removeItem(BUILDER_SEED_KEY)
    }
  }, [metrics])

  const selectedMetric = useMemo(
    () => metrics.find(m => m.name === metricId),
    [metrics, metricId],
  )

  const dimensionOptions = useMemo(() => {
    const metricDims = selectedMetric?.dimensions?.length ? selectedMetric.dimensions : FALLBACK_DIMENSIONS
    return Array.from(new Set(metricDims))
  }, [selectedMetric])

  const filterOptions = useMemo(() => {
    const metricFilters = selectedMetric?.filters?.length ? selectedMetric.filters : FALLBACK_FILTERS
    return Array.from(new Set(metricFilters))
  }, [selectedMetric])

  const recommendedViz = useMemo(() => {
    const metricViz = selectedMetric?.recommended_visualizations?.length
      ? selectedMetric.recommended_visualizations
      : [selectedMetric?.default_chart_type || 'bar']
    return Array.from(new Set(metricViz))
  }, [selectedMetric])

  const selectedViz = VIZ_TYPES.find(v => v.id === vizType)
  const activeFilterCount = filters.filter(f => f.field.trim() && String(f.value ?? '').trim()).length

  const dsl: AnalyticsDSL | null = useMemo(() => {
    if (!metricId) return null
    return {
      intent_family: intentFamily,
      metrics: [metricId],
      dimensions,
      filters: filters.filter(f => f.field.trim() && String(f.value ?? '').trim()),
      visualization_plan: { type: vizType, config: {} },
      account_id: accountId,
    }
  }, [metricId, intentFamily, dimensions, filters, vizType, accountId])

  const querySummary = useMemo(() => {
    if (!selectedMetric) return 'Choose a metric to start.'
    const breakdown = dimensions.length
      ? `broken down by ${dimensions.map(readableDimension).join(', ')}`
      : 'shown as one overall number'
    const filterText = activeFilterCount
      ? `with ${activeFilterCount} filter${activeFilterCount > 1 ? 's' : ''} applied`
      : 'with no extra filters'
    return `${selectedMetric.display_name} will be ${breakdown}, ${filterText}, and rendered as ${selectedViz?.label.toLowerCase() || vizType}.`
  }, [selectedMetric, dimensions, activeFilterCount, selectedViz, vizType])

  function applyMetricDefaults(metric: MetricSummary) {
    setMetricId(metric.name)
    setDimensions(metric.dimensions?.length ? [metric.dimensions[0]] : [])
    setVizType(metric.default_chart_type || 'bar')
    setIntentFamily(inferIntent(metric))
  }

  const handleRun = async () => {
    if (!dsl) return
    setRunning(true)
    setError(null)
    setResult(null)
    try {
      const res = await executeDsl(dsl, accountId)
      setResult(res)
      if (res.visualization_type) setVizType(res.visualization_type)
    } catch (e: unknown) {
      const message = e && typeof e === 'object' && 'response' in e
        ? (e as { response?: { data?: { detail?: string } } }).response?.data?.detail
        : null
      setError(message || 'Failed to run query')
    } finally {
      setRunning(false)
    }
  }

  const addFilter = () => setFilters(fs => [
    ...fs,
    { field: filterOptions[0] || '', operator: 'eq', value: '' },
  ])
  const updateFilter = (i: number, patch: Partial<FilterClause>) =>
    setFilters(fs => fs.map((f, idx) => (idx === i ? { ...f, ...patch } : f)))
  const removeFilter = (i: number) => setFilters(fs => fs.filter((_, idx) => idx !== i))

  const toggleDimension = (dim: string) => {
    setDimensions(ds => (ds.includes(dim) ? ds.filter(d => d !== dim) : [...ds, dim]))
  }

  const addCustomDimension = () => {
    const value = customDimension.trim()
    if (!value || dimensions.includes(value)) return
    setDimensions(ds => [...ds, value])
    setCustomDimension('')
  }

  return (
    <div className="h-full overflow-hidden">
      <div className="h-full max-w-[1500px] mx-auto px-4 py-3 grid grid-cols-1 xl:grid-cols-[380px_1fr] gap-3">
        <aside className="bg-secondary/40 border border-border rounded-lg p-4 space-y-3 overflow-y-auto custom-scrollbar">
          <div>
            <p className="text-[9px] uppercase tracking-wider text-muted-foreground font-bold">Guided analytics</p>
            <h1 className="text-lg font-bold tracking-tight">Query Builder</h1>
          </div>

          <Section
            label="1. Metric"
            helper="The metric is the business question you want to measure. It decides the SQL calculation, the base table, and the safe joins."
          >
            <select
              value={metricId}
              onChange={e => {
                const metric = metrics.find(x => x.name === e.target.value)
                if (metric) applyMetricDefaults(metric)
              }}
              className="w-full bg-background border border-border rounded-md px-2 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
            >
              {metrics.map(m => (
                <option key={m.name} value={m.name}>{m.display_name}</option>
              ))}
            </select>
            {selectedMetric && (
              <div className="mt-2 space-y-2 text-[11px] text-muted-foreground leading-snug">
                <p className="line-clamp-2" title={selectedMetric.description}>{selectedMetric.description}</p>
                {selectedMetric.is_approximation && (
                  <p className="border border-amber-500/30 bg-amber-500/10 text-amber-100 rounded-md px-2 py-1">
                    Approximation — directional only.
                  </p>
                )}
              </div>
            )}
          </Section>

          <Section
            label="2. Breakdown by"
            helper="A breakdown is a GROUP BY. It splits one metric into buckets, for example candidate count by stage or submissions by recruiter."
          >
            <div className="flex flex-wrap gap-1.5">
              {dimensionOptions.map(d => {
                const copy = DIMENSION_COPY[d]
                const label = copy?.label || readableDimension(d)
                const helper = copy?.useWhen || `Groups by ${readableDimension(d)}.`
                const active = dimensions.includes(d)
                return (
                  <button
                    key={d}
                    onClick={() => toggleDimension(d)}
                    title={helper}
                    className={`text-[11px] px-2 py-1 rounded-md border transition-colors ${
                      active
                        ? 'bg-primary/15 border-primary/50 text-foreground'
                        : 'bg-background border-border text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
            <div className="mt-2 flex gap-2">
              <input
                type="text"
                value={customDimension}
                onChange={e => setCustomDimension(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    addCustomDimension()
                    e.preventDefault()
                  }
                }}
                placeholder="custom dimension"
                className="min-w-0 flex-1 bg-background border border-border rounded-md px-2 py-1 text-[11px] outline-none focus:ring-1 focus:ring-primary"
              />
              <button
                onClick={addCustomDimension}
                className="bg-background border border-border hover:border-primary rounded-md px-2 py-1 text-[11px]"
              >
                Add
              </button>
            </div>
          </Section>

          <Section
            label="3. Filters"
            helper="Filters are WHERE conditions. They narrow the rows before the metric is calculated, such as only one job, stage, recruiter, or country."
          >
            <div className="space-y-2">
              {filters.map((f, i) => (
                <div key={i} className="grid grid-cols-[1fr_112px_1fr_28px] gap-1.5">
                  <select
                    value={f.field}
                    onChange={e => updateFilter(i, { field: e.target.value })}
                    className="min-w-0 bg-background border border-border rounded-md px-2 py-1.5 text-xs outline-none"
                  >
                    {filterOptions.map(field => <option key={field} value={field}>{readableDimension(field)}</option>)}
                  </select>
                  <select
                    value={f.operator}
                    onChange={e => updateFilter(i, { operator: e.target.value })}
                    className="min-w-0 bg-background border border-border rounded-md px-1 py-1.5 text-xs outline-none"
                  >
                    {OPERATORS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                  </select>
                  <input
                    type="text"
                    placeholder="value"
                    value={String(f.value ?? '')}
                    onChange={e => updateFilter(i, { value: e.target.value })}
                    className="min-w-0 bg-background border border-border rounded-md px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary"
                  />
                  <button
                    onClick={() => removeFilter(i)}
                    className="text-muted-foreground hover:text-destructive text-xs border border-border rounded-md"
                    aria-label="Remove filter"
                  >
                    <X size={12} className="mx-auto" />
                  </button>
                </div>
              ))}
              <button
                onClick={addFilter}
                className="w-full bg-background border border-dashed border-border hover:border-primary rounded-md px-3 py-2 text-xs text-muted-foreground hover:text-foreground"
              >
                Add filter
              </button>
            </div>
          </Section>

          <Section
            label="4. Visualization"
            helper="The visualization should match the query shape. A line needs a time breakdown, a funnel needs stage labels, and a table is best for lists."
          >
            <div className="flex flex-wrap gap-1.5">
              {VIZ_TYPES.map(v => {
                const active = vizType === v.id
                const recommended = recommendedViz.includes(v.id)
                return (
                  <button
                    key={v.id}
                    onClick={() => setVizType(v.id)}
                    title={v.bestFor}
                    className={`text-[11px] px-2 py-1 rounded-md border transition-colors ${
                      active
                        ? 'bg-primary/15 border-primary/50 text-foreground'
                        : 'bg-background border-border text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {v.label}
                    {recommended && <Sparkles size={10} className="ml-1 inline text-sky-300" />}
                  </button>
                )
              })}
            </div>
          </Section>

          <Section
            label="5. Intent family"
            helper="Intent family is the planner's broad analytical purpose. It helps explain why this query exists, but the metric and breakdown do the main SQL work."
          >
            <select
              value={intentFamily}
              onChange={e => setIntentFamily(e.target.value)}
              className="w-full bg-background border border-border rounded-md px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary"
            >
              {INTENT_FAMILIES.map(intent => (
                <option key={intent.id} value={intent.id} title={intent.description}>
                  {intent.label}
                </option>
              ))}
            </select>
          </Section>

          <p className="text-[11px] text-muted-foreground leading-snug" title={querySummary}>
            {querySummary}
          </p>

          <button
            onClick={handleRun}
            disabled={running || !metricId}
            className="w-full bg-primary hover:bg-indigo-500 disabled:opacity-50 text-white font-medium rounded-md px-3 py-2 text-sm"
          >
            {running ? 'Running...' : 'Run query'}
          </button>
        </aside>

        <main className="overflow-y-auto custom-scrollbar pr-1">
          {error && (
            <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-3 text-sm text-destructive mb-3">
              {error}
            </div>
          )}

          {!result && !error && (
            <div className="h-full min-h-[300px] border border-dashed border-border rounded-lg flex items-center justify-center text-sm text-muted-foreground px-6 text-center">
              Configure a query on the left and run it to see the chart, SQL lineage, and saved-chart controls.
            </div>
          )}

          {result && (
            <div className="bg-secondary/40 border border-border rounded-lg p-4 space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <h2 className="font-semibold text-sm">{selectedMetric?.display_name || metricId}</h2>
                  <p className="text-[11px] text-muted-foreground">
                    {result.row_count} rows | {result.visualization_type} | {result.intent_family.replace(/_/g, ' ')}
                  </p>
                </div>
                <SaveChartButton
                  accountId={accountId}
                  dsl={result.dsl}
                  lineage={result.lineage}
                  visualizationType={result.visualization_type}
                  defaultTitle={selectedMetric?.display_name || metricId}
                />
              </div>

              <div ref={chartRef} className="bg-chart-surface rounded-lg p-4 border border-border/60">
                <ChartRenderer
                  type={result.visualization_type}
                  data={result.rows}
                  config={{ xLabel: result.dsl.dimensions?.[0] || 'Category', yLabel: selectedMetric?.display_name || 'Value' }}
                />
              </div>

              <div className="flex items-center justify-end">
                <ChartDownloads
                  rows={result.rows as Record<string, unknown>[]}
                  chartRef={chartRef}
                  filename={selectedMetric?.display_name || metricId}
                  metricName={result.lineage?.metric_id || selectedMetric?.display_name || metricId}
                  dsl={result.dsl}
                />
              </div>

              <ChartInspector
                lineage={result.lineage}
                dsl={result.dsl}
                sql={result.sql}
                rowCount={result.row_count}
                accountId={accountId}
              />
            </div>
          )}
        </main>
      </div>
    </div>
  )
}

function Section({
  label,
  helper,
  children,
}: {
  label: string
  helper: string
  children: React.ReactNode
}) {
  return (
    <section>
      <div className="mb-1.5 flex items-center gap-1.5">
        <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">
          {label}
        </label>
        <span
          className="text-[10px] text-muted-foreground/70 cursor-help select-none"
          title={helper}
          aria-label={helper}
        >
          <CircleHelp size={12} />
        </span>
      </div>
      {children}
    </section>
  )
}

function readableDimension(value: string) {
  return (DIMENSION_COPY[value]?.label || value.replace(/_/g, ' ')).replace(/\b\w/g, c => c.toUpperCase())
}

function inferIntent(metric: MetricSummary) {
  const id = metric.name.toLowerCase()
  const chart = metric.default_chart_type
  if (id.includes('funnel') || id.includes('stage') || chart === 'funnel') return 'funnel_analysis'
  if (id.includes('recruiter')) return 'recruiter_productivity'
  if (id.includes('time') || id.includes('velocity')) return 'time_efficiency'
  if (id.includes('bottleneck') || id.includes('inactive')) return 'bottleneck_detection'
  if (id.includes('trend') || chart === 'line') return 'trend'
  return 'ranking'
}
