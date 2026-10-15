'use client'
/**
 * BigMap (M key) — full-screen north-up view of the whole level.
 * Canvas 90vw × 80vh; roads, labeled buildings, water, live mission
 * markers with names, the player arrow, and the personal waypoint.
 * Click anywhere → set a personal waypoint (emerald ping, also visible
 * on the minimap). Click the existing waypoint again (or the Clear
 * button) to remove it. M / Escape close (handled by GameShell's
 * capture-phase key listener).
 *
 * FAST TRAVEL: toggle the toolbar button (or press T while the map is
 * open) to highlight service POIs parsed from the level — hospitals,
 * police stations and the spawn-point safehouse. Click a POI to
 * teleport there for a $50 fare, when off-mission and off cooldown.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Crosshair, Map as MapIcon, Navigation, X } from 'lucide-react'
import { engineRef, useGameStore } from '@/game/state'
import type { LevelData } from '@/game/types'
import type { AvailableMission } from '@/game/gameplay/MissionSystem'
import { getCameraHeading, getGarageMapPoint, getLiveMissions, getServices } from './engineViews'
import {
  drawBuildings,
  drawGrid,
  drawMapBackground,
  drawMissionMarker,
  drawPlayerArrow,
  drawRoads,
  drawServiceBlip,
  drawWater,
  drawWaypointDiamond,
} from './mapRender'
import { Button } from '@/components/ui/button'

const FRAME_MS = 1000 / 30
const MISSION_POLL_MS = 1000
const PAD_PX = 34

const FAST_TRAVEL_FEE = 50
const FAST_TRAVEL_COOLDOWN_MS = 30_000
const FAST_TRAVEL_CLICK_RADIUS_M = 30

interface FastTravelPOI {
  id: string
  label: string
  letter: string
  position: { x: number; y: number; z: number }
}

/** Service POIs parsed from the live level data (authored buildings + spawn). */
function getFastTravelPOIs(level: LevelData): FastTravelPOI[] {
  const pois: FastTravelPOI[] = []
  for (const b of level.buildings) {
    const t = b.type.toLowerCase()
    if (t.includes('hospital')) {
      pois.push({ id: `ft_h_${b.name}`, label: b.name, letter: 'H', position: b.position })
    } else if (t.includes('police')) {
      pois.push({ id: `ft_p_${b.name}`, label: b.name, letter: 'P', position: b.position })
    }
  }
  pois.push({
    id: 'ft_safehouse',
    label: 'Safehouse',
    letter: 'S',
    position: level.spawnPoint,
  })
  return pois
}

