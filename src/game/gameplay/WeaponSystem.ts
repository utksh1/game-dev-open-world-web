/**
 * WeaponSystem — fists / pistol / smg / rifle / shotgun with REAL
 * hitscan damage and REAL reload timing. THE gap fixes vs the original
 * C++ project (whose weapons were never even instantiated):
 *   - reload takes 1.8 s (interruptible by weapon switch), progress
 *     reported via WeaponState.reloadProgress (0..1) — the original
 *     "reload" was instant counter shuffling.
 *   - firing is a true hitscan: ray vs NPCManager.raycastNPCs AND
 *     PhysicsWorld.raycast (buildings + vehicles) — nearest hit wins,
 *     NPCs take damage via damageNPC, vehicles via applyDamage.
 *   - shotgun fires 6 pellets with spread; sustained fire grows spread
 *     (resets on stop); recoil kicks the camera via engine.addCameraRecoil.
 *
 * Registered as engine system 'weapons'. The engine forwards
 * {type:'select'|'cycle'|'fire'|'fireRelease'|'reload'} actions here
 * (keys 1-5 / Tab-cycle / R / LMB). Player starts owning fists +
 * pistol (mission_01's required weapon_pistol check passes).
 */
import * as THREE from 'three'
import type { EngineSystem, GameEngine, WeaponsAction } from '@/game/engine'
import type { InventoryItem, Vec3, WeaponId, WeaponState } from '@/game/types'
import type { SystemSaveFragment } from '@/game/engine'

interface WeaponDef {
  id: WeaponId
  name: string
  melee: boolean
  damage: number
  fireRate: number // ms between shots
  range: number
  magSize: number
  reserveMax: number
  auto: boolean
  pellets: number
  spread: number // radians base cone half-angle
  recoilPitch: number
  sound: string
}

const WEAPON_ORDER: WeaponId[] = ['fists', 'pistol', 'smg', 'rifle', 'shotgun']

const WEAPONS: Record<WeaponId, WeaponDef> = {
  fists: {
    id: 'fists', name: 'Fists', melee: true, damage: 15, fireRate: 450, range: 1.2,
    magSize: 0, reserveMax: 0, auto: false, pellets: 1, spread: 0, recoilPitch: 0.003, sound: 'melee',
  },
  pistol: {
    id: 'pistol', name: 'Pistol', melee: false, damage: 25, fireRate: 350, range: 60,
    magSize: 12, reserveMax: 60, auto: false, pellets: 1, spread: 0.004, recoilPitch: 0.012, sound: 'gunshot_pistol',
  },
  smg: {
    id: 'smg', name: 'SMG', melee: false, damage: 18, fireRate: 110, range: 45,
    magSize: 30, reserveMax: 120, auto: true, pellets: 1, spread: 0.011, recoilPitch: 0.007, sound: 'gunshot_smg',
  },
  rifle: {
    id: 'rifle', name: 'Rifle', melee: false, damage: 40, fireRate: 500, range: 120,
    magSize: 10, reserveMax: 40, auto: false, pellets: 1, spread: 0.002, recoilPitch: 0.028, sound: 'gunshot_rifle',
  },
  shotgun: {
    id: 'shotgun', name: 'Shotgun', melee: false, damage: 12, fireRate: 900, range: 25,
    magSize: 6, reserveMax: 24, auto: false, pellets: 6, spread: 0.045, recoilPitch: 0.045, sound: 'gunshot_shotgun',
  },
}

const RELOAD_SEC = 1.8
const MUZZLE_FLASH_SEC = 0.06
const TRACER_SEC = 0.08
const SUSTAINED_MAX = 8
const SUSTAINED_SPREAD = 0.006 // extra radians per sustained shot

// ---------------------------------------------------------------------
// Round 10: gun-shop catalog (prices / stats for the shop sheet UI)
// ---------------------------------------------------------------------

