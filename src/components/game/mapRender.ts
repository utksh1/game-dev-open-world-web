'use client'
/**
 * Shared canvas-2D rendering primitives for the Minimap and BigMap.
 * Both maps project world (x, z) → canvas pixels through a Projector
 * closure, so the minimap can compose translate+rotate around the player
 * while the big map uses a static fit-to-level transform. Palette is
 * strictly emerald/amber/rose/slate/zinc (no blue/indigo).
 */
import type { LevelData } from '@/game/types'
import { buildingTint } from './engineViews'

export interface MapView {
  /** world (x,z) → canvas [x,y] */
  project: (wx: number, wz: number) => [number, number]
  /** pixels per meter (line widths etc.) */
  scale: number
}

/** Deep-zinc map background. */
export function drawMapBackground(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
): void {
  ctx.fillStyle = '#09090b' // zinc-950
  ctx.fillRect(0, 0, w, h)
}

/** Water areas (harbor ocean strip) — emerald-tinted deep water. */
export function drawWater(ctx: CanvasRenderingContext2D, level: LevelData, view: MapView): void {
  ctx.fillStyle = 'rgba(6, 78, 59, 0.85)' // emerald-900
  ctx.strokeStyle = 'rgba(52, 211, 153, 0.25)'
  for (const area of level.waterAreas) {
    const minX = Math.min(area.min.x, area.max.x)
    const maxX = Math.max(area.min.x, area.max.x)
    const minZ = Math.min(area.min.z, area.max.z)
    const maxZ = Math.max(area.min.z, area.max.z)
    const [x0, y0] = view.project(minX, minZ)
    const [x1, y1] = view.project(maxX, maxZ)
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0)
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0)
  }
}

/** 100 m city grid (the chunk borders the CityBuilder puts roads on). */
export function drawGrid(ctx: CanvasRenderingContext2D, level: LevelData, view: MapView): void {
  const step = 100
  ctx.strokeStyle = 'rgba(113, 113, 122, 0.16)' // zinc-500 @16%
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let x = 0; x <= level.sizeX + 1; x += step) {
    const [px] = view.project(x, 0)
    ctx.moveTo(px, -9999)
    ctx.lineTo(px, 9999)
  }
  for (let z = 0; z <= level.sizeZ + 1; z += step) {
    const [, py] = view.project(0, z)
    ctx.moveTo(-9999, py)
    ctx.lineTo(9999, py)
  }
  ctx.stroke()
}

/** Authored roads from the .level asset, drawn as wide strokes. */
export function drawRoads(ctx: CanvasRenderingContext2D, level: LevelData, view: MapView): void {
  ctx.strokeStyle = 'rgba(161, 161, 170, 0.42)' // zinc-400 @42%
  ctx.lineCap = 'round'
  for (const road of level.roads) {
    ctx.lineWidth = Math.max(2.5, road.width * view.scale * 0.9)
    const [x0, y0] = view.project(road.start.x, road.start.z)
    const [x1, y1] = view.project(road.end.x, road.end.z)
    ctx.beginPath()
    ctx.moveTo(x0, y0)
    ctx.lineTo(x1, y1)
    ctx.stroke()
  }
}

/** Authored buildings as type-tinted rects (position = center). */
export function drawBuildings(
  ctx: CanvasRenderingContext2D,
  level: LevelData,
  view: MapView,
  opts?: { labels?: boolean; labelText?: (name: string, type: string) => string | null },
): void {
  for (const b of level.buildings) {
    const [cx, cy] = view.project(b.position.x, b.position.z)
    const w = Math.max(3, b.size.x * view.scale)
    const h = Math.max(3, b.size.z * view.scale)
    ctx.fillStyle = buildingTint(b.type)
    ctx.globalAlpha = 0.9
    ctx.fillRect(cx - w / 2, cy - h / 2, w, h)
    ctx.globalAlpha = 1
    if (opts?.labels) {
      const text = opts.labelText
        ? opts.labelText(b.name, b.type)
        : b.name || null
      if (text) {
        ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        ctx.fillStyle = 'rgba(9, 9, 11, 0.75)'
        const tw = ctx.measureText(text).width
        ctx.fillRect(cx - tw / 2 - 3, cy + h / 2 + 2, tw + 6, 13)
        ctx.fillStyle = '#e4e4e7'
        ctx.fillText(text, cx, cy + h / 2 + 3)
      }
    }
  }
}

/** Emerald player arrow rotated to `heading` (0 = north/−Z). */
export function drawPlayerArrow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  heading: number,
  size = 7,
): void {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(heading)
  ctx.beginPath()
  ctx.moveTo(0, -size)
  ctx.lineTo(size * 0.72, size)
  ctx.lineTo(0, size * 0.55)
  ctx.lineTo(-size * 0.72, size)
  ctx.closePath()
  ctx.fillStyle = '#34d399' // emerald-400
  ctx.strokeStyle = '#064e3b'
  ctx.lineWidth = 1.5
  ctx.fill()
  ctx.stroke()
  ctx.restore()
}

