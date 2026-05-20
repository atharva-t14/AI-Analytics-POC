'use client'

import { useState, KeyboardEvent } from 'react'

interface Props {
  onSubmit: (message: string) => void
  isLoading: boolean
}

export default function ChatInput({ onSubmit, isLoading }: Props) {
  const [message, setMessage] = useState('')

  const handleSubmit = () => {
    if (!message.trim() || isLoading) return
    onSubmit(message)
    setMessage('')
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  return (
    <div className="relative group">
      <div className="absolute -inset-0.5 bg-gradient-to-r from-indigo-500 to-purple-600 rounded-xl blur opacity-20 group-focus-within:opacity-40 transition duration-200"></div>
      <div className="relative flex items-end gap-2 bg-secondary border border-border p-2 rounded-xl focus-within:border-indigo-500/50 transition-colors">
        <textarea
          rows={1}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask about your recruitment data..."
          className="flex-1 bg-transparent border-none focus:ring-0 text-foreground placeholder:text-muted-foreground resize-none py-2 px-3 min-h-[44px] max-h-[200px]"
          style={{ height: 'auto' }}
          onInput={(e) => {
            const target = e.target as HTMLTextAreaElement;
            target.style.height = 'auto';
            target.style.height = `${target.scrollHeight}px`;
          }}
        />

        <button
          onClick={handleSubmit}
          disabled={!message.trim() || isLoading}
          className="flex items-center justify-center bg-primary hover:bg-indigo-600 disabled:opacity-50 disabled:hover:bg-primary text-white w-10 h-10 rounded-lg transition-all"
        >
          {isLoading ? (
            <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m22 2L11 13"/><path d="m22 2-7 20-4-9-9-4Z"/></svg>
          )}
        </button>
      </div>
      <div className="mt-2 text-[10px] text-muted-foreground px-1 flex justify-between">
        <span>Press Enter to send, Shift+Enter for new line</span>
        <span>Powered by Groq LLM</span>
      </div>
    </div>
  )
}