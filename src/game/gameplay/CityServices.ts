/**
 * CityServices — THE economy gap fix: money had NO sinks (missions paid
 * out, BUSTED fined you — nothing to BUY). This system seeds three
 * classic-GTA money sinks per level and wires them to the E-key
 * interaction flow already used by missions:
 *
 *   - CLINIC ($50, hospital building)  → full health.
 *   - AMMO SHOP ($40, gun shop)        → every owned weapon's reserve
 *                                        topped to max.
 *   - PAY'N'SPRAY ($100, gas station /
 *     parking / warehouse — vehicle required) → vehicle fully repaired
 *     + wanted level cleared (20 s cooldown so you can't spam the
 *     respray between two cruisers boxing you in).
 *
 * Service spots are derived from the level's AUTHORED buildings when
 * present (hospital / shop / gas_station / parking / warehouse), with
 * deterministic spawn-point fallbacks nudged out of walls — every level
 * gets all three services.
 *
 * Markers are a distinct visual language vs mission cylinders: a flat
 * pulsing ground ring + a floating billboard icon sprite (canvas-drawn
 * cross / bullets / spray can), colored per service (clinic rose, ammo
 * amber, spray teal) and echoed on the minimap, big map and HUD prompt.
 */
import * as THREE from 'three'
import type { EngineSystem, GameEngine } from '@/game/engine'
import type { BuildingData, Vec3, WeaponId } from '@/game/types'
import type { WeaponShopEntry } from '@/game/gameplay/WeaponSystem'

export type ServiceKind = 'clinic' | 'ammo' | 'spray'

export interface ServicePointInfo {
  kind: ServiceKind
  name: string
  price: number
  /** Interaction spot on the pavement / drive-in bay. */
  position: Vec3
  /** Pay'n'Spray needs the player IN a vehicle. */
  requiresVehicle: boolean
}

export interface ServicePrompt extends ServicePointInfo {
  /** Player currently in a vehicle (for the spray prompt copy). */
  inVehicle: boolean
  /** Cooldown seconds remaining (spray only), 0 when ready. */
  cooldownSec: number
  /** False when a purchase precondition fails (full health, etc.) */
  wouldDoSomething: boolean
}

/** Round 9: armed purchase awaiting a second E press (confirm sheet). */
export interface ServiceConfirm {
  kind: ServiceKind
  name: string
  price: number
  /** One-line effect description for the confirm card. */
  effect: string
  /** Seconds until the confirm auto-cancels (counts down live). */
  expiresInSeconds: number
}

interface ServicePoint extends ServicePointInfo {
  group: THREE.Group
  ringMat: THREE.MeshBasicMaterial
  iconMat: THREE.SpriteMaterial
  seen: boolean
}

const KIND_META: Record<
  ServiceKind,
  { name: string; price: number; color: number; requiresVehicle: boolean }
> = {
  clinic: { name: 'Street Clinic', price: 50, color: 0xf87171, requiresVehicle: false },
  ammo: { name: 'Gun Shop', price: 40, color: 0xfbbf24, requiresVehicle: false },
  spray: { name: "Pay'n'Spray", price: 100, color: 0x2dd4bf, requiresVehicle: true },
}

/** On-foot reach for clinic/ammo; the spray bay is car-sized. */
const REACH_M: Record<ServiceKind, number> = { clinic: 3.5, ammo: 3.5, spray: 6.5 }
/** One-time "service spotted" toast radius. */
const HINT_M = 26
const SPRAY_COOLDOWN_SEC = 20
/** Round 9: how long an armed purchase waits for the second E. */
const CONFIRM_WINDOW_SEC = 8
/** Round 10: shop-sheet walk-away leash (hysteresis over REACH_M). */
const SHOP_LEASH_M = REACH_M.ammo + 4
/** Ring pulse parameters. */
const RING_INNER = 2.6
const RING_OUTER = 3.4

const RING_GEO = new THREE.RingGeometry(RING_INNER, RING_OUTER, 40, 1)
const ICON_TEX = new Map<ServiceKind, THREE.Texture>()

export class CityServices implements EngineSystem {
  private engine: GameEngine | null = null
  private points: ServicePoint[] = []
  private time = 0
  private sprayCooldown = 0
  /** Round 9: armed purchase (awaiting the confirming E press). */
  private pendingConfirm: ServicePrompt | null = null
  private confirmExpiresAt = 0
  /** Round 10: gun-shop sheet is up (opened with E at the ammo pad). */
  private shopOpen = false

