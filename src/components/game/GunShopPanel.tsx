'use client'
/**
 * GunShopPanel — round 10's browsable gun-shop counter. Opened with E at
 * the amber ammo pad (replacing the single-purpose $40 confirm card —
 * missions gate on weapons the shop now legitimately sells); closed with
 * E / Esc / the close button / the walk-away leash.
 *
 * Layout:
 *   - AMMO ROW: the $40 reserve top-up for every owned weapon
 *     (disabled + "RESERVES FULL" when there is nothing to fill).
 *   - WEAPON GRID: one card per firearm — live stat bars (damage, rate,
 *     mag), price, BUY button or an emerald OWNED chip. Buying includes
 *     a full mag + reserve.
 */
import { useCallback, useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Bomb,
  Check,
  Crosshair,
  Package,
  ShoppingCart,
  Store,
  Target,
  Wallet,
  Zap,
} from 'lucide-react'
import type { WeaponId } from '@/game/types'
import type { WeaponShopEntry } from '@/game/gameplay/WeaponSystem'
import { engineRef, useGameStore } from '@/game/state'
import {
  formatMoney,
  getGunShopStock,
  gunShopBuyAmmoTopup,
  gunShopBuyWeapon,
  gunShopCanTopUp,
} from './engineViews'
import { Button } from '@/components/ui/button'

const AMMO_PRICE = 40

/** Per-weapon icon + accent (amber shop theme, zinc-900 dark base). */
const WEAPON_META: Record<WeaponId, { Icon: typeof Crosshair; tag: string }> = {
  fists: { Icon: Crosshair, tag: 'MELEE' },
  pistol: { Icon: Crosshair, tag: 'SIDEARM' },
  smg: { Icon: Zap, tag: 'AUTO' },
  rifle: { Icon: Target, tag: 'LONG RANGE' },
  shotgun: { Icon: Bomb, tag: 'SPREAD' },
}

/** Icon chips per stat row. */
function StatRow({
  label,
  value,
  pct,
  tone,
}: {
  label: string
  value: string
  pct: number
  tone: string
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-10 shrink-0 font-mono text-[9px] uppercase tracking-wider text-zinc-500">
        {label}
      </span>
      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-800">
        <span
          className={`block h-full rounded-full ${tone}`}
          style={{ width: `${Math.max(4, Math.min(100, pct))}%` }}
        />
      </span>
      <span className="w-12 shrink-0 text-right font-mono text-[10px] text-zinc-400">{value}</span>
    </div>
  )
}

