/**
 * GarageSystem — the property ladder + vehicle persistence gap fix
 * (round-8) UPGRADED in round 9 to a full car-collection lockup:
 *
 *   - THREE bays: the $300 lockup key includes ONE bay; a $450
 *     expansion unlocks the remaining two ("the industrial unit next
 *     door"). Bays persist through saves.
 *   - STORE (E while driving, an empty bay free): the car is
 *     snapshotted {vehicleDataId, name, health, maxHealth, paintColor}
 *     and despawns — it travels with you across level swaps.
 *   - GARAGE PANEL (E on foot, or E while driving with every bay
 *     full): opens the bay-management overlay — take out / swap per
 *     bay, RESPRAY per bay ($25, 10-color palette — cosmetic only,
 *     the Pay'n'Spray booth still owns repairs + heat clearing),
 *     and the expansion purchase for locked bays.
 *   - Legacy saves (round 8 `garageVehicle`) migrate into bay 0.
 *
 * Visual language matches CityServices (flat pulsing ground ring +
 * floating billboard sprite) in LIME with a padlock icon while
 * unowned and a car icon once yours.
 */
import * as THREE from 'three'
import type { EngineSystem, GameEngine } from '@/game/engine'
import type { SystemSaveFragment } from '@/game/engine'
import type { BuildingData, GarageVehicleSnapshot, Vec3 } from '@/game/types'
import { RESPRAY_COLORS } from '@/game/paint'

export type { GarageVehicleSnapshot } from '@/game/types'
export { RESPRAY_COLORS } from '@/game/paint'

export type GarageAction = 'buy' | 'store' | 'openPanel' | 'noop'

/** One bay as the garage panel sees it. */
export interface GarageBay {
  index: number
  unlocked: boolean
  car: GarageVehicleSnapshot | null
}

export interface GaragePrompt {
  /** True once the $300 lockup network is owned. */
  owned: boolean
  /** Cars parked across unlocked bays (for the pill suffix / chip). */
  carsInside: number
  /** Unlocked bays / total bays. */
  baysUnlocked: number
  baysTotal: number
  /** What a single E press would do right now. */
  action: GarageAction
  /** The car the player is sitting in (null on foot). */
  currentVehicle: { id: string; name: string } | null
  /** Pad position (map layers). */
  position: Vec3
  /** Buy price while unowned, 0 once owned. */
  price: number
}

/** Respray palette offered in the garage panel (see paint.ts). */
const GARAGE_PRICE = 300
export const GARAGE_EXPAND_PRICE = 450
export const RESPRAY_PRICE = 25
export const MAX_BAYS = 3
const GARAGE_COLOR = 0xa3e635
/** Driving reach is car-sized like the spray bay. */
const REACH_M = 6.5
const HINT_M = 26
const RING_INNER = 2.6
const RING_OUTER = 3.4
/** Panel auto-closes past this (hysteresis over REACH_M). */
const PANEL_LEASH_M = REACH_M + 4

const RING_GEO = new THREE.RingGeometry(RING_INNER, RING_OUTER, 40, 1)
const ICON_TEX = { locked: null as THREE.Texture | null, car: null as THREE.Texture | null }
/** Unique spawn ids — two cars can be out at once (bays!) so the
 *  round-8 constant 'garage_car' id now collides. */
let garageSpawnCounter = 0

export class GarageSystem implements EngineSystem {
  private engine: GameEngine | null = null
  private owned = false
  private slots: (GarageVehicleSnapshot | null)[] = [null, null, null]
  private baysUnlocked = 1
  private panelOpen = false
  private pad: {
    group: THREE.Group
    ringMat: THREE.MeshBasicMaterial
    iconMat: THREE.SpriteMaterial
  } | null = null
  private padPos: Vec3 = { x: 0, y: 0, z: 0 }
  private time = 0
  private seen = false

  // =================================================================
  // EngineSystem hooks
  // =================================================================

