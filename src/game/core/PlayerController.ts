/**
 * PlayerController — the on-foot player: kinematic movement, stylized box
 * character with limb-swing animation, and GTA-style player stats.
 *
 * ============================ THE dt² BUG FIX ============================
 * The original C++ engine (Engine.cpp:143) called
 *     character->move(worldMoveDir, deltaTime)   // deltaTime as "speed"!
 * and RigidBody::update integrated velocity/position with dt-scaled force,
 * compounding to position ∝ dt³ — the player moved ~2 cm/s. WASD was
 * effectively broken while docs claimed "Character controller active".
 * Here movement is explicit semi-implicit Euler on a FIXED timestep
 * (Time.FIXED_DT = 1/60), applied by the engine:
 *     velocity += acceleration · dt        (accel 40 m/s² toward target vel)
 *     position += velocity · dt            (never velocity · dt²)
 * giving exact walk 3 m/s / run 6.5 m/s speeds at any frame rate.
 * =========================================================================
 *
 * Features:
 *  - Walk 3 m/s, run 6.5 m/s (Shift), accel 40 m/s², jump v₀ 7.5 m/s,
 *    gravity 20 m/s², air control 30%.
 *  - Swimming in level water areas: locked near the surface, 40% speed,
 *    gentle bob; climb-out snaps onto the shore/dock ground.
 *  - Sliding collision vs building/vehicle AABBs (PhysicsWorld.collideCircle).
 *  - Stats: health 100, armor 0, money 500, xp 0, wantedLevel 0.
 *    damage() soaks armor first; death fires onDeath (engine respawns).
 *  - Stylized box character (dark outfit + skin head) with:
 *      · limb-swing walk/run cycle (arms counter-phase to legs),
 *      · idle sway (breathing bob + arm micro-sway),
 *      · swim pose (forward pitch + kick/paddle),
 *      · dead pose (keel over) during the wasted flow.
 *    Hidden by the engine in FPS mode and while driving.
 */
import * as THREE from 'three'
import type { PhysicsWorld } from '../physics/PhysicsWorld'
import { WATER_SURFACE_Y } from '../physics/PhysicsWorld'

// ---------------------------------------------------------------------
// Tunables (spec values)
// ---------------------------------------------------------------------
const HEIGHT = 1.8 // collider height
const RADIUS = 0.4 // collider radius
export const PLAYER_EYE_HEIGHT = 1.65 // camera eye above feet

const ACCEL = 40 // m/s² toward desired velocity (ground)
const WALK_SPEED = 3 // m/s
const RUN_SPEED = 6.5 // m/s
const JUMP_VELOCITY = 7.5 // m/s
const GRAVITY = 20 // m/s²
const AIR_CONTROL = 0.3 // 30% acceleration while airborne
const SWIM_SPEED_FACTOR = 0.4 // 40% speed in water
const SWIM_Y = WATER_SURFACE_Y - 0.45 // feet height while swimming

export interface PlayerIntent {
  /** World-space desired move direction (unit or zero). */
  dirX: number
  dirZ: number
  /** Shift held. */
  run: boolean
  /** Jump requested this fixed step (edge). */
  jump: boolean
}

export interface PlayerCallbacks {
  onDamaged?: (info: { amount: number; health: number; armor: number; source?: string }) => void
  onDeath?: (source?: string) => void
}

export class PlayerController {
  /** Feet position (world). */
  readonly position = new THREE.Vector3()
  /** World velocity (m/s). */
  readonly velocity = new THREE.Vector3()
  /** Character mesh root (added to the scene by the engine). */
  readonly group = new THREE.Group()

  // Stats
  health = 100
  maxHealth = 100
  armor = 0
  maxArmor = 100
  money = 500
  xp = 0
  wantedLevel = 0

  dead = false
  grounded = false
  swimming = false
  /** Engine may clear the death pose (teleport / save restore). */
  deadPose = false

  private callbacks: PlayerCallbacks
  private geoms: THREE.BufferGeometry[] = []
  private mats: THREE.Material[] = []

  // Animation state
  private bodyPivot = new THREE.Group() // pitch for swim/dead poses
  private legPivots: THREE.Object3D[] = []
  private armPivots: THREE.Object3D[] = []
  private animPhase = 0
  private animTime = 0
  private meshYaw = 0

