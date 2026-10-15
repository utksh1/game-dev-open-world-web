'use client'
/**
 * GaragePanel — round 9's bay-management overlay (the "car collection"
 * UI). Opened with E at the lockup pad while owned (on foot, or driving
 * with every bay full); closed with E / Esc / the close button / the
 * walk-away leash.
 *
 * Each bay card shows the parked car with its live damage bar and paint
 * chip, a take-out (or swap-while-driving) action, and the $25 respray
 * palette (cosmetic only — Pay'n'Spray still owns repairs + heat).
 * Locked bays carry the annex-the-unit-next-door purchase.
 */
import { useCallback, useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Car,
  Check,
  ChevronDown,
  Lock,
  LogOut,
  Plus,
  SprayCan,
  Wallet,
  Warehouse,
  Wrench,
} from 'lucide-react'
import { engineRef, useGameStore } from '@/game/state'
import type { GarageBay } from '@/game/gameplay/GarageSystem'
import { GARAGE_EXPAND_PRICE, RESPRAY_PRICE } from '@/game/gameplay/GarageSystem'
import { RESPRAY_COLORS, hexToCss } from '@/game/paint'
import {
  formatMoney,
  garageExpand,
  garageRespray,
  garageTakeOut,
  getGarageBays,
} from './engineViews'
import { Button } from '@/components/ui/button'

/** Damage bar tint buckets (emerald → amber → rose). */
function damageTint(pct: number): string {
  if (pct >= 66) return 'bg-lime-500'
  if (pct >= 33) return 'bg-amber-400'
  return 'bg-rose-500'
}

