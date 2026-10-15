'use client'
/**
 * DistrictBanner — GTA-style cinematic area splash.
 * Shows on boot (current level) and every 'levelLoaded' event: the
 * district name in large italic serif with a type/weather subtitle,
 * sliding in from the bottom-right, holding ~4.5 s, then fading.
 * Purely presentational — reads engine.level via engineRef.
 */
import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { engineRef } from '@/game/state'
import type { LevelData } from '@/game/types'

interface BannerInfo {
  name: string
  type: string
  weather: string
  traffic: string
  key: number
}

const HOLD_MS = 4500

function describe(level: LevelData): BannerInfo {
  return {
    name: level.name,
    type: level.type,
    weather: level.weather,
    traffic: level.trafficDensity,
    key: Date.now(),
  }
}

export default function DistrictBanner() {
  const [banner, setBanner] = useState<BannerInfo | null>(null)

  useEffect(() => {
    let timer = 0
    let disposed = false

    const show = (level: LevelData): void => {
      if (disposed) return
      setBanner(describe(level))
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        if (!disposed) setBanner(null)
      }, HOLD_MS)
    }

    // Initial banner for the already-running level (small delay so it
    // lands after the boot overlay fades).
    const bootDelay = window.setTimeout(() => {
      const level = engineRef.current?.level
      if (level) show(level)
    }, 600)

    const engine = engineRef.current
    const off = engine?.onEvent((evt) => {
      if (evt.type !== 'levelLoaded') return
      const current = engineRef.current?.level
      if (current) show(current)
    })

    return () => {
      disposed = true
      window.clearTimeout(bootDelay)
      window.clearTimeout(timer)
      off?.()
    }
  }, [])

  return (
    <div
      aria-live="polite"
      className="pointer-events-none absolute bottom-16 right-4 z-20 max-w-[min(20rem,60vw)] text-right sm:bottom-20 sm:right-8"
    >
      <AnimatePresence>
        {banner && (
          <motion.div
            key={banner.key}
            initial={{ opacity: 0, x: 48 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 24 }}
            transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
          >
            <motion.div
              className="font-serif text-[clamp(1.6rem,4vw,2.6rem)] font-bold italic leading-none tracking-tight text-zinc-100"
              style={{ textShadow: '0 2px 18px rgba(0,0,0,0.85), 0 0 42px rgba(52,211,153,0.28)' }}
              initial={{ scale: 0.96 }}
              animate={{ scale: 1 }}
              transition={{ duration: 0.6, ease: 'easeOut' }}
            >
              {banner.name}
            </motion.div>
            <div className="mt-1.5 flex items-center justify-end gap-1.5 text-[10px] font-semibold uppercase tracking-[0.28em] text-zinc-400 sm:text-[11px]">
              <span className="text-emerald-400/90">{banner.type}</span>
              <span aria-hidden="true" className="text-zinc-600">·</span>
              <span>{banner.weather}</span>
              <span aria-hidden="true" className="text-zinc-600">·</span>
              <span>{banner.traffic} traffic</span>
            </div>
            <motion.div
              className="ml-auto mt-2 h-[2px] w-24 rounded-full bg-gradient-to-l from-emerald-400 to-transparent"
              initial={{ scaleX: 0, originX: 1 }}
              animate={{ scaleX: 1 }}
              transition={{ duration: 0.7, delay: 0.15 }}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
