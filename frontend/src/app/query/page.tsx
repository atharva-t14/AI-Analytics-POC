'use client'

import { useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import {
  getRawSchema,
  runRawQuery,
  RawSchema,
  RawSchemaTable,
  RawSchemaOperator,
  RawColumnRef,
  RawJoin,
  RawFilter,
  RawOrder,
  RawQueryResult,
} from '@/src/lib/api'
import { useAccountId } from '@/src/lib/useAccountId'
import ChartRenderer from '@/src/components/ChartRenderer'

/**
 * Ad-hoc query builder.
 *
 * - Pick a primary table from the allowlist; optionally JOIN more.
 * - Pick columns (optionally with aggregate + alias).
 * - Add WHERE filters with typed operators.
 * - Optional GROUP BY, ORDER BY, LIMIT.
 * - Run → preview SQL + tabular results. Tenant scoping is auto-applied
 *   server-side when the primary table has an `account_id` column.
 */
export default function QueryBuilderPage() {
  const [accountId] = useAccountId()
  const [schema, setSchema] = useState<RawSchema | null>(null)
  const [schemaError, setSchemaError] = useState<string | null>(null)

  const [primaryTable, setPrimaryTable] = useState<string>('')
  const [joins, setJoins] = useState<RawJoin[]>([])
  const [columns, setColumns] = useState<RawColumnRef[]>([])
  const [filters, setFilters] = useState<RawFilter[]>([])
  const [groupBy, setGroupBy] = useState<{ table: string; column: string }[]>([])
  const [orderBy, setOrderBy] = useState<RawOrder[]>([])
  const [limit, setLimit] = useState<number>(100)

  const [running, setRunning] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [result, setResult] = useState<RawQueryResult | null>(null)

  // --- load schema ----------------------------------------------------- //
  useEffect(() => {
    getRawSchema()
      .then(s => {
        setSchema(s)
        if (s.tables.length && !primaryTable) {
          setPrimaryTable(s.tables[0].name)
        }
      })
      .catch(e => setSchemaError(e?.response?.data?.detail || 'Failed to load schema'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --- derived --------------------------------------------------------- //
  const tablesById = useMemo(() => {
    const m = new Map<string, RawSchemaTable>()
    schema?.tables.forEach(t => m.set(t.name, t))
    return m
  }, [schema])

  const tablesInQuery = useMemo<string[]>(() => {
    if (!primaryTable) return []
    return [primaryTable, ...joins.map(j => j.table)]
  }, [primaryTable, joins])

  const allColumns = useMemo(() => {
    const out: { table: string; column: string; type: string }[] = []
    for (const tn of tablesInQuery) {
      const t = tablesById.get(tn)
      if (!t) continue
      for (const c of t.columns) out.push({ table: tn, column: c.name, type: c.type })
    }
    return out
  }, [tablesInQuery, tablesById])

  // Reset dependent state when primary table changes.
  const handlePrimaryChange = (t: string) => {
    setPrimaryTable(t)
    setJoins([])
    setColumns([])
    setFilters([])
    setGroupBy([])
    setOrderBy([])
    setResult(null)
    setRunError(null)
  }

  // --- mutators -------------------------------------------------------- //
  const addJoin = () => {
    if (!schema) return
    const other = schema.tables.find(t => !tablesInQuery.includes(t.name))
    if (!other) return
    const left = tablesById.get(primaryTable)?.columns[0]
    const right = other.columns[0]
    if (!left || !right) return
    setJoins(js => [
      ...js,
      {
        table: other.name,
        type: 'INNER',
        left: { table: primaryTable, column: left.name },
        right: { table: other.name, column: right.name },
      },
    ])
  }

  const addColumn = () => {
    if (!allColumns.length) return
    const first = allColumns[0]
    setColumns(cs => [...cs, { table: first.table, column: first.column }])
  }

  const addFilter = () => {
    if (!allColumns.length || !schema) return
    const first = allColumns[0]
    const op = schema.operators[0]?.id || 'eq'
    setFilters(fs => [...fs, { table: first.table, column: first.column, op, value: '' }])
  }

  const addGroupBy = () => {
    if (!allColumns.length) return
    const first = allColumns[0]
    setGroupBy(gs => [...gs, { table: first.table, column: first.column }])
  }

  const addOrderBy = () => {
    if (!allColumns.length) return
    const first = allColumns[0]
    setOrderBy(os => [...os, { table: first.table, column: first.column, direction: 'DESC' }])
  }

  // --- run ------------------------------------------------------------- //
  const run = async () => {
    if (!primaryTable) return
    if (columns.length === 0) {
      setRunError('Add at least one column to SELECT.')
      return
    }
    setRunning(true)
    setRunError(null)
    setResult(null)
    try {
      // Coerce list-operator values into arrays.
      const cleanedFilters: RawFilter[] = filters.map(f => {
        const opMeta = schema?.operators.find(o => o.id === f.op)
        if (opMeta?.unary) return { ...f, value: undefined }
        if (opMeta?.list && typeof f.value === 'string') {
          return {
            ...f,
            value: f.value
              .split(',')
              .map(s => s.trim())
              .filter(Boolean),
          }
        }
        return f
      })
      const out = await runRawQuery({
        account_id: accountId,
        primary_table: primaryTable,
        columns,
        joins,
        filters: cleanedFilters,
        group_by: groupBy,
        order_by: orderBy,
        limit,
      })
      setResult(out)
    } catch (e: any) {
      setRunError(e?.response?.data?.detail || e?.message || 'Query failed')
    } finally {
      setRunning(false)
    }
  }

  if (schemaError) {
    return (
      <div className="max-w-3xl mx-auto p-8">
        <p className="text-destructive text-sm">{schemaError}</p>
      </div>
    )
  }
  if (!schema) {
    return (
      <div className="max-w-3xl mx-auto p-8">
        <p className="text-muted-foreground text-sm">Loading schema…</p>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto custom-scrollbar">
      <div className="max-w-[1400px] mx-auto px-6 py-6 space-y-5">
        {/* Header */}
        <div className="flex items-end justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Query Builder</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Pick tables, columns, conditions, and run. Tenant scoping (
              <code className="text-[11px] bg-secondary/60 px-1 rounded">account_id = {accountId}</code>
              ) is enforced automatically.
            </p>
          </div>
          <button
            onClick={run}
            disabled={running || !primaryTable || columns.length === 0}
            className="bg-indigo-500 hover:bg-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm px-4 py-2 rounded-md"
          >
            {running ? 'Running…' : 'Run query'}
          </button>
        </div>

        {/* FROM */}
        <Section title="From">
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={primaryTable}
              onChange={e => handlePrimaryChange(e.target.value)}
              className="bg-background border border-border rounded px-2 py-1 text-sm"
            >
              {schema.tables.map(t => (
                <option key={t.name} value={t.name}>{t.name}</option>
              ))}
            </select>
            <button
              onClick={addJoin}
              className="text-xs text-accent-strong hover:opacity-85"
              disabled={tablesInQuery.length >= schema.tables.length}
            >
              + Add JOIN
            </button>
          </div>
          <div className="mt-3 space-y-2">
            {joins.map((j, idx) => (
              <JoinRow
                key={idx}
                join={j}
                schema={schema}
                primaryTable={primaryTable}
                tablesInQuery={tablesInQuery}
                onChange={next =>
                  setJoins(js => js.map((x, i) => (i === idx ? next : x)))
                }
                onRemove={() => setJoins(js => js.filter((_, i) => i !== idx))}
              />
            ))}
          </div>
        </Section>

        {/* SELECT */}
        <Section title="Select" onAdd={addColumn} addLabel="+ Column">
          {columns.length === 0 ? (
            <p className="text-xs text-muted-foreground">No columns selected.</p>
          ) : (
            <div className="space-y-2">
              {columns.map((c, idx) => (
                <ColumnRow
                  key={idx}
                  col={c}
                  allColumns={allColumns}
                  aggregates={schema.aggregates}
                  onChange={next =>
                    setColumns(cs => cs.map((x, i) => (i === idx ? next : x)))
                  }
                  onRemove={() => setColumns(cs => cs.filter((_, i) => i !== idx))}
                />
              ))}
            </div>
          )}
        </Section>

        {/* WHERE */}
        <Section title="Where" onAdd={addFilter} addLabel="+ Filter">
          {filters.length === 0 ? (
            <p className="text-xs text-muted-foreground">No filters.</p>
          ) : (
            <div className="space-y-2">
              {filters.map((f, idx) => (
                <FilterRow
                  key={idx}
                  filter={f}
                  allColumns={allColumns}
                  operators={schema.operators}
                  onChange={next =>
                    setFilters(fs => fs.map((x, i) => (i === idx ? next : x)))
                  }
                  onRemove={() => setFilters(fs => fs.filter((_, i) => i !== idx))}
                />
              ))}
            </div>
          )}
        </Section>

        {/* GROUP BY */}
        <Section title="Group by" onAdd={addGroupBy} addLabel="+ Group">
          {groupBy.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              None. Inferred automatically when aggregates are present.
            </p>
          ) : (
            <div className="space-y-2">
              {groupBy.map((g, idx) => (
                <ColumnPicker
                  key={idx}
                  value={g}
                  allColumns={allColumns}
                  onChange={next =>
                    setGroupBy(gs => gs.map((x, i) => (i === idx ? next : x)))
                  }
                  onRemove={() => setGroupBy(gs => gs.filter((_, i) => i !== idx))}
                />
              ))}
            </div>
          )}
        </Section>

        {/* ORDER BY + LIMIT */}
        <Section title="Order by" onAdd={addOrderBy} addLabel="+ Order">
          {orderBy.length === 0 ? (
            <p className="text-xs text-muted-foreground">No ordering.</p>
          ) : (
            <div className="space-y-2">
              {orderBy.map((o, idx) => (
                <OrderRow
                  key={idx}
                  order={o}
                  allColumns={allColumns}
                  onChange={next =>
                    setOrderBy(os => os.map((x, i) => (i === idx ? next : x)))
                  }
                  onRemove={() => setOrderBy(os => os.filter((_, i) => i !== idx))}
                />
              ))}
            </div>
          )}
          <div className="mt-3 flex items-center gap-2">
            <label className="text-xs text-muted-foreground">Limit</label>
            <input
              type="number"
              min={1}
              max={schema.max_limit}
              value={limit}
              onChange={e => setLimit(Math.max(1, parseInt(e.target.value, 10) || 1))}
              className="w-24 bg-background border border-border rounded px-2 py-1 text-sm"
            />
            <span className="text-[11px] text-muted-foreground">max {schema.max_limit}</span>
          </div>
        </Section>

        {/* Errors */}
        {runError && (
          <p className="text-sm text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
            {runError}
          </p>
        )}

        {/* Results */}
        {result && (
          <Section title={`Result (${result.row_count} row${result.row_count === 1 ? '' : 's'}${result.truncated ? ', truncated' : ''})`}>
            <details className="mb-3">
              <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                Show generated SQL
              </summary>
              <pre className="text-[11px] bg-background border border-border rounded p-3 mt-2 overflow-x-auto whitespace-pre-wrap break-words">
                {result.sql}
              </pre>
            </details>
            {result.rows.length === 0 ? (
              <p className="text-xs text-muted-foreground">No rows.</p>
            ) : (
              <ResultsPanel result={result} />
            )}
          </Section>
        )}
      </div>
    </div>
  )
}

// --- Subcomponents -------------------------------------------------------- //

const CHART_TYPES = [
  { id: 'bar', label: 'Bar' },
  { id: 'line', label: 'Line' },
  { id: 'pie', label: 'Pie' },
  { id: 'donut', label: 'Donut' },
]

function ResultsPanel({ result }: { result: RawQueryResult }) {
  const [mode, setMode] = useState<'table' | 'chart'>('table')

  // Detect column types from the first row so we can suggest sensible
  // defaults for the chart picker.
  const numericCols = useMemo(() => {
    if (result.rows.length === 0) return []
    const first = result.rows[0]
    return result.columns.filter(c => typeof first[c] === 'number')
  }, [result])
  const categoryCols = useMemo(
    () => result.columns.filter(c => !numericCols.includes(c)),
    [result, numericCols],
  )

  const [chartType, setChartType] = useState<string>('bar')
  const [xKey, setXKey] = useState<string>(categoryCols[0] || result.columns[0] || '')
  const [yKey, setYKey] = useState<string>(numericCols[0] || result.columns[1] || result.columns[0] || '')

  // Reset axis picks whenever the underlying result changes.
  useEffect(() => {
    setXKey(categoryCols[0] || result.columns[0] || '')
    setYKey(numericCols[0] || result.columns[1] || result.columns[0] || '')
  }, [result, categoryCols, numericCols])

  // Map rows into the {label, value} shape ChartRenderer expects.
  const chartData = useMemo(() => {
    if (!xKey || !yKey) return []
    return result.rows.map(row => {
      const rawVal = row[yKey]
      const num =
        typeof rawVal === 'number'
          ? rawVal
          : Number(rawVal)
      return {
        label: String(row[xKey] ?? ''),
        value: Number.isFinite(num) ? num : 0,
      }
    })
  }, [result, xKey, yKey])

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <ToggleButton active={mode === 'table'} onClick={() => setMode('table')}>
          Table
        </ToggleButton>
        <ToggleButton active={mode === 'chart'} onClick={() => setMode('chart')}>
          Chart
        </ToggleButton>
      </div>

      {mode === 'table' && (
        <div className="overflow-x-auto border border-border rounded-md">
          <table className="text-xs w-full">
            <thead className="bg-secondary/40">
              <tr>
                {result.columns.map(c => (
                  <th key={c} className="text-left px-3 py-2 font-semibold whitespace-nowrap">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, i) => (
                <tr key={i} className="border-t border-border">
                  {result.columns.map(c => (
                    <td key={c} className="px-3 py-1.5 whitespace-nowrap">
                      {formatCell(row[c])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {mode === 'chart' && (
        <div>
          <div className="flex items-end gap-3 flex-wrap mb-3">
            <FieldSelect label="Chart type" value={chartType} onChange={setChartType}>
              {CHART_TYPES.map(c => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
            </FieldSelect>
            <FieldSelect label="Category (X)" value={xKey} onChange={setXKey}>
              {result.columns.map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </FieldSelect>
            <FieldSelect label="Value (Y)" value={yKey} onChange={setYKey}>
              {(numericCols.length ? numericCols : result.columns).map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </FieldSelect>
          </div>
          {numericCols.length === 0 && (
            <p className="text-[11px] text-amber-400 mb-2">
              No numeric columns detected — chart values will be coerced from text and may be 0.
              Add an aggregate (count, sum, avg…) to your SELECT for a meaningful chart.
            </p>
          )}
          <div className="border border-border rounded-md p-3 bg-background h-[360px]">
            <ChartRenderer type={chartType} data={chartData} />
          </div>
        </div>
      )}
    </div>
  )
}

function ToggleButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`text-xs px-3 py-1 rounded-md border transition-colors ${
        active
          ? 'bg-indigo-500/15 text-indigo-200 border-indigo-500/40'
          : 'bg-background text-muted-foreground border-border hover:text-foreground'
      }`}
    >
      {children}
    </button>
  )
}

function FieldSelect({
  label,
  value,
  onChange,
  children,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  children: React.ReactNode
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="bg-background border border-border rounded px-2 py-1 text-xs"
      >
        {children}
      </select>
    </label>
  )
}

function Section({
  title,
  children,
  onAdd,
  addLabel,
}: {
  title: string
  children: React.ReactNode
  onAdd?: () => void
  addLabel?: string
}) {
  return (
    <div className="bg-secondary/40 border border-border rounded-2xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xs uppercase tracking-wider text-muted-foreground font-bold">
          {title}
        </h2>
        {onAdd && (
          <button onClick={onAdd} className="text-xs text-accent-strong hover:opacity-85">
            {addLabel || '+ Add'}
          </button>
        )}
      </div>
      {children}
    </div>
  )
}

function ColumnPicker({
  value,
  allColumns,
  onChange,
  onRemove,
}: {
  value: { table: string; column: string }
  allColumns: { table: string; column: string; type: string }[]
  onChange: (v: { table: string; column: string }) => void
  onRemove?: () => void
}) {
  return (
    <div className="flex items-center gap-2">
      <select
        value={`${value.table}.${value.column}`}
        onChange={e => {
          const [t, c] = e.target.value.split('.')
          onChange({ table: t, column: c })
        }}
        className="flex-1 bg-background border border-border rounded px-2 py-1 text-sm"
      >
        {allColumns.map(c => (
          <option key={`${c.table}.${c.column}`} value={`${c.table}.${c.column}`}>
            {c.table}.{c.column} · {c.type}
          </option>
        ))}
      </select>
      {onRemove && (
        <button onClick={onRemove} className="text-xs text-muted-foreground hover:text-destructive">
          <X size={14} />
        </button>
      )}
    </div>
  )
}

function ColumnRow({
  col,
  allColumns,
  aggregates,
  onChange,
  onRemove,
}: {
  col: RawColumnRef
  allColumns: { table: string; column: string; type: string }[]
  aggregates: string[]
  onChange: (v: RawColumnRef) => void
  onRemove: () => void
}) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <select
        value={col.aggregate || ''}
        onChange={e => onChange({ ...col, aggregate: e.target.value || null })}
        className="bg-background border border-border rounded px-2 py-1 text-xs"
      >
        <option value="">no aggregate</option>
        {aggregates.map(a => (
          <option key={a} value={a}>{a}</option>
        ))}
      </select>
      <ColumnPicker
        value={{ table: col.table, column: col.column }}
        allColumns={allColumns}
        onChange={v => onChange({ ...col, ...v })}
      />
      <input
        type="text"
        value={col.alias || ''}
        onChange={e => onChange({ ...col, alias: e.target.value || null })}
        placeholder="alias"
        className="w-28 bg-background border border-border rounded px-2 py-1 text-xs"
      />
      <button onClick={onRemove} className="text-xs text-muted-foreground hover:text-destructive">
        <X size={14} />
      </button>
    </div>
  )
}

function FilterRow({
  filter,
  allColumns,
  operators,
  onChange,
  onRemove,
}: {
  filter: RawFilter
  allColumns: { table: string; column: string; type: string }[]
  operators: RawSchemaOperator[]
  onChange: (v: RawFilter) => void
  onRemove: () => void
}) {
  const opMeta = operators.find(o => o.id === filter.op)
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <ColumnPicker
        value={{ table: filter.table, column: filter.column }}
        allColumns={allColumns}
        onChange={v => onChange({ ...filter, ...v })}
      />
      <select
        value={filter.op}
        onChange={e => onChange({ ...filter, op: e.target.value, value: '' })}
        className="bg-background border border-border rounded px-2 py-1 text-xs"
      >
        {operators.map(o => (
          <option key={o.id} value={o.id}>{o.id}</option>
        ))}
      </select>
      {!opMeta?.unary && (
        <input
          type="text"
          value={typeof filter.value === 'string' ? filter.value : ''}
          onChange={e => onChange({ ...filter, value: e.target.value })}
          placeholder={opMeta?.list ? 'a, b, c' : 'value'}
          className="flex-1 min-w-[10rem] bg-background border border-border rounded px-2 py-1 text-xs"
        />
      )}
      <button onClick={onRemove} className="text-xs text-muted-foreground hover:text-destructive">
        <X size={14} />
      </button>
    </div>
  )
}

function OrderRow({
  order,
  allColumns,
  onChange,
  onRemove,
}: {
  order: RawOrder
  allColumns: { table: string; column: string; type: string }[]
  onChange: (v: RawOrder) => void
  onRemove: () => void
}) {
  return (
    <div className="flex items-center gap-2">
      <ColumnPicker
        value={{ table: order.table, column: order.column }}
        allColumns={allColumns}
        onChange={v => onChange({ ...order, ...v })}
      />
      <select
        value={order.direction || 'ASC'}
        onChange={e => onChange({ ...order, direction: e.target.value as 'ASC' | 'DESC' })}
        className="bg-background border border-border rounded px-2 py-1 text-xs"
      >
        <option value="ASC">ASC</option>
        <option value="DESC">DESC</option>
      </select>
      <button onClick={onRemove} className="text-xs text-muted-foreground hover:text-destructive">
        <X size={14} />
      </button>
    </div>
  )
}

function JoinRow({
  join,
  schema,
  primaryTable,
  tablesInQuery,
  onChange,
  onRemove,
}: {
  join: RawJoin
  schema: RawSchema
  primaryTable: string
  tablesInQuery: string[]
  onChange: (v: RawJoin) => void
  onRemove: () => void
}) {
  // Tables available to join in: not the primary, not already in another join (except this one)
  const otherTaken = new Set(tablesInQuery.filter(t => t !== join.table))
  const joinableTables = schema.tables.filter(t => !otherTaken.has(t.name))
  const leftCols = schema.tables.find(t => t.name === join.left.table)?.columns || []
  const rightCols = schema.tables.find(t => t.name === join.table)?.columns || []
  const leftTables = tablesInQuery.filter(t => t !== join.table)

  return (
    <div className="bg-background border border-border rounded-md p-2 flex items-center gap-2 flex-wrap text-xs">
      <select
        value={join.type || 'INNER'}
        onChange={e => onChange({ ...join, type: e.target.value as 'INNER' | 'LEFT' | 'RIGHT' })}
        className="bg-background border border-border rounded px-2 py-1"
      >
        <option value="INNER">INNER</option>
        <option value="LEFT">LEFT</option>
        <option value="RIGHT">RIGHT</option>
      </select>
      <span className="text-muted-foreground">JOIN</span>
      <select
        value={join.table}
        onChange={e => {
          const t = e.target.value
          const firstCol = schema.tables.find(x => x.name === t)?.columns[0]?.name || ''
          onChange({ ...join, table: t, right: { table: t, column: firstCol } })
        }}
        className="bg-background border border-border rounded px-2 py-1"
      >
        {joinableTables.map(t => (
          <option key={t.name} value={t.name}>{t.name}</option>
        ))}
      </select>
      <span className="text-muted-foreground">ON</span>
      <select
        value={`${join.left.table}.${join.left.column}`}
        onChange={e => {
          const [t, c] = e.target.value.split('.')
          onChange({ ...join, left: { table: t, column: c } })
        }}
        className="bg-background border border-border rounded px-2 py-1"
      >
        {leftTables.map(lt => {
          const cols = schema.tables.find(x => x.name === lt)?.columns || []
          return cols.map(c => (
            <option key={`${lt}.${c.name}`} value={`${lt}.${c.name}`}>
              {lt}.{c.name}
            </option>
          ))
        })}
      </select>
      <span className="text-muted-foreground">=</span>
      <select
        value={`${join.right.table}.${join.right.column}`}
        onChange={e => {
          const [, c] = e.target.value.split('.')
          onChange({ ...join, right: { table: join.table, column: c } })
        }}
        className="bg-background border border-border rounded px-2 py-1"
      >
        {rightCols.map(c => (
          <option key={c.name} value={`${join.table}.${c.name}`}>
            {join.table}.{c.name}
          </option>
        ))}
      </select>
      <button onClick={onRemove} className="ml-auto text-muted-foreground hover:text-destructive">
        <X size={14} />
      </button>
      {/* Suppress unused-var lint */}
      <span className="hidden">{leftCols.length}{primaryTable}</span>
    </div>
  )
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}
