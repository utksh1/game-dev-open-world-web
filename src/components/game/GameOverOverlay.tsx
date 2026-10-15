'use client'
/**
 * GameOverOverlay — WASTED / BUSTED full-screen flashes (auto-hide after
 * ~3.2 s; the engine respawns the player after its own 3 s corpse pause)
 * and the persistent CAMPAIGN COMPLETE celebration screen.
 */
import { useEffect } from 'react'
import { motion } from 'framer-motion'
import { Home, PartyPopper, ShieldAlert, Trophy } from 'lucide-react'
import { useGameStore } from '@/game/state'
import { getLiveCompleted } from './engineViews'
import { engineRef } from '@/game/state'
import { Button } from '@/components/ui/button'

export default function GameOverOverlay({ onQuit }: { onQuit: () => void }) {
  const overlay = useGameStore((s) => s.overlay)
  const hud = useGameStore((s) => s.hud)
  const setOverlay = useGameStore((s) => s.setOverlay)

  // WASTED/BUSTED auto-hide — the engine's respawn timer clears the state.
  useEffect(() => {
    if (overlay !== 'wasted' && overlay !== 'busted') return
    const timer = window.setTimeout(() => setOverlay(null), 3200)
    return () => window.clearTimeout(timer)
  }, [overlay, setOverlay])

  if (!overlay) return null

  if (overlay === 'campaign') {
    const completed = getLiveCompleted(engineRef.current)
    return (
      <div
        className="absolute inset-0 z-[60] flex items-center justify-center bg-black/85 p-4 backdrop-blur-md"
        role="dialog"
        aria-modal="true"
        aria-label="Campaign complete"
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.92, y: 24 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.35, ease: 'easeOut' }}
          className="w-full max-w-md rounded-2xl border border-emerald-500/40 bg-zinc-950/95 p-6 text-center shadow-2xl shadow-emerald-950/60"
        >
          <PartyPopper className="mx-auto h-10 w-10 text-emerald-400" aria-hidden="true" />
          <h3 className="mt-3 text-2xl font-black tracking-[0.18em] text-emerald-300 sm:text-3xl">
            CAMPAIGN COMPLETE
          </h3>
          <p className="mt-1 text-xs text-zinc-400">
            Every campaign mission from the repo&apos;s <span className="font-mono text-emerald-500">campaign_main.campaign</span> is done.
          </p>
          {hud && (
            <div className="mt-4 grid grid-cols-3 gap-2 font-mono tabular-nums">
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-2.5">
                <p className="text-[9px] uppercase tracking-widest text-zinc-500">Money</p>
                <p className="text-base font-bold text-emerald-400">
                  ${(hud.player.money ?? 0).toLocaleString()}
                </p>
              </div>
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-2.5">
                <p className="text-[9px] uppercase tracking-widest text-zinc-500">XP</p>
                <p className="text-base font-bold text-amber-400">{hud.player.xp}</p>
              </div>
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-2.5">
                <p className="text-[9px] uppercase tracking-widest text-zinc-500">Missions</p>
                <p className="text-base font-bold text-zinc-100">{completed.size}</p>
              </div>
            </div>
          )}
          <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-center">
            <Button
              onClick={() => setOverlay(null)}
              className="bg-emerald-600 font-bold text-white hover:bg-emerald-500"
            >
              <Trophy className="mr-1.5 h-4 w-4" aria-hidden="true" /> Keep Playing
            </Button>
            <Button
              variant="outline"
              onClick={onQuit}
              className="border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
            >
              <Home className="mr-1.5 h-4 w-4" aria-hidden="true" /> Back to Menu
            </Button>
          </div>
        </motion.div>
      </div>
    )
  }

  const wasted = overlay === 'wasted'
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className={`pointer-events-none absolute inset-0 z-40 flex flex-col items-center justify-center ${
        wasted
          ? 'bg-[radial-gradient(ellipse_at_center,rgba(9,9,11,0.35)_0%,rgba(76,5,25,0.85)_100%)]'
          : 'bg-[radial-gradient(ellipse_at_center,rgba(9,9,11,0.35)_0%,rgba(69,45,3,0.85)_100%)]'
      }`}
      role="status"
      aria-live="assertive"
    >
      <motion.h2
        initial={{ scale: 1.6, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
        className={`text-5xl font-black tracking-[0.4em] sm:text-7xl ${
          wasted ? 'text-rose-500 drop-shadow-[0_0_24px_rgba(244,63,94,0.45)]' : 'text-amber-400 drop-shadow-[0_0_24px_rgba(251,191,36,0.4)]'
        }`}
      >
        {wasted ? 'WASTED' : 'BUSTED'}
      </motion.h2>
      <motion.p
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3, duration: 0.3 }}
        className="mt-3 flex items-center gap-2 rounded-full bg-black/60 px-4 py-1.5 text-xs text-zinc-300 backdrop-blur-sm sm:text-sm"
      >
        <ShieldAlert className={`h-4 w-4 ${wasted ? 'text-rose-400' : 'text-amber-400'}`} aria-hidden="true" />
        {wasted ? 'You lost $100 — respawning at the hospital…' : '$200 fine — released at the police station…'}
      </motion.p>
    </motion.div>
  )
}
