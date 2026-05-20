'use client'

import { MetricSummary } from '../types/analytics'

interface Props {
  metrics: MetricSummary[]
  onMetricClick: (alias: string) => void
}

export default function MetricsSidebar({ metrics, onMetricClick }: Props) {
  const categories = Array.from(new Set(metrics.map(m => m.category)))

  return (
    <aside className="w-80 h-screen flex flex-col bg-secondary border-r border-border overflow-hidden">
      <div className="p-6 border-b border-border">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 bg-indigo-500 rounded-xl flex items-center justify-center shadow-lg shadow-indigo-500/20">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></svg>
          </div>
          <div>
            <h1 className="font-bold text-lg tracking-tight">RecruitCRM AI</h1>
            <p className="text-[10px] text-muted-foreground uppercase font-bold tracking-widest">Analytics Builder</p>
          </div>
        </div>

        <div className="relative">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          <input 
            type="text" 
            placeholder="Search metrics..." 
            className="w-full bg-background border border-border rounded-lg py-1.5 pl-9 pr-3 text-xs focus:ring-1 focus:ring-indigo-500 outline-none transition-all"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-8 custom-scrollbar">
        {categories.map(category => (
          <div key={category} className="space-y-3">
            <h3 className="px-2 text-[10px] font-bold text-muted-foreground uppercase tracking-[0.2em]">
              {category}
            </h3>
            <div className="space-y-1">
              {metrics
                .filter(m => m.category === category)
                .map(metric => (
                  <button
                    key={metric.name}
                    onClick={() => onMetricClick(metric.aliases?.[0] || metric.display_name || metric.name)}
                    className="w-full text-left p-3 rounded-xl hover:bg-background border border-transparent hover:border-border group transition-all"
                  >
                    <div className="font-medium text-sm text-foreground group-hover:text-indigo-400 mb-1 transition-colors">
                      {metric.display_name}
                    </div>
                    <p className="text-[11px] text-muted-foreground leading-relaxed line-clamp-2">
                      {metric.description}
                    </p>
                  </button>
                ))}
            </div>
          </div>
        ))}
      </div>

      <div className="p-4 border-t border-border">
        <div className="bg-indigo-500/5 border border-indigo-500/10 rounded-xl p-4">
          <p className="text-[11px] text-indigo-300 font-medium leading-relaxed">
            Tip: You can ask "Compare recruiter performance by month for Engineering"
          </p>
        </div>
      </div>
    </aside>
  )
}