/** Pulsing amber mission marker (available mission at its startPosition). */
export function drawMissionMarker(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  t: number,
  size = 5,
): void {
  const pulse = 0.5 + 0.5 * Math.sin(t * 3)
  ctx.beginPath()
  ctx.arc(x, y, size + pulse * 2.5, 0, Math.PI * 2)
  ctx.fillStyle = `rgba(251, 191, 36, ${0.16 + pulse * 0.14})` // amber-400
  ctx.fill()
  ctx.beginPath()
  ctx.arc(x, y, size, 0, Math.PI * 2)
  ctx.fillStyle = '#fbbf24'
  ctx.strokeStyle = '#78350f'
  ctx.lineWidth = 1.5
  ctx.fill()
  ctx.stroke()
}

/**
 * City-service blip — small kind-colored badge with a dark outline:
 * clinic (rose cross), gun shop (amber square), Pay'n'Spray (teal pad),
 * garage lockup (lime "roof" wedge). Static, distinct from the pulsing
 * amber mission markers.
 */
export function drawServiceBlip(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  kind: 'clinic' | 'ammo' | 'spray' | 'garage',
): void {
  const color =
    kind === 'clinic' ? '#f87171' : kind === 'ammo' ? '#fbbf24' : kind === 'garage' ? '#a3e635' : '#2dd4bf'
  ctx.save()
  ctx.beginPath()
  ctx.arc(x, y, 4.2, 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(9, 9, 11, 0.9)'
  ctx.fill()
  ctx.strokeStyle = color
  ctx.lineWidth = 1.6
  ctx.stroke()
  ctx.fillStyle = color
  if (kind === 'clinic') {
    // plus/cross
    ctx.fillRect(x - 0.8, y - 2.6, 1.6, 5.2)
    ctx.fillRect(x - 2.6, y - 0.8, 5.2, 1.6)
  } else if (kind === 'ammo') {
    ctx.fillRect(x - 1.5, y - 1.5, 3, 3)
  } else if (kind === 'garage') {
    // pitched-roof silhouette: wedge + door
    ctx.beginPath()
    ctx.moveTo(x - 2.4, y - 0.4)
    ctx.lineTo(x, y - 2.4)
    ctx.lineTo(x + 2.4, y - 0.4)
    ctx.lineTo(x + 2.4, y + 2.2)
    ctx.lineTo(x - 2.4, y + 2.2)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = 'rgba(9, 9, 11, 0.9)'
    ctx.fillRect(x - 1, y + 0.2, 2, 2)
  } else {
    ctx.beginPath()
    ctx.arc(x, y, 1.8, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}

/** Emerald diamond — active mission objective waypoint / personal waypoint. */
export function drawWaypointDiamond(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size = 6,
  pulse = 0,
): void {
  if (pulse > 0) {
    ctx.beginPath()
    ctx.arc(x, y, size + 3 + pulse * 4, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(52, 211, 153, ${0.7 - pulse * 0.5})`
    ctx.lineWidth = 2
    ctx.stroke()
  }
  ctx.beginPath()
  ctx.moveTo(x, y - size)
  ctx.lineTo(x + size, y)
  ctx.lineTo(x, y + size)
  ctx.lineTo(x - size, y)
  ctx.closePath()
  ctx.fillStyle = '#34d399'
  ctx.strokeStyle = '#022c22'
  ctx.lineWidth = 1.5
  ctx.fill()
  ctx.stroke()
}

/**
 * Off-map indicator: arrow on the ring border pointing toward a target
 * that lies outside the visible radius, with a distance label.
 */
export function drawEdgeArrow(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  angle: number,
  label: string,
  color = '#34d399',
): void {
  const ax = cx + Math.cos(angle) * (radius - 12)
  const ay = cy + Math.sin(angle) * (radius - 12)
  ctx.save()
  ctx.translate(ax, ay)
  ctx.rotate(angle)
  ctx.beginPath()
  ctx.moveTo(7, 0)
  ctx.lineTo(-4, 5)
  ctx.lineTo(-4, -5)
  ctx.closePath()
  ctx.fillStyle = color
  ctx.strokeStyle = 'rgba(9, 9, 11, 0.8)'
  ctx.lineWidth = 1.5
  ctx.fill()
  ctx.stroke()
  ctx.restore()
  // Distance chip just inside the ring next to the arrow.
  const lx = cx + Math.cos(angle) * (radius - 30)
  const ly = cy + Math.sin(angle) * (radius - 30)
  ctx.font = '700 10px ui-monospace, SFMono-Regular, Menlo, monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const tw = ctx.measureText(label).width
  ctx.fillStyle = 'rgba(9, 9, 11, 0.8)'
  ctx.beginPath()
  ctx.roundRect(lx - tw / 2 - 4, ly - 8, tw + 8, 16, 8)
  ctx.fill()
  ctx.fillStyle = color
  ctx.fillText(label, lx, ly)
}

/** Format a horizontal distance for map labels. */
export function formatDistance(meters: number): string {
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)}km`
  return `${Math.round(meters)}m`
}