  constructor(spawn: THREE.Vector3, callbacks: PlayerCallbacks = {}) {
    this.callbacks = callbacks
    this.position.copy(spawn)
    this.buildMesh()
    this.group.position.copy(this.position)
    this.group.name = 'player'
  }

  // -------------------------------------------------------------------
  // Fixed-step update (dt is ALWAYS 1/60 — see the dt² FIX note above)
  // -------------------------------------------------------------------
  update(dt: number, intent: PlayerIntent, physics: PhysicsWorld): void {
    this.animTime += dt

    if (this.dead) {
      // Wasted: no input, just settle the pose.
      this.velocity.set(0, 0, 0)
      this.updateAnimation(dt, 0)
      return
    }

    // ---- water state ----
    const wasSwimming = this.swimming
    this.swimming =
      physics.isWater(this.position.x, this.position.z) &&
      this.position.y < WATER_SURFACE_Y + 0.05
    if (this.swimming && !wasSwimming && this.velocity.y < -6) {
      // Heavy entry splash — kill most downward speed.
      this.velocity.y *= -0.15
    }

    // ---- desired horizontal velocity ----
    const targetSpeed = (intent.run ? RUN_SPEED : WALK_SPEED) * (this.swimming ? SWIM_SPEED_FACTOR : 1)
    let dx = intent.dirX * targetSpeed
    let dz = intent.dirZ * targetSpeed
    const len = Math.hypot(dx, dz)
    if (len > targetSpeed) {
      dx = (dx / len) * targetSpeed
      dz = (dz / len) * targetSpeed
    }

    // ---- accelerate toward it (semi-implicit Euler) ----
    const accel = this.swimming ? ACCEL * 0.5 : this.grounded ? ACCEL : ACCEL * AIR_CONTROL
    const maxDelta = accel * dt
    const stepX = THREE.MathUtils.clamp(dx - this.velocity.x, -maxDelta, maxDelta)
    const stepZ = THREE.MathUtils.clamp(dz - this.velocity.z, -maxDelta, maxDelta)
    this.velocity.x += stepX
    this.velocity.z += stepZ

    // ---- vertical ----
    if (this.swimming) {
      // Locked near the surface: spring toward SWIM_Y with a gentle bob.
      const bob = Math.sin(this.animTime * 2.2) * 0.06
      this.position.y += (SWIM_Y + bob - this.position.y) * Math.min(1, dt * 5)
      this.velocity.y = 0
      this.grounded = false
    } else {
      if (intent.jump && this.grounded) {
        this.velocity.y = JUMP_VELOCITY
        this.grounded = false
      }
      this.velocity.y -= GRAVITY * dt
    }

    // ---- integrate ----
    this.position.x += this.velocity.x * dt
    this.position.y += this.velocity.y * dt
    this.position.z += this.velocity.z * dt

    // ---- ground / sea floor ----
    if (!this.swimming) {
      const groundY = physics.getGroundHeight(this.position.x, this.position.z)
      if (this.position.y <= groundY && this.velocity.y <= 0.001) {
        this.position.y = groundY
        this.velocity.y = 0
        this.grounded = true
      } else {
        this.grounded = false
      }
    }

    // ---- slide against buildings & vehicles ----
    physics.collideCircle(this.position, RADIUS, HEIGHT)

    // Keep inside the level's ground apron (soft world bounds).
    this.position.x = THREE.MathUtils.clamp(this.position.x, this.worldMinX, this.worldMaxX)
    this.position.z = THREE.MathUtils.clamp(this.position.z, this.worldMinZ, this.worldMaxZ)

    this.updateAnimation(dt, Math.hypot(this.velocity.x, this.velocity.z))
  }

  private worldMinX = -280
  private worldMaxX = 1380
  private worldMinZ = -280
  private worldMaxZ = 1480
  /** Called by the engine on level load to match the level's ground apron. */
  setWorldBounds(sizeX: number, sizeZ: number): void {
    this.worldMinX = -280
    this.worldMaxX = sizeX + 280
    this.worldMinZ = -280
    this.worldMaxZ = sizeZ + 280
  }

