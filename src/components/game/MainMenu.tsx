'use client'
/**
 * MainMenu — full-screen glassmorphism menu shown over the landing-page
 * game section BEFORE the engine boots (no WebGL until the user chooses
 * Play/Continue — the click doubles as the audio-unlock gesture).
 *
 * Tabs: New Game (level select) · Continue (3 save slots + leaderboard) ·
 * Missions (MissionBoard, engineless campaign unlock chain) · Controls ·
 * Settings · Credits (audit note).
 */
import { useMemo, useState } from 'react'
import {
  Building2,
  Car,
  Coins,
  Crown,
  FileJson,
  Footprints,
  Gamepad2,
  Github,
  Map,
  Play,
  Save,
  Skull,
  Trash2,
  Users,
} from 'lucide-react'
import { useGameStore } from '@/game/state'
import type { SaveGameRecord } from '@/game/types'
import { CONTROL_SCHEME } from '@/data/gapAnalysis'
import { clearLocalSlot } from '@/game/gameplay/SaveSystem'
import { formatMoney, formatPlaytime, relativeTime } from './engineViews'
import MissionBoard from './MissionBoard'
import SettingsPanel from './SettingsPanel'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

const LEVEL_TYPE_STYLES: Record<string, string> = {
  urban: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  industrial: 'border-zinc-500/40 bg-zinc-500/10 text-zinc-300',
  residential: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  harbor: 'border-emerald-600/40 bg-emerald-600/10 text-emerald-300',
}

