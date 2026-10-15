/**
 * DayNightCycle — 24 game-hours per 10 real minutes.
 *
 * Level `time_of_day` sets the starting hour; level `weather` ('foggy')
 * tightens the fog frustum. Sun color/intensity, sky top/bottom colors,
 * hemisphere light and fog color all lerp through keyframes:
 * night → dawn → morning → noon → afternoon → dusk → night.
 *
 * Aesthetic constraint: no cold blue-tinted scheme. Night is a muted
 * dark slate; human-lit hours lean warm (amber dusk, warm sodium lamps).
 */
import * as THREE from 'three'

export const HOURS_PER_SECOND = 24 / 600 // full day = 10 real minutes

interface DayKeyframe {
  h: number
  skyTop: number
  skyBottom: number
  sun: number
  sunIntensity: number
  hemiSky: number
  hemiGround: number
  hemiIntensity: number
  fog: number
  night: number
}

// hour, skyTop, skyBottom, sun color, sun intensity, hemi sky, hemi ground, hemi intensity, fog, night factor
const KEYS: DayKeyframe[] = [
  { h: 0.0, skyTop: 0x070a12, skyBottom: 0x1a1f2b, sun: 0x4a5266, sunIntensity: 0.5, hemiSky: 0x333a48, hemiGround: 0x1a1d24, hemiIntensity: 0.78, fog: 0x101219, night: 1.0 },
  { h: 4.5, skyTop: 0x080b13, skyBottom: 0x1a1e29, sun: 0x4a5266, sunIntensity: 0.5, hemiSky: 0x343a49, hemiGround: 0x1a1d24, hemiIntensity: 0.78, fog: 0x101219, night: 1.0 },
  { h: 6.0, skyTop: 0x45415f, skyBottom: 0xe08b52, sun: 0xff9a5e, sunIntensity: 0.45, hemiSky: 0x6b5f66, hemiGround: 0x2c261f, hemiIntensity: 0.5, fog: 0xb08165, night: 0.55 },
  { h: 7.5, skyTop: 0x6d94b4, skyBottom: 0xe6d3b4, sun: 0xffd9a3, sunIntensity: 1.0, hemiSky: 0xa8b4bd, hemiGround: 0x554c40, hemiIntensity: 0.6, fog: 0xd0c8ba, night: 0.0 },
  { h: 12.0, skyTop: 0x6ea2c9, skyBottom: 0xd9e0e0, sun: 0xfff1da, sunIntensity: 1.3, hemiSky: 0xbcc7cc, hemiGround: 0x6a6156, hemiIntensity: 0.65, fog: 0xd4d7d3, night: 0.0 },
  { h: 16.5, skyTop: 0x6795b8, skyBottom: 0xe3d3ae, sun: 0xffe3b0, sunIntensity: 1.05, hemiSky: 0xb2b5a8, hemiGround: 0x5d5347, hemiIntensity: 0.6, fog: 0xd6ccae, night: 0.0 },
  { h: 19.0, skyTop: 0x514a66, skyBottom: 0xf08a4b, sun: 0xff8443, sunIntensity: 0.42, hemiSky: 0x7a6866, hemiGround: 0x33291f, hemiIntensity: 0.45, fog: 0xa87a5c, night: 0.6 },
  { h: 20.5, skyTop: 0x151829, skyBottom: 0x382f3e, sun: 0x515868, sunIntensity: 0.52, hemiSky: 0x37404e, hemiGround: 0x1e1a15, hemiIntensity: 0.8, fog: 0x14151c, night: 1.0 },
  { h: 24.0, skyTop: 0x070a12, skyBottom: 0x1a1f2b, sun: 0x4a5266, sunIntensity: 0.5, hemiSky: 0x333a48, hemiGround: 0x1a1d24, hemiIntensity: 0.78, fog: 0x101219, night: 1.0 },
]

export interface DayNightState {
  dayTime: number
  sunDir: THREE.Vector3
  sunColor: THREE.Color
  sunIntensity: number
  hemiSky: THREE.Color
  hemiGround: THREE.Color
  hemiIntensity: number
  skyTop: THREE.Color
  skyBottom: THREE.Color
  fogColor: THREE.Color
  nightFactor: number
  /** True when street lamps / headlights should be on. */
  lampsOn: boolean
}