function BayCard({ bay, driving }: { bay: GarageBay; driving: boolean }) {
  const [paletteOpen, setPaletteOpen] = useState(false)
  const money = useGameStore((s) => s.hud?.player.money) ?? 0
  const car = bay.car

  // ---- locked bay: the annex CTA ----
  if (!bay.unlocked) {
    return (
      <div className="relative flex min-h-[280px] flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-zinc-700/70 bg-zinc-900/40 p-5 text-center">
        <span className="flex h-11 w-11 items-center justify-center rounded-full border border-zinc-700 bg-zinc-950/80">
          <Lock className="h-5 w-5 text-zinc-500" aria-hidden="true" />
        </span>
        <div>
          <p className="text-sm font-semibold text-zinc-300">Bay {bay.index + 1} — locked</p>
          <p className="mt-1 text-xs text-zinc-500">
            The industrial unit next door. Same key, more metal.
          </p>
        </div>
        <Button
          size="sm"
          className="border border-lime-500/40 bg-lime-500/10 text-lime-300 hover:bg-lime-500/20"
          onClick={() => garageExpand(engineRef.current)}
        >
          <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          Annex — {formatMoney(GARAGE_EXPAND_PRICE)}
        </Button>
      </div>
    )
  }

  // ---- empty bay ----
  if (!car) {
    return (
      <div className="relative flex min-h-[280px] flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-zinc-700/70 bg-zinc-900/40 p-5 text-center">
        <span className="flex h-11 w-11 items-center justify-center rounded-full border border-zinc-700 bg-zinc-950/80">
          <Warehouse className="h-5 w-5 text-zinc-600" aria-hidden="true" />
        </span>
        <div>
          <p className="text-sm font-semibold text-zinc-300">Bay {bay.index + 1} — empty</p>
          <p className="mt-1 text-xs text-zinc-500">
            Drive a car onto the pad and press E to fill it.
          </p>
        </div>
        <span className="rounded-full border border-zinc-800 bg-zinc-950/60 px-2.5 py-1 font-mono text-[10px] tracking-widest text-zinc-600">
          FREE STORAGE
        </span>
      </div>
    )
  }

  // ---- occupied bay ----
  const healthPct = Math.max(0, Math.min(100, Math.round((car.health / Math.max(1, car.maxHealth)) * 100)))
  const isCurrentPaint = (hex: number | null): boolean =>
    (car.paintColor ?? null) === hex

  return (
    <div className="relative flex min-h-[280px] flex-col rounded-xl border border-lime-500/20 bg-zinc-900/70 p-5 shadow-[inset_0_1px_0_rgba(163,230,53,0.06)]">
      {/* bay number chip */}
      <span className="absolute -top-2.5 left-4 rounded-full border border-lime-500/30 bg-zinc-950 px-2 py-0.5 font-mono text-[10px] tracking-widest text-lime-400">
        BAY {bay.index + 1}
      </span>

      {/* paint chip + name */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-zinc-700/60"
            style={{ backgroundColor: `${hexToCss(car.paintColor)}26` }}
            aria-hidden="true"
          >
            <Car className="h-5 w-5" style={{ color: hexToCss(car.paintColor) }} />
          </span>
          <div>
            <p className="text-sm font-semibold text-zinc-100">{car.name}</p>
            <p className="font-mono text-[10px] uppercase tracking-widest text-zinc-500">
              {car.paintColor != null
                ? RESPRAY_COLORS.find((c) => c.hex === car.paintColor)?.name ?? 'Custom paint'
                : 'Factory paint'}
            </p>
          </div>
        </div>
        {car.paintColor != null && (
          <span
            className="mt-1 h-4 w-4 rounded-full border border-zinc-600 shadow-inner"
            style={{ backgroundColor: hexToCss(car.paintColor) }}
            title={RESPRAY_COLORS.find((c) => c.hex === car.paintColor)?.name ?? 'Custom paint'}
          />
        )}
      </div>

      {/* damage bar */}
      <div className="mt-4">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
            <Wrench className="h-3 w-3" aria-hidden="true" /> Condition
          </span>
          <span className="font-mono text-[10px] text-zinc-400">
            {Math.round(car.health)}/{car.maxHealth}
          </span>
        </div>
        <div
          className="h-2 overflow-hidden rounded-full bg-zinc-800"
          role="progressbar"
          aria-valuenow={healthPct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${car.name} condition`}
        >
          <div
            className={`h-full rounded-full transition-all ${damageTint(healthPct)}`}
            style={{ width: `${healthPct}%` }}
          />
        </div>
        {healthPct < 100 && (
          <p className="mt-1.5 text-[10px] text-zinc-600">
            Damage persists in storage — Pay&apos;n&apos;Spray repairs for {formatMoney(100)}.
          </p>
        )}
      </div>

      {/* respray palette (collapsible) */}
      <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-950/50">
        <button
          type="button"
          onClick={() => setPaletteOpen((v) => !v)}
          className="flex w-full items-center justify-between px-3 py-2 text-left"
          aria-expanded={paletteOpen}
        >
          <span className="flex items-center gap-1.5 text-xs font-semibold text-zinc-300">
            <SprayCan className="h-3.5 w-3.5 text-fuchsia-400" aria-hidden="true" />
            Respray
            <span className="font-normal text-zinc-500">· {formatMoney(RESPRAY_PRICE)}</span>
          </span>
          <ChevronDown
            className={`h-3.5 w-3.5 text-zinc-500 transition-transform ${paletteOpen ? 'rotate-180' : ''}`}
            aria-hidden="true"
          />
        </button>
        <AnimatePresence initial={false}>
          {paletteOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
              className="overflow-hidden"
            >
              <div className="grid grid-cols-6 gap-1.5 px-3 pb-3">
                {RESPRAY_COLORS.map((c) => {
                  const selected = isCurrentPaint(c.hex)
                  const broke = money < RESPRAY_PRICE
                  return (
                    <button
                      key={c.hex}
                      type="button"
                      title={`${c.name}${selected ? ' (current)' : ''}`}
                      disabled={broke && !selected}
                      aria-label={`Respray ${c.name}`}
                      className={`group relative flex h-8 w-8 items-center justify-center rounded-full border transition-all ${
                        selected
                          ? 'border-lime-400 ring-2 ring-lime-400/30'
                          : 'border-zinc-700 hover:scale-110 hover:border-zinc-500'
                      } ${broke && !selected ? 'cursor-not-allowed opacity-30 hover:scale-100' : ''}`}
                      style={{ backgroundColor: hexToCss(c.hex) }}
                      onClick={() => garageRespray(engineRef.current, bay.index, c.hex)}
                    >
                      {selected && <Check className="h-3.5 w-3.5 text-zinc-950" aria-hidden="true" />}
                    </button>
                  )
                })}
                <button
                  type="button"
                  title="Factory paint (free)"
                  aria-label="Restore factory paint"
                  className={`flex h-8 items-center justify-center rounded-full border text-[9px] font-bold tracking-tight transition-all ${
                    isCurrentPaint(null)
                      ? 'border-lime-400 text-lime-300 ring-2 ring-lime-400/30'
                      : 'border-zinc-700 text-zinc-400 hover:border-zinc-500'
                  }`}
                  onClick={() => garageRespray(engineRef.current, bay.index, null)}
                >
                  OEM
                </button>
              </div>
              <p className="px-3 pb-2.5 text-[10px] text-zinc-600">
                Cosmetic only — the spray booth still owns repairs &amp; heat clearing.
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* take out / swap */}
      <div className="mt-auto pt-4">
        <Button
          size="sm"
          className="w-full border border-lime-500/40 bg-lime-500/15 text-lime-200 hover:bg-lime-500/25"
          onClick={() => {
            garageTakeOut(engineRef.current, bay.index)
            if (!driving) useGameStore.getState().setGaragePanelOpen(false)
            ;(
              engineRef.current?.systems as unknown as { garage?: { onUiClosed?: () => void } }
            )?.garage?.onUiClosed?.()
          }}
        >
          <LogOut className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          {driving ? `Swap — park here, take the ${car.name}` : `Take out the ${car.name}`}
        </Button>
      </div>
    </div>
  )
}

export default function GaragePanel() {
  const open = useGameStore((s) => s.garagePanelOpen)
  const setGaragePanelOpen = useGameStore((s) => s.setGaragePanelOpen)
  const hud = useGameStore((s) => s.hud)
  const money = hud?.player.money ?? 0
  const driving = !!hud?.player.inVehicleId
  const [bays, setBays] = useState<GarageBay[]>([])
  const [district, setDistrict] = useState('')

  // Poll bay data while open (actions mutate the system immediately).
  useEffect(() => {
    if (!open) return
    const refresh = (): void => {
      setBays(getGarageBays(engineRef.current))
      try {
        setDistrict(engineRef.current?.level?.name ?? '')
      } catch {
        setDistrict('')
      }
    }
    refresh()
    const poll = window.setInterval(refresh, 300)
    return () => window.clearInterval(poll)
  }, [open])

  const close = useCallback(() => {
    setGaragePanelOpen(false)
    ;(
      engineRef.current?.systems as unknown as { garage?: { onUiClosed?: () => void } }
    )?.garage?.onUiClosed?.()
  }, [setGaragePanelOpen])

  const used = bays.filter((b) => b.unlocked && b.car).length
  const unlocked = bays.filter((b) => b.unlocked).length || 3

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          className="fixed inset-0 z-[56] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label="Garage bay management"
        >
          <motion.div
            initial={{ y: 22, scale: 0.97, opacity: 0 }}
            animate={{ y: 0, scale: 1, opacity: 1 }}
            exit={{ y: 14, scale: 0.98, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 320, damping: 28 }}
            className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-lime-500/25 bg-zinc-950/95 shadow-[0_0_60px_rgba(163,230,53,0.08)]"
          >
            {/* ---- header ---- */}
            <div className="flex items-center justify-between gap-3 border-b border-zinc-800/80 bg-gradient-to-r from-lime-500/10 via-transparent to-transparent px-5 py-4">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-lime-500/30 bg-lime-500/10">
                  <Warehouse className="h-5 w-5 text-lime-400" aria-hidden="true" />
                </span>
                <div>
                  <h2 className="text-base font-bold tracking-tight text-zinc-50">
                    Your Lockup
                    <span className="ml-2 rounded-full border border-lime-500/30 bg-lime-500/10 px-2 py-0.5 align-middle font-mono text-[10px] font-medium tracking-widest text-lime-300">
                      {used}/{unlocked} BAYS
                    </span>
                  </h2>
                  <p className="text-xs text-zinc-500">
                    {district ? `${district} · ` : ''}one key, every district — cars travel with you
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span
                  className="flex items-center gap-1.5 rounded-full border border-zinc-700/70 bg-zinc-900/70 px-3 py-1.5 font-mono text-xs font-semibold text-emerald-300"
                  aria-live="polite"
                >
                  <Wallet className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
                  {formatMoney(money)}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-500"
                  onClick={close}
                >
                  Close
                </Button>
              </div>
            </div>

            {/* ---- bays ---- */}
            <div className="grid gap-4 overflow-y-auto p-5 sm:grid-cols-2 lg:grid-cols-3">
              {bays.map((bay, i) => (
                <motion.div
                  key={bay.index}
                  initial={{ y: 16, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ delay: 0.05 + i * 0.06, duration: 0.24, ease: 'easeOut' }}
                >
                  <BayCard bay={bay} driving={driving} />
                </motion.div>
              ))}
            </div>

            {/* ---- footer ---- */}
            <div className="flex items-center justify-between gap-3 border-t border-zinc-800/80 bg-zinc-900/40 px-5 py-3">
              <p className="text-[11px] text-zinc-500">
                Respray {formatMoney(RESPRAY_PRICE)} · repairs &amp; heat clearing stay at
                Pay&apos;n&apos;Spray ({formatMoney(100)})
              </p>
              <p className="hidden items-center gap-2 text-[11px] text-zinc-500 sm:flex">
                <kbd className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300">
                  E
                </kbd>
                <kbd className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300">
                  Esc
                </kbd>
                close
              </p>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