  // =================================================================
  // EngineSystem hooks
  // =================================================================

  init(engine: GameEngine): void {
    this.engine = engine
    this.rebuild()
    engine.onEvent((evt) => {
      if (evt.type === 'levelLoaded') this.rebuild()
      if (evt.type === 'playerWasted' || evt.type === 'playerBusted') this.closeShop()
    })
  }

  update(dt: number): void {
    const engine = this.engine
    if (!engine) return
    this.time += dt
    if (this.sprayCooldown > 0) this.sprayCooldown = Math.max(0, this.sprayCooldown - dt)

    const p = engine.player.position
    for (const s of this.points) {
      // Ground-ring pulse + slow icon bob — services breathe quietly.
      const pulse = 0.55 + 0.35 * (0.5 + 0.5 * Math.sin(this.time * 2.2))
      s.ringMat.opacity = pulse
      s.iconMat.opacity = 0.85 + 0.15 * Math.sin(this.time * 1.6)
      s.group.rotation.y += dt * 0.35
      const d = Math.hypot(p.x - s.position.x, p.z - s.position.z)
      if (!s.seen && d < HINT_M) {
        s.seen = true
        const verb = s.requiresVehicle ? 'drive in' : 'press E'
        engine.notify(
          `${s.name} — ${verb}${s.requiresVehicle ? ' with a car' : ''} for $${s.price}`,
          'info',
        )
      }
    }

    // Round 9: the armed purchase expires or cancels with distance —
    // walking away never spends money.
    if (this.pendingConfirm) {
      const still = this.getNearbyService()
      if (this.time >= this.confirmExpiresAt || still?.kind !== this.pendingConfirm.kind) {
        this.pendingConfirm = null
      }
    }
    // Round 10: shop leash — wander off the counter and the sheet closes.
    if (this.shopOpen) {
      const ammoPoint = this.points.find((p) => p.kind === 'ammo')
      const d = ammoPoint
        ? Math.hypot(p.x - ammoPoint.position.x, p.z - ammoPoint.position.z)
        : Infinity
      if (d > SHOP_LEASH_M) this.closeShop()
    }
  }

  dispose(): void {
    this.clear()
    this.engine = null
  }

  /** E-key purchase at the nearest in-range service (no-op elsewhere). */
  onAction(action: { type: string } | 'interact'): void {
    if (action !== 'interact') return
    const engine = this.engine
    if (!engine || engine.player.dead) return
    const prompt = this.getNearbyService()
    if (!prompt) return

    // Round 10: the gun shop is a browsable counter — E opens the shop
    // sheet (weapon purchases + the $40 ammo top-up) instead of the
    // single-purpose confirm card.
    if (prompt.kind === 'ammo') {
      this.pendingConfirm = null
      this.openShop()
      return
    }

    // Round 9 two-step flow: the first E ARMS the purchase (confirm
    // sheet on the HUD), the second E within the window CONFIRMS it.
    if (this.pendingConfirm?.kind === prompt.kind && this.time < this.confirmExpiresAt) {
      this.pendingConfirm = null
      this.purchase(prompt)
      return
    }
    if (!this.canPurchaseNow(prompt)) return // rejected paths toast above
    this.pendingConfirm = prompt
    this.confirmExpiresAt = this.time + CONFIRM_WINDOW_SEC
    this.playSound('ui_click')
  }

  /** The armed purchase for the HUD confirm card (null when none). */
  getConfirm(): ServiceConfirm | null {
    if (!this.pendingConfirm || this.time >= this.confirmExpiresAt) return null
    const kind = this.pendingConfirm.kind
    return {
      kind,
      name: this.pendingConfirm.name,
      price: this.pendingConfirm.price,
      effect:
        kind === 'clinic'
          ? 'Full health'
          : kind === 'ammo'
            ? 'Every owned weapon topped to max reserve'
            : 'Full vehicle repair + wanted level cleared',
      expiresInSeconds: Math.max(0, this.confirmExpiresAt - this.time),
    }
  }

  // =================================================================
  // Public queries (HUD prompt, minimap, big map, debug bar)
  // =================================================================

