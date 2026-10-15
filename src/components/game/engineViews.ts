'use client'
/**
 * Narrow structural views over the live engine + its registered systems.
 *
 * The engine's `systems` map is typed with the structural `EngineSystem`
 * interface (only lifecycle hooks), so UI code that needs gameplay APIs
 * (traffic positions, NPC blips, mission listings, audio volumes…) casts
 * to the tiny duck-typed views below — the same pattern SaveSystem.ts
 * uses for `notify`. All calls are optional-chained and never throw when
 * a system is absent.
 *
 * Types are imported with `import type` ONLY — three.js stays out of the
 * landing-page bundle.
 */
import type { ContentBundle, MissionData, MissionStatus, Vec3, WeaponId } from '@/game/types'
import type { GameEngine } from '@/game/engine'
import type { TrafficInfo } from '@/game/ai/TrafficSystem'
import type { NpcInfo } from '@/game/ai/NPCManager'
import type { PursuitInfo } from '@/game/ai/PolicePursuit'
import type { HelicopterInfo } from '@/game/ai/PoliceHelicopter'
import type { RadioState } from '@/game/audio/RadioSystem'
import type { AvailableMission, RaceOpponentInfo } from '@/game/gameplay/MissionSystem'
import type { ServiceConfirm, ServicePrompt, ServicePointInfo, ServiceKind } from '@/game/gameplay/CityServices'
import type { GarageBay, GaragePrompt, GarageVehicleSnapshot } from '@/game/gameplay/GarageSystem'
import type { WeaponShopEntry } from '@/game/gameplay/WeaponSystem'

// ---------------------------------------------------------------------
// System views
// ---------------------------------------------------------------------

interface TrafficSystemView {
  getTraffic?: () => TrafficInfo[]
}
interface PursuitSystemView {
  getPursuit?: () => PursuitInfo[]
  isPursuing?: () => boolean
  getArrestCountdown?: () => number | null
}
interface HeliSystemView {
  getHelicopter?: () => HelicopterInfo | null
  isPlayerLit?: () => boolean
}
interface RadioSystemView {
  getRadioState?: () => RadioState
}
interface NpcSystemView {
  getNPCs?: () => NpcInfo[]
}
interface MissionSystemView {
  getAvailableMissions?: () => AvailableMission[]
  debugCompleteObjective?: () => boolean
  debugRaceStatus?: () => string
  getRaceOpponents?: () => RaceOpponentInfo[]
  getSaveData?: () => { missionsCompleted?: string[]; campaignProgress?: number }
}
interface AudioSystemView {
  setVolumes?: (v: { master?: number; music?: number; sfx?: number }) => void
}
interface WeaponsSystemView {
  giveAllWeapons?: () => void
}
interface PoliceDebugView {
  debugSpawnPolice?: () => void
  registerCrime?: (bump?: number) => void
}
interface VehicleHealthView {
  getById?: (id: string) => { health: number; maxHealth?: number } | null
}
interface ServicesSystemView {
  getServices?: () => ServicePointInfo[]
  getNearbyService?: () => ServicePrompt | null
  getConfirm?: () => ServiceConfirm | null
  debugTeleport?: (kind: ServiceKind) => boolean
}

/** Live traffic cars (minimap amber dots). Empty when the system is absent. */
export function getTraffic(engine: GameEngine | null): TrafficInfo[] {
  return (engine?.systems.traffic as TrafficSystemView | undefined)?.getTraffic?.() ?? []
}

/** Live pursuit cruisers (minimap rose blips + HUD banner). */
export function getPursuit(engine: GameEngine | null): PursuitInfo[] {
  return (engine?.systems.pursuit as PursuitSystemView | undefined)?.getPursuit?.() ?? []
}

/** True while cruisers are actively chasing the player's vehicle. */
export function isPursuitActive(engine: GameEngine | null): boolean {
  return (engine?.systems.pursuit as PursuitSystemView | undefined)?.isPursuing?.() ?? false
}

