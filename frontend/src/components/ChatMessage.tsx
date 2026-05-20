'use client'

import { QueryResponse } from '../types/analytics'
import ChartRenderer from './ChartRenderer'

interface Props {
  role: 'user' | 'assistant'
  content?: string
  response?: QueryResponse
  onSuggestionClick?: (suggestion: string) => void
}

export default function ChatMessage({ role, content, response, onSuggestionClick }: Props) {
  const isAI = role === 'assistant'

  return (
    <div className={`flex ${isAI ? 'justify-start' : 'justify-end'} mb-6 animate-in`}>
      <div className={`max-w-[85%] ${isAI ? 'w-full' : ''}`}>
        {!isAI ? (
          <div className="chat-bubble-user px-4 py-3 rounded-2xl rounded-tr-none select-text whitespace-pre-wrap break-words leading-relaxed">
            {content}
          </div>
        ) : (
          <div className="space-y-4">
            {/* Main AI Response Card */}
            <div className="chat-bubble-ai rounded-2xl p-6 shadow-sm select-text">
              {response?.error ? (
                <div className="text-destructive flex items-center gap-2">
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                  <span>{response.error}</span>
                </div>
              ) : response?.is_clarification ? (
                <div className="space-y-4">
                  <div className="flex items-center gap-2 text-indigo-400">
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                    <span className="text-xs font-bold uppercase tracking-wider">Clarification Needed</span>
                  </div>
                  <p className="text-foreground leading-relaxed">
                    {response.message}
                  </p>
                  {response.options && response.options.length > 0 && onSuggestionClick && (
                    <div className="flex flex-wrap gap-2 pt-2">
                      {response.options.map((option, idx) => (
                        <button
                          key={idx}
                          onClick={() => onSuggestionClick(option)}
                          className="text-xs bg-indigo-500/10 border border-indigo-500/20 hover:border-indigo-500/50 hover:bg-indigo-500/20 text-indigo-400 px-3 py-1.5 rounded-full transition-all"
                        >
                          {option}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-6">
                  {/* Header */}
                  {response?.title && (
                    <div className="flex items-center justify-between">
                      <h3 className="text-lg font-semibold text-foreground">{response.title}</h3>
                      {response.used_fallback && (
                        <span className="text-[10px] bg-amber-500/10 text-amber-500 px-2 py-0.5 rounded border border-amber-500/20">
                          Fallback Mode
                        </span>
                      )}
                    </div>
                  )}

                  {/* Chart Section */}
                  {response?.chart && (
                    <div className="bg-[#0d0d0e] rounded-xl p-4 border border-border/50">
                      <ChartRenderer 
                        type={response.chart.type} 
                        data={response.chart.data} 
                        config={response.chart.config}
                      />
                    </div>
                  )}

                  {/* Insights Section */}
                  {response?.insight && (
                    <div className="bg-indigo-500/5 border border-indigo-500/10 rounded-xl p-4">
                      <div className="flex items-center gap-2 mb-2 text-indigo-400">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
                        <span className="text-xs font-bold uppercase tracking-wider">Insight</span>
                      </div>
                      <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">
                        {response.insight}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Suggestions Chips */}
            {response?.suggestions && response.suggestions.length > 0 && onSuggestionClick && (
              <div className="flex flex-wrap gap-2 px-1">
                {response.suggestions.map((suggestion, idx) => (
                  <button
                    key={idx}
                    onClick={() => onSuggestionClick(suggestion)}
                    className="text-xs bg-secondary border border-border hover:border-indigo-500/50 hover:bg-indigo-500/5 text-muted-foreground hover:text-indigo-400 px-3 py-1.5 rounded-full transition-all"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
