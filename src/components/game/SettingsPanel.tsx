'use client'
/**
 * SettingsPanel — shared by the main menu and the pause menu.
 * Sliders/toggles write to the persisted zustand settings
 * (`ow_settings` in localStorage) and push audio volumes into the live
 * AudioSystem immediately when the engine is running. The radio strip
 * picks the default station (R hops while driving; OFF supported).
 */
import { Gauge, Map as MapIcon, MonitorPlay, Music, Radio, RotateCw, Volume2, VolumeX, Zap } from 'lucide-react'
import { engineRef, useGameStore } from '@/game/state'
import type { GameSettings } from '@/game/state'
import { RADIO_STATIONS } from '@/game/audio/RadioSystem'
import { applyAudioVolumes } from './engineViews'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'

function VolumeRow({
  icon,
  label,
  value,
  onChange,
}: {
  icon: React.ReactNode
  label: string
  value: number
  onChange: (v: number) => void
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label className="flex items-center gap-2 text-xs font-semibold text-zinc-300">
          {icon} {label}
        </Label>
        <span className="font-mono text-xs tabular-nums text-zinc-400">
          {Math.round(value * 100)}%
        </span>
      </div>
      <Slider
        value={[value]}
        min={0}
        max={1}
        step={0.05}
        onValueChange={(v) => onChange(v[0] ?? 0)}
        aria-label={`${label} volume`}
      />
    </div>
  )
}