/** Seconds-to-BUSTED while boxed in and stopped, else null. */
export function getArrestCountdown(engine: GameEngine | null): number | null {
  return (engine?.systems.pursuit as PursuitSystemView | undefined)?.getArrestCountdown?.() ?? null
}

/** Live police helicopter (4★+ air unit), or null when grounded. */
export function getHelicopter(engine: GameEngine | null): HelicopterInfo | null {
  return (engine?.systems.heli as HeliSystemView | undefined)?.getHelicopter?.() ?? null
}

/** True while the chopper's searchlight has the player pinned. */
export function isPlayerLitByHeli(engine: GameEngine | null): boolean {
  return (engine?.systems.heli as HeliSystemView | undefined)?.isPlayerLit?.() ?? false
}

/** Live photo-mode state (free camera FOV + snapshot counter). */
export function getPhotoState(
  engine: GameEngine | null,
): { active: boolean; fov: number; snappedAt: number } {
  try {
    const e = engine as unknown as
      | { getPhotoState?: () => { active: boolean; fov: number; snappedAt: number } }
      | null
    return e?.getPhotoState?.() ?? { active: false, fov: 70, snappedAt: 0 }
  } catch {
    return { active: false, fov: 70, snappedAt: 0 }
  }
}

/** Live radio state (station / playing / track title), for the HUD widget. */
export function getRadioState(engine: GameEngine | null): RadioState | null {
  return (engine?.systems.radio as RadioSystemView | undefined)?.getRadioState?.() ?? null
}

/** Live NPCs (minimap blips + AI state). Empty when the system is absent. */
export function getNpcs(engine: GameEngine | null): NpcInfo[] {
  return (engine?.systems.npcs as NpcSystemView | undefined)?.getNPCs?.() ?? []
}

/** Live AI race opponents (white diamonds on the minimap). */
export function getRaceOpponents(engine: GameEngine | null): RaceOpponentInfo[] {
  return (engine?.systems.missions as MissionSystemView | undefined)?.getRaceOpponents?.() ?? []
}

/** Mission listings from the LIVE mission system (authoritative status). */
export function getLiveMissions(engine: GameEngine | null): AvailableMission[] {
  return (engine?.systems.missions as MissionSystemView | undefined)?.getAvailableMissions?.() ?? []
}

/** Missions completed according to the live mission system. */
export function getLiveCompleted(engine: GameEngine | null): Set<string> {
  const fragment = (engine?.systems.missions as MissionSystemView | undefined)?.getSaveData?.()
  return new Set(fragment?.missionsCompleted ?? [])
}

/** Push volume settings into the audio system (no-op when not registered). */
export function applyAudioVolumes(
  engine: GameEngine | null,
  volumes: { master: number; music: number; sfx: number },
): void {
  const audio = engine?.systems.audio as AudioSystemView | undefined
  audio?.setVolumes?.(volumes)
}

/** Debug-bar helpers (weapon cheats, objective cheat, police spawns). */
export function debugGiveAllWeapons(engine: GameEngine | null): void {
  ;(engine?.systems.weapons as WeaponsSystemView | undefined)?.giveAllWeapons?.()
}
export function debugCompleteObjective(engine: GameEngine | null): boolean {
  return (
    (engine?.systems.missions as MissionSystemView | undefined)?.debugCompleteObjective?.() ?? false
  )
}
export function debugSpawnPolice(engine: GameEngine | null): void {
  ;(engine?.systems.npcs as PoliceDebugView | undefined)?.debugSpawnPolice?.()
}

/** Debug: one-line race diagnostic (place, opponents, countdown). */
export function debugRaceStatus(engine: GameEngine | null): string {
  return (
    (engine?.systems.missions as MissionSystemView | undefined)?.debugRaceStatus?.() ??
    'no mission system'
  )
}

/** Debug: jump the in-game clock +6 h (fires nightfall/dawn events). */
export function debugSkipTime(engine: GameEngine | null): void {
  engine?.advanceTime(6)
}
export function debugSuppressWantedDecay(engine: GameEngine | null): void {
  ;(engine?.systems.npcs as PoliceDebugView | undefined)?.registerCrime?.(0)
}