  init(engine: GameEngine): void {
    this.engine = engine
    this.rebuild()
    engine.onEvent((evt) => {
      if (evt.type === 'levelLoaded') {
        this.rebuild()
        // The stored snapshots survive the swap; the physical cars do
        // not (loadLevel clears all vehicles) — nothing to respawn,
        // they are "inside the lockup".
      }
      if (evt.type === 'playerWasted' || evt.type === 'playerBusted') {
        this.closePanel()
      }
    })
  }

  update(dt: number): void {
    const engine = this.engine
    if (!engine || !this.pad) return
    this.time += dt
    const pulse = 0.55 + 0.35 * (0.5 + 0.5 * Math.sin(this.time * 2.2))
    this.pad.ringMat.opacity = pulse
    this.pad.iconMat.opacity = 0.85 + 0.15 * Math.sin(this.time * 1.6)
    this.pad.group.rotation.y += dt * 0.35
    const p = engine.player.position
    const d = Math.hypot(p.x - this.padPos.x, p.z - this.padPos.z)
    if (!this.seen && d < HINT_M) {
      this.seen = true
      engine.notify(
        this.owned
          ? `Your lockup — E to manage your bays (${this.carsInside()}/${this.baysUnlocked} used)`
          : `Garage lockup for sale — E to buy ($${GARAGE_PRICE})`,
        'info',
      )
    }
    // Panel leash: wander off and it closes itself.
    if (this.panelOpen && d > PANEL_LEASH_M) this.closePanel()
  }

  dispose(): void {
    this.clearPad()
    this.engine = null
  }

  /** E-key interaction at the pad (proximity checked here). */
  onAction(action: { type: string } | 'interact'): void {
    if (action !== 'interact') return
    const engine = this.engine
    if (!engine || engine.player.dead) return
    const p = engine.player.position
    if (Math.hypot(p.x - this.padPos.x, p.z - this.padPos.z) > REACH_M) return
    this.interact()
  }

  getSaveData(): SystemSaveFragment {
    return {
      garageOwned: this.owned,
      garageVehicle: this.slots[0] ? { ...this.slots[0] } : null,
      garageBays: this.baysUnlocked,
      garageSlotsData: this.slots.map((s) => (s ? { ...s } : null)),
    }
  }

  applySaveData(data: SystemSaveFragment): void {
    this.owned = data.garageOwned === true
    const migrate = (v: unknown): GarageVehicleSnapshot | null => {
      const s = v as Partial<GarageVehicleSnapshot> | null | undefined
      if (!s || typeof s.vehicleDataId !== 'string' || typeof s.name !== 'string') return null
      return {
        vehicleDataId: s.vehicleDataId,
        name: s.name,
        health: Math.max(1, Math.round(s.health ?? 100)),
        maxHealth: Math.max(1, Math.round(s.maxHealth ?? 100)),
        paintColor: typeof s.paintColor === 'number' ? s.paintColor : null,
      }
    }
    this.slots = [null, null, null]
    const arr = data.garageSlotsData as unknown[] | undefined
    if (Array.isArray(arr)) {
      for (let i = 0; i < Math.min(MAX_BAYS, arr.length); i++) {
        this.slots[i] = migrate(arr[i])
      }
    }
    // Round-8 legacy save: the single car lands in bay 0.
    if (!this.slots.some(Boolean)) {
      const legacy = migrate(data.garageVehicle)
      if (legacy) this.slots[0] = legacy
    }
    this.baysUnlocked = Math.max(1, Math.min(MAX_BAYS, Math.round(Number(data.garageBays) || 1)))
    this.refreshIcon()
  }

  // =================================================================
  // Public queries (HUD pill, panel, maps, debug bar)
  // =================================================================

  /** Map-layer point (kind-tagged so drawServiceBlip can render it). */
  getMapPoint(): { kind: 'garage'; position: Vec3 } | null {
    if (!this.engine) return null
    return { kind: 'garage', position: { x: this.padPos.x, y: 0, z: this.padPos.z } }
  }