/** Shop rows as the GunShopPanel sees them. */
export interface WeaponShopEntry {
  id: WeaponId
  name: string
  price: number
  owned: boolean
  /** Damage per bullet/pellet. */
  damage: number
  /** damage × pellets (shotgun burst). */
  burstDamage: number
  /** Rounds per minute. */
  rpm: number
  magSize: number
  reserveMax: number
  auto: boolean
  pellets: number
  range: number
}

/** Street prices — tuned against mission payouts (bank heist $5k final). */
export const WEAPON_PRICES: Record<WeaponId, number> = {
  fists: 0,
  pistol: 250,
  smg: 450,
  rifle: 800,
  shotgun: 350,
}

/** Shop display order (fists are not for sale). */
const SHOP_ORDER: WeaponId[] = ['pistol', 'smg', 'shotgun', 'rifle']


interface AmmoState {
  mag: number
  reserve: number
}

interface NpcSystemLike {
  raycastNPCs?: (origin: Vec3, dir: Vec3, maxDist: number) => { npcId: string; distance: number; point: Vec3 } | null
  damageNPC?: (id: string, amount: number, byPlayer: boolean) => void
  getNPCs?: () => { id: string; position: Vec3; alive: boolean }[]
  notifyGunshot?: (position: Vec3) => void
  fleeAll?: (position: Vec3, radius: number) => void
}
interface AudioLike {
  play?: (name: string, opts?: { position?: Vec3; volume?: number }) => void
}
interface PickupLike {
  spawn?: (pos: Vec3, opts: { kind: 'ammo'; amount: number; weaponId: WeaponId; respawnSec?: number }) => string
}

export class WeaponSystem implements EngineSystem {
  private engine: GameEngine | null = null
  private owned = new Set<WeaponId>(['fists', 'pistol'])
  private current: WeaponId = 'pistol'
  private ammo: Record<WeaponId, AmmoState> = {
    fists: { mag: 0, reserve: 0 },
    pistol: { mag: 12, reserve: 60 },
    smg: { mag: 30, reserve: 120 },
    rifle: { mag: 10, reserve: 40 },
    shotgun: { mag: 6, reserve: 24 },
  }

  private fireTimer = 0
  private triggerReady = true // semi-auto: needs a release before next shot
  private reloading = false
  private reloadTimer = 0
  private sustained = 0

  // visuals
  private muzzleLights: THREE.PointLight[] = []
  private muzzleTimers: number[] = []
  private tracers: { line: THREE.Line; life: number }[] = []
  private tmpDir = new THREE.Vector3()
  private tmpOrigin = new THREE.Vector3()
  private tmpJitter = new THREE.Vector3()
  private cratesSpawned = false
  private time = 0

  // =================================================================
  // EngineSystem hooks
  // =================================================================