  // -------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------

  /** Armor soaks damage first, then health. Fires onDamaged / onDeath. */
  damage(amount: number, source?: string): void {
    if (this.dead || amount <= 0) return
    let remaining = amount
    if (this.armor > 0) {
      const soak = Math.min(this.armor, remaining)
      this.armor -= soak
      remaining -= soak
    }
    if (remaining > 0) this.health = Math.max(0, this.health - remaining)
    this.callbacks.onDamaged?.({
      amount,
      health: this.health,
      armor: this.armor,
      source,
    })
    if (this.health <= 0) {
      this.dead = true
      this.deadPose = true
      this.callbacks.onDeath?.(source)
    }
  }

  /** Heal / give armor. Omitted args restore to full / keep current. */
  restore(health?: number, armor?: number): void {
    if (health !== undefined) this.health = THREE.MathUtils.clamp(health, 0, this.maxHealth)
    else if (this.health < this.maxHealth) this.health = this.maxHealth
    if (armor !== undefined) this.armor = THREE.MathUtils.clamp(armor, 0, this.maxArmor)
  }

  /** Full respawn reset at a position (engine calls after the wasted flow). */
  respawnAt(pos: THREE.Vector3): void {
    this.position.copy(pos)
    this.velocity.set(0, 0, 0)
    this.health = this.maxHealth
    this.armor = 0
    this.dead = false
    this.deadPose = false
    this.grounded = false
    this.swimming = false
  }

  /** Add (or deduct) money, clamped at 0. Returns false when a deduction
   *  was capped (insufficient funds). */
  addMoney(delta: number): boolean {
    const target = this.money + delta
    this.money = Math.max(0, target)
    return target >= 0
  }

  addXp(amount: number): void {
    this.xp = Math.max(0, this.xp + amount)
  }

  /** XP-derived level: 1 + floor(xp / 1000). */
  getLevel(): number {
    return 1 + Math.floor(this.xp / 1000)
  }

  getSpeedKmh(): number {
    return Math.hypot(this.velocity.x, this.velocity.z) * 3.6
  }

  // -------------------------------------------------------------------
  // Mesh — stylized box character
  // -------------------------------------------------------------------

  setVisible(visible: boolean): void {
    this.group.visible = visible
  }