  /** Everything the HUD pill needs, including the resolved E action. */
  getPrompt(): GaragePrompt | null {
    const engine = this.engine
    if (!engine) return null
    const p = engine.player.position
    if (Math.hypot(p.x - this.padPos.x, p.z - this.padPos.z) > REACH_M) return null
    const vid = engine.vehicles.playerVehicleId
    const veh = vid ? engine.vehicles.getById(vid) : null
    const currentVehicle = veh && !veh.destroyed ? { id: veh.id, name: veh.data.name } : null
    const free = this.firstFreeBay()
    let action: GarageAction
    if (!this.owned) action = 'buy'
    else if (currentVehicle && free !== -1) action = 'store'
    else action = 'openPanel'
    return {
      owned: this.owned,
      carsInside: this.carsInside(),
      baysUnlocked: this.baysUnlocked,
      baysTotal: MAX_BAYS,
      action,
      currentVehicle,
      position: { x: this.padPos.x, y: 0, z: this.padPos.z },
      price: GARAGE_PRICE,
    }
  }

  /** Ownership + bay occupancy for the HUD chip (any distance). */
  getStatus(): {
    owned: boolean
    stored: GarageVehicleSnapshot | null
    carsInside: number
    baysUnlocked: number
  } {
    return {
      owned: this.owned,
      stored: this.slots[0] ? { ...this.slots[0] } : null,
      carsInside: this.carsInside(),
      baysUnlocked: this.baysUnlocked,
    }
  }

  /** All bays for the garage panel. */
  getBays(): GarageBay[] {
    return this.slots.map((car, index) => ({
      index,
      unlocked: index < this.baysUnlocked,
      car: car ? { ...car } : null,
    }))
  }

  /** True while the bay-management overlay is up. */
  get panelIsOpen(): boolean {
    return this.panelOpen
  }

  /** UI hook: the React panel closed itself (close button / E / Esc). */
  onUiClosed(): void {
    this.closePanel()
  }

  /** Panel: take the car in `bayIndex` out (swap when driving). */
  takeOut(bayIndex: number): boolean {
    const engine = this.engine
    if (!engine || !this.owned) return false
    if (bayIndex < 0 || bayIndex >= this.baysUnlocked) return false
    const car = this.slots[bayIndex]
    if (!car) return false

    const vid = engine.vehicles.playerVehicleId
    const veh = vid ? engine.vehicles.getById(vid) : null
    if (veh && !veh.destroyed) {
      // SWAP: store the current ride into this bay, pull the stored
      // one out — the classic one-press garage swap.
      this.slots[bayIndex] = this.snapshotOf(veh)
      const storedName = veh.data.name
      engine.enterOrExitVehicle()
      engine.vehicles.removeVehicle(veh.id)
      this.spawnStored(car)
      this.playSound('pickup')
      engine.notify(`Swapped — ${storedName} in bay ${bayIndex + 1}, ${car.name} is out front`, 'success')
      return true
    }

    this.slots[bayIndex] = null
    this.spawnStored(car)
    this.playSound('pickup')
    engine.notify(`${car.name} is out front — F to get in`, 'success')
    return true
  }

  /** Panel: respray the car parked in `bayIndex` ($25, cosmetic only). */
  respray(bayIndex: number, hex: number | null): boolean {
    const engine = this.engine
    if (!engine || !this.owned) return false
    const car = this.slots[bayIndex]
    if (!car) return false
    if (car.paintColor === hex) return false
    if (hex != null && engine.player.money < RESPRAY_PRICE) {
      engine.notify(`Respray is $${RESPRAY_PRICE} — not enough cash`, 'warning')
      this.playSound('ui_click')
      return false
    }
    if (hex != null) engine.player.addMoney(-RESPRAY_PRICE)
    car.paintColor = hex
    this.playSound('pickup')
    engine.notify(
      hex == null
        ? `${car.name} back to factory paint (free)`
        : `${car.name} resprayed ${RESPRAY_COLORS.find((c) => c.hex === hex)?.name ?? 'custom'} — $${RESPRAY_PRICE}`,
      'success',
    )
    return true
  }

  /** Panel: unlock the remaining bays ($450, once). */
  expand(): boolean {
    const engine = this.engine
    if (!engine || !this.owned || this.baysUnlocked >= MAX_BAYS) return false
    if (engine.player.money < GARAGE_EXPAND_PRICE) {
      engine.notify(`The unit next door is $${GARAGE_EXPAND_PRICE} — not enough cash`, 'warning')
      this.playSound('ui_click')
      return false
    }
    engine.player.addMoney(-GARAGE_EXPAND_PRICE)
    this.baysUnlocked = MAX_BAYS
    this.playSound('pickup')
    engine.notify('Industrial unit annexed — all 3 bays are yours, in every district', 'success')
    return true
  }