/** Current vehicle health (0..100 %) for the speedometer damage bar. */
export function getVehicleHealthPct(engine: GameEngine | null, vehicleId: string | null): number | null {
  if (!engine || !vehicleId) return null
  try {
    const v = (engine.vehicles as unknown as VehicleHealthView).getById?.(vehicleId)
    if (!v) return null
    const max = v.maxHealth ?? 100
    return Math.max(0, Math.min(100, Math.round((v.health / max) * 100)))
  } catch {
    return null
  }
}

/**
 * Camera heading for maps: 0 = north (−Z), π/2 = east (+X).
 * The CameraController writes YXZ euler (`rotation.set(pitch, yaw, 0, 'YXZ')`)
 * with forward (−sin yaw, −cos yaw) — so heading = −yaw.
 */
export function getCameraHeading(engine: GameEngine | null): number {
  try {
    return -(engine?.camera.rotation.y ?? 0)
  } catch {
    return 0
  }
}

// ---------------------------------------------------------------------
// Mission listings WITHOUT a running engine (MainMenu Mission Board)
// ---------------------------------------------------------------------

export interface MissionListing {
  id: string
  name: string
  description: string
  difficulty: string
  isSide: boolean
  repeatable: boolean
  status: MissionStatus
  /** Fixed reward (main missions). */
  rewardMoney: number
  /** Side missions roll within [rewardMoneyMin, rewardMoneyMax]. */
  rewardMoneyMin?: number
  rewardMoneyMax?: number
  rewardXp: number
  requiredItems: string[]
  startPosition: Vec3 | null
  objectives: MissionData['objectives']
  timeLimit?: number
  /** Campaign unlock requirement (for locked tooltips). */
  unlockRequirement: string | null
}

/**
 * Client-side replica of MissionSystem.statusOf/unlockRequirement so the
 * Mission Board can render before the engine boots: campaign missions
 * unlock in chain order (unlock === 'start' or unlock-mission completed),
 * side missions are always available, completed non-repeatables stay done.
 */
export function resolveMissionListings(
  content: ContentBundle | null,
  completedIds: ReadonlySet<string>,
): MissionListing[] {
  if (!content) return []
  return content.missions.map((m) => {
    let status: MissionStatus
    let unlockRequirement: string | null = null
    if (completedIds.has(m.id) && !m.repeatable) {
      status = 'completed'
    } else if (m.isSide) {
      status = 'available'
    } else {
      const entry = content.campaign?.missions.find((c) => c.id === m.id)
      if (!entry) {
        status = 'available'
      } else if (entry.unlock === 'start' || completedIds.has(entry.unlock)) {
        status = 'available'
      } else {
        status = 'locked'
        const unlockName =
          content.missions.find((x) => x.id === entry.unlock)?.name ?? entry.unlock
        unlockRequirement = unlockName
      }
    }
    return {
      id: m.id,
      name: m.name,
      description: m.description,
      difficulty: m.difficulty,
      isSide: m.isSide,
      repeatable: m.repeatable,
      status,
      rewardMoney: m.rewardMoney,
      rewardMoneyMin: m.rewardMoneyMin,
      rewardMoneyMax: m.rewardMoneyMax,
      rewardXp: m.rewardXp,
      requiredItems: m.requiredItems,
      startPosition: m.startPosition ?? null,
      objectives: m.objectives,
      timeLimit: m.timeLimit,
      unlockRequirement,
    }
  })
}

// ---------------------------------------------------------------------
// Shared UI constants
// ---------------------------------------------------------------------

export const DIFFICULTY_STYLES: Record<string, string> = {
  easy: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300',
  medium: 'border-amber-500/50 bg-amber-500/10 text-amber-300',
  hard: 'border-rose-500/50 bg-rose-500/10 text-rose-300',
}

