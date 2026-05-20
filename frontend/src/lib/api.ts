import axios from 'axios'
import { MetricSummary } from '../types/analytics'

export const api = axios.create({
  baseURL: 'http://127.0.0.1:8000'
})

export const getMetrics = async (): Promise<MetricSummary[]> => {
  const res = await api.get<{ metrics: MetricSummary[] }>('/metrics')
  return res.data.metrics ?? []
}

// Simple session management
export const getSessionId = (): string => {
  if (typeof window === 'undefined') return ''
  let sessionId = localStorage.getItem('analytics_session_id')
  if (!sessionId) {
    sessionId = Math.random().toString(36).substring(2, 15)
    localStorage.setItem('analytics_session_id', sessionId)
  }
  return sessionId
}