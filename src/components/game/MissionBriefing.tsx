'use client'
/**
 * MissionBriefing — pre-mission modal. Opened from the Mission Board
 * (menu or pause) or by clicking the HUD "Start Mission" prompt.
 * Start flow is owned by GameShell: if the engine is booted it calls
 * engine.startMission directly; otherwise it boots the engine on the
 * mission's home level and starts the mission right after start().
 */
import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Coins,
  Crosshair,
  Lock,
  Package,
  Play,
  Star,
  Timer,
  X,
} from 'lucide-react'
import { engineRef, useGameStore } from '@/game/state'
import { DIFFICULTY_STYLES, formatMoney, getLiveMissions } from './engineViews'
import type { AvailableMission } from '@/game/gameplay/MissionSystem'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'

export default function MissionBriefing({
  onStart,
  onCancel,
}: {
  /** Returns 'booting' when the engine needs to boot first (modal closes),
   *  or the startMission result when the engine is live (error keeps it open). */
  onStart: (missionId: string) => { ok: boolean; message?: string } | 'booting'
  onCancel: () => void
}) {
  const missionId = useGameStore((s) => s.briefingMissionId)
  const content = useGameStore((s) => s.content)
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState<AvailableMission | null>(null)

  // Live extras (hustle fatigue + race best time) straight from the
  // mission system — the static content bundle can't know them.
  useEffect(() => {
    if (!missionId) return
    const read = (): void => {
      const engine = engineRef.current
      setLive(engine ? getLiveMissions(engine).find((m) => m.id === missionId) ?? null : null)
    }
    read()
    const poll = window.setInterval(read, 1000)
    return () => window.clearInterval(poll)
  }, [missionId])

  const mission = missionId ? content?.missions.find((m) => m.id === missionId) ?? null : null

  if (!missionId || !mission) return null

  const difficultyCls = DIFFICULTY_STYLES[mission.difficulty] ?? ''
  const sideRange =
    mission.rewardMoneyMin != null &&
    mission.rewardMoneyMax != null &&
    mission.rewardMoneyMax > mission.rewardMoneyMin

  const start = (): void => {
    const result = onStart(mission.id)
    if (result === 'booting') return // modal closes, boot overlay takes over
    if (!result.ok) setError(result.message ?? 'Cannot start this mission')
  }

  return (
    <div
      className="fixed inset-0 z-[55] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={`Mission briefing: ${mission.name}`}
    >
      <motion.div
        initial={{ opacity: 0, y: 24, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.22, ease: 'easeOut' }}
        className="w-full max-w-lg overflow-hidden rounded-2xl border border-zinc-700/80 bg-zinc-950/95 shadow-2xl shadow-black"
      >
        {/* header */}
        <div className="flex items-start justify-between gap-3 border-b border-zinc-800 bg-gradient-to-r from-amber-500/10 via-transparent to-transparent p-4 sm:p-5">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-amber-400">
              Mission Briefing
            </p>
            <h3 className="mt-0.5 text-xl font-black text-zinc-50">{mission.name}</h3>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <Badge
                variant="outline"
                className={`px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${difficultyCls}`}
              >
                {mission.difficulty}
              </Badge>
              {mission.isSide && (
                <Badge
                  variant="outline"
                  className="border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-amber-300"
                >
                  side mission
                </Badge>
              )}
              {mission.repeatable && (
                <Badge
                  variant="outline"
                  className="border-zinc-700 px-2 py-0.5 text-[10px] uppercase tracking-wider text-zinc-400"
                >
                  repeatable
                </Badge>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
            aria-label="Close briefing"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <ScrollArea className="max-h-[46vh]">
          <div className="space-y-4 p-4 sm:p-5">
            <p className="text-sm leading-relaxed text-zinc-300">{mission.description}</p>

            {/* objectives */}
            <section aria-label="Objectives">
              <h4 className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.2em] text-zinc-400">
                <Crosshair className="h-3 w-3 text-emerald-400" aria-hidden="true" /> Objectives
              </h4>
              <ul className="space-y-1">
                {mission.objectives.map((o, i) => (
                  <li key={o.id} className="flex items-start gap-2 text-xs text-zinc-300">
                    {i === 0 ? (
                      <Circle className="mt-0.5 h-3 w-3 shrink-0 fill-emerald-400/30 text-emerald-400" aria-hidden="true" />
                    ) : (
                      <Circle className="mt-0.5 h-3 w-3 shrink-0 text-zinc-600" aria-hidden="true" />
                    )}
                    <span>
                      {o.description}
                      {o.type === 'race' && o.opponents != null && o.opponents > 0 && (
                        <span className="ml-1.5 rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] font-bold text-amber-300">
                          🏁 vs {o.opponents} AI rivals
                        </span>
                      )}
                      {o.timeLimit != null && (
                        <span className="ml-1.5 font-mono text-[10px] text-amber-500/90">
                          ({Math.floor(o.timeLimit / 60)}:{String(o.timeLimit % 60).padStart(2, '0')})
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            {/* rewards + requirements */}
            <div className="grid gap-3 sm:grid-cols-2">
              <section
                className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3"
                aria-label="Rewards"
              >
                <h4 className="mb-1 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.2em] text-emerald-400">
                  <Coins className="h-3 w-3" aria-hidden="true" /> Reward
                </h4>
                {sideRange ? (
                  <p className="font-mono text-sm font-bold tabular-nums text-emerald-300">
                    {formatMoney(mission.rewardMoneyMin ?? 0)} – {formatMoney(mission.rewardMoneyMax ?? 0)}
                    <span className="ml-1 text-[10px] font-normal text-emerald-500/80">random</span>
                  </p>
                ) : (
                  <p className="font-mono text-sm font-bold tabular-nums text-emerald-300">
                    {formatMoney(mission.rewardMoney)}
                  </p>
                )}
                <p className="mt-0.5 flex items-center gap-1 font-mono text-xs text-amber-400">
                  <Star className="h-3 w-3" aria-hidden="true" /> +{mission.rewardXp} XP
                </p>
                {live && live.payMultiplier < 1 && (
                  <p className="mt-1.5 flex items-center gap-1.5 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-1 font-mono text-[10px] tabular-nums text-amber-300">
                    <Timer className="h-3 w-3 shrink-0" aria-hidden="true" />
                    run #{live.repeatCount + 1} · pays {Math.round(live.payMultiplier * 100)}%
                  </p>
                )}
                {live?.bestTime != null && (
                  <p className="mt-1.5 flex items-center gap-1.5 rounded border border-zinc-700/60 bg-zinc-900/60 px-1.5 py-1 font-mono text-[10px] tabular-nums text-zinc-300">
                    <Star className="h-3 w-3 shrink-0 text-amber-400" aria-hidden="true" />
                    your best: {live.bestTime < 60
                      ? `${live.bestTime.toFixed(1)}s`
                      : `${Math.floor(live.bestTime / 60)}m ${Math.floor(live.bestTime % 60)}s`}
                  </p>
                )}
              </section>
              <section
                className="rounded-lg border border-zinc-700/60 bg-zinc-900/60 p-3"
                aria-label="Required items"
              >
                <h4 className="mb-1 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.2em] text-zinc-400">
                  <Package className="h-3 w-3" aria-hidden="true" /> Required
                </h4>
                {mission.requiredItems.length > 0 ? (
                  <ul className="space-y-0.5">
                    {mission.requiredItems.map((item) => (
                      <li key={item} className="font-mono text-xs text-zinc-300">
                        {item.replace(/_/g, ' ')}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-zinc-500">No special requirements</p>
                )}
              </section>
            </div>

            {error && (
              <p
                role="alert"
                className="flex items-center gap-2 rounded-lg border border-rose-500/50 bg-rose-500/10 p-2.5 text-xs text-rose-300"
              >
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> {error}
              </p>
            )}
          </div>
        </ScrollArea>

        {/* actions */}
        <div className="flex items-center justify-end gap-2 border-t border-zinc-800 bg-zinc-900/50 p-4">
          <Button
            variant="outline"
            onClick={onCancel}
            className="border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
          >
            Cancel
          </Button>
          <Button
            onClick={start}
            className="bg-emerald-600 font-bold text-white shadow-lg shadow-emerald-950 hover:bg-emerald-500"
          >
            <Play className="mr-1.5 h-4 w-4" aria-hidden="true" /> Start Mission
          </Button>
        </div>
      </motion.div>
    </div>
  )
}