function WeaponCard({ w, money }: { w: WeaponShopEntry; money: number }) {
  const meta = WEAPON_META[w.id] ?? WEAPON_META.pistol
  const Icon = meta.Icon
  const broke = !w.owned && money < w.price
  return (
    <div
      className={`relative flex flex-col rounded-xl border p-3.5 transition-colors ${
        w.owned
          ? 'border-emerald-500/25 bg-emerald-500/[0.04]'
          : 'border-zinc-700/60 bg-zinc-900/70 hover:border-amber-500/40'
      }`}
    >
      {/* header: icon + name + tag */}
      <div className="flex items-start gap-3">
        <span
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border ${
            w.owned ? 'border-emerald-500/30 bg-emerald-500/10' : 'border-zinc-700/60 bg-zinc-950/60'
          }`}
          aria-hidden="true"
        >
          <Icon className={`h-5 w-5 ${w.owned ? 'text-emerald-300' : 'text-amber-300'}`} />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-bold text-zinc-100">{w.name}</p>
          <p className="font-mono text-[9px] uppercase tracking-widest text-zinc-500">
            {meta.tag}
            {w.auto ? ' · HOLD' : ''}
          </p>
        </div>
        {w.owned ? (
          <span className="ml-auto flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest text-emerald-300">
            <Check className="h-3 w-3" aria-hidden="true" /> Owned
          </span>
        ) : (
          <span className="ml-auto rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 font-mono text-[10px] font-semibold text-amber-300">
            {formatMoney(w.price)}
          </span>
        )}
      </div>

      {/* stat bars */}
      <div className="mt-2.5 flex flex-col gap-1.5">
        <StatRow
          label="DMG"
          value={w.pellets > 1 ? `${w.burstDamage}×` : String(w.damage)}
          pct={(w.burstDamage / 90) * 100}
          tone="bg-rose-400"
        />
        <StatRow
          label="RATE"
          value={`${w.rpm} rpm`}
          pct={(w.rpm / 550) * 100}
          tone="bg-amber-400"
        />
        <StatRow
          label="MAG"
          value={String(w.magSize)}
          pct={(w.magSize / 30) * 100}
          tone="bg-zinc-400"
        />
        <StatRow
          label="RANGE"
          value={`${w.range} m`}
          pct={(w.range / 120) * 100}
          tone="bg-teal-400"
        />
      </div>

      {/* buy */}
      <div className="mt-auto pt-2.5">
        {w.owned ? (
          <p className="text-center text-[10px] text-zinc-500">
            Full mag + {w.reserveMax} reserve included with every purchase
          </p>
        ) : (
          <Button
            size="sm"
            disabled={broke}
            onClick={() => gunShopBuyWeapon(engineRef.current, w.id)}
            className={`w-full border font-semibold ${
              broke
                ? 'cursor-not-allowed border-zinc-800 bg-zinc-900 text-zinc-600'
                : 'border-amber-500/40 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25'
            }`}
          >
            <ShoppingCart className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            {broke ? `Need ${formatMoney(w.price - money)} more` : `Buy — ${formatMoney(w.price)}`}
          </Button>
        )}
      </div>
    </div>
  )
}

export default function GunShopPanel() {
  const open = useGameStore((s) => s.gunShopOpen)
  const setGunShopOpen = useGameStore((s) => s.setGunShopOpen)
  const hud = useGameStore((s) => s.hud)
  const money = hud?.player.money ?? 0
  const [stock, setStock] = useState<WeaponShopEntry[]>([])
  const [canTopUp, setCanTopUp] = useState(false)
  const [district, setDistrict] = useState('')

  // Poll stock while open (buys mutate the weapons system immediately).
  useEffect(() => {
    if (!open) return
    const refresh = (): void => {
      setStock(getGunShopStock(engineRef.current))
      setCanTopUp(gunShopCanTopUp(engineRef.current))
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
    setGunShopOpen(false)
    ;(
      engineRef.current?.systems as unknown as { services?: { onUiClosed?: () => void } }
    )?.services?.onUiClosed?.()
  }, [setGunShopOpen])

  const ownedCount = stock.filter((w) => w.owned).length

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
          aria-label="Gun shop"
        >
          <motion.div
            initial={{ y: 22, scale: 0.97, opacity: 0 }}
            animate={{ y: 0, scale: 1, opacity: 1 }}
            exit={{ y: 14, scale: 0.98, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 320, damping: 28 }}
            className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-amber-500/25 bg-zinc-950/95 shadow-[0_0_60px_rgba(251,191,36,0.07)]"
          >
            {/* ---- header ---- */}
            <div className="flex items-center justify-between gap-3 border-b border-zinc-800/80 bg-gradient-to-r from-amber-500/10 via-transparent to-transparent px-5 py-4">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-amber-500/30 bg-amber-500/10">
                  <Store className="h-5 w-5 text-amber-400" aria-hidden="true" />
                </span>
                <div>
                  <h2 className="text-base font-bold tracking-tight text-zinc-50">
                    Ammu-City
                    <span className="ml-2 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 align-middle font-mono text-[10px] font-medium tracking-widest text-amber-300">
                      {ownedCount}/{stock.length} OWNED
                    </span>
                  </h2>
                  <p className="text-xs text-zinc-500">
                    {district ? `${district} · ` : ''}every purchase ships with a full mag + reserve
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
                  Leave
                </Button>
              </div>
            </div>

            {/* ---- counter ---- */}
            <div className="overflow-y-auto p-4">
              {/* ammo top-up row */}
              <div
                className={`flex items-center gap-4 rounded-xl border p-4 ${
                  canTopUp
                    ? 'border-amber-500/25 bg-amber-500/[0.05]'
                    : 'border-zinc-800 bg-zinc-900/40'
                }`}
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-zinc-700/60 bg-zinc-950/60">
                  <Package
                    className={`h-5 w-5 ${canTopUp ? 'text-amber-300' : 'text-zinc-600'}`}
                    aria-hidden="true"
                  />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-zinc-100">Reserve top-up</p>
                  <p className="text-xs text-zinc-500">
                    Every owned weapon topped to max reserve — box of assorted rounds.
                  </p>
                </div>
                {canTopUp ? (
                  <Button
                    size="sm"
                    onClick={() => gunShopBuyAmmoTopup(engineRef.current)}
                    className="border border-amber-500/40 bg-amber-500/15 font-semibold text-amber-200 hover:bg-amber-500/25"
                  >
                    <Package className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                    Top up — {formatMoney(AMMO_PRICE)}
                  </Button>
                ) : (
                  <span className="rounded-full border border-zinc-700 bg-zinc-950/60 px-2.5 py-1 font-mono text-[10px] tracking-widest text-zinc-600">
                    RESERVES FULL
                  </span>
                )}
              </div>

              {/* weapon grid */}
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {stock.map((w, i) => (
                  <motion.div
                    key={w.id}
                    initial={{ y: 14, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    transition={{ delay: 0.05 + i * 0.05, duration: 0.22, ease: 'easeOut' }}
                  >
                    <WeaponCard w={w} money={money} />
                  </motion.div>
                ))}
              </div>
            </div>

            {/* ---- footer ---- */}
            <div className="flex items-center justify-between gap-3 border-t border-zinc-800/80 bg-zinc-900/40 px-5 py-3">
              <p className="text-[11px] text-zinc-500">
                Some missions need proper hardware — the counter&apos;s watched, not judged.
              </p>
              <p className="hidden items-center gap-2 text-[11px] text-zinc-500 sm:flex">
                <kbd className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300">
                  E
                </kbd>
                <kbd className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300">
                  Esc
                </kbd>
                leave
              </p>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