  private buildMesh(): void {
    const mkMat = (color: number, rough = 0.8) => {
      const m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.05 })
      this.mats.push(m)
      return m
    }
    const skinMat = mkMat(0xc98d6b, 0.75)
    const jacketMat = mkMat(0x2c3036) // dark outfit
    const jeansMat = mkMat(0x1e2126)
    const shoeMat = mkMat(0x141518, 0.9)
    const hairMat = mkMat(0x171310, 0.9)

    const mkBox = (
      mat: THREE.Material,
      parent: THREE.Object3D,
      x: number,
      y: number,
      z: number,
      sx: number,
      sy: number,
      sz: number,
    ) => {
      const geo = new THREE.BoxGeometry(sx, sy, sz)
      this.geoms.push(geo)
      const m = new THREE.Mesh(geo, mat)
      m.position.set(x, y, z)
      m.castShadow = true
      parent.add(m)
      return m
    }

    this.group.add(this.bodyPivot)

    // Torso + hips (dark outfit)
    mkBox(jacketMat, this.bodyPivot, 0, 1.25, 0, 0.46, 0.58, 0.26)
    mkBox(jeansMat, this.bodyPivot, 0, 0.9, 0, 0.4, 0.16, 0.24)
    // Head (skin) + hair cap
    mkBox(skinMat, this.bodyPivot, 0, 1.64, 0, 0.24, 0.26, 0.24)
    mkBox(hairMat, this.bodyPivot, 0, 1.79, -0.005, 0.26, 0.08, 0.25)
    mkBox(hairMat, this.bodyPivot, 0, 1.7, -0.12, 0.26, 0.12, 0.03)

    // Arms — pivot at the shoulder so they swing
    for (const side of [-1, 1]) {
      const pivot = new THREE.Object3D()
      pivot.position.set(side * 0.3, 1.5, 0)
      this.bodyPivot.add(pivot)
      mkBox(jacketMat, pivot, 0, -0.26, 0, 0.13, 0.44, 0.15)
      mkBox(skinMat, pivot, 0, -0.55, 0, 0.11, 0.14, 0.13) // hand
      this.armPivots.push(pivot)
    }

    // Legs — pivot at the hip
    for (const side of [-1, 1]) {
      const pivot = new THREE.Object3D()
      pivot.position.set(side * 0.12, 0.95, 0)
      this.bodyPivot.add(pivot)
      mkBox(jeansMat, pivot, 0, -0.41, 0, 0.17, 0.78, 0.19)
      mkBox(shoeMat, pivot, 0, -0.85, 0.04, 0.18, 0.1, 0.3)
      this.legPivots.push(pivot)
    }
  }

  // -------------------------------------------------------------------
  // Animation
  // -------------------------------------------------------------------

  private updateAnimation(dt: number, horizSpeed: number): void {
    // Face the movement direction (shortest-arc smoothing).
    if (horizSpeed > 0.4 && !this.dead) {
      const targetYaw = Math.atan2(this.velocity.x, this.velocity.z)
      let d = targetYaw - this.meshYaw
      while (d > Math.PI) d -= Math.PI * 2
      while (d < -Math.PI) d += Math.PI * 2
      this.meshYaw += d * Math.min(1, dt * 10)
    }
    this.group.position.copy(this.position)
    this.group.rotation.y = this.meshYaw

    // Body pitch: swim forward-lean / dead keel-over / upright.
    let pitchTarget = 0
    if (this.deadPose) pitchTarget = Math.PI / 2 // fall forward (WASTED)
    else if (this.swimming) pitchTarget = 1.05 // lying on the water
    this.bodyPivot.rotation.x += (pitchTarget - this.bodyPivot.rotation.x) * Math.min(1, dt * (this.deadPose ? 6 : 4))
    // When pitched over, lift so the body doesn't sink into the ground.
    this.bodyPivot.position.y = this.bodyPivot.rotation.x * 0.35

    // Limb cycle.
    const swimK = this.swimming ? 1 : 0
    const cadence = this.swimming ? 3.4 : Math.max(horizSpeed, 0) * 2.4
    this.animPhase += cadence * dt
    const amp = this.dead
      ? 0
      : this.swimming
        ? 0.7
        : THREE.MathUtils.clamp(horizSpeed / RUN_SPEED, 0, 1) * 0.85
    const swing = Math.sin(this.animPhase) * amp

    const airborne = !this.grounded && !this.swimming && !this.dead
    if (airborne) {
      // Slight tuck while airborne.
      for (let i = 0; i < this.legPivots.length; i++) {
        this.legPivots[i].rotation.x += (i === 0 ? -0.35 : 0.25 - this.legPivots[i].rotation.x) * Math.min(1, dt * 8)
      }
      for (let i = 0; i < this.armPivots.length; i++) {
        this.armPivots[i].rotation.x += (i === 0 ? -0.5 : 0.4 - this.armPivots[i].rotation.x) * Math.min(1, dt * 8)
      }
    } else {
      // Legs swing; arms counter-swing (swim: full paddle).
      for (let i = 0; i < this.legPivots.length; i++) {
        const s = i === 0 ? swing : -swing
        this.legPivots[i].rotation.x = s * (swimK ? 0.55 : 1)
      }
      for (let i = 0; i < this.armPivots.length; i++) {
        const s = i === 0 ? -swing : swing
        const idleSway = amp < 0.05 && !this.swimming ? Math.sin(this.animTime * 1.8) * 0.045 : 0
        this.armPivots[i].rotation.x = s * (swimK ? 1.1 : 0.8) + idleSway
      }
    }

    // Idle sway: subtle breathing bob of the torso.
    if (amp < 0.05 && !this.swimming && !this.dead) {
      this.bodyPivot.position.y += Math.sin(this.animTime * 1.8) * 0.012
    }
  }

  // -------------------------------------------------------------------

  dispose(): void {
    for (const g of this.geoms) g.dispose()
    for (const m of this.mats) m.dispose()
    this.geoms.length = 0
    this.mats.length = 0
    this.group.clear()
    if (this.group.parent) this.group.parent.remove(this.group)
  }
}
