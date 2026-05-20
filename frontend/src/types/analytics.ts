export interface ChartDataItem {
  label: string
  value: number
}

export interface ChartConfig {
  xLabel: string
  yLabel: string
}

export interface QueryIntent {
  metric: string
  metric_label: string
  dimensions: string[]
  filters: any[]
  chart_type: string
}

export interface QueryResponse {
  chart?: {
    type: string
    data: ChartDataItem[]
    config: ChartConfig
  }
  title?: string
  insight?: string
  intent?: QueryIntent
  suggestions?: string[]
  error?: string
  used_fallback?: boolean
  
  // New fields for clarification flow
  is_clarification?: boolean
  message?: string
  options?: string[]
  confidence?: number
}

export interface MetricSummary {
  name: string
  display_name: string
  description: string
  category: string
  dimensions: string[]
  filters: string[]
  default_chart_type: string
  aliases: string[]
}