export function dayTimeFromString(v: string): number {
  switch (v.toLowerCase()) {
    case 'dawn':
      return 6.2
    case 'morning':
      return 8.5
    case 'day':
      return 12
    case 'noon':
      return 12
    case 'afternoon':
      return 15.5
    case 'dusk':
      return 18.8
    case 'evening':
      return 19.5
    case 'night':
      return 23
    case 'any':
    default:
      return 10.5
  }
}

export class DayNightCycle {
  dayTime: number
  foggy: boolean
  private state: DayNightState

  constructor(startHour: number, foggy: boolean) {
    this.dayTime = ((startHour % 24) + 24) % 24
    this.foggy = foggy
    this.state = {
      dayTime: this.dayTime,
      sunDir: new THREE.Vector3(0.4, 0.8, -0.3),
      sunColor: new THREE.Color(),
      sunIntensity: 1,
      hemiSky: new THREE.Color(),
      hemiGround: new THREE.Color(),
      hemiIntensity: 0.6,
      skyTop: new THREE.Color(),
      skyBottom: new THREE.Color(),
      fogColor: new THREE.Color(),
      nightFactor: 0,
      lampsOn: false,
    }
  }

  advance(dt: number): void {
    this.dayTime = (this.dayTime + dt * HOURS_PER_SECOND) % 24
  }

  /** Fog distances for the current weather. */
  getFogRange(): { near: number; far: number } {
    return this.foggy ? { near: 40, far: 260 } : { near: 130, far: 680 }
  }

  /** Compute (and cache) the interpolated state. Returns a shared object — do not retain. */
  getState(): DayNightState {
    const h = this.dayTime
    // Find bracketing keyframes.
    let i = 0
    while (i < KEYS.length - 1 && KEYS[i + 1].h <= h) i++
    const a = KEYS[i]
    const b = KEYS[Math.min(i + 1, KEYS.length - 1)]
    const span = Math.max(b.h - a.h, 1e-6)
    const t = THREE.MathUtils.clamp((h - a.h) / span, 0, 1)

    const s = this.state
    s.dayTime = h
    s.sunColor.lerpColors(clr(a.sun), clr(b.sun), t)
    s.sunIntensity = THREE.MathUtils.lerp(a.sunIntensity, b.sunIntensity, t)
    s.hemiSky.lerpColors(clr(a.hemiSky), clr(b.hemiSky), t)
    s.hemiGround.lerpColors(clr(a.hemiGround), clr(b.hemiGround), t)
    s.hemiIntensity = THREE.MathUtils.lerp(a.hemiIntensity, b.hemiIntensity, t)
    s.skyTop.lerpColors(clr(a.skyTop), clr(b.skyTop), t)
    s.skyBottom.lerpColors(clr(a.skyBottom), clr(b.skyBottom), t)
    s.fogColor.lerpColors(clr(a.fog), clr(b.fog), t)
    s.nightFactor = THREE.MathUtils.lerp(a.night, b.night, t)
    s.lampsOn = s.nightFactor > 0.35

    // Sun travels east → west between 6:00 and 18:00; below horizon at
    // night we use the mirrored "moon" direction for the dim light.
    const theta = ((h - 6) / 12) * Math.PI
    let sx = Math.cos(theta)
    let sy = Math.sin(theta)
    let sz = -0.35
    if (sy < 0.08) {
      // Moon phase: opposite direction, forced above horizon.
      sx = -sx
      sy = Math.max(0.3, -sy)
      sz = 0.35
    }
    s.sunDir.set(sx, sy, sz).normalize()
    return s
  }
}

// Color cache so lerpColors doesn't allocate every frame.
const colorCache = new Map<number, THREE.Color>()
function clr(hex: number): THREE.Color {
  let c = colorCache.get(hex)
  if (!c) {
    c = new THREE.Color(hex)
    colorCache.set(hex, c)
  }
  return c
}