  /** Debug: teleport to the pad. */
  debugTeleport(): boolean {
    const engine = this.engine
    if (!engine) return false
    engine.teleportPlayer({ x: this.padPos.x, y: 0, z: this.padPos.z })
    return true
  }

  /** Debug: grant ownership + all bays without paying. */
  debugGiveOwnership(): boolean {
    if (this.owned && this.baysUnlocked >= MAX_BAYS) return false
    this.owned = true
    this.baysUnlocked = MAX_BAYS
    this.refreshIcon()
    return true
  }

  /** Debug: park a fresh (undamaged) car into the first free bay. */
  debugFillBay(): boolean {
    const engine = this.engine
    if (!engine || !this.owned) return false
    const bay = this.firstFreeBay()
    if (bay === -1) return false
    const data = engine.content.vehicles[bay % Math.max(1, engine.content.vehicles.length)]
    if (!data) return false
    this.slots[bay] = {
      vehicleDataId: data.id,
      name: data.name,
      health: data.durability,
      maxHealth: data.durability,
      paintColor: null,
    }
    return true
  }

  // =================================================================
  // Interaction state machine
  // =================================================================

  private interact(): void {
    const engine = this.engine!
    if (!this.owned) {
      if (engine.player.money < GARAGE_PRICE) {
        engine.notify(`Not enough cash — the lockup is $${GARAGE_PRICE}`, 'warning')
        this.playSound('ui_click')
        return
      }
      engine.player.addMoney(-GARAGE_PRICE)
      this.owned = true
      this.refreshIcon()
      this.playSound('pickup')
      engine.notify('Lockup bought — your key works at every garage in the city', 'success')
      return
    }

    const vid = engine.vehicles.playerVehicleId
    const veh = vid ? engine.vehicles.getById(vid) : null
    const driving = !!veh && !veh.destroyed

    if (driving && veh) {
      const bay = this.firstFreeBay()
      if (bay !== -1) {
        // STORE: snapshot the current ride, pop the player out at the
        // door, despawn it. Bays make this always instant while any
        // slot is free.
        this.slots[bay] = this.snapshotOf(veh)
        const storedName = veh.data.name
        engine.enterOrExitVehicle()
        engine.vehicles.removeVehicle(veh.id)
        this.playSound('pickup')
        engine.notify(
          `${storedName} locked up in bay ${bay + 1} — it travels with you between districts`,
          'success',
        )
        return
      }
      // Every bay full → open the panel so the player picks a swap.
      this.openPanel()
      return
    }

    // On foot → the bay management panel (take out / respray / expand).
    this.openPanel()
  }

  private snapshotOf(veh: {
    data: { id: string; name: string; durability: number }
    health: number
    paintColor: number | null
  }): GarageVehicleSnapshot {
    return {
      vehicleDataId: veh.data.id,
      name: veh.data.name,
      health: Math.max(1, Math.round(veh.health)),
      maxHealth: veh.data.durability,
      paintColor: veh.paintColor,
    }
  }

  private openPanel(): void {
    if (this.panelOpen) return
    this.panelOpen = true
    this.engine?.emitEvent({ type: 'garagePanel', open: true })
    this.playSound('ui_click')
  }

  private closePanel(): void {
    if (!this.panelOpen) return
    this.panelOpen = false
    this.engine?.emitEvent({ type: 'garagePanel', open: false })
  }