  /** Static service listing for map layers. */
  getServices(): ServicePointInfo[] {
    return this.points.map(({ kind, name, price, position, requiresVehicle }) => ({
      kind,
      name,
      price,
      position: { x: position.x, y: 0, z: position.z },
      requiresVehicle,
    }))
  }

  /** The service the player can currently use (or is standing at), if any. */
  getNearbyService(): ServicePrompt | null {
    const engine = this.engine
    if (!engine) return null
    const p = engine.player.position
    const inVehicle = engine.vehicles.playerVehicleId !== null
    let best: ServicePoint | null = null
    let bestD = Infinity
    for (const s of this.points) {
      const reach = REACH_M[s.kind]
      const d = Math.hypot(p.x - s.position.x, p.z - s.position.z)
      if (d <= reach && d < bestD) {
        bestD = d
        best = s
      }
    }
    if (!best) return null
    const cooldownSec = best.kind === 'spray' ? this.sprayCooldown : 0
    return {
      kind: best.kind,
      name: best.name,
      price: best.price,
      position: { x: best.position.x, y: 0, z: best.position.z },
      requiresVehicle: best.requiresVehicle,
      inVehicle,
      cooldownSec,
      wouldDoSomething: this.wouldDoSomething(best, inVehicle),
    }
  }

  /** Debug: teleport the player (and exit any vehicle) to a service. */
  debugTeleport(kind: ServiceKind): boolean {
    const engine = this.engine
    const s = this.points.find((p) => p.kind === kind)
    if (!engine || !s) return false
    engine.teleportPlayer({ x: s.position.x, y: 0, z: s.position.z })
    return true
  }

  // =================================================================
  // Round 10: gun-shop counter (weapon purchases + ammo top-up)
  // =================================================================

  /** True while the shop sheet is up. */
  get shopIsOpen(): boolean {
    return this.shopOpen
  }

  /** UI hook: the React sheet closed itself (close button / E / Esc). */
  onUiClosed(): void {
    this.closeShop()
  }

  /** Catalog rows for the sheet (stats + price + owned flag). */
  getShopStock(): WeaponShopEntry[] {
    const weapons = this.engine?.systems.weapons as unknown as
      | { getShopEntries?: () => WeaponShopEntry[] }
      | undefined
    return weapons?.getShopEntries?.() ?? []
  }

  /** The $40 ammo top-up as its own row (disabled when reserves full). */
  canTopUpAmmo(): boolean {
    const any = this.engine?.systems.weapons as unknown as
      | { anyReserveBelowMax?: () => boolean }
      | undefined
    return any?.anyReserveBelowMax?.() ?? false
  }

  /**
   * Sheet action: buy a firearm (full mag + reserve included). Money is
   * validated BEFORE addMoney — a rejected purchase never eats cash.
   */
  buyWeapon(id: WeaponId): boolean {
    const engine = this.engine
    if (!engine || !this.shopOpen || engine.player.dead) return false
    const entry = this.getShopStock().find((w) => w.id === id)
    if (!entry) return false
    if (entry.owned) {
      engine.notify(`You already own the ${entry.name}`, 'info')
      return false
    }
    if (engine.player.money < entry.price) {
      engine.notify(`The ${entry.name} is $${entry.price} — not enough cash`, 'warning')
      this.playSound('ui_click')
      return false
    }
    const weapons = engine.systems.weapons as unknown as
      | { giveWeapon?: (id: WeaponId) => void }
      | undefined
    if (!weapons?.giveWeapon) return false
    engine.player.addMoney(-entry.price)
    weapons.giveWeapon(id) // notifies "Acquired X" + fills mag/reserve
    this.playSound('pickup')
    return true
  }

  /** Sheet action: the $40 reserve top-up for every owned weapon. */
  buyAmmoTopup(): boolean {
    const engine = this.engine
    if (!engine || !this.shopOpen || engine.player.dead) return false
    const price = KIND_META.ammo.price
    if (!this.canTopUpAmmo()) {
      engine.notify('Reserves already full', 'info')
      return false
    }
    if (engine.player.money < price) {
      engine.notify(`Top-up is $${price} — not enough cash`, 'warning')
      this.playSound('ui_click')
      return false
    }
    engine.player.addMoney(-price)
    this.refillAmmo()
    this.playSound('pickup')
    engine.notify('Reserves topped up — $40 at the counter', 'success')
    return true
  }

