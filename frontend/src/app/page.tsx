'use client'

import { useState, useEffect, useRef } from 'react'
import { api, getMetrics, getSessionId } from '@/src/lib/api'
import { QueryResponse, MetricSummary } from '@/src/types/analytics'
import ChatInput from '@/src/components/ChatInput'
import ChatMessage from '@/src/components/ChatMessage'
import MetricsSidebar from '@/src/components/MetricsSidebar'

interface Message {
  role: 'user' | 'assistant'
  content?: string
  response?: QueryResponse
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([
    {
      role: 'assistant',
      content: 'Welcome! I can help you analyze your recruitment data. Try asking about "recruiter performance" or "hiring pipeline".'
    }
  ])
  const [metrics, setMetrics] = useState<MetricSummary[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [sessionId, setSessionId] = useState('')
  const [accountId, setAccountId] = useState(5) // Default test account
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Initialize session and fetch metrics catalog
    setSessionId(getSessionId())
    fetchMetrics()
  }, [])

  useEffect(() => {
    // Scroll to bottom on new messages
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  const fetchMetrics = async () => {
    try {
      const data = await getMetrics()
      setMetrics(data)
    } catch (err) {
      console.error('Failed to fetch metrics:', err)
    }
  }

  const handleQuery = async (text: string) => {
    // Add user message
    const userMsg: Message = { role: 'user', content: text }
    setMessages(prev => [...prev, userMsg])
    setIsLoading(true)

    try {
      const res = await api.post<QueryResponse>('/query', {
        message: text,
        account_id: accountId,
        session_id: sessionId
      })

      console.log('API Response:', res.data)

      const aiMsg: Message = {
        role: 'assistant',
        response: res.data
      }
      setMessages(prev => [...prev, aiMsg])
    } catch (error: any) {
      const aiMsg: Message = {
        role: 'assistant',
        response: {
          error: error.response?.data?.error || 'Failed to connect to the analytics engine.'
        }
      }
      setMessages(prev => [...prev, aiMsg])
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      {/* Left Sidebar */}
      <MetricsSidebar 
        metrics={metrics} 
        onMetricClick={handleQuery} 
      />

      {/* Main Chat Area */}
      <main className="flex-1 flex flex-col relative">
        {/* Header Decoration & Account Selector */}
        <div className="absolute top-0 inset-x-0 h-40 bg-gradient-to-b from-indigo-500/5 to-transparent pointer-events-none" />
        
        <div className="absolute top-6 right-6 z-20 flex items-center gap-3">
          <div className="flex flex-col items-end">
            <span className="text-[10px] text-muted-foreground font-bold uppercase tracking-widest">Active Account</span>
            <div className="flex items-center gap-2 bg-background/50 backdrop-blur-md border border-border rounded-lg px-2 py-1 shadow-sm">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-indigo-400"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
              <input 
                type="number" 
                value={accountId}
                onChange={(e) => setAccountId(parseInt(e.target.value) || 5)}
                className="bg-transparent border-none outline-none text-sm font-semibold w-20 text-foreground text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
            </div>
          </div>
        </div>

        {/* Messages Thread */}
        <div 
          ref={scrollRef}
          className="flex-1 overflow-y-auto px-6 py-10 space-y-2 relative scroll-smooth custom-scrollbar"
        >
          <div className="max-w-4xl mx-auto w-full">
            {messages.map((msg, idx) => (
              <ChatMessage
                key={idx}
                role={msg.role}
                content={msg.content}
                response={msg.response}
                onSuggestionClick={handleQuery}
              />
            ))}
            
            {isLoading && (
              <div className="flex justify-start mb-6 animate-pulse">
                <div className="chat-bubble-ai rounded-2xl px-6 py-4 border border-border flex items-center gap-2">
                  <div className="flex gap-1">
                    <span className="w-1.5 h-1.5 bg-indigo-500 rounded-full animate-bounce [animation-delay:-0.3s]"></span>
                    <span className="w-1.5 h-1.5 bg-indigo-500 rounded-full animate-bounce [animation-delay:-0.15s]"></span>
                    <span className="w-1.5 h-1.5 bg-indigo-500 rounded-full animate-bounce"></span>
                  </div>
                  <span className="text-xs text-muted-foreground font-medium ml-2">Analysing data...</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Input Bar */}
        <div className="p-6 border-t border-border bg-background/80 backdrop-blur-md relative z-10">
          <div className="max-w-4xl mx-auto">
            <ChatInput 
              onSubmit={handleQuery} 
              isLoading={isLoading} 
            />
            <p className="mt-4 text-center text-[10px] text-muted-foreground">
              Built for Recruit CRM &bull; Enterprise-grade AI Analytics POC
            </p>
          </div>
        </div>
      </main>
    </div>
  )
}