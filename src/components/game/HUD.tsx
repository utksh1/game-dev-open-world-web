'use client'
/**
 * HUD — GTA-style heads-up display (pointer-events-none overlay).
 *
 * Data: the zustand `hud` snapshot republished by the engine at ~10 Hz
 * (money, health, weapon, mission, notifications...). Things the engine
 * does not publish in HudState (nearby mission markers, live vehicle
 * damage) are polled directly from the engineRef at ~0.6–1 Hz.
 *
 * Layout: top-left time/FPS · top-center mission tracker · top-right
 * money/wanted/level · bottom-left hint + minimap + health/armor ·
 * bottom-right weapon panel or speedometer · bottom-center notifications.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  AlertTriangle,
  Aperture,
  CheckCircle2,
  ChevronsRight,
  Expand,
  Heart,
  Info,
  Lightbulb,
  Shield,
  Skull,
  Star,
  Sun,
  SunDim,
  Moon,
  RotateCw,
  Timer,
  X,
  Zap,
  Siren,
  Paintbrush,
  Warehouse,
} from 'lucide-react'
import { engineRef, useGameStore } from '@/game/state'
import type { AvailableMission } from '@/game/gameplay/MissionSystem'
import type { HelicopterInfo } from '@/game/ai/PoliceHelicopter'
import {
  formatDayTime,
  formatDistance,
  formatMoney,
  getArrestCountdown,
  getGaragePrompt,
  getGarageStatus,
  getHelicopter,
  getLiveMissions,
  getPhotoState,
  getPursuit,
  getServiceConfirm,
  getServicePrompt,
  getVehicleHealthPct,
  isPursuitActive,
  WEAPON_SHORT,
} from './engineViews'
import type { ServiceConfirm, ServicePrompt } from '@/game/gameplay/CityServices'
import type { GaragePrompt } from '@/game/gameplay/GarageSystem'
import Minimap from './Minimap'
import RadioWidget from './RadioWidget'

const NOTIF_STYLES: Record<string, { cls: string; chip: string; Icon: typeof Info }> = {
  info: { cls: 'border-zinc-600/60 text-zinc-200', chip: 'bg-zinc-500/20 text-zinc-300', Icon: Info },
  success: { cls: 'border-emerald-500/60 text-emerald-300', chip: 'bg-emerald-500/20 text-emerald-300', Icon: CheckCircle2 },
  warning: { cls: 'border-amber-500/60 text-amber-300', chip: 'bg-amber-500/20 text-amber-300', Icon: AlertTriangle },
  danger: { cls: 'border-rose-500/60 text-rose-300', chip: 'bg-rose-500/20 text-rose-300', Icon: Skull },
}

const HINT_ROWS: [string, string][] = [
  ['WASD + Shift', 'move / sprint'],
  ['Mouse', 'look (click to lock aim)'],
  ['F', 'enter / exit vehicle'],
  ['R', 'radio (driving) · reload'],
  ['E', 'interact · missions · shops · garage'],
  ['C', 'camera · M map · V photo mode'],
  ['Esc', 'pause'],
]

function healthBarClass(pct: number): string {
  if (pct > 55) return 'from-emerald-500 to-emerald-400'
  if (pct > 25) return 'from-amber-500 to-amber-400'
  return 'from-rose-600 to-rose-400'
}

/** 1ST · 2ND · 3RD · 4TH… */
function placeLabel(place: number): string {
  const suffix =
    place % 10 === 1 && place !== 11
      ? 'ST'
      : place % 10 === 2 && place !== 12
        ? 'ND'
        : place % 10 === 3 && place !== 13
          ? 'RD'
          : 'TH'
  return `${place}${suffix}`
}

/** Medal tint per place (gold / silver / bronze / zinc). */
function placeBadgeClass(place: number): string {
  if (place === 1) return 'bg-amber-400/95 text-zinc-950 shadow-[0_0_12px_rgba(251,191,36,0.55)]'
  if (place === 2) return 'bg-zinc-200/95 text-zinc-900'
  if (place === 3) return 'bg-orange-400/95 text-zinc-950'
  return 'bg-zinc-700/90 text-zinc-300'
}