export const WEAPON_SHORT: Record<string, string> = {
  fists: 'FIST',
  pistol: 'PST',
  smg: 'SMG',
  rifle: 'RFL',
  shotgun: 'SHG',
}

/** Building-type tint used by both maps (no blue/indigo — see rules). */
export const BUILDING_TINTS: Record<string, string> = {
  police: '#94a3b8', // slate
  hospital: '#fb7185', // rose
  bank: '#fbbf24', // amber
  shop: '#34d399', // emerald
  mall: '#34d399',
  gas_station: '#fbbf24',
  warehouse: '#a1a1aa', // zinc
  factory: '#a1a1aa',
  office: '#71717a',
  apartment: '#71717a',
  parking: '#52525b',
  terminal: '#d4d4d8',
  crane: '#d4d4d8',
  cargo_dock: '#d4d4d8',
}

export function buildingTint(type: string): string {
  const key = type.toLowerCase().trim()
  return BUILDING_TINTS[key] ?? '#52525b'
}

/** "2h ago"-style relative time (client-only, falls back to locale string). */
export function relativeTime(iso: string): string {
  try {
    const then = new Date(iso).getTime()
    if (!Number.isFinite(then)) return 'unknown'
    const diff = Math.max(0, Date.now() - then)
    const mins = Math.floor(diff / 60_000)
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins}m ago`
    const hours = Math.floor(mins / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    if (days < 30) return `${days}d ago`
    return new Date(iso).toLocaleDateString()
  } catch {
    return 'unknown'
  }
}

export function formatPlaytime(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0m'
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

export function formatDayTime(h: number): string {
  const hours = Math.floor(h) % 24
  const minutes = Math.floor((h % 1) * 60)
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

export function formatMoney(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`
}

/** Meters → compact display: 842m, 1.3km */
export function formatDistance(m: number | null | undefined): string {
  if (m === null || m === undefined || !Number.isFinite(m)) return ''
  if (m < 1000) return `${Math.round(m)}m`
  return `${(m / 1000).toFixed(1)}km`
}

// ---------------------------------------------------------------------
// City services (clinic / gun shop / Pay'n'Spray)
// ---------------------------------------------------------------------

/** Static service points (minimap + big map layers). */
export function getServices(engine: GameEngine | null): ServicePointInfo[] {
  return (engine?.systems.services as ServicesSystemView | undefined)?.getServices?.() ?? []
}

/** The service the player can currently use — HUD prompt pill. */
export function getServicePrompt(engine: GameEngine | null): ServicePrompt | null {
  return (engine?.systems.services as ServicesSystemView | undefined)?.getNearbyService?.() ?? null
}

/** Round 9: the armed purchase awaiting its confirming E press. */
export function getServiceConfirm(engine: GameEngine | null): ServiceConfirm | null {
  return (engine?.systems.services as ServicesSystemView | undefined)?.getConfirm?.() ?? null
}

/** Debug: teleport to a service point. */
export function debugTeleportService(engine: GameEngine | null, kind: ServiceKind): boolean {
  return (
    (engine?.systems.services as ServicesSystemView | undefined)?.debugTeleport?.(kind) ?? false
  )
}

// ---------------------------------------------------------------------
// Garage lockup (round 8 — property + vehicle persistence; round 9 —
// 3 bays, respray customization, bay-management panel)
// ---------------------------------------------------------------------

interface GarageSystemView {
  getPrompt?: () => GaragePrompt
  getMapPoint?: () => { kind: 'garage'; position: Vec3 } | null
  getStatus?: () => {
    owned: boolean
    stored: GarageVehicleSnapshot | null
    carsInside: number
    baysUnlocked: number
  } | null
  getBays?: () => GarageBay[]
  takeOut?: (bayIndex: number) => boolean
  respray?: (bayIndex: number, hex: number | null) => boolean
  expand?: () => boolean
  debugTeleport?: () => boolean
  debugGiveOwnership?: () => boolean
  debugFillBay?: () => boolean
}