  private openShop(): void {
    if (this.shopOpen) return
    this.shopOpen = true
    this.engine?.emitEvent({ type: 'gunShopPanel', open: true })
    this.playSound('ui_click')
  }

  private closeShop(): void {
    if (!this.shopOpen) return
    this.shopOpen = false
    this.engine?.emitEvent({ type: 'gunShopPanel', open: false })
  }

  // =================================================================
  // Purchases
  // =================================================================

  /**
   * Round 9: shared precondition gate — used when ARMING a purchase
   * (first E) and re-run at confirm time by purchase() itself. Every
   * rejection path keeps its original toast.
   */
  private canPurchaseNow(prompt: ServicePrompt): boolean {
    const engine = this.engine
    if (!engine) return false
    if (prompt.requiresVehicle && !prompt.inVehicle) {
      engine.notify("Pay'n'Spray is a drive-in — bring a vehicle", 'info')
      return false
    }
    if (prompt.cooldownSec > 0) {
      engine.notify(
        `Spray booth recharging — ${Math.ceil(prompt.cooldownSec)}s`,
        'info',
      )
      return false
    }
    // Round 10 exploit guard: no respray while a pursuing cruiser is
    // right on top of you — lose them first, THEN duck into the bay.
    if (prompt.kind === 'spray' && this.cruiserOnTopOfPlayer()) {
      engine.notify('Too hot — a cruiser is right on you. Lose them first', 'warning')
      this.playSound('ui_click')
      return false
    }
    if (!prompt.wouldDoSomething) {
      this.rejectNoop(prompt.kind)
      return false
    }
    if (engine.player.money < prompt.price) {
      engine.notify(`Not enough cash — need $${prompt.price}`, 'warning')
      this.playSound('ui_click')
      return false
    }
    return true
  }

  /** True when an actively pursuing police cruiser is within 16 m. */
  private cruiserOnTopOfPlayer(): boolean {
    const engine = this.engine
    if (!engine || engine.player.wantedLevel <= 0) return false
    const pursuit = engine.systems.pursuit as unknown as
      | { getPursuit?: () => { position: Vec3; speed: number }[] }
      | undefined
    const p = engine.player.position
    return (pursuit?.getPursuit?.() ?? []).some(
      (c) => Math.hypot(c.position.x - p.x, c.position.z - p.z) < 16,
    )
  }

  private purchase(prompt: ServicePrompt): void {
    const engine = this.engine
    if (!engine) return

    // Re-validate at confirm time (cooldown / health / wallet may have
    // changed since the sheet armed).
    if (!this.canPurchaseNow(prompt)) return
    // Affordability is checked BEFORE addMoney: a rejected purchase must
    // not eat the player's remaining cash (addMoney clamps at 0).
    engine.player.addMoney(-prompt.price)

    switch (prompt.kind) {
      case 'clinic': {
        engine.player.restore(100, 0)
        engine.notify('Patched up — full health for $50', 'success')
        break
      }
      case 'ammo': {
        this.refillAmmo()
        engine.notify('Reserves topped up — $40 at the counter', 'success')
        break
      }
      case 'spray': {
        const vid = engine.vehicles.playerVehicleId
        const v = vid ? engine.vehicles.getById(vid) : null
        if (v) {
          v.health = v.data.durability
          v.destroyed = false
        }
        const hadHeat = engine.player.wantedLevel > 0
        engine.setWantedLevel(0)
        this.sprayCooldown = SPRAY_COOLDOWN_SEC
        engine.notify(
          hadHeat
            ? "Respray done — car repaired, heat gone ($100)"
            : "Respray done — car looks factory-new ($100)",
          'success',
        )
        break
      }
    }
    this.playSound('pickup')
  }

  private refillAmmo(): void {
    const engine = this.engine
    if (!engine) return
    interface WeaponsAmmoApi {
      refillAllReserves?: () => void
    }
    const weapons = engine.systems.weapons as unknown as WeaponsAmmoApi | undefined
    if (weapons?.refillAllReserves) weapons.refillAllReserves()
  }