/** City-service purchase prompt (E at clinic / gun shop / spray bay). */
function ServicePromptPill({ svc }: { svc: ServicePrompt }) {
  const meta =
    svc.kind === 'clinic'
      ? {
          Icon: Heart,
          kbd: 'bg-rose-500/20',
          ring: 'border-rose-500/50 hover:border-rose-400 hover:bg-rose-500/10',
          text: 'text-rose-300',
          action: 'Patch up',
        }
      : svc.kind === 'ammo'
        ? {
            Icon: Zap,
            kbd: 'bg-amber-500/20',
            ring: 'border-amber-500/50 hover:border-amber-400 hover:bg-amber-500/10',
            text: 'text-amber-300',
            action: 'Browse stock · guns from $250 · top-up $40',
          }
        : {
            Icon: Paintbrush,
            kbd: 'bg-teal-500/20',
            ring: 'border-teal-500/50 hover:border-teal-400 hover:bg-teal-500/10',
            text: 'text-teal-300',
            action: 'Respray + lose the heat',
          }
  const blocked =
    (svc.requiresVehicle && !svc.inVehicle) || svc.cooldownSec > 0 || !svc.wouldDoSomething
  // Round 10: the gun-shop sheet is always openable (browse ≠ buy) —
  // wouldDoSomething only means "something worth buying" for the copy.
  const hardBlocked = blocked && svc.kind !== 'ammo'
  return (
    <span
      className={`flex items-center gap-1.5 rounded-full border bg-black/70 px-3 py-1.5 text-xs font-semibold shadow-lg backdrop-blur-sm ${meta.ring} ${meta.text}`}
    >
      <meta.Icon className="h-3.5 w-3.5" aria-hidden="true" />
      <kbd className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${meta.kbd}`}>E</kbd>
      {svc.kind === 'ammo'
        ? `${svc.name} — ${meta.action}`
        : `${svc.name} — ${meta.action} · $${svc.price}`}
      {svc.requiresVehicle && !svc.inVehicle && (
        <span className="text-[10px] font-normal text-zinc-500">(bring a car)</span>
      )}
      {svc.cooldownSec > 0 && (
        <span className="text-[10px] font-normal text-zinc-500">
          (booth {Math.ceil(svc.cooldownSec)}s)
        </span>
      )}
      {hardBlocked && <span className="sr-only">Service currently unavailable</span>}
    </span>
  )
}

/** Garage lockup prompt — buy / store / open the bay panel (E at the pad). */
function GaragePromptPill({ g }: { g: GaragePrompt }) {
  // One action string per GarageAction, bays-aware suffixes.
  const label = !g.owned
    ? `Buy the lockup · $${g.price}`
    : g.action === 'store'
      ? `Store ${g.currentVehicle?.name ?? 'your car'} (free)`
      : `Open your bays (${g.carsInside}/${g.baysUnlocked} used)`
  const blocked = !g.owned && g.action === 'noop'
  return (
    <span
      className={`flex items-center gap-1.5 rounded-full border bg-black/70 px-3 py-1.5 text-xs font-semibold shadow-lg backdrop-blur-sm transition-colors ${
        blocked
          ? 'border-lime-700/40 text-lime-700/80'
          : 'border-lime-500/50 text-lime-300 hover:border-lime-400 hover:bg-lime-500/10'
      }`}
    >
      <Warehouse className="h-3.5 w-3.5" aria-hidden="true" />
      <kbd className="rounded bg-lime-500/20 px-1.5 py-0.5 font-mono text-[10px]">E</kbd>
      {label}
      {g.owned && g.carsInside > 0 && g.action !== 'store' && (
        <span className="text-[10px] font-normal text-lime-500/80">
          ({g.carsInside} car{g.carsInside > 1 ? 's' : ''} inside)
        </span>
      )}
      {g.owned && g.baysUnlocked < g.baysTotal && (
        <span className="text-[10px] font-normal text-lime-600/80">(+{g.baysTotal - g.baysUnlocked} locked)</span>
      )}
      {blocked && <span className="sr-only">Garage unavailable</span>}
    </span>
  )
}

/**
 * Round 9: the armed service purchase awaiting its confirming E press.
 * Countdown ring ticks with expiresInSeconds; walking away cancels.
 */
function ServiceConfirmChip({ c }: { c: ServiceConfirm }) {
  const meta =
    c.kind === 'clinic'
      ? { Icon: Heart, ring: 'border-rose-400/70', text: 'text-rose-200', kbd: 'bg-rose-500/25' }
      : c.kind === 'ammo'
        ? { Icon: Zap, ring: 'border-amber-400/70', text: 'text-amber-200', kbd: 'bg-amber-500/25' }
        : { Icon: Paintbrush, ring: 'border-teal-400/70', text: 'text-teal-200', kbd: 'bg-teal-500/25' }
  const pct = Math.max(0, Math.min(100, (c.expiresInSeconds / 8) * 100))
  return (
    <motion.span
      key={c.kind}
      initial={{ opacity: 0, y: 10, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 6, scale: 0.97 }}
      transition={{ type: 'spring', stiffness: 380, damping: 26 }}
      className={`relative flex items-center gap-2.5 rounded-xl border bg-black/80 px-3.5 py-2 shadow-xl backdrop-blur-sm ${meta.ring} ${meta.text}`}
      role="status"
      aria-live="polite"
    >
      <meta.Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="flex flex-col">
        <span className="text-xs font-bold">
          {c.name} — {formatMoney(c.price)}?
        </span>
        <span className="text-[10px] font-normal opacity-80">{c.effect}</span>
      </span>
      <span className="ml-1 flex items-center gap-1.5">
        <kbd className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ${meta.kbd}`}>E</kbd>
        <span className="text-[10px] font-semibold">confirm</span>
      </span>
      {/* countdown track */}
      <span className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden rounded-b-xl">
        <span
          className="block h-full bg-current opacity-60 transition-[width] duration-200"
          style={{ width: `${pct}%` }}
        />
      </span>
    </motion.span>
  )
}

