'use client'
/**
 * RadioWidget — the in-car radio strip (round 5). Shows while driving,
 * bottom-right above the speedometer: animated EQ bars, station name in
 * its accent color, the procedurally generated track title, and
 * prev/next buttons. The station index is persisted to ow_settings
 * (including changes made with the R key — the poller syncs both ways).
 *
 * Round 8: when the station's DJ breaks in between tracks (see
 * RadioSystem's interlude scheduler), the track line swaps for an
 * ON AIR mic badge + the DJ's name and the line they're "saying" —
 * the widget becomes the radio's talk-back channel.
 *
 * Data: polled from the live engine's radio system at ~170 ms (station /
 * track / playing / dj), with CSS-animated EQ bars (JS-level would need
 * a much hotter poll for no visual gain).
 */
import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronLeft, ChevronRight, Mic, Radio, VolumeX } from 'lucide-react'
import { engineRef, useGameStore } from '@/game/state'
import { RADIO_STATIONS, type RadioState } from '@/game/audio/RadioSystem'

export default function RadioWidget({ driving }: { driving: boolean }) {
  const [radio, setRadio] = useState<RadioState | null>(null)

  useEffect(() => {
    if (!driving) return
    const poll = window.setInterval(() => {
      const engine = engineRef.current
      if (!engine) return
      const state =
        (engine.systems.radio as { getRadioState?: () => RadioState } | undefined)?.getRadioState?.() ??
        null
      setRadio(state)
      // Keep the persisted setting in sync (covers the R-key path too).
      if (state) {
        const persisted = useGameStore.getState().settings.radioStation
        const now = state.station === null ? -1 : state.station
        if (persisted !== now) useGameStore.getState().applySettings({ radioStation: now })
      }
    }, 170)
    return () => window.clearInterval(poll)
  }, [driving])

  const station = radio?.station != null ? RADIO_STATIONS[radio.station] : null
  const playing = radio?.playing ?? false
  const djOnAir = playing && !!radio?.djLine && !!radio?.djName

  const hop = (dir: 1 | -1): void => {
    const engine = engineRef.current
    if (!engine) return
    if (dir === 1) engine.radioNext()
    else engine.radioPrev()
  }

  return (
    <AnimatePresence>
      {driving && (
        <motion.div
          key="radio"
          initial={{ opacity: 0, y: 14, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 10, scale: 0.97 }}
          transition={{ type: 'spring', stiffness: 320, damping: 26 }}
          role="group"
          aria-label={`Radio: ${station ? station.name : 'off'}${djOnAir ? ` — ${radio?.djName} on air` : ''}`}
        >
          <div
            className={`relative flex w-[196px] items-center gap-2 rounded-lg border bg-black/70 px-2.5 py-1.5 shadow-lg backdrop-blur-sm transition-colors sm:w-[236px] sm:px-3 ${
              djOnAir ? 'border-amber-400/40' : 'border-white/10'
            }`}
          >
            {/* EQ bars / antenna icon */}
            <div className="flex h-7 w-6 shrink-0 items-end justify-center gap-[2.5px]" aria-hidden="true">
              {station && playing ? (
                [0, 1, 2, 3].map((i) => (
                  <span
                    key={i}
                    className="animate-eq-bar w-[3px] rounded-sm"
                    style={{
                      height: '70%',
                      backgroundColor: djOnAir ? '#fbbf24' : station.accent,
                      animationDelay: `${i * 0.11}s`,
                      animationDuration: i % 2 ? '0.62s' : '0.48s',
                    }}
                  />
                ))
              ) : (
                <span className="flex h-full w-full items-center justify-center">
                  {station ? (
                    <Radio className="h-4 w-4 text-zinc-500" aria-hidden="true" />
                  ) : (
                    <VolumeX className="h-4 w-4 text-zinc-600" aria-hidden="true" />
                  )}
                </span>
              )}
            </div>

            {/* Station + track / DJ line */}
            <div className="min-w-0 flex-1">
              {station ? (
                <>
                  <p
                    className="truncate text-[10px] font-black uppercase tracking-[0.18em] leading-tight"
                    style={{ color: station.accent }}
                  >
                    {station.name}
                  </p>
                  <AnimatePresence mode="wait" initial={false}>
                    {djOnAir ? (
                      <motion.p
                        key="dj"
                        initial={{ opacity: 0, y: 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        transition={{ duration: 0.18 }}
                        className="flex items-center gap-1 text-[10px] font-medium leading-tight text-amber-300"
                        aria-live="polite"
                      >
                        <span className="flex shrink-0 items-center gap-0.5 rounded-sm bg-amber-400/15 px-1 py-px text-[8px] font-black uppercase tracking-wider text-amber-400">
                          <Mic className="h-2 w-2 animate-pulse" aria-hidden="true" />
                          On air
                        </span>
                        <span className="truncate">
                          {radio?.djName}: {radio?.djLine}
                        </span>
                      </motion.p>
                    ) : (
                      <motion.p
                        key="track"
                        initial={{ opacity: 0, y: 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        transition={{ duration: 0.18 }}
                        className="truncate text-[10px] font-medium leading-tight text-zinc-400"
                      >
                        {playing ? `“${radio?.trackTitle}”` : station.tagline}
                      </motion.p>
                    )}
                  </AnimatePresence>
                </>
              ) : (
                <p className="text-[10px] font-bold uppercase tracking-[0.18em] leading-tight text-zinc-500">
                  Radio off
                </p>
              )}
            </div>

            {/* Channel buttons */}
            <div className="flex shrink-0 items-center gap-0.5">
              <button
                type="button"
                onClick={() => hop(-1)}
                className="pointer-events-auto flex h-6 w-6 items-center justify-center rounded-md border border-white/10 bg-white/5 text-zinc-300 transition-colors hover:border-white/25 hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-amber-400"
                aria-label="Previous station"
              >
                <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => hop(1)}
                className="pointer-events-auto flex h-6 w-6 items-center justify-center rounded-md border border-white/10 bg-white/5 text-zinc-300 transition-colors hover:border-white/25 hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-amber-400"
                aria-label="Next station (or press R)"
                title="Next station (R)"
              >
                <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          </div>
          <p className="mt-1 pr-1 text-right text-[9px] font-medium tracking-wide text-zinc-600">
            <kbd className="rounded bg-zinc-800/90 px-1 py-px font-mono text-[8px] text-zinc-400">R</kbd>{' '}
            browse stations
          </p>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
