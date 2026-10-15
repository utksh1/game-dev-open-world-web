'use client'
/**
 * Minimap — canvas-2D radar, bottom-left of the HUD.
 *
 * Data flow: NO React state — a requestAnimationFrame loop (~30 fps) reads
 * the live engine through the store's non-reactive `engineRef` and the
 * latest HudState via `useGameStore.getState()`, exactly like the engine
 * publishes it. Modes: rotate-with-player (default) or north-up, from the
 * persisted settings. Range ≈ 150 m across.
 */
import { useEffect, useRef } from 'react'
import { engineRef, useGameStore } from '@/game/state'
import type { LevelData } from '@/game/types'
import type { AvailableMission } from '@/game/gameplay/MissionSystem'
import {
  getCameraHeading,
  getHelicopter,
  getGarageMapPoint,
  getLiveMissions,
  getNpcs,
  getPursuit,
  getRaceOpponents,
  getServices,
  getTraffic,
} from './engineViews'
import {
  drawBuildings,
  drawEdgeArrow,
  drawGrid,
  drawMapBackground,
  drawMissionMarker,
  drawPlayerArrow,
  drawRoads,
  drawServiceBlip,
  drawWater,
  drawWaypointDiamond,
  formatDistance,
} from './mapRender'

const RANGE_M = 150 // meters across the minimap
const FRAME_MS = 1000 / 30
const MISSION_POLL_MS = 1000

