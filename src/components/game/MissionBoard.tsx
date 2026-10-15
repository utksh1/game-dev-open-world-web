'use client'
/**
 * MissionBoard — mission list used by both the main menu (no engine: the
 * campaign unlock chain is replicated client-side from the content bundle
 * + the completed set of the latest save) and the pause menu (engine
 * running: authoritative statuses polled from the live MissionSystem).
 * Clicking an available mission opens the MissionBriefing modal.
 */
import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Clock, Coins, Lock, Repeat, Star, Zap } from 'lucide-react'
import { engineRef, useGameStore } from '@/game/state'
import {
  DIFFICULTY_STYLES,
  getLiveMissions,
  resolveMissionListings,
  type MissionListing,
} from './engineViews'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'

const STATUS_STYLES: Record<string, { cls: string; label: string }> = {
  available: { cls: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300', label: 'Available' },
  active: { cls: 'border-amber-500/50 bg-amber-500/10 text-amber-300', label: 'Active' },
  locked: { cls: 'border-zinc-700 bg-zinc-800/50 text-zinc-500', label: 'Locked' },
  completed: { cls: 'border-zinc-700 bg-zinc-800/50 text-zinc-400', label: 'Completed' },
  failed: { cls: 'border-rose-500/50 bg-rose-500/10 text-rose-300', label: 'Failed' },
}

function rewardText(m: { rewardMoney: number; rewardMoneyMin?: number; rewardMoneyMax?: number; rewardXp: number }): string {
  if (m.rewardMoneyMin != null && m.rewardMoneyMax != null && m.rewardMoneyMax > m.rewardMoneyMin) {
    return `$${m.rewardMoneyMin.toLocaleString()}–${m.rewardMoneyMax.toLocaleString()} · ${m.rewardXp} XP`
  }
  return `$${m.rewardMoney.toLocaleString()} · ${m.rewardXp} XP`
}

export default function MissionBoard({
  onSelect,
  completedIds,
  maxHeight = '22rem',
}: {
  onSelect: (missionId: string) => void
  /** Completed mission ids when NO engine is running (menu board). */
  completedIds?: ReadonlySet<string>
  maxHeight?: string
}) {
  const content = useGameStore((s) => s.content)
  const contentLoading = useGameStore((s) => s.contentLoading)
  const [listings, setListings] = useState<MissionListing[] | null>(null)

  useEffect(() => {
    const compute = (): void => {
      const engine = engineRef.current
      if (engine) {
        // Live engine → authoritative statuses from the MissionSystem.
        setListings(
          getLiveMissions(engine).map((m) => ({
            ...m,
            objectives: [],
            unlockRequirement: null,
          })),
        )
        return
      }
      setListings(resolveMissionListings(content, completedIds ?? new Set()))
    }
    compute()
    const poll = window.setInterval(compute, 1000)
    return () => window.clearInterval(poll)
  }, [content, completedIds])

  const { campaign, side } = useMemo(() => {
    const l = listings ?? []
    const campaignOrder = content?.campaign?.missions.map((m) => m.id) ?? []
    const campaignMissions = l
      .filter((m) => !m.isSide)
      .sort((a, b) => {
        const ia = campaignOrder.indexOf(a.id)
        const ib = campaignOrder.indexOf(b.id)
        return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib)
      })
    return { campaign: campaignMissions, side: l.filter((m) => m.isSide) }
  }, [listings, content])

  if (contentLoading || (!listings && contentLoading)) {
    return (
      <div className="space-y-2 p-1" aria-busy="true">
        <Skeleton className="h-12 w-full bg-zinc-800" />
        <Skeleton className="h-12 w-full bg-zinc-800" />
        <Skeleton className="h-12 w-full bg-zinc-800" />
      </div>
    )
  }

  const renderRow = (m: MissionListing) => {
    const status = STATUS_STYLES[m.status] ?? STATUS_STYLES.available
    const clickable = m.status === 'available' || m.status === 'failed'
    return (
      <button
        key={m.id}
        type="button"
        disabled={!clickable}
        onClick={() => clickable && onSelect(m.id)}
        className={`w-full rounded-lg border p-3 text-left transition-colors ${
          clickable
            ? 'border-zinc-700/80 bg-zinc-900/70 hover:border-emerald-500/50 hover:bg-zinc-800/70'
            : 'cursor-not-allowed border-zinc-800/60 bg-zinc-950/40 opacity-60'
        }`}
        aria-label={`Mission ${m.name}: ${status.label}`}
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-semibold text-zinc-100">{m.name}</span>
          <Badge variant="outline" className={`px-1.5 py-0 text-[9px] uppercase tracking-wider ${DIFFICULTY_STYLES[m.difficulty] ?? ''}`}>
            {m.difficulty}
          </Badge>
          {m.isSide && (
            <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 px-1.5 py-0 text-[9px] uppercase tracking-wider text-amber-300">
              side
            </Badge>
          )}
          {m.repeatable && <Repeat className="h-3 w-3 text-zinc-500" aria-label="Repeatable" />}
          <span className={`ml-auto inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${status.cls}`}>
            {m.status === 'locked' ? <Lock className="h-2.5 w-2.5" aria-hidden="true" /> : null}
            {m.status === 'completed' ? <CheckCircle2 className="h-2.5 w-2.5" aria-hidden="true" /> : null}
            {status.label}
          </span>
        </div>
        <p className="mt-1 line-clamp-1 text-xs text-zinc-400">{m.description}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px] tabular-nums text-zinc-500">
          <span className="flex items-center gap-1 text-emerald-400/90">
            <Coins className="h-3 w-3" aria-hidden="true" /> {rewardText(m)}
          </span>
          <span className="flex items-center gap-1">
            <Star className="h-3 w-3 text-amber-500/80" aria-hidden="true" />
            {m.objectives?.length ?? 0} objectives
          </span>
          {m.timeLimit != null && (
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" aria-hidden="true" />
              {Math.floor(m.timeLimit / 60)}:{String(m.timeLimit % 60).padStart(2, '0')}
            </span>
          )}
          {m.status === 'locked' && m.unlockRequirement && (
            <span className="text-zinc-600">complete “{m.unlockRequirement}” first</span>
          )}
        </div>
      </button>
    )
  }

  return (
    <ScrollArea className="pr-2" style={{ maxHeight }}>
      <div className="space-y-4 p-1">
        <section aria-label="Campaign missions">
          <h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.2em] text-amber-400">
            <Zap className="h-3 w-3" aria-hidden="true" /> Campaign
          </h4>
          <div className="space-y-2">{campaign.map(renderRow)}</div>
        </section>
        <section aria-label="Side missions">
          <h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.2em] text-emerald-400">
            <Repeat className="h-3 w-3" aria-hidden="true" /> Side Missions
          </h4>
          <div className="space-y-2">{side.map(renderRow)}</div>
        </section>
        {listings?.length === 0 && (
          <p className="p-4 text-center text-sm text-zinc-500">No missions in the content bundle.</p>
        )}
      </div>
    </ScrollArea>
  )
}