export default function BigMap() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const transformRef = useRef<{ scale: number; ox: number; oy: number }>({ scale: 1, ox: 0, oy: 0 })
  const waypoint = useGameStore((s) => s.waypoint)
  const setWaypoint = useGameStore((s) => s.setWaypoint)
  const [hoverWorld, setHoverWorld] = useState<{ x: number; z: number } | null>(null)
  const [fastTravel, setFastTravel] = useState(false)
  const fastTravelRef = useRef(false)
  const lastTravelRef = useRef(0)

  /** Execute a fast-travel hop after validating the GTA-style rules. */
  const tryFastTravel = useCallback(
    (poi: FastTravelPOI): boolean => {
      const engine = engineRef.current
      const state = useGameStore.getState()
      const hud = state.hud
      if (!engine || !hud) return false
      const fail = (msg: string): boolean => {
        engine.notify(msg, 'warning')
        return false
      }
      if (hud.mission?.status === 'active') {
        return fail('Cannot fast travel during a mission')
      }
      if (Date.now() - lastTravelRef.current < FAST_TRAVEL_COOLDOWN_MS) {
        return fail('Fast travel is cooling down')
      }
      if (!engine.player.addMoney(-FAST_TRAVEL_FEE)) {
        return fail(`Fast travel costs $${FAST_TRAVEL_FEE} — not enough cash`)
      }
      lastTravelRef.current = Date.now()
      engine.teleportPlayer({
        x: poi.position.x + 6,
        y: poi.position.y,
        z: poi.position.z + 6,
      })
      setWaypoint(null)
      engine.notify(`Fast traveled to ${poi.label} — $${FAST_TRAVEL_FEE} fare`, 'success')
      state.setBigMapOpen(false)
      return true
    },
    [setWaypoint],
  )

  useEffect(() => {
    let raf = 0
    let lastDraw = -9999
    let lastMissionPoll = -9999
    let missions: AvailableMission[] = []
    let services: ReturnType<typeof getServices> = []
    let garage: ReturnType<typeof getGarageMapPoint> = null
    let level: LevelData | null = null
    try {
      level = engineRef.current?.level ?? null
    } catch {
      level = null
    }

    const draw = (nowMs: number): void => {
      const canvas = canvasRef.current
      const engine = engineRef.current
      const state = useGameStore.getState()
      const hud = state.hud
      if (!canvas || !engine || !hud || !level) return

      if (nowMs - lastMissionPoll > MISSION_POLL_MS) {
        lastMissionPoll = nowMs
        missions = getLiveMissions(engine)
        services = getServices(engine)
        garage = getGarageMapPoint(engine)
      }

      const cssW = canvas.clientWidth
      const cssH = canvas.clientHeight
      if (cssW < 20 || cssH < 20) return
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const pxW = Math.round(cssW * dpr)
      const pxH = Math.round(cssH * dpr)
      if (canvas.width !== pxW || canvas.height !== pxH) {
        canvas.width = pxW
        canvas.height = pxH
      }
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      const t = nowMs / 1000
      const scale = Math.min(
        (cssW - PAD_PX * 2) / level.sizeX,
        (cssH - PAD_PX * 2) / level.sizeZ,
      )
      const ox = (cssW - level.sizeX * scale) / 2
      const oy = (cssH - level.sizeZ * scale) / 2
      transformRef.current = { scale, ox, oy }
      const view = {
        scale,
        project: (wx: number, wz: number): [number, number] => [ox + wx * scale, oy + wz * scale],
      }

      drawMapBackground(ctx, cssW, cssH)
      drawGrid(ctx, level, view)
      drawRoads(ctx, level, view)
      drawWater(ctx, level, view)
      drawBuildings(ctx, level, view, { labels: true })

      // available mission markers + names
      ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace'
      for (const m of missions) {
        if (m.status !== 'available' || !m.startPosition) continue
        const [x, y] = view.project(m.startPosition.x, m.startPosition.z)
        drawMissionMarker(ctx, x, y, t, 6)
        const label = m.isSide ? `${m.name} (side)` : m.name
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        const tw = ctx.measureText(label).width
        ctx.fillStyle = 'rgba(9, 9, 11, 0.78)'
        ctx.fillRect(x - tw / 2 - 3, y + 9, tw + 6, 14)
        ctx.fillStyle = '#fcd34d'
        ctx.fillText(label, x, y + 11)
      }

      // city services (clinic / gun shop / Pay'n'Spray — purchase spots)
      ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace'
      for (const s of services) {
        const [x, y] = view.project(s.position.x, s.position.z)
        drawServiceBlip(ctx, x, y, s.kind)
        const tag =
          s.kind === 'clinic'
            ? 'CLINIC $50'
            : s.kind === 'ammo'
              ? 'GUN SHOP'
              : 'SPRAY $100'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'bottom'
        const tw = ctx.measureText(tag).width
        ctx.fillStyle = 'rgba(9, 9, 11, 0.78)'
        ctx.fillRect(x - tw / 2 - 3, y - 15, tw + 6, 12)
        ctx.fillStyle =
          s.kind === 'clinic' ? '#fca5a5' : s.kind === 'ammo' ? '#fcd34d' : '#5eead4'
        ctx.fillText(tag, x, y - 6)
      }

      // garage lockup (property — store / take out your car)
      if (garage) {
        const [x, y] = view.project(garage.position.x, garage.position.z)
        drawServiceBlip(ctx, x, y, 'garage')
        ctx.textAlign = 'center'
        ctx.textBaseline = 'bottom'
        ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace'
        const tag = 'GARAGE $300'
        const tw = ctx.measureText(tag).width
        ctx.fillStyle = 'rgba(9, 9, 11, 0.78)'
        ctx.fillRect(x - tw / 2 - 3, y - 15, tw + 6, 12)
        ctx.fillStyle = '#bef264'
        ctx.fillText(tag, x, y - 6)
      }

      // fast-travel POIs (always drawn; highlighted while mode is on)
      const ftMode = fastTravelRef.current
      const pois = level ? getFastTravelPOIs(level) : []
      for (const poi of pois) {
        const [x, y] = view.project(poi.position.x, poi.position.z)
        const pulse = (Math.sin(t * 2.2) + 1) / 2
        const r = ftMode ? 8 + pulse * 2 : 5
        ctx.beginPath()
        ctx.arc(x, y, r + 3, 0, Math.PI * 2)
        ctx.fillStyle = ftMode ? `rgba(52, 211, 153, ${0.16 + pulse * 0.12})` : 'rgba(52, 211, 153, 0.1)'
        ctx.fill()
        ctx.beginPath()
        ctx.arc(x, y, r, 0, Math.PI * 2)
        ctx.fillStyle = ftMode ? '#10b981' : 'rgba(16, 185, 129, 0.55)'
        ctx.fill()
        ctx.strokeStyle = ftMode ? '#a7f3d0' : 'rgba(167, 243, 208, 0.5)'
        ctx.lineWidth = 1.5
        ctx.stroke()
        ctx.font = `bold ${ftMode ? 10 : 9}px ui-monospace, SFMono-Regular, Menlo, monospace`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillStyle = '#022c22'
        ctx.fillText(poi.letter, x, y + 0.5)
        if (ftMode) {
          ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace'
          ctx.textBaseline = 'top'
          const tw = ctx.measureText(poi.label).width
          ctx.fillStyle = 'rgba(9, 9, 11, 0.78)'
          ctx.fillRect(x - tw / 2 - 3, y + r + 5, tw + 6, 13)
          ctx.fillStyle = '#a7f3d0'
          ctx.fillText(poi.label, x, y + r + 7)
        }
      }

      // active mission objective waypoint
      const objWaypoint = hud.mission?.waypoint ?? null
      if (objWaypoint) {
        const [x, y] = view.project(objWaypoint.x, objWaypoint.z)
        drawWaypointDiamond(ctx, x, y, 7, (Math.sin(t * 2.4) + 1) / 2)
      }

      // personal waypoint
      const wp = state.waypoint
      if (wp) {
        const [x, y] = view.project(wp.x, wp.z)
        drawWaypointDiamond(ctx, x, y, 6, (Math.sin(t * 2.4 + Math.PI) + 1) / 2)
        ctx.font = '700 10px ui-monospace, SFMono-Regular, Menlo, monospace'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        ctx.fillStyle = '#a7f3d0'
        ctx.fillText('WAYPOINT', x, y + 10)
      }

      // player
      const p = hud.player.position
      const [px, py] = view.project(p.x, p.z)
      drawPlayerArrow(ctx, px, py, getCameraHeading(engine), 9)

      // hover crosshair coordinates
      if (hoverWorld) {
        const [hx, hy] = view.project(hoverWorld.x, hoverWorld.z)
        ctx.strokeStyle = 'rgba(228, 228, 231, 0.5)'
        ctx.setLineDash([4, 4])
        ctx.beginPath()
        ctx.moveTo(hx - 12, hy)
        ctx.lineTo(hx + 12, hy)
        ctx.moveTo(hx, hy - 12)
        ctx.lineTo(hx, hy + 12)
        ctx.stroke()
        ctx.setLineDash([])
      }

      // scale bar (bottom-left, ~100 m)
      const barPx = Math.max(24, 100 * scale)
      ctx.strokeStyle = '#a1a1aa'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(14, cssH - 16)
      ctx.lineTo(14 + barPx, cssH - 16)
      ctx.moveTo(14, cssH - 20)
      ctx.lineTo(14, cssH - 12)
      ctx.moveTo(14 + barPx, cssH - 20)
      ctx.lineTo(14 + barPx, cssH - 12)
      ctx.stroke()
      ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'bottom'
      ctx.fillStyle = '#a1a1aa'
      ctx.fillText('100 m', 14, cssH - 20)
    }

    const loop = (t: number): void => {
      if (t - lastDraw >= FRAME_MS) {
        lastDraw = t
        draw(t)
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [hoverWorld])

  const toWorld = (clientX: number, clientY: number): { x: number; z: number } | null => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    const { scale, ox, oy } = transformRef.current
    return {
      x: (clientX - rect.left - ox) / scale,
      z: (clientY - rect.top - oy) / scale,
    }
  }

  const onCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    const world = toWorld(e.clientX, e.clientY)
    if (!world) return
    // Fast-travel mode: clicking near a POI hops there (validated).
    if (fastTravel) {
      const level = engineRef.current?.level
      if (level) {
        const pois = getFastTravelPOIs(level)
        for (const poi of pois) {
          const d = Math.hypot(poi.position.x - world.x, poi.position.z - world.z)
          if (d <= FAST_TRAVEL_CLICK_RADIUS_M) {
            tryFastTravel(poi)
            return
          }
        }
      }
    }
    const current = useGameStore.getState().waypoint
    if (current && Math.hypot(current.x - world.x, current.z - world.z) < 15) {
      setWaypoint(null) // clicking the existing waypoint clears it
      return
    }
    setWaypoint({ x: world.x, y: 0, z: world.z })
  }

  // T toggles fast-travel mode while the map is open (also exits it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.code === 'KeyT') setFastTravel((v) => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Keep the draw loop's closure fresh without re-creating the RAF loop.
  useEffect(() => {
    fastTravelRef.current = fastTravel
  }, [fastTravel])

  return (
    <div
      className="fixed inset-0 z-[55] flex flex-col items-center justify-center gap-3 bg-black/90 p-4 backdrop-blur-sm"
      role="dialog"
      aria-label="Big map"
    >
      <div className="flex w-full max-w-6xl flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <MapIcon className="h-5 w-5 text-emerald-400" aria-hidden="true" />
          <h2 className="text-lg font-bold tracking-wide text-zinc-100">District Map</h2>
          <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-emerald-300">
            north-up
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            aria-pressed={fastTravel}
            onClick={() => setFastTravel((v) => !v)}
            className={`h-8 ${
              fastTravel
                ? 'border-emerald-400 bg-emerald-500/20 text-emerald-200 hover:bg-emerald-500/30'
                : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 hover:text-emerald-200'
            }`}
          >
            <Navigation className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
            Fast Travel
            <kbd className="ml-1 rounded bg-emerald-500/15 px-1 font-mono text-[10px]">T</kbd>
          </Button>
          {waypoint && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setWaypoint(null)}
              className="h-8 border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 hover:text-emerald-200"
            >
              <Crosshair className="mr-1 h-3.5 w-3.5" aria-hidden="true" /> Clear waypoint
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => useGameStore.getState().setBigMapOpen(false)}
            className="h-8 border-zinc-700 bg-zinc-900 text-zinc-200 hover:bg-zinc-800"
          >
            <X className="mr-1 h-3.5 w-3.5" aria-hidden="true" /> Close <kbd className="ml-1 rounded bg-zinc-800 px-1 font-mono text-[10px]">M</kbd>
          </Button>
        </div>
      </div>

      <canvas
        ref={canvasRef}
        onClick={onCanvasClick}
        onMouseMove={(e) => {
          const w = toWorld(e.clientX, e.clientY)
          if (w) setHoverWorld(w)
        }}
        onMouseLeave={() => setHoverWorld(null)}
        className={`h-[80vh] max-h-[80vh] w-[90vw] max-w-6xl rounded-xl border shadow-2xl shadow-black ${
          fastTravel ? 'cursor-pointer border-emerald-500/60' : 'cursor-crosshair border-zinc-700'
        }`}
        aria-label="District map — click to set a waypoint or fast travel"
      />

      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[11px] text-zinc-400">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-emerald-400" aria-hidden="true" /> Player
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-amber-400" aria-hidden="true" /> Available mission
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rotate-45 bg-emerald-300" aria-hidden="true" /> Waypoint
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-flex h-2.5 w-2.5 items-center justify-center rounded-full bg-emerald-500 text-[8px] font-bold text-emerald-950"
            aria-hidden="true"
          >
            H
          </span>
          Fast travel POI (${FAST_TRAVEL_FEE} fare)
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-2.5 items-center justify-center rounded-full border border-rose-400"
            aria-hidden="true"
          />
          Clinic · gun shop (weapons for sale) · Pay'n'Spray (E to buy)
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-2.5 rounded-[2px] border border-lime-400 bg-lime-400/25"
            aria-hidden="true"
          />
          Garage lockup — buy once, park cars across districts
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-emerald-900" aria-hidden="true" /> Water
        </span>
        <span>
          {fastTravel
            ? 'Fast travel ON — click a POI to hop (T to exit mode)'
            : 'Click the map to set a waypoint · M / Esc closes'}
        </span>
      </div>
    </div>
  )
}