  private wouldDoSomething(s: ServicePoint, inVehicle: boolean): boolean {
    const engine = this.engine
    if (!engine) return false
    switch (s.kind) {
      case 'clinic':
        return engine.player.health < engine.player.maxHealth
      case 'ammo': {
        // Round 10: the shop is worth entering when reserves are low OR
        // there is a firearm left to buy (the sheet sells both).
        const any = engine.systems.weapons as unknown as
          | { anyReserveBelowMax?: () => boolean; getShopEntries?: () => { owned: boolean }[] }
          | undefined
        if (any?.anyReserveBelowMax?.()) return true
        return (any?.getShopEntries?.() ?? []).some((w) => !w.owned)
      }
      case 'spray': {
        if (!inVehicle) return false
        const vid = engine.vehicles.playerVehicleId
        const v = vid ? engine.vehicles.getById(vid) : null
        return !!v && (v.health < v.data.durability || engine.player.wantedLevel > 0)
      }
    }
  }

  private rejectNoop(kind: ServiceKind): void {
    const engine = this.engine
    if (!engine) return
    switch (kind) {
      case 'clinic':
        engine.notify("You're already patched up", 'info')
        break
      case 'ammo':
        engine.notify('Reserves already full', 'info')
        break
      case 'spray':
        engine.notify('Car is clean and the heat is cold — nothing to spray', 'info')
        break
    }
    this.playSound('ui_click')
  }

  private playSound(name: string): void {
    interface AudioLike {
      play?: (n: string, opts?: { volume?: number }) => void
    }
    const audio = this.engine?.systems.audio as unknown as AudioLike | undefined
    audio?.play?.(name, { volume: 0.7 })
  }

  // =================================================================
  // Level seeding — derive services from authored buildings
  // =================================================================

  private rebuild(): void {
    const engine = this.engine
    if (!engine) return
    this.clear()
    const level = engine.level
    const buildings = level.buildings

    const byType = (pred: (t: string, name: string) => boolean): BuildingData | undefined =>
      buildings.find((b) => pred(b.type.toLowerCase(), b.name.toLowerCase()))

    const hospital = byType((t, n) => t.includes('hospital') || n.includes('hospital') || n.includes('clinic'))
    const shop = byType((t, n) => t.includes('shop') || t.includes('gun') || n.includes('gun'))
    const garage = byType(
      (t, n) => t.includes('gas') || t.includes('parking') || t.includes('garage') || t.includes('warehouse') || n.includes('spray'),
    )

    const sp = level.spawnPoint
    this.addPoint('clinic', this.spotFor(hospital, { x: sp.x - 30, y: 0, z: sp.z - 30 }))
    this.addPoint('ammo', this.spotFor(shop, { x: sp.x + 30, y: 0, z: sp.z - 30 }))
    // Spray fallback: one road block EAST of the spawn intersection (all
    // four levels spawn on the 100 m road grid) — a drive-in bay on the
    // road line, well clear of spawn clutter and the other pads.
    this.addPoint('spray', this.spotFor(garage, { x: sp.x + 100, y: 0, z: sp.z }))
  }

  /** Interaction spot in front of an authored building (faces −Z), or the
   *  fallback nudged out of walls with expanding rings. */
  private spotFor(building: BuildingData | undefined, fallback: Vec3): Vec3 {
    const engine = this.engine!
    if (building) {
      const front: Vec3 = {
        x: building.position.x,
        y: 0,
        z: building.position.z - building.size.z / 2 - 6,
      }
      return this.nudgeOutOfWalls(front, 4)
    }
    return this.nudgeOutOfWalls(fallback, 5)
  }

