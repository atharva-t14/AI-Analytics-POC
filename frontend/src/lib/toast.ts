export type ToastType = 'success' | 'error' | 'info'

export interface ToastPayload {
  type?: ToastType
  title: string
  detail?: string
}

const TOAST_EVENT = 'analytics-toast'

export function showToast(payload: ToastPayload): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<ToastPayload>(TOAST_EVENT, { detail: payload }))
}

export function getToastEventName(): string {
  return TOAST_EVENT
}