export default function HUD({ gameEl }: { gameEl: React.RefObject<HTMLDivElement | null> }) {
  const hud = useGameStore((s) => s.hud)
  const showFps = useGameStore((s) => s.settings.showFps)
  const damageFlash = useGameStore((s) => s.damageFlash)
  const flourish = useGameStore((s) => s.flourish)
  const hintDismissed = useGameStore((s) => s.hintDismissed)
  const dismissHint = useGameStore((s) => s.dismissHint)
  const setBriefingMissionId = useGameStore((s) => s.setBriefingMissionId)

  // ---- controls hint (first 20 s, dismissible) ----
  const [hintVisible, setHintVisible] = useState(!hintDismissed)
  useEffect(() => {
    if (hintDismissed) {
      setHintVisible(false)
      return
    }
    const timer = window.setTimeout(() => {
      setHintVisible(false)
      dismissHint()
    }, 20_000)
    return () => window.clearTimeout(timer)
  }, [hintDismissed, dismissHint])

  // ---- damage flash (danger notifications) ----
  const [flashing, setFlashing] = useState(false)
  const flashTimer = useRef<number | null>(null)
  useEffect(() => {
    if (damageFlash === 0) return
    setFlashing(true)
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current)
    flashTimer.current = window.setTimeout(() => setFlashing(false), 380)
    return () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current)
    }
  }, [damageFlash])

  // ---- mission-complete flourish (confetti-ish burst) ----
  const [burstKey, setBurstKey] = useState(0)
  useEffect(() => {
    if (flourish > 0) setBurstKey(flourish)
  }, [flourish])

  // ---- Round 10: money delta chip — floats +$X / -$X on every change ----
  const moneyRef = useRef<number | null>(null)
  const [moneyDelta, setMoneyDelta] = useState<number | null>(null)
  const money = hud?.player.money ?? null
  useEffect(() => {
    if (money == null) {
      moneyRef.current = null
      return
    }
    const prev = moneyRef.current
    moneyRef.current = money
    if (prev == null || prev === money) return
    setMoneyDelta(money - prev)
    const t = window.setTimeout(() => setMoneyDelta(null), 1500)
    return () => window.clearTimeout(t)
  }, [money])
  const burstParticles = useMemo(
    () =>
      Array.from({ length: 26 }, (_, i) => ({
        angle: (i / 26) * Math.PI * 2 + Math.random() * 0.5,
        dist: 60 + Math.random() * 130,
        size: 4 + Math.random() * 5,
        color: ['#34d399', '#fbbf24', '#fb7185', '#a1a1aa'][i % 4],
        delay: Math.random() * 0.08,
      })),
    // regenerated per burst via the key embedded in a seeded-ish way
    [burstKey],
  )

  // ---- interaction prompts: nearby vehicle + nearby mission marker ----
  const [nearMission, setNearMission] = useState<AvailableMission | null>(null)
  const [nearService, setNearService] = useState<ServicePrompt | null>(null)
  const [serviceConfirm, setServiceConfirm] = useState<ServiceConfirm | null>(null)
  const [nearGarage, setNearGarage] = useState<GaragePrompt | null>(null)
  // ---- garage ownership chip (top-right, any distance) ----
  const [garageChip, setGarageChip] = useState<{
    owned: boolean
    carsInside: number
    baysUnlocked: number
  } | null>(null)
  useEffect(() => {
    const poll = window.setInterval(() => {
      const engine = engineRef.current
      const state = useGameStore.getState()
      const p = state.hud?.player.position
      if (!engine || !p) {
        setNearMission(null)
        setNearService(null)
        setServiceConfirm(null)
        setNearGarage(null)
        setGarageChip(null)
        return
      }
      let best: AvailableMission | null = null
      let bestD = Infinity
      for (const m of getLiveMissions(engine)) {
        if (m.status !== 'available' || !m.startPosition) continue
        const d = Math.hypot(m.startPosition.x - p.x, m.startPosition.z - p.z)
        if (d < 4.5 && d < bestD) {
          bestD = d
          best = m
        }
      }
      setNearMission(best)
      // City services (clinic / gun shop / Pay'n'Spray) + garage lockup — E.
      setNearService(getServicePrompt(engine))
      setServiceConfirm(getServiceConfirm(engine))
      setNearGarage(getGaragePrompt(engine))
      const gs = getGarageStatus(engine)
      setGarageChip(gs && gs.owned ? gs : null)
    }, 600)
    return () => window.clearInterval(poll)
  }, [])

  // ---- service confirm chip: fast poll for the 6 s countdown bar ----
  const [confirmFast, setConfirmFast] = useState<ServiceConfirm | null>(null)
  const confirmArmed = confirmFast ?? serviceConfirm
  useEffect(() => {
    if (!serviceConfirm) {
      setConfirmFast(null)
      return
    }
    const poll = window.setInterval(() => {
      setConfirmFast(getServiceConfirm(engineRef.current))
    }, 150)
    return () => window.clearInterval(poll)
  }, [serviceConfirm])

  // ---- live vehicle damage for the speedometer ----
  const [vehicleHealth, setVehicleHealth] = useState<number | null>(null)
  const inVehicleId = hud?.player.inVehicleId ?? null
  useEffect(() => {
    if (!inVehicleId) {
      setVehicleHealth(null)
      return
    }
    const poll = window.setInterval(() => {
      setVehicleHealth(getVehicleHealthPct(engineRef.current, inVehicleId))
    }, 250)
    return () => window.clearInterval(poll)
  }, [inVehicleId])

  // ---- police pursuit banner (active cruisers chasing the player) ----
  const [pursuit, setPursuit] = useState<{ active: boolean; count: number; arrestIn: number | null }>({
    active: false,
    count: 0,
    arrestIn: null,
  })
  useEffect(() => {
    const poll = window.setInterval(() => {
      const engine = engineRef.current
      setPursuit({
        active: isPursuitActive(engine),
        count: getPursuit(engine).length,
        arrestIn: getArrestCountdown(engine),
      })
    }, 300)
    return () => window.clearInterval(poll)
  }, [])

  // ---- police air unit (4★+ helicopter) ----
  const [heli, setHeli] = useState<HelicopterInfo | null>(null)
  useEffect(() => {
    const poll = window.setInterval(() => {
      setHeli(getHelicopter(engineRef.current))
    }, 300)
    return () => window.clearInterval(poll)
  }, [])

  // ---- photo mode (V): free-camera FOV + snapshot feedback ----
  const [photoFov, setPhotoFov] = useState(70)
  const [photoSnapCount, setPhotoSnapCount] = useState(0)
  const [snapFlash, setSnapFlash] = useState(false)
  const [savedChip, setSavedChip] = useState(false)
  useEffect(() => {
    const poll = window.setInterval(() => {
      const st = getPhotoState(engineRef.current)
      setPhotoFov(st.fov)
      setPhotoSnapCount(st.snappedAt)
    }, 200)
    return () => window.clearInterval(poll)
  }, [])
  useEffect(() => {
    if (photoSnapCount <= 0) return
    setSnapFlash(true)
    setSavedChip(true)
    const t1 = window.setTimeout(() => setSnapFlash(false), 300)
    const t2 = window.setTimeout(() => setSavedChip(false), 1700)
    return () => {
      window.clearTimeout(t1)
      window.clearTimeout(t2)
    }
  }, [photoSnapCount])

  if (!hud) return null
  const p = hud.player
  const mission = hud.mission
  const driving = !p.onFoot
  const nearVehicle = hud.nearbyVehicles.find((v) => v.distance <= 4) ?? null
  const healthPct = Math.max(0, Math.round((p.health / Math.max(1, p.maxHealth)) * 100))
  const armorPct = Math.max(0, Math.round((p.armor / Math.max(1, p.maxArmor)) * 100))
  const gunDrawn = p.weapon && p.weapon.id !== 'fists'
  const objectiveTimer = mission?.objectiveTimer ?? null
  const missionTimer = mission?.timeLeft ?? null
  const waypointDist =
    mission?.waypoint != null
      ? Math.hypot(mission.waypoint.x - p.position.x, mission.waypoint.z - p.position.z)
      : null

  const toggleFullscreen = (): void => {
    const el = gameEl.current
    if (!el) return
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    else void el.requestFullscreen?.().catch(() => {})
  }

  const photo = hud.photoMode === true

  return (
    <div className="pointer-events-none absolute inset-0 z-20 select-none" aria-hidden={false}>
      {/* ---- photo-mode snapshot flash (shutter) ---- */}
      <AnimatePresence>
        {snapFlash && (
          <motion.div
            key={`snapflash-${photoSnapCount}`}
            className="absolute inset-0 z-30 bg-white"
            initial={{ opacity: 0.9 }}
            animate={{ opacity: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.32, ease: 'easeOut' }}
            aria-hidden="true"
          />
        )}
      </AnimatePresence>

      {/* ---- everything below fades out in photo mode: visibility lags
           the fade by 300 ms so the elements finish fading BEFORE they
           stop rendering (and pointer-events-auto children die with it) ---- */}
      <div
        aria-hidden={photo}
        className={
          photo
            ? 'invisible opacity-0 [transition-delay:0s,0.3s] [transition-property:opacity,visibility] duration-300'
            : 'visible opacity-100 [transition-delay:0s,0s] [transition-property:opacity,visibility] duration-300'
        }
      >
      {/* ---- damage flash vignette ---- */}
      <AnimatePresence>
        {flashing && (
          <motion.div
            key="dmg"
            className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_55%,rgba(225,29,72,0.38))]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
          />
        )}
      </AnimatePresence>

      {/* ---- critical health: slow heartbeat vignette ---- */}
      {healthPct <= 25 && (
        <motion.div
          key="crit"
          className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_48%,rgba(190,18,60,0.34))]"
          initial={{ opacity: 0 }}
          animate={{ opacity: [0.35, 0.85, 0.35] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
          aria-hidden="true"
        />
      )}

      {/* ---- mission complete flourish ---- */}
      {burstKey > 0 && (
        <div key={burstKey} className="absolute left-1/2 top-[30%] -translate-x-1/2">
          {burstParticles.map((pt, i) => (
            <motion.span
              key={i}
              className="absolute rounded-[2px]"
              style={{ width: pt.size, height: pt.size, backgroundColor: pt.color }}
              initial={{ x: 0, y: 0, opacity: 1, rotate: 0 }}
              animate={{
                x: Math.cos(pt.angle) * pt.dist,
                y: Math.sin(pt.angle) * pt.dist + 55,
                opacity: 0,
                rotate: 220,
              }}
              transition={{ duration: 1.15, delay: pt.delay, ease: 'easeOut' }}
            />
          ))}
        </div>
      )}

      {/* ================= race 3-2-1-GO! big overlay ================= */}
      <AnimatePresence>
        {mission?.race?.countdown != null && (
          <motion.div
            key={`race-cd-${mission.race.countdown}`}
            initial={{ scale: 1.7, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.6, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 420, damping: 22 }}
            className="absolute inset-0 flex items-center justify-center"
            aria-live="assertive"
          >
            {mission.race.countdown > 0 ? (
              <span
                className="font-mono text-[120px] font-black leading-none tabular-nums text-white drop-shadow-[0_0_28px_rgba(52,211,153,0.75)] sm:text-[170px]"
                style={{ WebkitTextStroke: '3px rgba(16,185,129,0.85)' }}
              >
                {mission.race.countdown}
              </span>
            ) : (
              <span className="rotate-[-4deg] font-mono text-[92px] font-black italic leading-none tracking-tight text-emerald-300 drop-shadow-[0_0_34px_rgba(52,211,153,0.9)] sm:text-[132px]">
                GO!
              </span>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ================= top-left: clock + fps + fullscreen ================= */}
      <div className="absolute left-2 top-2 flex flex-col items-start gap-1.5 sm:left-3 sm:top-3">
        <div className="flex items-center gap-1.5">
          <span className="flex items-center gap-1.5 rounded-md border border-white/10 bg-black/60 px-2 py-1 font-mono text-[11px] tabular-nums text-zinc-200 backdrop-blur-sm">
            {hud.dayTime >= 21 || hud.dayTime < 6 ? (
              <Moon className="h-3 w-3 text-amber-200/90" aria-hidden="true" />
            ) : hud.dayTime >= 19 || hud.dayTime < 7 ? (
              <SunDim className="h-3 w-3 text-orange-300" aria-hidden="true" />
            ) : (
              <Sun className="h-3 w-3 text-amber-400" aria-hidden="true" />
            )}
            {formatDayTime(hud.dayTime)}
          </span>
          {showFps && (
            <span className="rounded-md border border-white/10 bg-black/60 px-2 py-1 font-mono text-[11px] tabular-nums backdrop-blur-sm">
              <span
                className={
                  hud.fps >= 50 ? 'text-emerald-400' : hud.fps >= 30 ? 'text-amber-400' : 'text-rose-400'
                }
              >
                {hud.fps}
              </span>{' '}
              FPS
            </span>
          )}
          <button
            type="button"
            onClick={toggleFullscreen}
            className="pointer-events-auto flex h-[26px] w-[26px] items-center justify-center rounded-md border border-white/10 bg-black/60 text-zinc-300 backdrop-blur-sm transition-colors hover:border-emerald-500/50 hover:text-emerald-300"
            aria-label="Toggle fullscreen"
            title="Fullscreen"
          >
            <Expand className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* ================= top-center: mission tracker ================= */}
      {mission && mission.status === 'active' && (
        <motion.div
          initial={{ y: -18, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          className="absolute left-1/2 top-2 w-[min(92vw,430px)] -translate-x-1/2 sm:top-3"
        >
          <div className="rounded-lg border border-white/10 bg-black/60 px-3 py-2 text-center backdrop-blur-sm">
            <p className="truncate text-[10px] font-bold uppercase tracking-[0.22em] text-amber-400">
              {mission.name}
            </p>
            <p className="mt-0.5 line-clamp-2 text-xs font-medium text-zinc-100 sm:text-sm">
              {mission.objectiveDescription}
            </p>
            <div className="mt-1 flex flex-wrap items-center justify-center gap-x-3 gap-y-0.5 font-mono text-[11px] tabular-nums text-zinc-400">
              {mission.objectiveProgress && (
                <span className="text-emerald-300">{mission.objectiveProgress}</span>
              )}
              {waypointDist != null && (
                <span className="flex items-center gap-1">
                  <ChevronsRight className="h-3 w-3 text-emerald-500" aria-hidden="true" />
                  {formatDistance(waypointDist)}
                </span>
              )}
              {objectiveTimer != null && (
                <span
                  className={`flex items-center gap-1 ${
                    objectiveTimer < 10 ? 'animate-pulse text-rose-400' : 'text-zinc-300'
                  }`}
                >
                  <Timer className="h-3 w-3" aria-hidden="true" />
                  {Math.ceil(objectiveTimer)}s
                </span>
              )}
              {missionTimer != null && (
                <span className={missionTimer < 30 ? 'text-rose-400' : 'text-amber-300'}>
                  ⏱ {Math.floor(missionTimer / 60)}:{String(Math.floor(missionTimer % 60)).padStart(2, '0')}
                </span>
              )}
            </div>
            {mission.race && mission.race.total > 0 && (
              <div className="mt-1.5" aria-label={`Checkpoint ${mission.race.checkpointIndex} of ${mission.race.total}`}>
                <div className="h-1 w-full overflow-hidden rounded-full bg-white/10">
                  <motion.div
                    className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-emerald-300"
                    initial={false}
                    animate={{
                      width: `${(mission.race.checkpointIndex / mission.race.total) * 100}%`,
                    }}
                    transition={{ type: 'spring', stiffness: 160, damping: 20 }}
                  />
                </div>
                <div className="mt-1 flex flex-wrap items-center justify-center gap-x-3 gap-y-0.5 font-mono text-[9px] uppercase tracking-[0.18em] text-zinc-500">
                  <span>
                    CP {mission.race.checkpointIndex}/{mission.race.total}
                  </span>
                  {mission.race.elapsed != null && (
                    <span className="tabular-nums text-zinc-300">
                      {mission.race.elapsed < 60
                        ? `${mission.race.elapsed.toFixed(1)}s`
                        : `${Math.floor(mission.race.elapsed / 60)}m ${Math.floor(mission.race.elapsed % 60)}s`}
                    </span>
                  )}
                  {mission.race.best != null && (
                    <span className="tabular-nums text-amber-400/90">
                      best {mission.race.best < 60
                        ? `${mission.race.best.toFixed(1)}s`
                        : `${Math.floor(mission.race.best / 60)}m ${Math.floor(mission.race.best % 60)}s`}
                    </span>
                  )}
                </div>
                {mission.race.place != null && mission.race.racerCount > 1 && (
                  <motion.div
                    key={`place-${mission.race.place}`}
                    initial={{ scale: 1.35, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ type: 'spring', stiffness: 380, damping: 20 }}
                    className="mt-1.5 flex items-center justify-center gap-1.5"
                    role="status"
                    aria-label={`Race position ${mission.race.place} of ${mission.race.racerCount}`}
                  >
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-black tracking-wider ${
                        placeBadgeClass(mission.race.place)
                      }`}
                    >
                      {placeLabel(mission.race.place)}
                    </span>
                    <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-zinc-500">
                      of {mission.race.racerCount}
                    </span>
                    {mission.race.leaderName && (
                      <span className="max-w-[120px] truncate font-mono text-[9px] uppercase tracking-[0.14em] text-rose-300/90">
                        lead: {mission.race.leaderName}
                      </span>
                    )}
                  </motion.div>
                )}
              </div>
            )}
          </div>
        </motion.div>
      )}

      {/* ================= police pursuit banner (below mission tracker) ================= */}
      <AnimatePresence>
        {(pursuit.active || heli !== null) && (
          <motion.div
            key={pursuit.arrestIn != null ? 'pursuit-arrest' : 'pursuit-banner'}
            initial={{ y: -14, opacity: 0, scale: 0.92 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: -10, opacity: 0, scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 380, damping: 26 }}
            className="absolute left-1/2 top-[76px] z-20 -translate-x-1/2 sm:top-[86px]"
            role="alert"
            aria-live="assertive"
          >
            {pursuit.arrestIn != null ? (
              <motion.div
                animate={{ scale: [1, 1.05, 1] }}
                transition={{ duration: 0.55, repeat: Infinity, ease: 'easeInOut' }}
                className="flex items-center gap-2 rounded-lg border-2 border-rose-400 bg-gradient-to-r from-rose-600/95 via-rose-950/95 to-rose-600/95 px-4 py-2 shadow-[0_0_30px_rgba(244,63,94,0.7)] backdrop-blur-sm"
              >
                <motion.span
                  animate={{ rotate: [-8, 8, -8] }}
                  transition={{ duration: 0.55, repeat: Infinity, ease: 'easeInOut' }}
                  className="flex items-center"
                >
                  <Siren className="h-5 w-5 text-rose-100" aria-hidden="true" />
                </motion.span>
                <span className="text-xs font-black uppercase tracking-[0.24em] text-white sm:text-sm">
                  Boxed in — busted in
                </span>
                <span className="rounded bg-white/20 px-2 py-0.5 font-mono text-lg font-black tabular-nums text-white">
                  {pursuit.arrestIn}s
                </span>
                <span className="hidden text-[10px] font-bold uppercase tracking-wider text-rose-100/90 sm:inline">
                  floor it!
                </span>
              </motion.div>
            ) : (
              <div className="flex items-center gap-2 rounded-lg border border-rose-500/70 bg-gradient-to-r from-rose-950/90 via-black/80 to-rose-950/90 px-3 py-1.5 shadow-[0_0_18px_rgba(244,63,94,0.35)] backdrop-blur-sm">
                <motion.span
                  animate={{ opacity: [1, 0.35, 1] }}
                  transition={{ duration: 0.9, repeat: Infinity, ease: 'easeInOut' }}
                  className="flex items-center"
                >
                  <Siren className="h-4 w-4 text-rose-400" aria-hidden="true" />
                </motion.span>
                <span className="text-[11px] font-black uppercase tracking-[0.24em] text-rose-300 sm:text-xs">
                  {pursuit.active || heli === null ? 'Pursuit' : 'Air pursuit'}
                </span>
                {pursuit.active && (
                  <span className="rounded bg-rose-500/20 px-1.5 py-0.5 font-mono text-[10px] font-bold tabular-nums text-rose-200">
                    {pursuit.count} {pursuit.count === 1 ? 'cruiser' : 'cruisers'}
                  </span>
                )}
                {heli !== null && (
                  <span
                    className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-black uppercase tracking-wider ${
                      heli.searchlightOn
                        ? 'bg-amber-400/25 text-amber-200 ring-1 ring-amber-300/60 shadow-[0_0_10px_rgba(251,191,36,0.4)]'
                        : 'bg-rose-500/20 text-rose-200'
                    }`}
                  >
                    <Lightbulb className="h-3 w-3" aria-hidden="true" />
                    Air unit{heli.searchlightOn ? ' — spotted' : ''}
                  </span>
                )}
                {heli?.rappelling && (
                  <motion.span
                    animate={{ opacity: [1, 0.45, 1] }}
                    transition={{ duration: 0.7, repeat: Infinity, ease: 'easeInOut' }}
                    className="rounded bg-rose-600/30 px-1.5 py-0.5 text-[10px] font-black uppercase tracking-wider text-rose-100 ring-1 ring-rose-400/60"
                  >
                    SWAT roping down
                  </motion.span>
                )}
                <span className="hidden text-[10px] font-medium text-rose-300/70 sm:inline">
                  {heli?.searchlightOn
                    ? 'under the light your heat will not cool'
                    : 'evade or get boxed in — they WILL ram'}
                </span>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ================= top-right: money · wanted · level ================= */}
      <div className="absolute right-2 top-2 flex flex-col items-end gap-1.5 sm:right-3 sm:top-3">
        <div className="relative flex items-center">
          {/* Round 10: floating +$X / -$X delta on every change */}
          <AnimatePresence>
            {moneyDelta != null && (
              <motion.span
                key={`${moneyDelta}-${money}`}
                initial={{ opacity: 0, x: 6, y: 4 }}
                animate={{ opacity: [0, 1, 1, 0], y: -14 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 1.5, ease: 'easeOut', times: [0, 0.12, 0.7, 1] }}
                className={`absolute -left-2 top-1/2 -translate-x-full whitespace-nowrap font-mono text-xs font-bold tabular-nums ${
                  moneyDelta > 0 ? 'text-emerald-400' : 'text-rose-400'
                }`}
                aria-live="polite"
              >
                {moneyDelta > 0 ? '+' : '−'}${Math.abs(moneyDelta)}
              </motion.span>
            )}
          </AnimatePresence>
          <motion.span
            key={p.money}
            initial={{ scale: 1.14 }}
            animate={{ scale: 1 }}
            className={`rounded-md border bg-black/60 px-2.5 py-1 font-mono text-sm font-bold tabular-nums backdrop-blur-sm transition-colors sm:text-base ${
              moneyDelta != null
                ? moneyDelta > 0
                  ? 'border-emerald-400/60 text-emerald-300'
                  : 'border-rose-400/60 text-rose-300'
                : 'border-white/10 text-emerald-400'
            }`}
          >
            {formatMoney(p.money)}
          </motion.span>
        </div>
        <motion.div
          key={p.wantedLevel}
          initial={p.wantedLevel > 0 ? { scale: 1.3 } : false}
          animate={
            p.wantedLevel >= 3
              ? { scale: [1, 1.06, 1] }
              : { scale: 1 }
          }
          transition={
            p.wantedLevel >= 3
              ? { duration: 1.1, repeat: Infinity, ease: 'easeInOut' }
              : undefined
          }
          className={`flex items-center gap-[3px] rounded-md border bg-black/60 px-2 py-1 backdrop-blur-sm ${
            p.wantedLevel >= 3
              ? 'border-rose-500/70 shadow-[0_0_10px_rgba(244,63,94,0.35)]'
              : 'border-white/10'
          }`}
          aria-label={`Wanted level ${p.wantedLevel} of 5${p.wantedLevel >= 3 ? ' — heavy police heat' : ''}`}
        >
          {Array.from({ length: 5 }, (_, i) => (
            <Star
              key={i}
              className={`h-3.5 w-3.5 sm:h-4 sm:w-4 ${
                i < p.wantedLevel
                  ? p.wantedLevel >= 3
                    ? 'fill-rose-400 text-rose-400 drop-shadow-[0_0_3px_rgba(251,113,133,0.8)]'
                    : 'fill-amber-400 text-amber-400'
                  : 'fill-zinc-800 text-zinc-700'
              }`}
              aria-hidden="true"
            />
          ))}
        </motion.div>
        <span className="flex items-center gap-1 rounded-md border border-white/10 bg-black/60 px-2 py-1 font-mono text-[10px] tabular-nums text-zinc-300 backdrop-blur-sm sm:text-[11px]">
          <Zap className="h-3 w-3 text-amber-400" aria-hidden="true" />
          LV {p.level} · {p.xp} XP
        </span>
        <AnimatePresence>
          {garageChip && (
            <motion.span
              key="garage-chip"
              initial={{ opacity: 0, scale: 0.85, y: -4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.85 }}
              className="flex items-center gap-1.5 rounded-md border border-lime-500/40 bg-black/60 px-2 py-1 text-[9px] font-bold uppercase tracking-wider text-lime-300/90 backdrop-blur-sm"
              aria-label={`Garage owned — ${garageChip.carsInside} of ${garageChip.baysUnlocked} bays used`}
            >
              <Warehouse className="h-3 w-3" aria-hidden="true" />
              Garage
              {/* bay pips: filled = car parked, hollow = free, dim = locked */}
              <span className="flex items-center gap-[3px]" aria-hidden="true">
                {[0, 1, 2].map((i) =>
                  i < garageChip.baysUnlocked ? (
                    <span
                      key={i}
                      className={`h-1.5 w-1.5 rounded-full border ${
                        i < garageChip.carsInside
                          ? 'border-lime-300 bg-lime-400 shadow-[0_0_5px_rgba(163,230,53,0.7)]'
                          : 'border-lime-500/50 bg-transparent'
                      }`}
                    />
                  ) : (
                    <span key={i} className="h-1.5 w-1.5 rounded-full border border-zinc-700 bg-zinc-800" />
                  ),
                )}
              </span>
            </motion.span>
          )}
        </AnimatePresence>
        <AnimatePresence>
          {heli !== null && (
            <motion.span
              key="air-unit"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              className="flex items-center gap-1.5 rounded-md border border-rose-500/60 bg-rose-950/70 px-2 py-1 text-[9px] font-black uppercase tracking-[0.18em] text-rose-200 shadow-[0_0_12px_rgba(244,63,94,0.35)] backdrop-blur-sm sm:text-[10px]"
              aria-label="Police helicopter overhead"
            >
              <motion.span
                animate={{ rotate: 360 }}
                transition={{ duration: 0.9, repeat: Infinity, ease: 'linear' }}
                className="flex items-center"
                aria-hidden="true"
              >
                <RotateCw className="h-3 w-3 text-rose-300" aria-hidden="true" />
              </motion.span>
              {heli.searchlightOn ? 'Lit — heat locked' : 'Chopper overhead'}
            </motion.span>
          )}
        </AnimatePresence>
        <AnimatePresence>
          {heli !== null && heli.swatDeployed > 0 && (
            <motion.span
              key="swat-deployed"
              initial={{ opacity: 0, x: 14 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 14 }}
              className="flex items-center gap-1.5 rounded-md border border-rose-400/50 bg-black/75 px-2 py-1 font-mono text-[9px] font-bold tabular-nums tracking-[0.14em] text-rose-200 backdrop-blur-sm sm:text-[10px]"
              aria-label={`${heli.swatDeployed} SWAT officers deployed by the air unit`}
            >
              <Shield className="h-3 w-3 text-rose-300" aria-hidden="true" />
              SWAT DEPLOYED ×{heli.swatDeployed}
            </motion.span>
          )}
        </AnimatePresence>
      </div>

      {/* ================= crosshair + interaction prompts ================= */}
      {gunDrawn && !driving && (
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
          <span className="block h-1.5 w-1.5 rounded-full bg-emerald-300/90 shadow-[0_0_6px_rgba(52,211,153,0.9)]" />
        </div>
      )}
      <div className="absolute left-1/2 top-[58%] flex -translate-x-1/2 flex-col items-center gap-1.5">
        {nearService && !confirmArmed && <ServicePromptPill svc={nearService} />}
        <AnimatePresence>
          {confirmArmed && <ServiceConfirmChip c={confirmArmed} key={`confirm-${confirmArmed.kind}`} />}
        </AnimatePresence>
        {nearGarage && !useGameStore.getState().garagePanelOpen && <GaragePromptPill g={nearGarage} />}
        {nearMission && (
          <button
            type="button"
            onClick={() => setBriefingMissionId(nearMission.id)}
            className="pointer-events-auto rounded-full border border-amber-500/50 bg-black/70 px-3 py-1.5 text-xs font-semibold text-amber-300 shadow-lg backdrop-blur-sm transition-colors hover:border-amber-400 hover:bg-amber-500/10"
          >
            <kbd className="mr-1.5 rounded bg-amber-500/20 px-1.5 py-0.5 font-mono text-[10px]">E</kbd>
            Start Mission: {nearMission.name}
            <span className="ml-1.5 text-[10px] font-normal text-amber-500/80">(click for briefing)</span>
          </button>
        )}
        {nearVehicle && (
          <span className="rounded-full border border-emerald-500/50 bg-black/70 px-3 py-1.5 text-xs font-semibold text-emerald-300 shadow-lg backdrop-blur-sm">
            <kbd className="mr-1.5 rounded bg-emerald-500/20 px-1.5 py-0.5 font-mono text-[10px]">F</kbd>
            Enter {nearVehicle.name}
          </span>
        )}
      </div>

      {/* ================= bottom-left: hint · minimap · health ================= */}
      <div className="absolute bottom-2 left-2 flex flex-col gap-2 sm:bottom-3 sm:left-3">
        <AnimatePresence>
          {hintVisible && (
            <motion.div
              key="hint"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              className="w-44 rounded-lg border border-white/10 bg-black/60 p-2.5 text-zinc-300 backdrop-blur-sm sm:w-52"
            >
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-emerald-400">
                  Controls
                </span>
                <button
                  type="button"
                  onClick={dismissHint}
                  className="pointer-events-auto rounded p-0.5 text-zinc-500 transition-colors hover:text-zinc-200"
                  aria-label="Dismiss controls hint"
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              </div>
              <ul className="space-y-0.5 text-[10px] leading-tight sm:text-[11px]">
                {HINT_ROWS.map(([k, v]) => (
                  <li key={k} className="flex items-center justify-between gap-2">
                    <kbd className="rounded bg-zinc-800/90 px-1.5 py-0.5 font-mono text-[9px] text-zinc-200">
                      {k}
                    </kbd>
                    <span className="text-zinc-400">{v}</span>
                  </li>
                ))}
              </ul>
            </motion.div>
          )}
        </AnimatePresence>

        <Minimap className="h-[120px] w-[120px] sm:h-[180px] sm:w-[180px]" />

        <div className="w-[120px] space-y-1 sm:w-[180px]">
          <div className="flex items-center gap-1.5">
            <motion.span
              animate={
                healthPct <= 25
                  ? { scale: [1, 1.35, 1], opacity: [1, 0.6, 1] }
                  : { scale: 1, opacity: 1 }
              }
              transition={healthPct <= 25 ? { duration: 1.1, repeat: Infinity } : { duration: 0.2 }}
              className="flex h-3 w-3 shrink-0 items-center justify-center"
            >
              <Heart className="h-3 w-3 text-rose-400" aria-hidden="true" />
            </motion.span>
            <div
              className={`h-2 flex-1 overflow-hidden rounded-full bg-zinc-900/90 ring-1 ring-white/10 ${
                healthPct <= 25 ? 'ring-rose-500/60' : ''
              }`}
              role="progressbar"
              aria-label={`Health ${healthPct}%${healthPct <= 25 ? ' — critical' : ''}`}
              aria-valuenow={healthPct}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <motion.div
                className={`h-full rounded-full bg-gradient-to-r ${healthBarClass(healthPct)}`}
                animate={{
                  width: `${healthPct}%`,
                  ...(healthPct <= 25 ? { opacity: [0.55, 1, 0.55] } : {}),
                }}
                transition={
                  healthPct <= 25
                    ? { width: { duration: 0.25 }, opacity: { duration: 1.1, repeat: Infinity } }
                    : { duration: 0.25 }
                }
              />
            </div>
            <span className="w-7 text-right font-mono text-[10px] tabular-nums text-zinc-300">
              {p.health}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Shield className="h-3 w-3 shrink-0 text-zinc-400" aria-hidden="true" />
            <div
              className="h-2 flex-1 overflow-hidden rounded-full bg-zinc-900/90 ring-1 ring-white/10"
              role="progressbar"
              aria-label={`Armor ${armorPct}%`}
              aria-valuenow={armorPct}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <motion.div
                className="h-full rounded-full bg-gradient-to-r from-zinc-500 to-zinc-300"
                animate={{ width: `${armorPct}%` }}
                transition={{ duration: 0.25 }}
              />
            </div>
            <span className="w-7 text-right font-mono text-[10px] tabular-nums text-zinc-400">
              {p.armor}
            </span>
          </div>
        </div>
      </div>

      {/* ================= bottom-right: weapon panel / speedometer ================= */}
      {driving ? (
        <div className="absolute bottom-2 right-2 flex flex-col items-end gap-1.5 sm:bottom-3 sm:right-3">
          <RadioWidget driving={driving} />
          <div className="w-[150px] rounded-lg border border-white/10 bg-black/60 px-3 py-2 text-right backdrop-blur-sm sm:w-[190px] sm:px-4 sm:py-3">
            <p className="truncate text-[10px] font-bold uppercase tracking-[0.2em] text-emerald-400">
              {p.vehicleName ?? 'Vehicle'}
            </p>
            <p className="font-mono text-3xl font-black tabular-nums leading-none text-zinc-100 sm:text-4xl">
              {Math.round(p.speedKmh)}
              <span className="ml-1 text-[10px] font-medium text-zinc-500">km/h</span>
            </p>
            <div className="mt-1.5 flex items-center justify-end gap-1.5">
              <span className="text-[9px] uppercase tracking-widest text-zinc-500">dmg</span>
              <div
                className="h-1.5 w-20 overflow-hidden rounded-full bg-zinc-900 ring-1 ring-white/10 sm:w-24"
                role="progressbar"
                aria-label="Vehicle condition"
                aria-valuenow={vehicleHealth ?? 100}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  className={`h-full rounded-full transition-[width] duration-300 ${
                    (vehicleHealth ?? 100) > 55
                      ? 'bg-emerald-500'
                      : (vehicleHealth ?? 100) > 25
                        ? 'bg-amber-500'
                        : 'animate-pulse bg-rose-500'
                  }`}
                  style={{ width: `${vehicleHealth ?? 100}%` }}
                />
              </div>
            </div>
            {vehicleHealth != null && vehicleHealth <= 30 && (
              <p
                className={`mt-1 text-[9px] font-bold uppercase tracking-[0.18em] ${
                  vehicleHealth <= 25 ? 'animate-pulse text-rose-400' : 'text-amber-400'
                }`}
              >
                {vehicleHealth <= 25 ? '⚠ engine critical — bail out' : '⚠ smoking'}
              </p>
            )}
          </div>
        </div>
      ) : (
        <div className="absolute bottom-2 right-2 sm:bottom-3 sm:right-3">
          <div className="w-[170px] rounded-lg border border-white/10 bg-black/60 px-3 py-2 text-right backdrop-blur-sm sm:w-[210px] sm:px-4 sm:py-3">
            <p className="truncate text-[10px] font-bold uppercase tracking-[0.2em] text-amber-400">
              {p.weapon.name}
            </p>
            <p className="font-mono tabular-nums leading-none text-zinc-100">
              <span className="text-3xl font-black sm:text-4xl">
                {p.weapon.id === 'fists' ? '—' : p.weapon.ammo}
              </span>
              <span className="ml-1.5 text-sm font-semibold text-zinc-500">
                / {p.weapon.id === 'fists' ? '∞' : p.weapon.reserveAmmo}
              </span>
            </p>
            {p.weapon.reloading ? (
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-zinc-900 ring-1 ring-amber-500/30">
                <div
                  className="h-full rounded-full bg-amber-400 transition-[width] duration-150"
                  style={{ width: `${Math.round(p.weapon.reloadProgress * 100)}%` }}
                />
              </div>
            ) : (
              <div className="mt-1.5 flex flex-wrap justify-end gap-1">
                {p.weaponsOwned.map((id) => {
                  const slot = ['fists', 'pistol', 'smg', 'rifle', 'shotgun'].indexOf(id) + 1
                  const active = p.weapon.id === id
                  return (
                    <span
                      key={id}
                      className={`rounded px-1.5 py-0.5 font-mono text-[9px] font-bold tracking-wider ${
                        active
                          ? 'bg-emerald-500/25 text-emerald-300 ring-1 ring-emerald-500/50'
                          : 'bg-zinc-800/80 text-zinc-500'
                      }`}
                    >
                      {slot} {WEAPON_SHORT[id] ?? id.toUpperCase()}
                    </span>
                  )
                })}
              </div>
            )}
            {p.weapon.reloading && (
              <p className="mt-1 text-[9px] uppercase tracking-widest text-amber-500">reloading…</p>
            )}
          </div>
        </div>
      )}

      {/* ================= bottom-center: notification stack ================= */}
      <div
        className="absolute bottom-2 left-1/2 flex w-[min(92vw,380px)] -translate-x-1/2 flex-col items-center gap-1 sm:bottom-3"
        aria-live="polite"
      >
        <AnimatePresence initial={false}>
          {hud.notifications.slice(-4).map((n) => {
            const style = NOTIF_STYLES[n.kind] ?? NOTIF_STYLES.info
            const Icon = style.Icon
            return (
              <motion.div
                key={n.id}
                layout
                initial={{ opacity: 0, y: 18, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -10, scale: 0.97 }}
                transition={{ duration: 0.22 }}
                className={`flex max-w-full items-center gap-2 rounded-full border bg-black/75 px-2.5 py-1.5 text-xs font-medium shadow-lg backdrop-blur-sm ${style.cls}`}
              >
                <span
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${style.chip}`}
                  aria-hidden="true"
                >
                  <Icon className="h-3 w-3" />
                </span>
                <span className="truncate">{n.text}</span>
              </motion.div>
            )
          })}
        </AnimatePresence>
      </div>
      </div>

      {/* ================= photo mode bar (V) ================= */}
      {/* cinematic overlays: subtle vignette + rule-of-thirds hairlines */}
      {photo && (
        <div className="absolute inset-0" aria-hidden="true">
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_62%,rgba(0,0,0,0.34))]" />
          <div className="absolute inset-y-0 left-1/3 w-px bg-white/[0.09]" />
          <div className="absolute inset-y-0 left-2/3 w-px bg-white/[0.09]" />
          <div className="absolute inset-x-0 top-1/3 h-px bg-white/[0.09]" />
          <div className="absolute inset-x-0 top-2/3 h-px bg-white/[0.09]" />
        </div>
      )}
      <AnimatePresence>
        {photo && (
          <motion.div
            key="photobar"
            initial={{ y: -22, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -22, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 380, damping: 26 }}
            className="absolute left-1/2 top-3 -translate-x-1/2"
            role="status"
          >
            <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-full border border-amber-500/40 bg-black/75 px-4 py-2 shadow-[0_8px_30px_rgba(0,0,0,0.55)] backdrop-blur-md">
              <span className="flex items-center gap-1.5 font-mono text-[11px] font-black tracking-[0.28em] text-amber-300">
                <Aperture className="h-4 w-4" aria-hidden="true" />
                PHOTO MODE
              </span>
              <span className="font-mono text-[11px] tabular-nums text-zinc-400">
                {photoFov}° FOV
              </span>
              <span className="hidden text-[10px] font-medium text-zinc-500 sm:inline">
                WASD fly · Q/E rise · Shift boost · wheel zoom
              </span>
              <span className="text-[10px] font-medium text-zinc-500">
                <kbd className="rounded border border-white/15 bg-white/5 px-1 py-0.5 font-mono text-[9px] text-zinc-300">Space</kbd> snap ·{' '}
                <kbd className="rounded border border-white/15 bg-white/5 px-1 py-0.5 font-mono text-[9px] text-zinc-300">V</kbd> exit
              </span>
            </div>
            <AnimatePresence>
              {savedChip && (
                <motion.div
                  key={`saved-${photoSnapCount}`}
                  initial={{ opacity: 0, y: -6, scale: 0.9 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -6, scale: 0.95 }}
                  transition={{ duration: 0.2 }}
                  className="mx-auto mt-2 flex w-fit items-center gap-1.5 rounded-full border border-emerald-500/50 bg-black/80 px-3 py-1 text-[10px] font-bold tracking-widest text-emerald-300 backdrop-blur-sm"
                >
                  <CheckCircle2 className="h-3 w-3" aria-hidden="true" /> PHOTO SAVED
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  )
}