export default function MainMenu({
  onNewGame,
  onContinue,
  onOpenBriefing,
  onSavesChanged,
}: {
  onNewGame: (levelId: string) => void
  onContinue: (record: SaveGameRecord) => void
  onOpenBriefing: (missionId: string) => void
  onSavesChanged: () => void
}) {
  const content = useGameStore((s) => s.content)
  const contentLoading = useGameStore((s) => s.contentLoading)
  const saves = useGameStore((s) => s.saves)
  const leaderboard = useGameStore((s) => s.leaderboard)
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null)
  const [deleting, setDeleting] = useState(false)

  const slotRecord = (slot: number): SaveGameRecord | undefined =>
    saves.find((s) => s.slot === slot)

  const levelName = (levelId: string): string =>
    content?.levels.find((l) => l.id === levelId)?.name ?? levelId

  /** Campaign progress source for the engineless Mission Board: the most
   *  recently updated save, or a fresh campaign when there are none. */
  const boardCompleted = useMemo(() => {
    const latest = [...saves].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0]
    return {
      set: new Set<string>(latest?.missionsCompleted ?? []),
      source: latest ? `save slot ${latest.slot}` : 'fresh campaign',
    }
  }, [saves])

  const deleteSlot = async (slot: number): Promise<void> => {
    setDeleting(true)
    try {
      await fetch(`/api/saves?slot=${slot}`, { method: 'DELETE' })
      clearLocalSlot(slot)
      onSavesChanged()
    } finally {
      setDeleting(false)
      setConfirmDelete(null)
    }
  }

  return (
    <div
      className="absolute inset-0 z-[60] flex flex-col bg-zinc-950/85 backdrop-blur-md"
      role="menu"
      aria-label="Main menu"
    >
      {/* header */}
      <div className="border-b border-zinc-800/80 bg-black/40 px-4 py-3 sm:px-6">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-black tracking-tight text-zinc-50 sm:text-xl">
              OPEN<span className="text-emerald-400">WORLD</span>
              <span className="ml-2 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 align-middle text-[9px] font-bold uppercase tracking-[0.25em] text-emerald-300">
                web rebuild
              </span>
            </h2>
            <p className="text-[11px] text-zinc-500">
              Every system the docs promised — actually playable.
            </p>
          </div>
          <Coins className="hidden h-6 w-6 text-amber-500/70 sm:block" aria-hidden="true" />
        </div>
      </div>

      {/* tabs */}
      <Tabs defaultValue="new" className="flex min-h-0 flex-1 flex-col px-3 pt-3 sm:px-6">
        <TabsList className="h-auto w-full flex-wrap justify-start gap-1 bg-zinc-900/70 p-1">
          <TabsTrigger value="new" className="gap-1.5 text-xs data-[state=active]:bg-emerald-600 data-[state=active]:text-white">Play</TabsTrigger>
          <TabsTrigger value="continue" className="gap-1.5 text-xs data-[state=active]:bg-emerald-600 data-[state=active]:text-white">Continue</TabsTrigger>
          <TabsTrigger value="missions" className="gap-1.5 text-xs data-[state=active]:bg-emerald-600 data-[state=active]:text-white">Missions</TabsTrigger>
          <TabsTrigger value="controls" className="gap-1.5 text-xs data-[state=active]:bg-emerald-600 data-[state=active]:text-white">Controls</TabsTrigger>
          <TabsTrigger value="settings" className="gap-1.5 text-xs data-[state=active]:bg-emerald-600 data-[state=active]:text-white">Settings</TabsTrigger>
          <TabsTrigger value="credits" className="gap-1.5 text-xs data-[state=active]:bg-emerald-600 data-[state=active]:text-white">Credits</TabsTrigger>
        </TabsList>

        <ScrollArea className="mt-3 min-h-0 flex-1">
          <div className="mx-auto max-w-4xl pb-6">
            {/* ---------------- New Game ---------------- */}
            <TabsContent value="new" className="mt-0">
              <p className="mb-3 text-xs text-zinc-400">
                Pick a district — all four load the repo&apos;s real <code className="font-mono text-emerald-400">.level</code> assets.
              </p>
              {contentLoading && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Skeleton className="h-28 bg-zinc-800" />
                  <Skeleton className="h-28 bg-zinc-800" />
                  <Skeleton className="h-28 bg-zinc-800" />
                  <Skeleton className="h-28 bg-zinc-800" />
                </div>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                {content?.levels.map((level) => (
                  <button
                    key={level.id}
                    type="button"
                    onClick={() => onNewGame(level.id)}
                    className="group rounded-xl border border-zinc-700/80 bg-zinc-900/70 p-4 text-left transition-all hover:-translate-y-0.5 hover:border-emerald-500/60 hover:bg-zinc-800/70 hover:shadow-lg hover:shadow-emerald-950/50"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-base font-bold text-zinc-100 group-hover:text-emerald-300">
                        {level.name}
                      </h3>
                      <Badge
                        variant="outline"
                        className={`px-2 py-0 text-[9px] font-bold uppercase tracking-wider ${
                          LEVEL_TYPE_STYLES[level.type.toLowerCase()] ?? 'border-zinc-600 text-zinc-300'
                        }`}
                      >
                        {level.type}
                      </Badge>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[11px] tabular-nums text-zinc-400">
                      <span className="flex items-center gap-1.5">
                        <Map className="h-3 w-3 text-zinc-500" aria-hidden="true" />
                        {level.sizeX}×{level.sizeZ} m
                      </span>
                      <span className="flex items-center gap-1.5">
                        <Building2 className="h-3 w-3 text-zinc-500" aria-hidden="true" />
                        {level.buildings.length} landmarks
                      </span>
                      <span className="flex items-center gap-1.5">
                        <Car className="h-3 w-3 text-zinc-500" aria-hidden="true" />
                        {level.trafficDensity} traffic
                      </span>
                      <span className="flex items-center gap-1.5">
                        <Users className="h-3 w-3 text-zinc-500" aria-hidden="true" />
                        {level.pedestrianDensity} peds
                      </span>
                      <span className="flex items-center gap-1.5">
                        {level.weather.toLowerCase().includes('fog') ? '🌫️' : '☀️'} {level.weather}
                      </span>
                      <span className="flex items-center gap-1.5">🕐 {level.timeOfDay}</span>
                    </div>
                    <span className="mt-3 inline-flex items-center gap-1.5 text-xs font-bold text-emerald-400 opacity-80 transition-opacity group-hover:opacity-100">
                      <Play className="h-3.5 w-3.5" aria-hidden="true" /> Start here
                    </span>
                  </button>
                ))}
              </div>
            </TabsContent>

            {/* ---------------- Continue ---------------- */}
            <TabsContent value="continue" className="mt-0">
              <p className="mb-3 text-xs text-zinc-400">
                Prisma/SQLite save slots — the fix for a C++ SaveSystem that wrote into a directory
                that never existed.
              </p>
              <div className="grid gap-3 sm:grid-cols-3">
                {[1, 2, 3].map((slot) => {
                  const record = slotRecord(slot)
                  return (
                    <div
                      key={slot}
                      className={`flex flex-col rounded-xl border p-3 ${
                        record
                          ? 'border-zinc-700/80 bg-zinc-900/70'
                          : 'border-zinc-800/60 bg-zinc-950/50'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-bold uppercase tracking-[0.25em] text-zinc-500">
                          Slot {slot}
                        </span>
                        {record && (
                          <button
                            type="button"
                            disabled={deleting}
                            onClick={() =>
                              confirmDelete === slot ? deleteSlot(slot) : setConfirmDelete(slot)
                            }
                            onBlur={() => setConfirmDelete((c) => (c === slot ? null : c))}
                            className={`rounded p-1 transition-colors ${
                              confirmDelete === slot
                                ? 'bg-rose-500/20 text-rose-300'
                                : 'text-zinc-600 hover:text-rose-400'
                            }`}
                            aria-label={
                              confirmDelete === slot ? `Confirm delete slot ${slot}` : `Delete slot ${slot}`
                            }
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                        )}
                      </div>
                      {record ? (
                        <>
                          <p className="mt-2 font-mono text-lg font-black tabular-nums text-emerald-400">
                            {formatMoney(record.money)}
                          </p>
                          <p className="truncate text-xs text-zinc-300">{levelName(record.levelId)}</p>
                          <p className="mt-0.5 font-mono text-[11px] tabular-nums text-zinc-500">
                            {record.missionsCompleted.length} missions · {formatPlaytime(record.playTimeSec)}
                          </p>
                          <p className="text-[10px] text-zinc-600">{relativeTime(record.updatedAt)}</p>
                          {confirmDelete === slot ? (
                            <Button
                              variant="outline"
                              size="sm"
                              className="mt-2 h-8 border-rose-500/50 bg-rose-500/10 text-xs text-rose-300 hover:bg-rose-500/20"
                              onClick={() => deleteSlot(slot)}
                              disabled={deleting}
                            >
                              <Skull className="mr-1 h-3 w-3" aria-hidden="true" />
                              {deleting ? 'Deleting…' : 'Confirm delete'}
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              className="mt-2 h-8 bg-emerald-600 text-xs font-bold text-white hover:bg-emerald-500"
                              onClick={() => onContinue(record)}
                            >
                              <Play className="mr-1 h-3 w-3" aria-hidden="true" /> Load
                            </Button>
                          )}
                        </>
                      ) : (
                        <div className="flex flex-1 flex-col items-center justify-center gap-1 py-4 text-zinc-600">
                          <Save className="h-5 w-5" aria-hidden="true" />
                          <p className="text-[11px]">Empty slot</p>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              {leaderboard.length > 0 && (
                <section className="mt-5" aria-label="Leaderboard">
                  <h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.2em] text-amber-400">
                    <Crown className="h-3 w-3" aria-hidden="true" /> Top Net Worth
                  </h4>
                  <ul className="overflow-hidden rounded-xl border border-zinc-800">
                    {leaderboard.map((r, i) => (
                      <li
                        key={r.id}
                        className="flex items-center justify-between gap-2 border-b border-zinc-800/60 bg-zinc-900/50 px-3 py-2 text-xs last:border-0"
                      >
                        <span className="font-mono tabular-nums text-zinc-500">#{i + 1}</span>
                        <span className="truncate text-zinc-300">
                          {levelName(r.levelId)} · {r.missionsCompleted.length} missions
                        </span>
                        <span className="ml-auto font-mono font-bold tabular-nums text-emerald-400">
                          {formatMoney(r.money)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </TabsContent>

            {/* ---------------- Missions ---------------- */}
            <TabsContent value="missions" className="mt-0">
              <p className="mb-3 text-xs text-zinc-400">
                14 missions from the repo&apos;s <code className="font-mono text-emerald-400">.mission</code>{' '}
                files — campaign unlock chain ({' '}
                <span className="text-zinc-300">progress source: {boardCompleted.source}</span> ).
              </p>
              <MissionBoard
                onSelect={onOpenBriefing}
                completedIds={boardCompleted.set}
                maxHeight="26rem"
              />
            </TabsContent>

            {/* ---------------- Controls ---------------- */}
            <TabsContent value="controls" className="mt-0">
              <div className="grid gap-2 sm:grid-cols-2">
                {CONTROL_SCHEME.map((c) => (
                  <div
                    key={c.keys}
                    className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2.5"
                  >
                    <kbd className="rounded-md border border-zinc-600 bg-zinc-800 px-2 py-1 font-mono text-[11px] font-bold text-zinc-200 shadow-[0_2px_0_0_rgba(63,63,70,0.9)]">
                      {c.keys}
                    </kbd>
                    <span className="text-xs text-zinc-400">{c.action}</span>
                  </div>
                ))}
              </div>
              <p className="mt-3 flex items-center gap-1.5 text-[11px] text-zinc-600">
                <Gamepad2 className="h-3.5 w-3.5" aria-hidden="true" />
                Click the game canvas to lock the mouse. Press Esc once to release the cursor, twice to pause.
              </p>
            </TabsContent>

            {/* ---------------- Settings ---------------- */}
            <TabsContent value="settings" className="mt-0">
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
                <SettingsPanel />
              </div>
            </TabsContent>

            {/* ---------------- Credits ---------------- */}
            <TabsContent value="credits" className="mt-0">
              <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 text-sm leading-relaxed text-zinc-300">
                <div>
                  <h4 className="mb-1 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.2em] text-emerald-400">
                    <FileJson className="h-3 w-3" aria-hidden="true" /> Audit Note
                  </h4>
                  <p>
                    This is a from-scratch rebuild prompted by an audit of{' '}
                    <a
                      href="https://github.com/utksh1/game-dev-open-world"
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium text-emerald-400 underline decoration-emerald-700 underline-offset-2 hover:text-emerald-300"
                    >
                      github.com/utksh1/game-dev-open-world
                    </a>{' '}
                    (commit <code className="font-mono text-xs text-zinc-400">0e10d54</code>). Its
                    VERIFICATION.md claimed all 10 phases complete; the C++ build delivered ~25% —
                    an empty HUD, print-only asset loading, zero traffic, zero audio, dead A*, and
                    a UB crash on every frame present.
                  </p>
                </div>
                <Separator className="bg-zinc-800" />
                <div>
                  <h4 className="mb-1 text-[11px] font-bold uppercase tracking-[0.2em] text-amber-400">
                    This rebuild
                  </h4>
                  <p className="text-zinc-400">
                    Next.js 16 (App Router) · TypeScript 5 · Three.js WebGL2 · Prisma/SQLite ·
                    Tailwind CSS 4 · shadcn/ui · Zustand · Framer Motion · Web Audio. All 32 asset
                    files (4 levels, 14 missions, campaign, 7 vehicles, 5 NPCs) are parsed by a real
                    server-side ContentLoader and drive the live game.
                  </p>
                </div>
                <Separator className="bg-zinc-800" />
                <p className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                  <Github className="h-3.5 w-3.5" aria-hidden="true" />
                  <Footprints className="h-3.5 w-3.5" aria-hidden="true" />
                  No original C++ code was reused — only its asset files.
                </p>
              </div>
            </TabsContent>
          </div>
        </ScrollArea>
      </Tabs>
    </div>
  )
}
