'use client'

import { Moon, Sun } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { DEFAULT_ACCOUNT_ID } from '@/src/lib/api'
import { useAccountId } from '@/src/lib/useAccountId'

const links = [
  { href: '/', label: 'Chat' },
  { href: '/builder', label: 'Builder' },
  { href: '/query', label: 'Query Builder' },
  // { href: '/er-diagram', label: 'ER Diagram' },
  { href: '/charts', label: 'Saved Charts' },
  { href: '/dashboard', label: 'Dashboards' },
]

export default function AppNav() {
  const pathname = usePathname()
  const [accountId, setAccountId] = useAccountId()
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')

  useEffect(() => {
    const root = document.documentElement
    const active = root.dataset.theme === 'light' ? 'light' : 'dark'
    setTheme(active)
  }, [])

  const handleAccountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = parseInt(e.target.value, 10) || DEFAULT_ACCOUNT_ID
    setAccountId(next)
  }

  const toggleTheme = () => {
    const next: 'dark' | 'light' = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    document.documentElement.dataset.theme = next
    localStorage.setItem('analytics_theme', next)
  }

  return (
    <header className="h-14 border-b border-border bg-background/80 backdrop-blur-md flex items-center px-6 gap-6 sticky top-0 z-30">
      <Link href="/" className="flex items-center gap-2 font-bold text-sm tracking-tight">
        <span className="w-7 h-7 rounded-lg bg-indigo-500 flex items-center justify-center text-white text-xs">RC</span>
        RecruitCRM AI
      </Link>
      <nav className="flex items-center gap-1 text-sm">
        {links.map(l => {
          const active = l.href === '/' ? pathname === '/' : pathname.startsWith(l.href)
          return (
            <Link
              key={l.href}
              href={l.href}
              className={`px-3 py-1.5 rounded-md transition-colors ${
                active
                  ? 'bg-primary/15 text-accent-strong'
                  : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
              }`}
            >
              {l.label}
            </Link>
          )
        })}
      </nav>
      <div className="ml-auto flex items-center gap-2">
        <button
          onClick={toggleTheme}
          className="inline-flex items-center gap-1.5 bg-background border border-border rounded-md px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? <Sun size={13} /> : <Moon size={13} />}
          <span>{theme === 'dark' ? 'Light' : 'Dark'}</span>
        </button>
        <span className="text-[10px] uppercase tracking-widest text-muted-foreground font-bold">Account</span>
        <input
          type="number"
          value={accountId}
          onChange={handleAccountChange}
          className="bg-background border border-border rounded-md px-2 py-1 text-xs w-24 text-center outline-none focus:ring-1 focus:ring-indigo-500 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
        />
      </div>
    </header>
  )
}
