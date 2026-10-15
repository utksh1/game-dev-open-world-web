'use client'

/**
 * LANDING PAGE — "The Build the Docs Promised"
 * ====================================================================
 * Audit story: github.com/utksh1/game-dev-open-world shipped complete
 * documentation (10/10 phases "verified ✅") on top of a ~25%-implemented
 * C++ build — empty HUD render(), a print-only ContentLoader, dead A*
 * pathfinding, a fake audio system. This page documents every gap
 * (src/data/gapAnalysis.ts) and mounts the full playable rebuild
 * (GameShell → Three.js engine + all gameplay systems).
 */
import { useSyncExternalStore } from 'react'
import dynamic from 'next/dynamic'
import { motion } from 'framer-motion'
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  FileCode2,
  Gamepad2,
  Github,
  Map,
  ShieldCheck,
  Zap,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import { CONTROL_SCHEME, OVERALL, PHASE_GAPS } from '@/data/gapAnalysis'

// Client-only: GameShell boots the Three.js engine after a user gesture.
const GameShell = dynamic(() => import('@/components/game/GameShell'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center bg-zinc-950">
      <span className="h-10 w-10 animate-spin rounded-full border-2 border-zinc-700 border-t-emerald-400" />
    </div>
  ),
})

const fadeUp = {
  hidden: { opacity: 0, y: 24 },
  show: { opacity: 1, y: 0 },
}

function StatChip({ value, label }: { value: string; label: string }) {
  return (
    <motion.div
      whileHover={{ y: -3, scale: 1.04 }}
      transition={{ type: 'spring', stiffness: 400, damping: 22 }}
      className="flex min-w-[86px] flex-col items-center rounded-lg border border-zinc-800 bg-zinc-900/70 px-3 py-2 backdrop-blur transition-colors hover:border-emerald-700/60 hover:bg-emerald-950/30"
    >
      <span className="font-mono text-lg font-bold text-emerald-400">{value}</span>
      <span className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</span>
    </motion.div>
  )
}

function PhaseCard({ phase, index }: { phase: (typeof PHASE_GAPS)[number]; index: number }) {
  return (
    <motion.article
      variants={fadeUp}
      transition={{ duration: 0.4, delay: Math.min(index * 0.05, 0.4) }}
      className="group"
    >
      <Card className="h-full overflow-hidden border-zinc-800 bg-zinc-950/80 transition-colors hover:border-emerald-800/60">
        <CardContent className="flex h-full flex-col gap-3 p-5">
          <header className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-zinc-900 font-mono text-sm font-bold text-emerald-400 ring-1 ring-zinc-800">
                {String(phase.phase).padStart(2, '0')}
              </span>
              <div>
                <h3 className="text-sm font-bold leading-tight text-zinc-100">{phase.name}</h3>
                <p className="text-[11px] text-zinc-500">{phase.gaps.length} gaps addressed</p>
              </div>
            </div>
            {phase.gaps.some((g) => g.severity === 'critical') && (
              <Badge variant="outline" className="shrink-0 border-rose-800/70 bg-rose-950/40 text-[10px] text-rose-300">
                <AlertTriangle className="mr-1 h-3 w-3" aria-hidden="true" /> critical
              </Badge>
            )}
          </header>

          <blockquote className="rounded-md border-l-2 border-amber-600/70 bg-amber-950/20 px-3 py-2 text-[11px] italic leading-relaxed text-amber-200/80">
            “{phase.docClaim}”
          </blockquote>

          <div className="space-y-2">
            <div>
              <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider">
                <span className="text-zinc-500">Docs claimed</span>
                <span className="font-mono text-zinc-400">100%</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-zinc-900">
                <div className="h-full w-full rounded-full bg-amber-600/70" />
              </div>
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider">
                <span className="text-zinc-500">Actually built (C++)</span>
                <span className="font-mono text-rose-300">{phase.actualPct}%</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-zinc-900">
                <div className="h-full rounded-full bg-rose-500/80" style={{ width: `${phase.actualPct}%` }} />
              </div>
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider">
                <span className="text-zinc-500">This rebuild ships</span>
                <span className="font-mono text-emerald-400">{phase.deliveredPct}%</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-zinc-900">
                <div className="h-full rounded-full bg-emerald-500" style={{ width: `${phase.deliveredPct}%` }} />
              </div>
            </div>
          </div>

          <ul className="mt-auto space-y-1.5 border-t border-zinc-900 pt-3">
            {phase.gaps.slice(0, 3).map((gap) => (
              <li key={gap.id} className="flex items-start gap-2 text-[11px] leading-relaxed">
                <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500" aria-hidden="true" />
                <span className="text-zinc-400">
                  <span className="text-zinc-300">{gap.fix}</span>
                </span>
              </li>
            ))}
            {phase.gaps.length > 3 && (
              <li className="pl-5 text-[10px] text-zinc-600">+{phase.gaps.length - 3} more…</li>
            )}
          </ul>
        </CardContent>
      </Card>
    </motion.article>
  )
}

