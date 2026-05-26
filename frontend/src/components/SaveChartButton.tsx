'use client'

import { useState } from 'react'
import { Check, Plus } from 'lucide-react'
import { AnalyticsDSL, QueryLineage } from '../types/analytics'
import { saveChart } from '../lib/api'
import { showToast } from '../lib/toast'

interface Props {
  accountId: number
  dsl?: AnalyticsDSL | null
  lineage?: QueryLineage | null
  visualizationType?: string | null
  naturalLanguageQuery?: string | null
  defaultTitle?: string
}

/**
 * Inline "Save chart" button. Stores the DSL so the chart can be re-run
 * deterministically from the Saved Charts / Dashboard pages.
 */
export default function SaveChartButton({
  accountId,
  dsl,
  lineage,
  visualizationType,
  naturalLanguageQuery,
  defaultTitle,
}: Props) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState(defaultTitle ?? '')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)
  const [savedId, setSavedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (!dsl) return null

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      const result = await saveChart({
        account_id: accountId,
        title: title.trim() || defaultTitle || 'Untitled chart',
        description: description.trim() || null,
        natural_language_query: naturalLanguageQuery ?? null,
        dsl,
        visualization_type: visualizationType ?? dsl.visualization_plan?.type ?? null,
        viz_config: dsl.visualization_plan?.config ?? null,
        lineage: lineage ?? null,
      })
      setSavedId(result.id)
      setOpen(false)
      showToast({ type: 'success', title: 'Chart saved', detail: result.title })
    } catch (e: any) {
      const message = e?.response?.data?.detail || 'Failed to save chart'
      setError(message)
      showToast({ type: 'error', title: 'Save failed', detail: message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="relative inline-block">
      {savedId ? (
        <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-md px-2 py-1">
          Saved <Check size={12} />
        </span>
      ) : (
        <button
          onClick={() => setOpen(o => !o)}
          className="inline-flex items-center gap-1 text-[11px] text-accent-strong bg-primary/10 border border-primary/25 hover:bg-primary/15 rounded-md px-2 py-1 transition-colors"
        >
          <Plus size={12} /> Save chart
        </button>
      )}

      {open && (
        <div className="absolute right-0 mt-2 w-80 bg-background border border-border rounded-xl shadow-xl p-4 z-20 space-y-3">
          <div>
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">
              Title
            </label>
            <input
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder={defaultTitle ?? 'Chart title'}
              className="w-full bg-secondary border border-border rounded-md px-2 py-1.5 text-sm mt-1 outline-none focus:ring-1 focus:ring-indigo-500"
              autoFocus
            />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">
              Description
            </label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              rows={2}
              className="w-full bg-secondary border border-border rounded-md px-2 py-1.5 text-xs mt-1 outline-none focus:ring-1 focus:ring-indigo-500 resize-none"
            />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={() => setOpen(false)}
              className="text-xs text-muted-foreground hover:text-foreground px-2 py-1"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="text-xs bg-indigo-500 hover:bg-indigo-600 disabled:opacity-50 text-white rounded-md px-3 py-1"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
