'use client'

import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Info, XCircle } from 'lucide-react'
import { getToastEventName, ToastPayload, ToastType } from '@/src/lib/toast'

interface ToastItem {
  id: string
  title: string
  detail?: string
  type: ToastType
}

const TTL_MS = 3200

function iconFor(type: ToastType) {
  if (type === 'success') return CheckCircle2
  if (type === 'error') return XCircle
  return Info
}

function classesFor(type: ToastType): string {
  if (type === 'success') return 'border-emerald-400/40 bg-emerald-500/10 text-emerald-100'
  if (type === 'error') return 'border-rose-400/40 bg-rose-500/10 text-rose-100'
  return 'border-indigo-400/40 bg-indigo-500/10 text-indigo-100'
}

export default function ToastViewport() {
  const [items, setItems] = useState<ToastItem[]>([])

  useEffect(() => {
    const handler = (ev: Event) => {
      const custom = ev as CustomEvent<ToastPayload>
      const payload = custom.detail
      if (!payload?.title) return

      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const next: ToastItem = {
        id,
        title: payload.title,
        detail: payload.detail,
        type: payload.type || 'info',
      }
      setItems(prev => [...prev, next])

      window.setTimeout(() => {
        setItems(prev => prev.filter(t => t.id !== id))
      }, TTL_MS)
    }

    const eventName = getToastEventName()
    window.addEventListener(eventName, handler as EventListener)
    return () => window.removeEventListener(eventName, handler as EventListener)
  }, [])

  const visible = useMemo(() => items.slice(-4), [items])

  if (visible.length === 0) return null

  return (
    <div className="fixed right-4 bottom-4 z-[70] flex flex-col gap-2 pointer-events-none">
      {visible.map(item => {
        const Icon = iconFor(item.type)
        return (
          <div
            key={item.id}
            className={`min-w-[240px] max-w-[360px] rounded-lg border px-3 py-2 shadow-lg backdrop-blur-md ${classesFor(item.type)}`}
          >
            <div className="flex items-start gap-2">
              <Icon size={16} className="mt-0.5 shrink-0" />
              <div>
                <p className="text-xs font-semibold leading-snug">{item.title}</p>
                {item.detail && <p className="text-[11px] opacity-90 mt-0.5 leading-snug">{item.detail}</p>}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