const emptySubscribe = () => () => {}

export default function Home() {
  // Hydration-safe client mount detection (no setState-in-effect).
  const mounted = useSyncExternalStore(emptySubscribe, () => true, () => false)

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-zinc-100">
      {/* ---------------------------------------------------------------- */}
      {/* Nav                                                              */}
      {/* ---------------------------------------------------------------- */}
      <header className="sticky top-0 z-40 border-b border-zinc-900/80 bg-zinc-950/80 backdrop-blur">
        <nav className="mx-auto flex h-14 w-full max-w-7xl items-center justify-between px-4 sm:px-6" aria-label="Main">
          <a href="#top" className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-md bg-emerald-600 font-mono text-sm font-black text-white">
              75
            </span>
            <span className="text-sm font-bold tracking-tight">
              Open World<span className="text-emerald-400">·Rebuilt</span>
            </span>
          </a>
          <div className="hidden items-center gap-6 text-xs text-zinc-400 sm:flex">
            <a href="#gaps" className="transition-colors hover:text-emerald-400">Gap Analysis</a>
            <a href="#play" className="transition-colors hover:text-emerald-400">Play</a>
            <a href="#controls" className="transition-colors hover:text-emerald-400">Controls</a>
            <a href="#controls" className="transition-colors hover:text-emerald-400">Tech</a>
          </div>
          <Button
            asChild
            size="sm"
            className="bg-emerald-600 font-semibold text-white hover:bg-emerald-500"
          >
            <a href="#play">
              <Gamepad2 className="mr-1.5 h-4 w-4" aria-hidden="true" /> Play Now
            </a>
          </Button>
        </nav>
      </header>

      <main id="top" className="flex-1">
        {/* ---------------------------------------------------------------- */}
        {/* Hero                                                             */}
        {/* ---------------------------------------------------------------- */}
        <section className="relative overflow-hidden">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 opacity-[0.35]"
            style={{
              backgroundImage:
                'linear-gradient(to right, rgba(63,98,18,0.25) 1px, transparent 1px), linear-gradient(to bottom, rgba(63,98,18,0.25) 1px, transparent 1px)',
              backgroundSize: '44px 44px',
              maskImage: 'radial-gradient(ellipse 80% 60% at 50% 0%, black 40%, transparent 100%)',
              WebkitMaskImage: 'radial-gradient(ellipse 80% 60% at 50% 0%, black 40%, transparent 100%)',
            }}
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -top-40 left-1/2 h-96 w-[42rem] -translate-x-1/2 rounded-full bg-emerald-500/15 blur-3xl"
          />
          <div className="relative mx-auto flex w-full max-w-7xl flex-col items-center px-4 pb-16 pt-20 text-center sm:px-6 sm:pt-28">
            <motion.div variants={fadeUp} initial="hidden" animate="show" transition={{ duration: 0.5 }}>
              <Badge variant="outline" className="border-emerald-800/60 bg-emerald-950/40 text-emerald-300">
                <ShieldCheck className="mr-1.5 h-3 w-3" aria-hidden="true" />
                Repo audit → full rebuild
              </Badge>
            </motion.div>
            <motion.h1
              variants={fadeUp}
              initial="hidden"
              animate="show"
              transition={{ duration: 0.5, delay: 0.1 }}
              className="mt-6 max-w-4xl text-balance text-4xl font-black leading-[1.05] tracking-tight sm:text-6xl"
            >
              The documentation was complete.
              <br />
              <span className="bg-gradient-to-r from-emerald-400 via-emerald-300 to-amber-300 bg-clip-text text-transparent">
                The build was 25% fiction.
              </span>
            </motion.h1>
            <motion.p
              variants={fadeUp}
              initial="hidden"
              animate="show"
              transition={{ duration: 0.5, delay: 0.2 }}
              className="mt-6 max-w-2xl text-pretty text-sm leading-relaxed text-zinc-400 sm:text-base"
            >
              We audited <span className="font-mono text-zinc-300">utksh1/game-dev-open-world</span> — a C++ GTA-like
              engine whose docs verified all 10 phases complete: HUD, minimap, audio, A* pathfinding, traffic,
              missions, save system. The code told a different story: empty render functions, print-only asset
              loaders, dead subsystems. So we addressed every gap — rebuilding the documented engine as a{' '}
              <span className="text-zinc-200">playable web game that loads the repo&apos;s real asset files</span>.
            </motion.p>
            <motion.div
              variants={fadeUp}
              initial="hidden"
              animate="show"
              transition={{ duration: 0.5, delay: 0.3 }}
              className="mt-8 flex flex-wrap items-center justify-center gap-3"
            >
              <Button asChild size="lg" className="bg-emerald-600 font-bold text-white hover:bg-emerald-500">
                <a href="#play">
                  <Zap className="mr-2 h-4 w-4" aria-hidden="true" /> Play the Rebuild
                </a>
              </Button>
              <Button
                asChild
                size="lg"
                variant="outline"
                className="border-zinc-700 bg-zinc-900/60 font-semibold text-zinc-200 hover:border-emerald-700 hover:text-emerald-300"
              >
                <a href="#gaps">
                  View the Gap Analysis <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
                </a>
              </Button>
            </motion.div>
            <motion.div
              variants={fadeUp}
              initial="hidden"
              animate="show"
              transition={{ duration: 0.5, delay: 0.4 }}
              className="mt-10 flex flex-wrap items-center justify-center gap-2"
            >
              <StatChip value="32/32" label="assets parsed" />
              <StatChip value="14" label="missions" />
              <StatChip value="4" label="districts" />
              <StatChip value="7" label="vehicles" />
              <StatChip value="15" label="objective types" />
              <StatChip value={`${OVERALL.gapCount}`} label="gaps fixed" />
            </motion.div>
            <motion.a
              href="#gaps"
              aria-label="Scroll to gap analysis"
              className="mt-12 text-zinc-600 transition-colors hover:text-emerald-400"
              animate={{ y: [0, 8, 0] }}
              transition={{ repeat: Infinity, duration: 1.8, ease: 'easeInOut' }}
            >
              <ChevronDown className="h-6 w-6" aria-hidden="true" />
            </motion.a>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Gap analysis                                                     */}
        {/* ---------------------------------------------------------------- */}
        <section id="gaps" className="border-t border-zinc-900/80 bg-zinc-950 py-16 sm:py-20" aria-labelledby="gaps-title">
          <div className="mx-auto w-full max-w-7xl px-4 sm:px-6">
            <motion.div
              initial="hidden"
              whileInView="show"
              viewport={{ once: true, margin: '-80px' }}
              variants={fadeUp}
              className="mb-4 flex flex-wrap items-end justify-between gap-4"
            >
              <div>
                <h2 id="gaps-title" className="text-2xl font-black tracking-tight sm:text-3xl">
                  The Gap Analysis
                </h2>
                <p className="mt-2 max-w-2xl text-sm text-zinc-500">
                  Every documented claim, what the C++ build actually shipped, and what this rebuild delivers.
                  Severity is assigned by how badly the gap broke the documented experience.
                </p>
              </div>
              <div className="flex items-center gap-4 rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3">
                <div className="text-center">
                  <p className="font-mono text-2xl font-black text-rose-400">{OVERALL.actualImplemented}%</p>
                  <p className="text-[10px] uppercase tracking-wider text-zinc-500">docs claimed 100%</p>
                </div>
                <Separator orientation="vertical" className="h-10 bg-zinc-800" />
                <div className="text-center">
                  <p className="font-mono text-2xl font-black text-emerald-400">100%</p>
                  <p className="text-[10px] uppercase tracking-wider text-zinc-500">this rebuild ships</p>
                </div>
                <Separator orientation="vertical" className="h-10 bg-zinc-800" />
                <div className="text-center">
                  <p className="font-mono text-2xl font-black text-amber-400">{OVERALL.criticalGaps}</p>
                  <p className="text-[10px] uppercase tracking-wider text-zinc-500">critical gaps fixed</p>
                </div>
              </div>
            </motion.div>

            <motion.div
              initial="hidden"
              whileInView="show"
              viewport={{ once: true, margin: '-60px' }}
              variants={{ show: { transition: { staggerChildren: 0.06 } } }}
              className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
            >
              {PHASE_GAPS.map((phase, i) => (
                <PhaseCard key={phase.phase} phase={phase} index={i} />
              ))}
            </motion.div>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Game                                                             */}
        {/* ---------------------------------------------------------------- */}
        <section id="play" className="border-t border-zinc-900/80 py-16 sm:py-20" aria-labelledby="play-title">
          <div className="mx-auto w-full max-w-7xl px-4 sm:px-6">
            <motion.div
              initial="hidden"
              whileInView="show"
              viewport={{ once: true, margin: '-80px' }}
              variants={fadeUp}
              className="mb-6 flex flex-wrap items-end justify-between gap-4"
            >
              <div>
                <h2 id="play-title" className="text-2xl font-black tracking-tight sm:text-3xl">
                  Play the Rebuild
                </h2>
                <p className="mt-2 max-w-2xl text-sm text-zinc-500">
                  Four districts, a 5-mission campaign, 4 side hustles, traffic, police heat — cruisers that
                  hunt your ride at 3 stars and box you in for the arrest, a searchlight helicopter at 4 —
                  and at 5 the chopper fast-ropes full SWAT squads onto the street — checkpoint street
                  races against 3-7 AI rivals with a 3-2-1-GO! countdown, live standings, lap records and
                  rivals you can carjack mid-race — five procedural radio stations with hosts that break
                  in between tracks — a working economy: street clinics that patch you up, a gun-shop
                  counter that sells real hardware (SMG, shotgun, rifle — with stat sheets) plus $40
                  reserve top-ups, drive-in Pay&apos;n&apos;Spray booths that repair your ride and
                  clear the heat, and a buyable garage lockup whose key works in every district — park
                  your car downtown, pull it out at the harbor — pedestrian crowds that swell with the
                  morning and evening rush and
                  thin out after dark — photo
                  mode (<kbd className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px]">V</kbd>) that freezes the world
                  for cinematic shots — and a garage of
                  cars with physics parsed straight from the original repo&apos;s <span className="font-mono text-zinc-400">.vehicle</span>{' '}
                  files. Click the game to lock your mouse; press <kbd className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px]">Esc</kbd> to pause.
                </p>
              </div>
              <Badge variant="outline" className="border-emerald-800/60 bg-emerald-950/40 text-emerald-300">
                <Map className="mr-1.5 h-3 w-3" aria-hidden="true" /> Tip: press M for the big map
              </Badge>
            </motion.div>
            <motion.div
              initial="hidden"
              whileInView="show"
              viewport={{ once: true, margin: '-60px' }}
              variants={fadeUp}
              className="overflow-hidden rounded-2xl border border-zinc-800 shadow-2xl shadow-emerald-950/40 ring-1 ring-zinc-900"
            >
              <div className="h-[78vh] min-h-[540px] w-full sm:h-[82vh]">
                {mounted && <GameShell />}
              </div>
            </motion.div>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Controls                                                         */}
        {/* ---------------------------------------------------------------- */}
        <section id="controls" className="border-t border-zinc-900/80 bg-zinc-950 py-16 sm:py-20" aria-labelledby="controls-title">
          <div className="mx-auto w-full max-w-7xl px-4 sm:px-6">
            <motion.div
              initial="hidden"
              whileInView="show"
              viewport={{ once: true, margin: '-80px' }}
              variants={fadeUp}
            >
              <h2 id="controls-title" className="text-2xl font-black tracking-tight sm:text-3xl">
                Controls
              </h2>
              <p className="mt-2 max-w-2xl text-sm text-zinc-500">
                The original PRD promised an Input abstraction that never shipped a single file. This one is
                wired end-to-end — pointer lock, edge-triggered actions, gamepad-safe layout.
              </p>
            </motion.div>
            <motion.div
              initial="hidden"
              whileInView="show"
              viewport={{ once: true, margin: '-60px' }}
              variants={{ show: { transition: { staggerChildren: 0.04 } } }}
              className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
            >
              {CONTROL_SCHEME.map((c) => (
                <motion.div
                  key={c.keys}
                  variants={fadeUp}
                  className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3"
                >
                  <kbd className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 font-mono text-xs font-bold text-emerald-300 shadow-[0_2px_0_rgba(0,0,0,0.5)]">
                    {c.keys}
                  </kbd>
                  <span className="text-right text-xs text-zinc-400">{c.action}</span>
                </motion.div>
              ))}
            </motion.div>

            <motion.div
              initial="hidden"
              whileInView="show"
              viewport={{ once: true }}
              variants={fadeUp}
              className="mt-12 grid gap-4 sm:grid-cols-3"
            >
              {[
                {
                  icon: FileCode2,
                  title: 'Honest content pipeline',
                  body: 'A real parser loads all 32 original asset files — buildings, roads, docks, water, traffic and NPC spawns, 15 objective types, vehicle physics stats, NPC reactions. The C++ ContentLoader printed "Loaded X" and returned true.',
                },
                {
                  icon: ShieldCheck,
                  title: 'Real persistence',
                  body: 'A Prisma-backed save system with 3 slots, autosave every 30 seconds, and localStorage fallback. The original SaveSystem wrote to a saves/ directory that nothing ever created — and was never called.',
                },
                {
                  icon: Zap,
                  title: 'Everything wired',
                  body: 'A* pathfinding runs every frame for NPCs and traffic. The reload timer takes 1.8 real seconds. The minimap draws roads from level data. Police cruisers pursue your ride at 3 stars — ramming, boxing you in for the arrest, deploying officers — at 4 a helicopter joins with a searchlight that pins your heat, and at 5 it fast-ropes SWAT squads down ropes that track the orbiting airframe. Street races count you down 3-2-1-GO!, grid you against 3-7 AI rivals with rubber-band pacing and live 1ST/2ND/3RD standings, score your lap, keep your record in the save file — and let you carjack a rival mid-race (they bail, panic, and drop out). Photo mode (V) freezes the sim and detaches a free-fly camera with FOV zoom and one-key PNG snapshots. Five procedural radio stations synthesize their playlists live in Web Audio — and the hosts break in between tracks with station-ID jingles (ON AIR flashes on the dash). Money finally has sinks: press E at a street clinic ($50) for a full heal, or at the gun shop to browse the counter — stat-sheeted firearms for sale (SMG $450, shotgun $350, rifle $800, full mag + reserve included) and a $40 top-up for everything you own — or drive into a Pay\'n\'Spray bay ($100) to factory-repair your car and erase the wanted level. Buy a garage lockup ($300, once) and your car follows you across districts — store it downtown, pull it out at the harbor, swap rides at the door. Pedestrian density follows the clock — rush-hour crowds at 8:30 and 17:30, near-empty streets at 3 AM. Nothing is a stub.',
                },
              ].map((f) => (
                <Card key={f.title} className="border-zinc-800 bg-zinc-950/80">
                  <CardContent className="p-5">
                    <f.icon className="mb-3 h-5 w-5 text-emerald-400" aria-hidden="true" />
                    <h3 className="text-sm font-bold text-zinc-100">{f.title}</h3>
                    <p className="mt-2 text-xs leading-relaxed text-zinc-500">{f.body}</p>
                  </CardContent>
                </Card>
              ))}
            </motion.div>
          </div>
        </section>
      </main>

      {/* ---------------------------------------------------------------- */}
      {/* Footer (sticky bottom)                                           */}
      {/* ---------------------------------------------------------------- */}
      <footer className="mt-auto border-t border-zinc-900/80 bg-zinc-950">
        <div className="mx-auto flex w-full max-w-7xl flex-col items-center gap-3 px-4 py-8 text-center sm:px-6">
          <p className="text-xs text-zinc-500">
            Rebuilt with <span className="text-zinc-300">Next.js 16 · Three.js · Prisma · Web Audio</span> — from the
            audit of{' '}
            <a
              href="https://github.com/utksh1/game-dev-open-world"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-mono text-emerald-400 underline-offset-2 hover:underline"
            >
              <Github className="h-3 w-3" aria-hidden="true" /> utksh1/game-dev-open-world
            </a>
          </p>
          <p className="max-w-2xl text-[11px] leading-relaxed text-zinc-600">
            The original VERIFICATION.md marked features “✅ verified” that were never implemented — empty HUD
            render functions, a fake audio system, a fabricated git history. This page documents every gap and
            ships working code instead.
          </p>
        </div>
      </footer>
    </div>
  )
}
