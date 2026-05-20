'use client'

import { useState, useEffect } from 'react'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  LineChart,
  Line,
  CartesianGrid,
  Legend
} from 'recharts'

interface Props {
  type: string
  data: {
    label?: string
    value?: number
    [key: string]: any
  }[]
  config?: {
    xLabel?: string
    yLabel?: string
  }
}

const COLORS = ['#6366f1', '#818cf8', '#a5b4fc', '#c7d2fe', '#e0e7ff', '#4f46e5', '#4338ca'];

export default function ChartRenderer({ type, data, config }: Props) {
  const [hasMounted, setHasMounted] = useState(false)

  useEffect(() => {
    setHasMounted(true)
  }, [])

  console.log('ChartRenderer Props:', { type, data, config })
  if (!hasMounted) return <div className="w-full h-[350px] bg-secondary/20 animate-pulse rounded-lg" />
  if (!data || data.length === 0) return <div className="h-full flex items-center justify-center text-muted-foreground">No data available</div>

  const renderChart = () => {
    switch (type.toLowerCase()) {
      case 'pie':
      case 'donut':
        return (
          <PieChart>
            <Pie
              data={data}
              innerRadius={type === 'donut' ? 60 : 0}
              outerRadius={100}
              paddingAngle={5}
              dataKey="value"
              nameKey="label"
              label={(entry: any) => entry.name}
            >
              {data.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} stroke="rgba(0,0,0,0.1)" />
              ))}
            </Pie>
            <Tooltip 
              contentStyle={{ backgroundColor: '#161617', border: '1px solid #27272a', borderRadius: '8px' }}
              itemStyle={{ color: '#f8fafc' }}
            />
          </PieChart>
        )
      
      case 'line':
        return (
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
            <XAxis 
              dataKey="label" 
              stroke="#94a3b8" 
              fontSize={12} 
              tickLine={false} 
              axisLine={false}
            />
            <YAxis 
              stroke="#94a3b8" 
              fontSize={12} 
              tickLine={false} 
              axisLine={false}
              tickFormatter={(value) => `${value}`}
            />
            <Tooltip 
              contentStyle={{ backgroundColor: '#161617', border: '1px solid #27272a', borderRadius: '8px' }}
              itemStyle={{ color: '#f8fafc' }}
            />
            <Line 
              type="monotone" 
              dataKey="value" 
              stroke="#6366f1" 
              strokeWidth={3} 
              dot={{ r: 4, fill: '#6366f1', strokeWidth: 2, stroke: '#0d0d0e' }}
              activeDot={{ r: 6, strokeWidth: 0 }}
            />
          </LineChart>
        )

      case 'table':
        {
          const headers = Object.keys(data[0] || {}).filter(k => k !== 'job_id');
          const getHeaderLabel = (key: string) => {
            switch (key) {
              case 'firstname': return 'First Name'
              case 'lastname': return 'Last Name'
              case 'emailid': return 'Email'
              case 'contactnumber': return 'Phone'
              case 'job_name': return 'Job'
              case 'stage': return 'Stage'
              case 'days_in_stage': return 'Days in Stage'
              default: return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
            }
          }
          return (
            <div className="overflow-x-auto w-full max-h-[320px] border border-zinc-800 rounded-lg">
              <table className="min-w-full divide-y divide-zinc-800 text-sm">
                <thead className="bg-[#121214] sticky top-0 z-10">
                  <tr>
                    {headers.map(h => (
                      <th key={h} className="px-4 py-3 text-left font-semibold text-zinc-400 uppercase tracking-wider text-xs">
                        {getHeaderLabel(h)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/50 bg-[#09090b]">
                  {data.map((row, idx) => (
                    <tr key={idx} className="hover:bg-zinc-800/30 transition-colors">
                      {headers.map(h => (
                        <td key={h} className="px-4 py-3 text-zinc-300 whitespace-nowrap">
                          {String(row[h] ?? '')}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }

      case 'bar':
      default:
        return (
          <BarChart data={data} layout={data.length > 8 ? 'vertical' : 'horizontal'}>
            <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
            {data.length > 8 ? (
               <>
                 <XAxis type="number" stroke="#94a3b8" fontSize={12} tickLine={false} axisLine={false} />
                 <YAxis dataKey="label" type="category" stroke="#94a3b8" fontSize={12} tickLine={false} axisLine={false} width={100} />
               </>
            ) : (
              <>
                <XAxis dataKey="label" stroke="#94a3b8" fontSize={12} tickLine={false} axisLine={false} />
                <YAxis stroke="#94a3b8" fontSize={12} tickLine={false} axisLine={false} />
              </>
            )}
            <Tooltip 
              cursor={{ fill: 'rgba(255,255,255,0.05)' }}
              contentStyle={{ backgroundColor: '#161617', border: '1px solid #27272a', borderRadius: '8px' }}
              itemStyle={{ color: '#f8fafc' }}
            />
            <Bar 
              dataKey="value" 
              fill="#6366f1" 
              radius={data.length > 8 ? [0, 4, 4, 0] : [4, 4, 0, 0]} 
              barSize={30}
            />
          </BarChart>
        )
    }
  }

  if (type.toLowerCase() === 'table') {
    return (
      <div className="w-full relative min-w-0">
        {renderChart()}
      </div>
    )
  }

  return (
    <div className="w-full h-[350px] relative min-w-0">
      <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0} debounce={100}>
        {renderChart()}
      </ResponsiveContainer>
    </div>
  )
}