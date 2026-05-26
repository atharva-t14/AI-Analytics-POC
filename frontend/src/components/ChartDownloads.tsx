'use client'

import { RefObject, useState } from 'react'

interface Props {
  rows: Record<string, unknown>[] | undefined
  chartRef: RefObject<HTMLDivElement | null>
  filename?: string
  metricName?: string
  dsl?: unknown
}

function sanitize(name: string): string {
  return (name || 'chart').toLowerCase().replace(/[^a-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'chart'
}

function rowsToCsv(rows: Record<string, unknown>[]): string {
  if (!rows || rows.length === 0) return ''
  const headers = Array.from(
    rows.reduce<Set<string>>((acc, r) => {
      Object.keys(r).forEach(k => acc.add(k))
      return acc
    }, new Set())
  )
  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return ''
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [headers.join(',')]
  for (const row of rows) {
    lines.push(headers.map(h => escape(row[h])).join(','))
  }
  return lines.join('\n')
}

function computeHash(value: unknown): string {
  const json = JSON.stringify(value ?? null)
  let hash = 5381
  for (let i = 0; i < json.length; i++) {
    hash = ((hash << 5) + hash) ^ json.charCodeAt(i)
  }
  return (hash >>> 0).toString(16)
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function svgToPng(svg: SVGSVGElement, scale = 2): Promise<Blob> {
  // Clone to inline computed styles where needed
  const clone = svg.cloneNode(true) as SVGSVGElement
  // Ensure width/height attributes are set (recharts uses viewBox)
  const bbox = svg.getBoundingClientRect()
  const width = Math.max(1, Math.round(bbox.width))
  const height = Math.max(1, Math.round(bbox.height))
  clone.setAttribute('width', String(width))
  clone.setAttribute('height', String(height))
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')

  const xml = new XMLSerializer().serializeToString(clone)
  const svg64 = window.btoa(unescape(encodeURIComponent(xml)))
  const dataUrl = `data:image/svg+xml;base64,${svg64}`

  const img = new Image()
  img.crossOrigin = 'anonymous'
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('Failed to load SVG'))
    img.src = dataUrl
  })

  const canvas = document.createElement('canvas')
  canvas.width = width * scale
  canvas.height = height * scale
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('No 2D context')
  const themeSurface = getComputedStyle(document.documentElement)
    .getPropertyValue('--chart-surface')
    .trim() || '#ffffff'
  ctx.fillStyle = themeSurface
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.scale(scale, scale)
  ctx.drawImage(img, 0, 0, width, height)

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png')
  })
}

export default function ChartDownloads({ rows, chartRef, filename, metricName, dsl }: Props) {
  const [busy, setBusy] = useState<null | 'csv' | 'png'>(null)
  const [error, setError] = useState<string | null>(null)

  const base = sanitize(filename || 'chart')
  const hasRows = Array.isArray(rows) && rows.length > 0

  const handleCsv = () => {
    if (!hasRows) return
    try {
      setBusy('csv')
      const body = rowsToCsv(rows!)
      const meta = `# metric=${(metricName || 'unknown').replace(/[\r\n]/g, ' ')} dsl_hash=${computeHash(dsl)}`
      const csv = `${meta}\n${body}`
      triggerDownload(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `${base}.csv`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'CSV export failed')
    } finally {
      setBusy(null)
    }
  }

  const handlePng = async () => {
    setError(null)
    const container = chartRef.current
    const svg = container?.querySelector('svg') as SVGSVGElement | null
    if (!svg) {
      setError('No chart to export (tables only support CSV).')
      return
    }
    try {
      setBusy('png')
      const blob = await svgToPng(svg, 2)
      triggerDownload(blob, `${base}.png`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'PNG export failed')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={handleCsv}
        disabled={!hasRows || busy !== null}
        className="text-xs px-2.5 py-1 rounded-md border border-border text-foreground/85 hover:bg-secondary disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        title="Download data as CSV"
      >
        {busy === 'csv' ? 'Exporting…' : 'CSV'}
      </button>
      <button
        type="button"
        onClick={handlePng}
        disabled={busy !== null}
        className="text-xs px-2.5 py-1 rounded-md border border-border text-foreground/85 hover:bg-secondary disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        title="Download chart as PNG"
      >
        {busy === 'png' ? 'Exporting…' : 'PNG'}
      </button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  )
}