export default function SettingsPanel() {
  const settings = useGameStore((s) => s.settings)
  const applySettings = useGameStore((s) => s.applySettings)

  const setVolumes = (patch: { master?: number; music?: number; sfx?: number }): void => {
    // Round-10 fix: the store keys are masterVolume/musicVolume/sfxVolume —
    // the old code spread {master,...} straight in, so the sliders never
    // moved, never persisted, and the engine got stale values.
    const mapped: Partial<GameSettings> = {}
    if (patch.master != null) mapped.masterVolume = patch.master
    if (patch.music != null) mapped.musicVolume = patch.music
    if (patch.sfx != null) mapped.sfxVolume = patch.sfx
    applySettings(mapped)
    const next = useGameStore.getState().settings
    applyAudioVolumes(engineRef.current, {
      master: next.masterVolume,
      music: next.musicVolume,
      sfx: next.sfxVolume,
    })
  }

  return (
    <div className="space-y-5">
      <section className="space-y-4" aria-label="Audio">
        <h4 className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.2em] text-emerald-400">
          <Music className="h-3 w-3" aria-hidden="true" /> Audio
        </h4>
        <VolumeRow
          icon={<Volume2 className="h-3.5 w-3.5 text-zinc-400" aria-hidden="true" />}
          label="Master"
          value={settings.masterVolume}
          onChange={(v) => setVolumes({ master: v })}
        />
        <VolumeRow
          icon={<Music className="h-3.5 w-3.5 text-zinc-400" aria-hidden="true" />}
          label="Music"
          value={settings.musicVolume}
          onChange={(v) => setVolumes({ music: v })}
        />
        <VolumeRow
          icon={<VolumeX className="h-3.5 w-3.5 text-zinc-400" aria-hidden="true" />}
          label="SFX"
          value={settings.sfxVolume}
          onChange={(v) => setVolumes({ sfx: v })}
        />

        {/* Default radio station (R hops while driving) */}
        <div className="space-y-1.5">
          <Label className="flex items-center gap-2 text-xs font-semibold text-zinc-300">
            <Radio className="h-3.5 w-3.5 text-zinc-400" aria-hidden="true" /> Radio station
          </Label>
          <div
            className="grid grid-cols-3 gap-1"
            role="radiogroup"
            aria-label="Default radio station"
          >
            {RADIO_STATIONS.map((st, i) => {
              const active = settings.radioStation === i
              return (
                <button
                  key={st.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => {
                    applySettings({ radioStation: i })
                    engineRef.current?.radioSetStation?.(i)
                  }}
                  className={`rounded-md border px-1.5 py-1 text-[10px] font-bold uppercase tracking-wide transition-colors ${
                    active
                      ? 'border-transparent bg-white/10 text-zinc-100 ring-1 ring-white/25'
                      : 'border-zinc-800 bg-zinc-900/60 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300'
                  }`}
                >
                  <span
                    className="mr-1 inline-block h-1.5 w-1.5 rounded-full align-middle"
                    style={{ backgroundColor: st.accent }}
                    aria-hidden="true"
                  />
                  {st.name}
                </button>
              )
            })}
            <button
              type="button"
              role="radio"
              aria-checked={settings.radioStation === -1}
              onClick={() => {
                applySettings({ radioStation: -1 })
                engineRef.current?.radioSetStation?.(null)
              }}
              className={`rounded-md border px-1.5 py-1 text-[10px] font-bold uppercase tracking-wide transition-colors ${
                settings.radioStation === -1
                  ? 'border-transparent bg-white/10 text-zinc-100 ring-1 ring-white/25'
                  : 'border-zinc-800 bg-zinc-900/60 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300'
              }`}
            >
              Off
            </button>
          </div>
          <p className="text-[10px] text-zinc-600">
            Plays automatically while driving — press <kbd className="rounded bg-zinc-800 px-1 font-mono text-[9px] text-zinc-400">R</kbd> in the car to hop stations.
          </p>
        </div>
      </section>

      <Separator className="bg-zinc-800" />

      <section className="space-y-4" aria-label="Controls and display">
        <h4 className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.2em] text-emerald-400">
          <Gauge className="h-3 w-3" aria-hidden="true" /> Controls &amp; Display
        </h4>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label className="flex items-center gap-2 text-xs font-semibold text-zinc-300">
              <MonitorPlay className="h-3.5 w-3.5 text-zinc-400" aria-hidden="true" /> Mouse
              sensitivity
            </Label>
            <span className="font-mono text-xs tabular-nums text-zinc-400">
              ×{settings.mouseSensitivity.toFixed(2)}
            </span>
          </div>
          <Slider
            value={[settings.mouseSensitivity]}
            min={0.25}
            max={2}
            step={0.05}
            onValueChange={(v) => applySettings({ mouseSensitivity: v[0] ?? 1 })}
            aria-label="Mouse sensitivity"
          />
          <p className="text-[10px] text-zinc-600">
            Applies to drag-look; pointer-lock aim uses the engine&apos;s tuned curve.
          </p>
        </div>

        <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
          <Label htmlFor="show-fps" className="flex items-center gap-2 text-xs font-semibold text-zinc-300">
            <MonitorPlay className="h-3.5 w-3.5 text-zinc-400" aria-hidden="true" /> Show FPS chip
          </Label>
          <Switch
            id="show-fps"
            checked={settings.showFps}
            onCheckedChange={(v) => applySettings({ showFps: v })}
          />
        </div>

        <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
          <Label htmlFor="minimap-rotate" className="flex items-center gap-2 text-xs font-semibold text-zinc-300">
            <RotateCw className="h-3.5 w-3.5 text-zinc-400" aria-hidden="true" /> Rotate minimap with
            player
          </Label>
          <Switch
            id="minimap-rotate"
            checked={settings.minimapRotate}
            onCheckedChange={(v) => applySettings({ minimapRotate: v })}
          />
        </div>
        <p className="flex items-center gap-1.5 text-[10px] text-zinc-600">
          <MapIcon className="h-3 w-3" aria-hidden="true" /> Off = classic north-up radar.
        </p>

        <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
          <div className="space-y-0.5">
            <Label htmlFor="perf-mode" className="flex items-center gap-2 text-xs font-semibold text-zinc-300">
              <Zap className="h-3.5 w-3.5 text-zinc-400" aria-hidden="true" /> Performance mode
            </Label>
            <p className="text-[10px] text-zinc-600">Low-end GPUs: drops shadows, halved street lamps.</p>
          </div>
          <Switch
            id="perf-mode"
            checked={settings.performanceMode}
            onCheckedChange={(v) => {
              applySettings({ performanceMode: v })
              engineRef.current?.setPerformanceMode?.(v)
            }}
          />
        </div>
      </section>
    </div>
  )
}
