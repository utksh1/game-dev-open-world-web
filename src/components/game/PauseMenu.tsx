'use client'
/**
 * PauseMenu — glass panel over the (frozen) game when hud.paused.
 * Resume · Save (slots 1-3) · Load (slot cards) · Mission Board (live
 * statuses) · Settings · Quit to Menu (disposes the engine).
 */
import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  ChevronLeft,
  FolderOpen,
  ListChecks,
  LogOut,
  Play,
  Save,
  Settings as SettingsIcon,
} from 'lucide-react'
import { engineRef, useGameStore } from '@/game/state'
import { formatMoney, formatPlaytime, relativeTime } from './engineViews'
import { loadSlot, saveGame } from '@/game/gameplay/SaveSystem'
import MissionBoard from './MissionBoard'
import SettingsPanel from './SettingsPanel'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'

type Section = 'main' | 'save' | 'load' | 'board' | 'settings'

export default function PauseMenu({
  onQuit,
  onOpenBriefing,
  onSavesChanged,
}: {
  onQuit: () => void
  onOpenBriefing: (missionId: string) => void
  onSavesChanged: () => void
}) {
  const hud = useGameStore((s) => s.hud)
  const saves = useGameStore((s) => s.saves)
  const setActiveSaveSlot = useGameStore((s) => s.setActiveSaveSlot)
  const [section, setSection] = useState<Section>('main')
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [confirmQuit, setConfirmQuit] = useState(false)

  // Pointer lock would swallow menu clicks — release it while paused.
  useEffect(() => {
    try {
      if (document.pointerLockElement) document.exitPointerLock()
    } catch {
      /* not focused / unsupported — ignore */
    }
  }, [])

  if (!hud?.paused) return null

  const engine = engineRef.current
  const levelName = engine
    ? (() => {
        try {
          return engine.level.name
        } catch {
          return ''
        }
      })()
    : ''

  const doSave = async (slot: number): Promise<void> => {
    if (!engine) return
    setBusy(`save-${slot}`)
    try {
      const result = await saveGame(engine, slot)
      setNote(result.ok ? `Saved to slot ${slot}` : `Save failed — ${result.serverError ?? 'error'}`)
      if (result.ok) {
        setActiveSaveSlot(slot)
        onSavesChanged()
      }
    } finally {
      setBusy(null)
    }
  }

  const doLoad = async (slot: number): Promise<void> => {
    if (!engine) return
    setBusy(`load-${slot}`)
    try {
      const result = await loadSlot(engine, slot)
      if (result.ok) {
        setActiveSaveSlot(slot)
        engine.setPaused(false)
        onSavesChanged()
      } else {
        setNote(result.error ?? 'Load failed')
      }
    } finally {
      setBusy(null)
    }
  }

  const menuButton =
    'flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left text-sm font-semibold transition-colors'

  return (
    <div
      className="absolute inset-0 z-[60] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Pause menu"
    >
      <motion.div
        initial={{ opacity: 0, y: 20, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
        className="flex max-h-full w-full max-w-md flex-col overflow-hidden rounded-2xl border border-zinc-700/80 bg-zinc-950/95 shadow-2xl shadow-black"
      >
        {/* header */}
        <div className="flex items-center justify-between border-b border-zinc-800 bg-gradient-to-r from-emerald-500/10 via-transparent to-transparent px-5 py-3">
          <div>
            <h3 className="text-lg font-black tracking-[0.3em] text-zinc-100">PAUSED</h3>
            {levelName && <p className="text-[11px] text-zinc-500">{levelName}</p>}
          </div>
          {section !== 'main' && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSection('main')
                setNote(null)
              }}
              className="h-8 text-zinc-400 hover:text-zinc-100"
            >
              <ChevronLeft className="mr-1 h-4 w-4" aria-hidden="true" /> Back
            </Button>
          )}
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="p-5">
            {section === 'main' && (
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => engine?.setPaused(false)}
                  className={`${menuButton} border-emerald-600/60 bg-emerald-600/20 text-emerald-300 hover:bg-emerald-600/30`}
                >
                  <Play className="h-4 w-4" aria-hidden="true" /> Resume
                  <kbd className="ml-auto rounded bg-black/40 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500">Esc</kbd>
                </button>
                <button
                  type="button"
                  onClick={() => setSection('save')}
                  className={`${menuButton} border-zinc-700 bg-zinc-900 text-zinc-200 hover:border-amber-500/50 hover:bg-zinc-800`}
                >
                  <Save className="h-4 w-4 text-amber-400" aria-hidden="true" /> Save Game
                </button>
                <button
                  type="button"
                  onClick={() => setSection('load')}
                  className={`${menuButton} border-zinc-700 bg-zinc-900 text-zinc-200 hover:border-emerald-500/50 hover:bg-zinc-800`}
                >
                  <FolderOpen className="h-4 w-4 text-emerald-400" aria-hidden="true" /> Load Game
                </button>
                <button
                  type="button"
                  onClick={() => setSection('board')}
                  className={`${menuButton} border-zinc-700 bg-zinc-900 text-zinc-200 hover:border-amber-500/50 hover:bg-zinc-800`}
                >
                  <ListChecks className="h-4 w-4 text-amber-400" aria-hidden="true" /> Mission Board
                </button>
                <button
                  type="button"
                  onClick={() => setSection('settings')}
                  className={`${menuButton} border-zinc-700 bg-zinc-900 text-zinc-200 hover:bg-zinc-800`}
                >
                  <SettingsIcon className="h-4 w-4 text-zinc-300" aria-hidden="true" /> Settings
                </button>
                {confirmQuit ? (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={onQuit}
                      className={`${menuButton} justify-center border-rose-600/60 bg-rose-600/20 text-rose-300 hover:bg-rose-600/30`}
                    >
                      <LogOut className="h-4 w-4" aria-hidden="true" /> Really quit?
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmQuit(false)}
                      className="rounded-lg border border-zinc-700 bg-zinc-900 px-4 text-xs font-semibold text-zinc-400 hover:text-zinc-200"
                    >
                      Stay
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmQuit(true)}
                    className={`${menuButton} border-zinc-800 bg-zinc-950 text-zinc-500 hover:border-rose-600/40 hover:text-rose-300`}
                  >
                    <LogOut className="h-4 w-4" aria-hidden="true" /> Quit to Menu
                  </button>
                )}
              </div>
            )}

            {section === 'save' && (
              <div className="space-y-2">
                <p className="text-xs text-zinc-400">Save the current session to a slot.</p>
                {[1, 2, 3].map((slot) => {
                  const existing = saves.find((s) => s.slot === slot)
                  return (
                    <button
                      key={slot}
                      type="button"
                      disabled={busy !== null}
                      onClick={() => doSave(slot)}
                      className={`${menuButton} justify-between border-zinc-700 bg-zinc-900 text-zinc-200 hover:border-amber-500/50 hover:bg-zinc-800 disabled:opacity-50`}
                    >
                      <span className="flex items-center gap-3">
                        <Save className="h-4 w-4 text-amber-400" aria-hidden="true" /> Slot {slot}
                        {busy === `save-${slot}` && <span className="text-[10px] text-zinc-500">saving…</span>}
                      </span>
                      {existing && (
                        <span className="font-mono text-[11px] tabular-nums text-zinc-500">
                          {formatMoney(existing.money)} · {relativeTime(existing.updatedAt)}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            )}

            {section === 'load' && (
              <div className="space-y-2">
                <p className="text-xs text-zinc-400">Load a slot (replaces the current session).</p>
                {saves.length === 0 && (
                  <p className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4 text-center text-xs text-zinc-500">
                    No saves yet.
                  </p>
                )}
                {[...saves]
                  .sort((a, b) => a.slot - b.slot)
                  .map((record) => (
                    <button
                      key={record.id}
                      type="button"
                      disabled={busy !== null}
                      onClick={() => doLoad(record.slot)}
                      className={`${menuButton} justify-between border-zinc-700 bg-zinc-900 text-zinc-200 hover:border-emerald-500/50 hover:bg-zinc-800 disabled:opacity-50`}
                    >
                      <span className="flex flex-col items-start">
                        <span className="flex items-center gap-2">
                          <FolderOpen className="h-4 w-4 text-emerald-400" aria-hidden="true" />
                          Slot {record.slot}
                          {busy === `load-${record.slot}` && (
                            <span className="text-[10px] text-zinc-500">loading…</span>
                          )}
                        </span>
                        <span className="text-[11px] text-zinc-500">
                          {record.missionsCompleted.length} missions · {formatPlaytime(record.playTimeSec)} ·{' '}
                          {relativeTime(record.updatedAt)}
                        </span>
                      </span>
                      <span className="font-mono text-sm font-bold tabular-nums text-emerald-400">
                        {formatMoney(record.money)}
                      </span>
                    </button>
                  ))}
              </div>
            )}

            {section === 'board' && (
              <MissionBoard onSelect={onOpenBriefing} maxHeight="18rem" />
            )}

            {section === 'settings' && <SettingsPanel />}

            {note && (
              <p role="status" className="mt-3 text-center text-xs text-emerald-400">
                {note}
              </p>
            )}
          </div>
        </ScrollArea>
      </motion.div>
    </div>
  )
}