  /** Nudge a spot out of building colliders (and away from already-placed
   *  service pads) using an expanding spiral of candidates. */
  private nudgeOutOfWalls(spot: Vec3, radius: number): Vec3 {
    const engine = this.engine!
    // Expanding spiral: dense near the target, wide coverage by ±48 m
    // (covers authored-building footprints like the 60 m hospital).
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
      const res = engine.physics.collideCircle(
        { x: test.x, y: 0, z: test.z },
        radius,
        2,
        false,
      )
      if (res.hit) continue
      // Keep service pads ≥ 12 m apart so rings never overlap.
      const near = this.points.some(
        (p) => Math.hypot(p.position.x - test.x, p.position.z - test.z) < 12,
      )
      if (near) continue
      return test
    }
    return spot
  }

  private addPoint(kind: ServiceKind, position: Vec3): void {
    const engine = this.engine!
    const meta = KIND_META[kind]
    const group = new THREE.Group()
    group.position.set(position.x, 0, position.z)

    // Flat pulsing ground ring (unlit → glows at night).
    const ringMat = new THREE.MeshBasicMaterial({
      color: meta.color,
      transparent: true,
      opacity: 0.6,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
    const ring = new THREE.Mesh(RING_GEO, ringMat)
    ring.rotation.x = -Math.PI / 2
    ring.position.y = 0.06
    group.add(ring)

    // Inner disc so the bay reads as a pad.
    const discMat = new THREE.MeshBasicMaterial({
      color: meta.color,
      transparent: true,
      opacity: 0.16,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
    const disc = new THREE.Mesh(new THREE.CircleGeometry(RING_INNER - 0.15, 32), discMat)
    disc.rotation.x = -Math.PI / 2
    disc.position.y = 0.05
    group.add(disc)

    // Floating billboard icon above the pad.
    const iconMat = new THREE.SpriteMaterial({
      map: serviceIconTexture(kind),
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    })
    const icon = new THREE.Sprite(iconMat)
    icon.scale.set(2.2, 2.2, 1)
    icon.position.y = 4.2
    group.add(icon)

    engine.scene.add(group)
    this.points.push({
      kind,
      name: meta.name,
      price: meta.price,
      position: { x: position.x, y: 0, z: position.z },
      requiresVehicle: meta.requiresVehicle,
      group,
      ringMat,
      iconMat,
      seen: false,
    })
  }

  private clear(): void {
    const engine = this.engine
    for (const s of this.points) {
      engine?.scene.remove(s.group)
      s.ringMat.dispose()
      s.iconMat.dispose()
    }
    this.points = []
    this.sprayCooldown = 0
  }
}

// ---------------------------------------------------------------------
// Icon sprites (canvas-drawn — cross / bullets / spray can)
// ---------------------------------------------------------------------

function serviceIconTexture(kind: ServiceKind): THREE.Texture {
  let tex = ICON_TEX.get(kind)
  if (tex) return tex
  const S = 128
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = S
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, S, S)

  const badge = (fill: string, stroke: string): void => {
    ctx.beginPath()
    ctx.roundRect(10, 10, S - 20, S - 20, 22)
    ctx.fillStyle = fill
    ctx.fill()
    ctx.lineWidth = 6
    ctx.strokeStyle = stroke
    ctx.stroke()
  }

  if (kind === 'clinic') {
    badge('rgba(24,24,27,0.85)', '#f87171')
    // white cross
    ctx.fillStyle = '#f4f4f5'
    ctx.fillRect(S / 2 - 9, 30, 18, 68)
    ctx.fillRect(30, S / 2 - 9, 68, 18)
  } else if (kind === 'ammo') {
    badge('rgba(24,24,27,0.85)', '#fbbf24')
    // three bullets
    for (let i = 0; i < 3; i++) {
      const cx = 36 + i * 28
      ctx.fillStyle = '#fde68a'
      ctx.beginPath()
      ctx.roundRect(cx - 7, 52, 14, 34, 6)
      ctx.fill()
      ctx.beginPath()
      ctx.moveTo(cx - 7, 52)
      ctx.quadraticCurveTo(cx, 30, cx + 7, 52)
      ctx.closePath()
      ctx.fillStyle = '#fbbf24'
      ctx.fill()
    }
  } else {
    badge('rgba(24,24,27,0.85)', '#2dd4bf')
    // spray can silhouette
    ctx.fillStyle = '#5eead4'
    ctx.beginPath()
    ctx.roundRect(44, 54, 40, 48, 7)
    ctx.fill()
    ctx.fillStyle = '#ccfbf1'
    ctx.beginPath()
    ctx.roundRect(44, 54, 40, 12, 5)
    ctx.fill()
    // nozzle + mist
    ctx.fillStyle = '#99f6e4'
    ctx.fillRect(60, 42, 8, 12)
    ctx.fillRect(72, 44, 12, 6)
    ctx.fillStyle = 'rgba(153,246,228,0.7)'
    ctx.beginPath()
    ctx.arc(92, 34, 4, 0, Math.PI * 2)
    ctx.arc(100, 42, 3, 0, Math.PI * 2)
    ctx.arc(90, 24, 2.5, 0, Math.PI * 2)
    ctx.fill()
  }

  tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  ICON_TEX.set(kind, tex)
  return tex
}