export default function Minimap({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    let raf = 0
    let lastDraw = -9999
    let lastMissionPoll = -9999
    let missions: AvailableMission[] = []
    let services: ReturnType<typeof getServices> = []
    let garage: ReturnType<typeof getGarageMapPoint> = null

    const draw = (nowMs: number): void => {
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const cssSize = canvas.clientWidth
      const engine = engineRef.current
      const state = useGameStore.getState()
      const hud = state.hud

      if (!engine || !hud || cssSize < 20) {
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        return
      }

      let level: LevelData | null = null
      try {
        level = engine.level
      } catch {
        level = null
      }
      if (!level) return

      // Poll the mission system for markers (~1 Hz — statuses only change
      // on mission completion; randomizing side rewards each poll is fine).
      if (nowMs - lastMissionPoll > MISSION_POLL_MS) {
        lastMissionPoll = nowMs
        missions = getLiveMissions(engine)
        services = getServices(engine)
        garage = getGarageMapPoint(engine)
      }

      // ---- backing store / DPR ----
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const px = Math.round(cssSize * dpr)
      if (canvas.width !== px || canvas.height !== px) {
        canvas.width = px
        canvas.height = px
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      const t = nowMs / 1000
      const c = cssSize / 2
      const radius = c - 2
      const scale = cssSize / RANGE_M
      const rotate = state.settings.minimapRotate
      const heading = getCameraHeading(engine)
      const p = hud.player.position
      const view = {
        scale,
        project: (wx: number, wz: number): [number, number] => [
          (wx - p.x) * scale,
          (wz - p.z) * scale,
        ],
      }

      // ---- circular clip ----
      ctx.clearRect(0, 0, cssSize, cssSize)
      ctx.save()
      ctx.beginPath()
      ctx.arc(c, c, radius, 0, Math.PI * 2)
      ctx.clip()
      drawMapBackground(ctx, cssSize, cssSize)

      // ---- world features (optionally rotated around the player) ----
      ctx.save()
      ctx.translate(c, c)
      if (rotate) ctx.rotate(-heading)
      drawGrid(ctx, level, view)
      drawRoads(ctx, level, view)
      drawWater(ctx, level, view)
      drawBuildings(ctx, level, view)

      // traffic (amber dots)
      for (const car of getTraffic(engine)) {
        const [x, y] = view.project(car.position.x, car.position.z)
        ctx.beginPath()
        ctx.arc(x, y, 2.4, 0, Math.PI * 2)
        ctx.fillStyle = '#fbbf24'
        ctx.fill()
      }
      // pursuit cruisers (pulsing rose squares — sirens, not civilians)
      const pursuit = getPursuit(engine)
      if (pursuit.length > 0) {
        const pulse = 0.6 + 0.4 * Math.sin(nowMs / 140)
        for (const cruiser of pursuit) {
          const [x, y] = view.project(cruiser.position.x, cruiser.position.z)
          const s = 4 + pulse * 2.2
          ctx.fillStyle = `rgba(244, 63, 94, ${0.65 + pulse * 0.35})`
          ctx.fillRect(x - s / 2, y - s / 2, s, s)
          ctx.strokeStyle = `rgba(253, 164, 175, ${pulse})`
          ctx.lineWidth = 1.2
          ctx.strokeRect(x - s / 2, y - s / 2, s, s)
        }
      }
      // police helicopter (rose rotor ring — spins like the blades)
      const heli = getHelicopter(engine)
      if (heli) {
        const [hx, hy] = view.project(heli.position.x, heli.position.z)
        const spin = nowMs / 90
        ctx.save()
        ctx.translate(hx, hy)
        ctx.rotate(spin)
        ctx.strokeStyle = heli.searchlightOn ? '#fcd34d' : '#fb7185'
        ctx.lineWidth = 1.6
        for (let b = 0; b < 4; b++) {
          const a = (b / 4) * Math.PI * 2
          ctx.beginPath()
          ctx.moveTo(Math.cos(a) * 1.8, Math.sin(a) * 1.8)
          ctx.lineTo(Math.cos(a) * 6, Math.sin(a) * 6)
          ctx.stroke()
        }
        ctx.restore()
        ctx.beginPath()
        ctx.arc(hx, hy, 2.1, 0, Math.PI * 2)
        ctx.fillStyle = '#fb7185'
        ctx.fill()
        ctx.strokeStyle = '#0f172a'
        ctx.lineWidth = 1
        ctx.stroke()
      }
      // race opponents (white diamonds w/ dark outline — rival racers)
      for (const opp of getRaceOpponents(engine)) {
        const [x, y] = view.project(opp.position.x, opp.position.z)
        const s = 3.4
        ctx.save()
        ctx.translate(x, y)
        ctx.rotate(Math.PI / 4)
        ctx.fillStyle = opp.finished ? 'rgba(113, 113, 122, 0.75)' : 'rgba(244, 244, 245, 0.95)'
        ctx.fillRect(-s / 2, -s / 2, s, s)
        ctx.strokeStyle = 'rgba(9, 9, 11, 0.9)'
        ctx.lineWidth = 1
        ctx.strokeRect(-s / 2, -s / 2, s, s)
        ctx.restore()
      }
      // NPCs: hostile=rose, police=slate, pedestrian=zinc
      for (const npc of getNpcs(engine)) {
        if (!npc.alive) continue
        const [x, y] = view.project(npc.position.x, npc.position.z)
        const isPolice = npc.type === 'police' || npc.type === 'swat'
        ctx.beginPath()
        ctx.arc(x, y, isPolice ? 2.8 : 2.2, 0, Math.PI * 2)
        ctx.fillStyle = npc.hostile ? '#fb7185' : isPolice ? '#cbd5e1' : '#71717a'
        ctx.fill()
        if (isPolice) {
          ctx.strokeStyle = '#0f172a'
          ctx.lineWidth = 1
          ctx.stroke()
        }
      }
      // available mission markers (pulsing amber)
      for (const m of missions) {
        if (m.status !== 'available' || !m.startPosition) continue
        const [x, y] = view.project(m.startPosition.x, m.startPosition.z)
        drawMissionMarker(ctx, x, y, t, 4.5)
      }
      // city services (clinic cross / ammo square / spray pad / garage roof)
      for (const s of services) {
        const [x, y] = view.project(s.position.x, s.position.z)
        drawServiceBlip(ctx, x, y, s.kind)
      }
      if (garage) {
        const [x, y] = view.project(garage.position.x, garage.position.z)
        drawServiceBlip(ctx, x, y, 'garage')
      }
      ctx.restore()

      // ---- on-map waypoints (inside the rotated frame) ----
      const inRange = (wx: number, wz: number): boolean =>
        Math.hypot((wx - p.x) * scale, (wz - p.z) * scale) < radius - 12
      const wpMission = hud.mission?.waypoint ?? null
      const wpPersonal = state.waypoint
      ctx.save()
      ctx.translate(c, c)
      if (rotate) ctx.rotate(-heading)
      if (wpMission && inRange(wpMission.x, wpMission.z)) {
        const [x, y] = view.project(wpMission.x, wpMission.z)
        drawWaypointDiamond(ctx, x, y, 6, (Math.sin(t * 2.4) + 1) / 2)
      }
      if (wpPersonal && inRange(wpPersonal.x, wpPersonal.z)) {
        const [x, y] = view.project(wpPersonal.x, wpPersonal.z)
        drawWaypointDiamond(ctx, x, y, 5, (Math.sin(t * 2.4 + Math.PI) + 1) / 2)
      }
      ctx.restore()

      // ---- off-map indicators (drawn unrotated) ----
      const edgeAngle = (wx: number, wz: number): number => {
        const phi = Math.atan2((wz - p.z) * scale, (wx - p.x) * scale)
        return rotate ? phi - heading : phi
      }
      if (wpMission && !inRange(wpMission.x, wpMission.z)) {
        drawEdgeArrow(
          ctx, c, c, radius, edgeAngle(wpMission.x, wpMission.z),
          formatDistance(Math.hypot(wpMission.x - p.x, wpMission.z - p.z)),
        )
      }
      if (wpPersonal && !inRange(wpPersonal.x, wpPersonal.z)) {
        drawEdgeArrow(
          ctx, c, c, radius, edgeAngle(wpPersonal.x, wpPersonal.z),
          formatDistance(Math.hypot(wpPersonal.x - p.x, wpPersonal.z - p.z)),
        )
      }

      // ---- player ----
      if (rotate) drawPlayerArrow(ctx, c, c, 0, 7)
      else drawPlayerArrow(ctx, c, c, heading, 7)

      // ---- north indicator on the ring ----
      const northAngle = rotate ? -Math.PI / 2 - heading : -Math.PI / 2
      const nx = c + Math.cos(northAngle) * (radius - 10)
      const ny = c + Math.sin(northAngle) * (radius - 10)
      ctx.font = '800 9px ui-monospace, SFMono-Regular, Menlo, monospace'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = 'rgba(9, 9, 11, 0.85)'
      ctx.beginPath()
      ctx.arc(nx, ny, 7, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#e4e4e7'
      ctx.fillText('N', nx, ny + 0.5)

      ctx.restore()
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
  }, [])

  return (
    <div
      className={`overflow-hidden rounded-full border-2 border-white/15 bg-zinc-950 shadow-lg shadow-black/60 ${className ?? ''}`}
      role="img"
      aria-label="Minimap: nearby roads, traffic, pedestrians and mission markers"
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  )
}