/** Garage ownership + bay occupancy for the HUD chip (any distance). */
export function getGarageStatus(
  engine: GameEngine | null,
): { owned: boolean; stored: GarageVehicleSnapshot | null; carsInside: number; baysUnlocked: number } | null {
  return (engine?.systems.garage as GarageSystemView | undefined)?.getStatus?.() ?? null
}

/** The garage pad as a map point (minimap + big map). */
export function getGarageMapPoint(
  engine: GameEngine | null,
): { kind: 'garage'; position: Vec3 } | null {
  return (engine?.systems.garage as GarageSystemView | undefined)?.getMapPoint?.() ?? null
}

/** Garage prompt for the HUD pill (null when out of reach). */
export function getGaragePrompt(engine: GameEngine | null): GaragePrompt | null {
  return (engine?.systems.garage as GarageSystemView | undefined)?.getPrompt?.() ?? null
}

/** All bays for the garage panel. */
export function getGarageBays(engine: GameEngine | null): GarageBay[] {
  return (engine?.systems.garage as GarageSystemView | undefined)?.getBays?.() ?? []
}

/** Panel action: take the car in a bay out (swaps while driving). */
export function garageTakeOut(engine: GameEngine | null, bayIndex: number): boolean {
  return (engine?.systems.garage as GarageSystemView | undefined)?.takeOut?.(bayIndex) ?? false
}

/** Panel action: respray the car in a bay ($25, cosmetic only). */
export function garageRespray(
  engine: GameEngine | null,
  bayIndex: number,
  hex: number | null,
): boolean {
  return (engine?.systems.garage as GarageSystemView | undefined)?.respray?.(bayIndex, hex) ?? false
}

/** Panel action: annex the unit next door (+2 bays, $450). */
export function garageExpand(engine: GameEngine | null): boolean {
  return (engine?.systems.garage as GarageSystemView | undefined)?.expand?.() ?? false
}

/** Debug: teleport to the garage pad. */
export function debugTeleportGarage(engine: GameEngine | null): boolean {
  return (engine?.systems.garage as GarageSystemView | undefined)?.debugTeleport?.() ?? false
}

// ---------------------------------------------------------------------
// Gun shop (round 10 — browsable counter: weapon purchases + ammo
// top-up sheet, replacing the single-purpose ammo confirm card)
// ---------------------------------------------------------------------

interface GunShopView {
  getShopStock?: () => WeaponShopEntry[]
  canTopUpAmmo?: () => boolean
  buyWeapon?: (id: WeaponId) => boolean
  buyAmmoTopup?: () => boolean
}

/** Catalog rows for the shop sheet (stats + price + owned flag). */
export function getGunShopStock(engine: GameEngine | null): WeaponShopEntry[] {
  return (engine?.systems.services as unknown as GunShopView | undefined)?.getShopStock?.() ?? []
}

/** True when at least one owned weapon's reserve is below max. */
export function gunShopCanTopUp(engine: GameEngine | null): boolean {
  return (engine?.systems.services as unknown as GunShopView | undefined)?.canTopUpAmmo?.() ?? false
}

/** Sheet action: buy a firearm (full mag + reserve included). */
export function gunShopBuyWeapon(engine: GameEngine | null, id: WeaponId): boolean {
  return (engine?.systems.services as unknown as GunShopView | undefined)?.buyWeapon?.(id) ?? false
}

/** Sheet action: the $40 reserve top-up for every owned weapon. */
export function gunShopBuyAmmoTopup(engine: GameEngine | null): boolean {
  return (engine?.systems.services as unknown as GunShopView | undefined)?.buyAmmoTopup?.() ?? false
}


/** Debug: grant garage ownership + all bays without paying. */
export function debugGarageOwnership(engine: GameEngine | null): boolean {
  return (engine?.systems.garage as GarageSystemView | undefined)?.debugGiveOwnership?.() ?? false
}

/** Debug: park a fresh car into the first free bay. */
export function debugGarageFillBay(engine: GameEngine | null): boolean {
  return (engine?.systems.garage as GarageSystemView | undefined)?.debugFillBay?.() ?? false
}
