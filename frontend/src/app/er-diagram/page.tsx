'use client'

import { useEffect, useMemo, useState } from 'react'
import { Copy, Database, Info, Network, ShieldCheck } from 'lucide-react'
import { getRawRelationships, getRawSchema, RawRelationship, RawSchemaTable } from '@/src/lib/api'

type ThemeMode = 'dark' | 'light'

const MERMAID_THEME_BY_MODE: Record<ThemeMode, Record<string, string>> = {
  dark: {
    background: '#00000000',
    primaryColor: '#161A23',
    primaryTextColor: '#F8FAFC',
    primaryBorderColor: '#7DD3FC',
    lineColor: '#93C5FD',
    tertiaryColor: '#0F172A',
    tertiaryTextColor: '#E2E8F0',
    edgeLabelBackground: '#0B1220',
    fontSize: '12px',
  },
  light: {
    background: '#00000000',
    primaryColor: '#F8FAFF',
    primaryTextColor: '#0F172A',
    primaryBorderColor: '#2563EB',
    lineColor: '#1D4ED8',
    tertiaryColor: '#EEF2FF',
    tertiaryTextColor: '#0F172A',
    edgeLabelBackground: '#FFFFFF',
    fontSize: '12px',
  },
}

function asEntity(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9_]/g, '_')
}

function edgeToken(rel: RawRelationship): string {
  const t = (rel.relationship_type || '').toLowerCase()
  if (t === 'many_to_one') return '}o--||'
  if (t === 'one_to_many') return '||--o{'
  if (t === 'one_to_one') return '||--||'
  return '}o--o{'
}

function buildMermaid(tables: string[], relationships: RawRelationship[]): string {
  const lines: string[] = ['erDiagram']

  for (const t of tables) {
    lines.push(`  ${asEntity(t)} {`)
    lines.push('    string id PK')
    lines.push('    int accountid')
    lines.push('  }')
  }

  for (const r of relationships) {
    const left = asEntity(r.left_table)
    const right = asEntity(r.right_table)
    const label = `${r.left_column} -> ${r.right_column}`
    lines.push(`  ${left} ${edgeToken(r)} ${right} : "${label}"`)
  }

  return lines.join('\n')
}