  /** Spawn the snapshot car beside the pad with its stored paint. */
  private spawnStored(car: GarageVehicleSnapshot): void {
    const engine = this.engine
    if (!engine) return
    const data = engine.content.vehicles.find((v) => v.id === car.vehicleDataId)
    if (!data) {
      engine.notify(`Garage: "${car.name}" is not registered in this city — sorry`, 'warning')
      return
    }
    // Spawn close enough that F-enter works right away (enter range is
    // 4 m; spawnVehicle's findFreeSpot may nudge a little further).
    // Round-10 fix: UNIQUE id per spawn — bays can put several garage
    // cars on the street at once and a shared forceId broke
    // getById/removeVehicle (wrong car matched).
    const pos = new THREE.Vector3(this.padPos.x + 2.5, 0, this.padPos.z)
    const v = engine.vehicles.spawnVehicle(
      data,
      pos,
      Math.PI / 2,
      false,
      `garage_car_${++garageSpawnCounter}`,
    )
    v.health = Math.min(car.health, data.durability)
    v.destroyed = false
    v.applyPaint(car.paintColor ?? null)
  }

  private firstFreeBay(): number {
    for (let i = 0; i < this.baysUnlocked; i++) if (!this.slots[i]) return i
    return -1
  }

  private carsInside(): number {
    let n = 0
    for (let i = 0; i < this.baysUnlocked; i++) if (this.slots[i]) n++
    return n
  }

  private playSound(name: string): void {
    interface AudioLike {
      play?: (n: string, opts?: { volume?: number }) => void
    }
    const audio = this.engine?.systems.audio as unknown as AudioLike | undefined
    audio?.play?.(name, { volume: 0.7 })
  }

  // =================================================================
  // Pad seeding + visuals
  // =================================================================

  private rebuild(): void {
    const engine = this.engine
    if (!engine) return
    this.clearPad()
    const level = engine.level
    const buildings = level.buildings

    // Prefer a dedicated parking/garage building; the spray bay already
    // claims gas stations & warehouses, so only overlap on true garages.
    const byType = (pred: (t: string, name: string) => boolean): BuildingData | undefined =>
      buildings.find((b) => pred(b.type.toLowerCase(), b.name.toLowerCase()))
    const garage = byType((t, n) => t.includes('parking') || t.includes('garage') || n.includes('garage'))

    const sp = level.spawnPoint
    let pos: Vec3
    if (garage) {
      pos = {
        x: garage.position.x,
        y: 0,
        z: garage.position.z - garage.size.z / 2 - 6,
      }
    } else {
      // Road block WEST of the spawn intersection (spray is EAST).
      pos = { x: sp.x - 100, y: 0, z: sp.z }
    }
    pos = this.nudgeOutOfWalls(pos, 4.5)
    this.padPos = pos
    this.seen = false
    this.buildPad()
  }

  /** Nudge the pad out of building colliders (expanding spiral). */
  private nudgeOutOfWalls(spot: Vec3, radius: number): Vec3 {
    const engine = this.engine!
    const candidates: [number, number][] = []
    for (let ring = 0; ring <= 6; ring++) {
      const off = ring === 0 ? 0 : ring * 8
      if (ring === 0) {
        candidates.push([0, 0])
        continue
      }
      candidates.push([0, -off], [off, 0], [0, off], [-off, 0])
      if (ring >= 2) {
        const d = off * 0.707
        candidates.push([d, -d], [d, d], [-d, d], [-d, -d])
      }
    }
    for (const [dx, dz] of candidates) {
      const test = { x: spot.x + dx, y: 0, z: spot.z + dz }
      test.x = THREE.MathUtils.clamp(test.x, 12, engine.level.sizeX - 12)
      test.z = THREE.MathUtils.clamp(test.z, 12, engine.level.sizeZ - 12)
      const res = engine.physics.collideCircle({ x: test.x, y: 0, z: test.z }, radius, 2, false)
      if (res.hit) continue
      // Keep clear of the service pads (12 m, CityServices convention).
      const services = (
        engine.systems.services as { getServices?: () => { position: Vec3 }[] } | undefined
      )?.getServices?.() ?? []
      if (services.some((s) => Math.hypot(s.position.x - test.x, s.position.z - test.z) < 12)) continue
      return test
    }
    return spot
  }