  init(engine: GameEngine): void {
    this.engine = engine
    const scene = engine.scene
    // Muzzle flash light pool.
    for (let i = 0; i < 3; i++) {
      const light = new THREE.PointLight(0xffd9a0, 0, 14, 2)
      light.visible = false
      scene.add(light)
      this.muzzleLights.push(light)
      this.muzzleTimers.push(0)
    }
    // Tracer line pool.
    const mat = new THREE.LineBasicMaterial({
      color: 0xffe8b0, transparent: true, opacity: 0.9, depthWrite: false,
    })
    for (let i = 0; i < 10; i++) {
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(), new THREE.Vector3(),
      ])
      const line = new THREE.Line(geo, mat.clone())
      line.visible = false
      line.frustumCulled = false
      scene.add(line)
      this.tracers.push({ line, life: 0 })
    }
  }

  update(dt: number): void {
    const engine = this.engine
    if (!engine) return
    this.time += dt
    this.fireTimer = Math.max(0, this.fireTimer - dt)

    // Reload timing (interruptible by switching — handled in select/cycle).
    if (this.reloading) {
      this.reloadTimer -= dt
      if (this.reloadTimer <= 0) this.finishReload()
    }

    // Sustained-fire spread recovery.
    this.sustained *= Math.exp(-2.5 * dt)

    // Muzzle flashes.
    for (let i = 0; i < this.muzzleLights.length; i++) {
      if (this.muzzleTimers[i] > 0) {
        this.muzzleTimers[i] -= dt
        if (this.muzzleTimers[i] <= 0) {
          this.muzzleLights[i].intensity = 0
          this.muzzleLights[i].visible = false
        }
      }
    }
    // Tracers.
    for (const t of this.tracers) {
      if (t.life > 0) {
        t.life -= dt
        const mat = t.line.material as THREE.LineBasicMaterial
        mat.opacity = Math.max(0, t.life / TRACER_SEC) * 0.9
        if (t.life <= 0) t.line.visible = false
      }
    }

    // One-time ammo crates near gun shops.
    if (!this.cratesSpawned) {
      this.cratesSpawned = true
      this.spawnAmmoCrates()
    }
  }

  dispose(): void {
    const engine = this.engine
    if (!engine) return
    for (const l of this.muzzleLights) engine.scene.remove(l)
    this.muzzleLights = []
    for (const t of this.tracers) {
      engine.scene.remove(t.line)
      ;(t.line.material as THREE.Material).dispose()
      t.line.geometry.dispose()
    }
    this.tracers = []
    this.engine = null
  }

  onAction(action: WeaponsAction): void {
    switch (action.type) {
      case 'select': {
        const id = WEAPON_ORDER[action.slot - 1]
        if (id) this.selectWeapon(id)
        break
      }
      case 'cycle':
        this.cycleWeapon(action.dir)
        break
      case 'fire':
        this.attemptFire()
        break
      case 'fireRelease':
        this.triggerReady = true
        break
      case 'reload':
        this.startReload()
        break
    }
  }

  // =================================================================
  // HUD / save hooks
  // =================================================================

  getHudWeapon(): WeaponState | null {
    const def = WEAPONS[this.current]
    const ammo = this.ammo[this.current]
    return {
      id: def.id,
      name: def.name,
      ammo: ammo.mag,
      magazineSize: def.magSize,
      reserveAmmo: ammo.reserve,
      reloading: this.reloading,
      reloadProgress: this.reloading ? 1 - this.reloadTimer / RELOAD_SEC : 0,
      damage: def.damage,
      fireRate: def.fireRate,
      range: def.range,
      auto: def.auto,
    }
  }

  getWeaponsOwned(): WeaponId[] {
    return WEAPON_ORDER.filter((id) => this.owned.has(id))
  }

  /**
   * Round 10: the gun-shop catalog — every firearm with stats + price +
   * live owned flag. Missions gate on weapons (gang war needs an SMG,
   * showdowns need a shotgun) and this is the legitimate in-game way to
   * acquire them (the debug give-all stays as a QA shortcut).
   */
  getShopEntries(): WeaponShopEntry[] {
    return SHOP_ORDER.map((id) => {
      const def = WEAPONS[id]
      return {
        id,
        name: def.name,
        price: WEAPON_PRICES[id],
        owned: this.owned.has(id),
        damage: def.damage,
        burstDamage: def.damage * def.pellets,
        rpm: Math.round(60000 / def.fireRate),
        magSize: def.magSize,
        reserveMax: def.reserveMax,
        auto: def.auto,
        pellets: def.pellets,
        range: def.range,
      }
    })
  }

  getHudInventory(): InventoryItem[] {
    const items: InventoryItem[] = []
    for (const id of WEAPON_ORDER) {
      if (id === 'fists' || !this.owned.has(id)) continue
      items.push({
        id: `ammo_${id}`,
        name: `${WEAPONS[id].name} rounds`,
        quantity: this.ammo[id].reserve,
        icon: 'crosshair',
      })
    }
    return items
  }

  getSaveData(): SystemSaveFragment {
    return {
      weaponsOwned: this.getWeaponsOwned(),
      currentWeapon: this.current,
      weaponAmmo: {
        pistol: { ...this.ammo.pistol },
        smg: { ...this.ammo.smg },
        rifle: { ...this.ammo.rifle },
        shotgun: { ...this.ammo.shotgun },
      },
      inventory: this.getHudInventory(),
    }
  }

  applySaveData(data: SystemSaveFragment): void {
    const owned = (data.weaponsOwned as WeaponId[] | undefined) ?? ['fists', 'pistol']
    this.owned = new Set(owned.filter((id) => id in WEAPONS))
    if (this.owned.size === 0) this.owned = new Set(['fists', 'pistol'])
    const ammo = data.weaponAmmo as Record<string, AmmoState> | undefined
    if (ammo) {
      for (const id of WEAPON_ORDER) {
        if (ammo[id]) {
          this.ammo[id].mag = Math.max(0, Math.min(WEAPONS[id].magSize, Math.round(ammo[id].mag ?? 0)))
          this.ammo[id].reserve = Math.max(0, Math.round(ammo[id].reserve ?? 0))
        }
      }
    }
    const cur = data.currentWeapon as WeaponId | null | undefined
    if (cur && this.owned.has(cur)) this.current = cur
    this.reloading = false
    this.reloadTimer = 0
  }

  // =================================================================
  // Public helpers (pickups, missions, debug)
  // =================================================================

  giveWeapon(id: WeaponId): void {
    if (!(id in WEAPONS)) return
    const isNew = !this.owned.has(id)
    this.owned.add(id)
    this.ammo[id].mag = WEAPONS[id].magSize
    this.ammo[id].reserve = WEAPONS[id].reserveMax
    if (isNew) this.engine?.notify(`Acquired ${WEAPONS[id].name}`, 'success')
  }

  giveAllWeapons(): void {
    for (const id of WEAPON_ORDER) this.giveWeapon(id)
  }

  addAmmo(id: WeaponId, amount: number): void {
    if (!(id in WEAPONS)) return
    this.ammo[id].reserve = Math.max(0, this.ammo[id].reserve + amount)
  }

  /** Gun-shop purchase: top up every owned weapon's reserve to its max. */
  refillAllReserves(): void {
    for (const id of WEAPON_ORDER) {
      if (!this.owned.has(id)) continue
      this.ammo[id].reserve = WEAPONS[id].reserveMax
    }
    // A topped reserve finishes any in-flight reload immediately.
    this.reloading = false
    this.reloadTimer = 0
  }

  /** True when at least one owned weapon's reserve is below max (shop UI). */
  anyReserveBelowMax(): boolean {
    for (const id of WEAPON_ORDER) {
      if (this.owned.has(id) && this.ammo[id].reserve < WEAPONS[id].reserveMax) return true
    }
    return false
  }

  // =================================================================
  // Internals
  // =================================================================

  private selectWeapon(id: WeaponId): void {
    if (!this.owned.has(id)) {
      this.engine?.notify(`${WEAPONS[id].name} not owned`, 'warning')
      return
    }
    if (this.current === id) return
    this.current = id
    this.reloading = false // switch interrupts reload
    this.reloadTimer = 0
    this.triggerReady = true
    this.sustained = 0
    this.engine?.notify(WEAPONS[id].name, 'info')
  }

  private cycleWeapon(dir: 1 | -1): void {
    const owned = this.getWeaponsOwned()
    if (owned.length <= 1) return
    const idx = owned.indexOf(this.current)
    const next = owned[(idx + dir + owned.length) % owned.length]
    this.selectWeapon(next)
  }

  private startReload(): void {
    const def = WEAPONS[this.current]
    const ammo = this.ammo[this.current]
    if (def.melee || this.reloading) return
    if (ammo.mag >= def.magSize || ammo.reserve <= 0) return
    this.reloading = true
    this.reloadTimer = RELOAD_SEC
    this.audio()?.play?.('reload_start')
  }

  private finishReload(): void {
    const def = WEAPONS[this.current]
    const ammo = this.ammo[this.current]
    const transfer = Math.min(def.magSize - ammo.mag, ammo.reserve)
    ammo.mag += transfer
    ammo.reserve -= transfer
    this.reloading = false
    this.triggerReady = true
    this.audio()?.play?.('reload_end')
  }

  private attemptFire(): void {
    const engine = this.engine
    if (!engine || engine.player.dead) return
    const def = WEAPONS[this.current]
    const ammo = this.ammo[this.current]

    if (this.reloading) return
    // Semi-auto: require trigger release between shots.
    if (!def.auto && !this.triggerReady) return
    if (this.fireTimer > 0) return

    if (def.melee) {
      this.fireTimer = def.fireRate / 1000
      this.triggerReady = false
      this.meleeAttack()
      return
    }

    if (ammo.mag <= 0) {
      // Dry fire → auto-reload.
      this.triggerReady = false
      this.audio()?.play?.('ui_click', { volume: 0.4 })
      if (ammo.reserve > 0) this.startReload()
      return
    }

    ammo.mag--
    this.fireTimer = def.fireRate / 1000
    this.triggerReady = false
    this.sustained = Math.min(SUSTAINED_MAX, this.sustained + 1)
    this.fireHitscan(def)
    engine.emitEvent({ type: 'weaponFired', weapon: def.id })
    this.audio()?.play?.(def.sound)
  }

  private fireHitscan(def: WeaponDef): void {
    const engine = this.engine!
    const origin = this.getFireOrigin(this.tmpOrigin)
    const baseDir = engine.camera.getWorldDirection(this.tmpDir).clone()

    // Muzzle flash.
    this.spawnMuzzleFlash(origin, baseDir)

    let anyHit = false
    for (let p = 0; p < def.pellets; p++) {
      const dir = this.jitterDirection(baseDir, def.spread + this.sustained * SUSTAINED_SPREAD, this.tmpJitter)
      const npcHit = this.npcs()?.raycastNPCs?.(origin, dir, def.range) ?? null
      const worldHit = engine.physics.raycast(origin, dir, def.range, true)

      let hitDist = def.range
      let endPoint: Vec3 = {
        x: origin.x + dir.x * def.range,
        y: origin.y + dir.y * def.range,
        z: origin.z + dir.z * def.range,
      }

      if (worldHit && worldHit.distance < hitDist) {
        hitDist = worldHit.distance
        endPoint = worldHit.point
        if (worldHit.kind === 'vehicle') {
          const veh = engine.vehicles.getById(worldHit.boxId)
          veh?.applyDamage(def.damage * 1.5)
          anyHit = true
        }
        // building hits just stop the tracer.
      }
      if (npcHit && npcHit.distance < hitDist) {
        hitDist = npcHit.distance
        endPoint = npcHit.point
        this.npcs()?.damageNPC?.(npcHit.npcId, def.damage, true)
        anyHit = true
      }

      this.spawnTracer(
        { x: origin.x + dir.x * 0.8, y: origin.y + dir.y * 0.8, z: origin.z + dir.z * 0.8 },
        endPoint,
      )
    }

    // Recoil: camera kick + shake; NPCs panic; bigger calibers scare wider.
    engine.addCameraRecoil(def.recoilPitch, (Math.random() - 0.5) * def.recoilPitch * 0.6)
    const shotPos = { x: origin.x, y: origin.y, z: origin.z }
    this.npcs()?.notifyGunshot?.(shotPos)
    if (def.id === 'shotgun' || def.id === 'rifle') {
      this.npcs()?.fleeAll?.(shotPos, 20)
    }
    void anyHit
  }

  private meleeAttack(): void {
    const engine = this.engine!
    const def = WEAPONS.fists
    const origin = this.getFireOrigin(this.tmpOrigin)
    const fwd = engine.camera.getWorldDirection(this.tmpDir)
    const hfx = fwd.x
    const hfz = fwd.z
    const hlen = Math.hypot(hfx, hfz) || 1
    const fx = hfx / hlen
    const fz = hfz / hlen

    const npcs = this.npcs()?.getNPCs?.() ?? []
    let hit = false
    for (const npc of npcs) {
      const dx = npc.position.x - origin.x
      const dz = npc.position.z - origin.z
      const dist = Math.hypot(dx, dz)
      if (dist > def.range + 0.6) continue
      const dot = (dx * fx + dz * fz) / (dist || 1)
      if (dot < 0.5) continue // ~60° cone
      this.npcs()?.damageNPC?.(npc.id, def.damage, true)
      hit = true
    }
    if (hit) {
      this.audio()?.play?.('melee', { volume: 0.8 })
      engine.addCameraRecoil(0.004, 0)
    } else {
      this.audio()?.play?.('melee', { volume: 0.25 }) // whoosh
    }
  }

  private getFireOrigin(out: THREE.Vector3): THREE.Vector3 {
    const engine = this.engine!
    const pvId = engine.vehicles.playerVehicleId
    const pv = pvId ? engine.vehicles.getById(pvId) : null
    if (pv) {
      return out.set(pv.position.x, pv.position.y + pv.data.height * 0.8, pv.position.z)
    }
    return out.set(
      engine.player.position.x,
      engine.player.position.y + 1.5,
      engine.player.position.z,
    )
  }

  private jitterDirection(base: THREE.Vector3, spread: number, out: THREE.Vector3): THREE.Vector3 {
    out.copy(base)
    if (spread <= 0) return out.normalize()
    out.x += (Math.random() - 0.5) * 2 * spread
    out.y += (Math.random() - 0.5) * 2 * spread
    out.z += (Math.random() - 0.5) * 2 * spread
    return out.normalize()
  }

  private spawnMuzzleFlash(origin: THREE.Vector3, dir: THREE.Vector3): void {
    const engine = this.engine!
    // Oldest slot reuse.
    let slot = 0
    for (let i = 1; i < this.muzzleTimers.length; i++) {
      if (this.muzzleTimers[i] < this.muzzleTimers[slot]) slot = i
    }
    const light = this.muzzleLights[slot]
    light.position.set(origin.x + dir.x * 0.7, origin.y + dir.y * 0.7, origin.z + dir.z * 0.7)
    light.intensity = 24
    light.visible = true
    this.muzzleTimers[slot] = MUZZLE_FLASH_SEC
    void engine
  }

  private spawnTracer(from: Vec3, to: Vec3): void {
    let slot: { line: THREE.Line; life: number } | null = null
    for (const t of this.tracers) {
      if (t.life <= 0) {
        slot = t
        break
      }
    }
    if (!slot) slot = this.tracers[0]
    const pos = slot.line.geometry.attributes.position as THREE.BufferAttribute
    pos.setXYZ(0, from.x, from.y, from.z)
    pos.setXYZ(1, to.x, to.y, to.z)
    pos.needsUpdate = true
    slot.line.visible = true
    slot.life = TRACER_SEC
    ;(slot.line.material as THREE.LineBasicMaterial).opacity = 0.9
  }

  private spawnAmmoCrates(): void {
    const engine = this.engine
    if (!engine) return
    const shops = engine.level.buildings.filter(
      (b) => b.type.toLowerCase().includes('shop') || b.name.toLowerCase().includes('gun'),
    )
    const pickups = this.pickups()
    if (!pickups?.spawn) return
    for (const shop of shops) {
      const front = {
        x: shop.position.x,
        y: 0,
        z: shop.position.z + shop.size.z / 2 + 3,
      }
      pickups.spawn({ ...front, x: front.x - 3 }, { kind: 'ammo', amount: 36, weaponId: 'pistol', respawnSec: 60 })
      pickups.spawn(front, { kind: 'ammo', amount: 40, weaponId: 'smg', respawnSec: 60 })
      pickups.spawn({ ...front, x: front.x + 3 }, { kind: 'ammo', amount: 10, weaponId: 'rifle', respawnSec: 90 })
      engine.notify('Ammo crates stocked at the gun shop', 'info')
    }
  }

  private npcs(): NpcSystemLike | null {
    return (this.engine?.systems.npcs as unknown as NpcSystemLike | undefined) ?? null
  }

  private audio(): AudioLike | null {
    return (this.engine?.systems.audio as unknown as AudioLike | undefined) ?? null
  }

  private pickups(): PickupLike | null {
    return (this.engine?.systems.pickups as unknown as PickupLike | undefined) ?? null
  }
}