export default function ErDiagramPage() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tables, setTables] = useState<string[]>([])
  const [relationships, setRelationships] = useState<RawRelationship[]>([])
  const [schemaTables, setSchemaTables] = useState<RawSchemaTable[]>([])
  const [selectedTable, setSelectedTable] = useState<string>('')
  const [openEdgeKey, setOpenEdgeKey] = useState<string | null>(null)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [svg, setSvg] = useState<string>('')
  const [themeMode, setThemeMode] = useState<ThemeMode>('dark')

  useEffect(() => {
    const root = document.documentElement
    const apply = () => {
      const next: ThemeMode = root.dataset.theme === 'light' ? 'light' : 'dark'
      setThemeMode(next)
    }
    apply()

    const observer = new MutationObserver(apply)
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    Promise.all([getRawRelationships(), getRawSchema()])
      .then(([relData, schemaData]) => {
        if (cancelled) return
        const t = relData.tables || []
        setTables(t)
        setRelationships(relData.relationships || [])
        setSchemaTables(schemaData.tables || [])
        if (t.length) setSelectedTable(prev => prev || t[0])
      })
      .catch(e => {
        if (!cancelled) setError(e?.response?.data?.detail || 'Failed to load ER metadata')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  const diagramSource = useMemo(
    () => buildMermaid(tables, relationships),
    [tables, relationships],
  )

  const selectedSchema = useMemo(
    () => schemaTables.find(t => t.name === selectedTable) || null,
    [schemaTables, selectedTable],
  )

  const connectedTables = useMemo(() => {
    if (!selectedTable) return []
    const out = new Set<string>()
    for (const r of relationships) {
      if (r.left_table === selectedTable) out.add(r.right_table)
      if (r.right_table === selectedTable) out.add(r.left_table)
    }
    return Array.from(out).sort()
  }, [relationships, selectedTable])

  const joinSnippet = (r: RawRelationship) => {
    return `JOIN ${r.right_table} ON ${r.left_table}.${r.left_column} = ${r.right_table}.${r.right_column}`
  }

  const edgeKey = (r: RawRelationship, i: number) => {
    return `${r.left_table}-${r.left_column}-${r.right_table}-${r.right_column}-${i}`
  }

  const copyJoinSnippet = async (r: RawRelationship, key: string) => {
    try {
      await navigator.clipboard.writeText(joinSnippet(r))
      setCopiedKey(key)
      window.setTimeout(() => {
        setCopiedKey(prev => (prev === key ? null : prev))
      }, 1400)
    } catch {
      // Best effort. Keep UI silent if clipboard is unavailable.
    }
  }

  useEffect(() => {
    let alive = true
    if (!diagramSource || !relationships.length) {
      setSvg('')
      return
    }

    ;(async () => {
      try {
        const mermaid = (await import('mermaid')).default
        mermaid.initialize({
          startOnLoad: false,
          theme: 'base',
          securityLevel: 'loose',
          er: { useMaxWidth: true },
          themeVariables: MERMAID_THEME_BY_MODE[themeMode],
        })
        const id = `er-${Date.now()}`
        const rendered = await mermaid.render(id, diagramSource)
        if (alive) setSvg(rendered.svg)
      } catch {
        if (alive) setError('Failed to render Mermaid diagram')
      }
    })()

    return () => {
      alive = false
    }
  }, [diagramSource, relationships.length, themeMode])

  return (
    <div className="h-full overflow-y-auto custom-scrollbar">
      <div className="max-w-[1500px] mx-auto px-6 py-6 space-y-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">Query planning aid</p>
            <h1 className="text-2xl font-bold tracking-tight">ER Diagram (Allowed Tables)</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Use this map to understand which tables are available in the safe query layer and how they join.
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1 bg-secondary border border-border rounded-md px-2 py-1">
              <Database size={12} /> {tables.length} tables
            </span>
            <span className="inline-flex items-center gap-1 bg-secondary border border-border rounded-md px-2 py-1">
              <Network size={12} /> {relationships.length} joins
            </span>
            <span className="inline-flex items-center gap-1 bg-secondary border border-border rounded-md px-2 py-1">
              <ShieldCheck size={12} /> Allowlisted only
            </span>
          </div>
        </div>

        {loading && <div className="text-sm text-muted-foreground">Loading ER metadata…</div>}
        {error && <div className="text-sm text-destructive">{error}</div>}

        {!loading && !error && (
          <>
            <section className="rounded-xl border border-border bg-card/70 p-4 ring-hairline">
              <h2 className="text-xs uppercase tracking-wider text-muted-foreground font-bold mb-3">Click a table to inspect columns</h2>
              <div className="flex flex-wrap gap-2">
                {tables.map(t => {
                  const active = t === selectedTable
                  return (
                    <button
                      key={t}
                      onClick={() => setSelectedTable(t)}
                      className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                        active
                          ? 'bg-primary/15 border-primary/40 text-accent-strong'
                          : 'bg-secondary border-border text-foreground/85 hover:border-primary/40'
                      }`}
                    >
                      {t}
                    </button>
                  )
                })}
              </div>
            </section>

            <section className="rounded-xl border border-border bg-card/70 p-4 overflow-x-auto ring-hairline">
              {svg ? (
                <div
                  className="min-w-[900px] [&_svg]:w-full [&_svg]:h-auto [&_.er>.entityBox]:stroke-[1.5px]"
                  dangerouslySetInnerHTML={{ __html: svg }}
                />
              ) : (
                <p className="text-sm text-muted-foreground">No ER diagram available.</p>
              )}
            </section>

            <section className="grid grid-cols-1 xl:grid-cols-[1.25fr_1fr] gap-4">
              <div className="rounded-xl border border-border bg-card/70 p-4 ring-hairline">
                <h2 className="text-xs uppercase tracking-wider text-muted-foreground font-bold mb-3">Relationship reference</h2>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-foreground/80 text-xs bg-secondary/70">
                      <tr>
                        <th className="text-left py-2 px-3">From table</th>
                        <th className="text-left py-2 px-3">From column</th>
                        <th className="text-left py-2 px-3">To table</th>
                        <th className="text-left py-2 px-3">To column</th>
                        <th className="text-left py-2 px-3">Type</th>
                        <th className="text-left py-2 px-3">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {relationships.map((r, i) => {
                        const key = edgeKey(r, i)
                        const isOpen = openEdgeKey === key
                        return (
                        <tr
                          key={key}
                          className="border-t border-border/70 odd:bg-secondary/20"
                        >
                          <td className="py-2 px-3 font-mono text-xs text-foreground">
                            <button onClick={() => setSelectedTable(r.left_table)} className="hover:text-accent-strong">
                              {r.left_table}
                            </button>
                          </td>
                          <td className="py-2 px-3 font-mono text-xs text-foreground">{r.left_column}</td>
                          <td className="py-2 px-3 font-mono text-xs text-foreground">
                            <button onClick={() => setSelectedTable(r.right_table)} className="hover:text-accent-strong">
                              {r.right_table}
                            </button>
                          </td>
                          <td className="py-2 px-3 font-mono text-xs text-foreground">{r.right_column}</td>
                          <td className="py-2 px-3 text-xs text-foreground/80">{r.relationship_type || 'unspecified'}</td>
                          <td className="py-2 px-3 text-xs text-foreground/80">
                            <div className="relative inline-flex items-center gap-2">
                              <button
                                onClick={() => setOpenEdgeKey(prev => (prev === key ? null : key))}
                                className="inline-flex items-center gap-1 rounded border border-border bg-background px-1.5 py-0.5 hover:border-primary/40"
                                title="Edge details"
                              >
                                <Info size={12} /> Details
                              </button>
                              <button
                                onClick={() => copyJoinSnippet(r, key)}
                                className="inline-flex items-center gap-1 rounded border border-border bg-background px-1.5 py-0.5 hover:border-primary/40"
                                title="Copy JOIN snippet"
                              >
                                <Copy size={12} /> {copiedKey === key ? 'Copied' : 'Copy JOIN'}
                              </button>

                              {isOpen && (
                                <div className="absolute right-0 top-7 z-20 w-[360px] rounded-lg border border-border bg-card shadow-xl p-3 text-xs space-y-2">
                                  <div className="flex items-center justify-between">
                                    <p className="font-semibold text-foreground">Edge details</p>
                                    <button
                                      onClick={() => setOpenEdgeKey(null)}
                                      className="text-muted-foreground hover:text-foreground"
                                    >
                                      Close
                                    </button>
                                  </div>
                                  <p className="text-muted-foreground">
                                    {r.left_table}.{r.left_column} = {r.right_table}.{r.right_column}
                                  </p>
                                  <div className="grid grid-cols-[120px_1fr] gap-y-1 gap-x-2">
                                    <span className="text-muted-foreground">Cardinality</span>
                                    <span className="text-foreground">{r.cardinality || 'unspecified'}</span>
                                    <span className="text-muted-foreground">Relationship</span>
                                    <span className="text-foreground">{r.relationship_type || 'unspecified'}</span>
                                    <span className="text-muted-foreground">Confidence</span>
                                    <span className="text-foreground">{r.confidence_level || 'unknown'}</span>
                                    <span className="text-muted-foreground">Source</span>
                                    <span className="text-foreground">{r.source_of_truth || 'unspecified'}</span>
                                  </div>
                                  <pre className="bg-secondary/60 border border-border rounded p-2 overflow-x-auto text-[11px] text-foreground/90">
{joinSnippet(r)}
                                  </pre>
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )})}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="rounded-xl border border-border bg-card/70 p-4 ring-hairline">
                <h2 className="text-xs uppercase tracking-wider text-muted-foreground font-bold mb-3">Column panel</h2>
                {selectedSchema ? (
                  <>
                    <div className="mb-3">
                      <p className="text-sm font-semibold text-foreground">{selectedSchema.name}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {selectedSchema.columns.length} available columns
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Connected tables: {connectedTables.length ? connectedTables.join(', ') : 'none'}
                      </p>
                    </div>
                    <div className="max-h-[420px] overflow-y-auto custom-scrollbar border border-border rounded-md">
                      <table className="w-full text-xs">
                        <thead className="sticky top-0 bg-secondary/80 text-muted-foreground">
                          <tr>
                            <th className="text-left px-3 py-2">Column</th>
                            <th className="text-left px-3 py-2">Type</th>
                            <th className="text-left px-3 py-2">Nullable</th>
                          </tr>
                        </thead>
                        <tbody>
                          {selectedSchema.columns.map(col => (
                            <tr key={`${selectedSchema.name}.${col.name}`} className="border-t border-border/70">
                              <td className="px-3 py-2 font-mono text-foreground">{col.name}</td>
                              <td className="px-3 py-2 text-foreground/90">{col.type}</td>
                              <td className="px-3 py-2">
                                <span className={`inline-flex rounded px-1.5 py-0.5 border ${col.nullable ? 'border-amber-500/35 text-amber-600 dark:text-amber-300' : 'border-emerald-500/35 text-emerald-700 dark:text-emerald-300'}`}>
                                  {col.nullable ? 'yes' : 'no'}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">Select a table to view its columns.</p>
                )}
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  )
}