  private buildPad(): void {
    const engine = this.engine!
    const group = new THREE.Group()
    group.position.set(this.padPos.x, 0, this.padPos.z)

    const ringMat = new THREE.MeshBasicMaterial({
      color: GARAGE_COLOR,
      transparent: true,
      opacity: 0.6,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
    const ring = new THREE.Mesh(RING_GEO, ringMat)
    ring.rotation.x = -Math.PI / 2
    ring.position.y = 0.06
    group.add(ring)

    const discMat = new THREE.MeshBasicMaterial({
      color: GARAGE_COLOR,
      transparent: true,
      opacity: 0.16,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
    const disc = new THREE.Mesh(new THREE.CircleGeometry(RING_INNER - 0.15, 32), discMat)
    disc.rotation.x = -Math.PI / 2
    disc.position.y = 0.05
    group.add(disc)
    // discMat is static — dispose together with the group via traversal.
    group.userData.discMat = discMat

    const iconMat = new THREE.SpriteMaterial({
      map: garageIconTexture(this.owned ? 'car' : 'locked'),
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    })
    const icon = new THREE.Sprite(iconMat)
    icon.scale.set(2.2, 2.2, 1)
    icon.position.y = 4.2
    group.add(icon)

    engine.scene.add(group)
    this.pad = { group, ringMat, iconMat }
  }

  /** Padlock → car when ownership flips (no rebuild needed). */
  private refreshIcon(): void {
    if (this.pad) this.pad.iconMat.map = garageIconTexture(this.owned ? 'car' : 'locked')
  }

  private clearPad(): void {
    const engine = this.engine
    if (this.pad) {
      engine?.scene.remove(this.pad.group)
      this.pad.ringMat.dispose()
      this.pad.iconMat.dispose()
      const discMat = this.pad.group.userData.discMat as THREE.MeshBasicMaterial | undefined
      discMat?.dispose()
      this.pad = null
    }
  }
}

// ---------------------------------------------------------------------
// Icon sprites (canvas-drawn — padlock while unowned, car once yours)
// ---------------------------------------------------------------------

function garageIconTexture(kind: 'locked' | 'car'): THREE.Texture {
  const cached = kind === 'locked' ? ICON_TEX.locked : ICON_TEX.car
  if (cached) return cached
  const S = 128
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = S
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, S, S)

  // Badge frame (matches the service icons).
  ctx.beginPath()
  ctx.roundRect(10, 10, S - 20, S - 20, 22)
  ctx.fillStyle = 'rgba(24,24,27,0.85)'
  ctx.fill()
  ctx.lineWidth = 6
  ctx.strokeStyle = '#a3e635'
  ctx.stroke()

  if (kind === 'locked') {
    // Padlock: shackle + body + keyhole.
    ctx.strokeStyle = '#d9f99d'
    ctx.lineWidth = 9
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.arc(64, 56, 16, Math.PI, 0)
    ctx.stroke()
    ctx.fillStyle = '#a3e635'
    ctx.beginPath()
    ctx.roundRect(38, 56, 52, 40, 8)
    ctx.fill()
    ctx.fillStyle = '#365314'
    ctx.beginPath()
    ctx.arc(64, 74, 6, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillRect(61, 74, 6, 12)
  } else {
    // Side-view car: cabin + body + wheels.
    ctx.fillStyle = '#d9f99d'
    ctx.beginPath()
    ctx.moveTo(26, 78)
    ctx.lineTo(26, 66)
    ctx.quadraticCurveTo(30, 62, 40, 60)
    ctx.lineTo(50, 48)
    ctx.quadraticCurveTo(52, 46, 58, 46)
    ctx.lineTo(78, 46)
    ctx.quadraticCurveTo(84, 46, 86, 52)
    ctx.lineTo(92, 60)
    ctx.quadraticCurveTo(102, 62, 102, 70)
    ctx.lineTo(102, 78)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = '#365314'
    ctx.beginPath()
    ctx.arc(44, 80, 9, 0, Math.PI * 2)
    ctx.arc(84, 80, 9, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#a3e635'
    ctx.beginPath()
    ctx.arc(44, 80, 4, 0, Math.PI * 2)
    ctx.arc(84, 80, 4, 0, Math.PI * 2)
    ctx.fill()
  }

  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  if (kind === 'locked') ICON_TEX.locked = tex
  else ICON_TEX.car = tex
  return tex
}
