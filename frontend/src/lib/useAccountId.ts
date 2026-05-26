'use client'

import { useEffect, useState } from 'react'
import { DEFAULT_ACCOUNT_ID, getAccountId, setAccountId as persistAccountId } from '../lib/api'

const EVENT = 'analytics-account-changed'

/**
 * Reactive accessor for the current account ID. Synced across pages via a
 * window-level custom event, so the AppNav input updates every page mounted
 * in the same tab without a full reload.
 */
export function useAccountId(): [number, (id: number) => void] {
  const [accountId, setLocal] = useState<number>(DEFAULT_ACCOUNT_ID)

  useEffect(() => {
    setLocal(getAccountId())
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<number>).detail
      if (typeof detail === 'number') setLocal(detail)
    }
    window.addEventListener(EVENT, handler)
    return () => window.removeEventListener(EVENT, handler)
  }, [])

  const set = (id: number) => {
    persistAccountId(id)
    setLocal(id)
    window.dispatchEvent(new CustomEvent<number>(EVENT, { detail: id }))
  }

  return [accountId, set]
}
