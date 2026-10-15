/**
 * VehicleController — THE gap fix: the original C++ project declared a
 * VehicleController that was never used (vehicles were static meshes).
 * This controller drives every vehicle with its parsed .vehicle stats:
 * mass, maxSpeed (km/h → m/s), acceleration, braking, handling (steer
 * rate) and traction (lateral grip — low traction = drift).
 *
 * Arcade kinematic model with emergent drift:
 *   - velocity is kept in WORLD space; each step it's decomposed into
 *     the vehicle's forward/lateral components,
 *   - throttle/brake act on the forward component (capped at maxSpeed),
 *   - the lateral component decays with traction (handbrake nearly
 *     kills grip → drift), so hard turns at speed slide naturally,
 *   - collisions circle-vs-building AABBs: damage by impact speed,
 *     bounce-back, camera shake.
 *
 * Helicopters are STATIC DISPLAY vehicles (not drivable) — noted per
 * spec: rotor spins, gentle hover bob. Marked `drivable = false`.
 *
 * Meshes are stylized low-poly boxes with rotating wheels, body roll on
 * steer, pitch on accel/brake, emissive head/tail lights (brake lights
 * flare when braking) and a blinking lightbar on police cruisers.
 */
import * as THREE from 'three'
import type { VehicleData } from '@/game/types'
import type { PhysicsWorld } from '../physics/PhysicsWorld'

export interface VehicleControls {
  /** -1..1 (W / S; S brakes then reverses). */
  throttle: number
  /** -1..1 (A/D). */
  steer: number
  /** Space — kills grip + extra braking (drift handbrake). */
  handbrake: boolean
}

export interface VehicleUpdateResult {
  /** Impact speed (m/s) of the hardest collision this step, 0 if none. */
  impactSpeed: number
  /** Just reached 0 health this step. */
  destroyedNow: boolean
  /** Player was driving when it got destroyed (engine should eject). */
  ejectPlayer: boolean
}

const EMPTY_CONTROLS: VehicleControls = { throttle: 0, steer: 0, handbrake: false }

// Shared material cache (module-level, bounded set — created once).
const matCache = new Map<string, THREE.MeshStandardMaterial>()
function vmat(key: string, color: number, opts: Partial<THREE.MeshStandardMaterialParameters> = {}): THREE.MeshStandardMaterial {
  let m = matCache.get(key)
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.25, ...opts })
    matCache.set(key, m)
  }
  return m
}
function emat(key: string, color: number, intensity: number): THREE.MeshStandardMaterial {
  let m = matCache.get(key)
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: 0x1a1a1a,
      emissive: new THREE.Color(color),
      emissiveIntensity: intensity,
      roughness: 0.4,
    })
    matCache.set(key, m)
  }
  return m
}
const UNIT_BOX = /* @__PURE__ */ new THREE.BoxGeometry(1, 1, 1)
const UNIT_CYL = /* @__PURE__ */ new THREE.CylinderGeometry(0.5, 0.5, 1, 10)
const UNIT_SPH = /* @__PURE__ */ new THREE.SphereGeometry(0.5, 12, 10)

export class VehicleController {
  readonly id: string
  readonly data: VehicleData
  readonly group = new THREE.Group()
  /** True unless helicopter (display-only). */
  readonly drivable: boolean

  position = new THREE.Vector3()
  yaw = 0
  /** World-space velocity (m/s). */
  velocity = new THREE.Vector3()
  health: number
  destroyed = false
  isPlayerDriving = false
  isTraffic = false
  /** Round 9: custom respray color (hex) — null = factory paint. */
  paintColor: number | null = null

  // Visual parts
  private bodyGroup = new THREE.Group() // roll/pitch juice
  private wheels: { pivot: THREE.Object3D; mesh: THREE.Mesh; radius: number }[] = []
  private brakeMats: THREE.MeshStandardMaterial[] = []
  private headMat: THREE.MeshStandardMaterial
  private lightbar?: { red: THREE.Mesh; amber: THREE.Mesh }
  private rotor?: THREE.Object3D
  /** Round 9: meshes sharing the (class-cached) body material. */
  private bodyMeshes: THREE.Mesh[] = []
  private sharedBodyMat: THREE.MeshStandardMaterial | null = null
  private customBodyMat: THREE.MeshStandardMaterial | null = null

  private steerSmoothed = 0
  private accelSmoothed = 0
  private time = Math.random() * 10
  private baseY = 0
  private smokeTimer = 0

  constructor(id: string, data: VehicleData, pos: THREE.Vector3, yaw: number) {
    this.id = id
    this.data = data
    this.health = data.durability
    this.drivable = data.type !== 'helicopter'
    this.position.copy(pos)
    this.yaw = yaw
    this.baseY = Math.max(pos.y, 0)
    this.buildMesh()
    this.group.position.copy(this.position)
    this.group.rotation.y = yaw
    this.headMat = emat('headlight', 0xffdfae, 0)
  }

  // ------------------------------------------------------------------
  // Mesh construction
  // ------------------------------------------------------------------

  private buildMesh(): void {
    const d = this.data
    const cls = d.vehicleClass || d.type
    const L = d.length
    const W = d.width
    const H = d.height
    this.group.add(this.bodyGroup)
    const add = (
      mat: THREE.Material,
      x: number,
      y: number,
      z: number,
      sx: number,
      sy: number,
      sz: number,
      geo: THREE.BufferGeometry = UNIT_BOX,
    ): THREE.Mesh => {
      const m = new THREE.Mesh(geo, mat)
      m.position.set(x, y, z)
      m.scale.set(sx, sy, sz)
      m.castShadow = true
      this.bodyGroup.add(m)
      return m
    }

    // Vehicle faces -Z (nose at -Z/2).
    let bodyMat: THREE.MeshStandardMaterial
    if (cls.includes('police')) {
      bodyMat = vmat('police_body', 0x1f2225)
      add(bodyMat, 0, H * 0.4, 0, W, H * 0.62, L * 0.96)
      add(vmat('police_door', 0xe8e6e0), 0, H * 0.38, 0, W + 0.04, H * 0.3, L * 0.4)
      // lightbar
      const red = add(emat('lb_red', 0xd93a2f, 1.8), -0.28, H * 0.78, 0.1, 0.5, 0.16, 0.34)
      const amber = add(emat('lb_amber', 0xffb020, 1.8), 0.28, H * 0.78, 0.1, 0.5, 0.16, 0.34)
      this.lightbar = { red, amber }
    } else if (cls.includes('sport') && !cls.includes('bike')) {
      bodyMat = vmat('sports_body', 0xc0392b)
      add(bodyMat, 0, H * 0.34, 0.1, W, H * 0.5, L * 0.94)
      add(vmat('sports_cabin', 0x1c1e22), 0, H * 0.6, -0.1, W * 0.82, H * 0.34, L * 0.42)
      add(bodyMat, 0, H * 0.78, L * 0.42, W * 0.9, 0.1, 0.34) // spoiler
    } else if (d.type === 'motorcycle') {
      bodyMat = vmat('moto_body', 0x2b2b2e)
      add(bodyMat, 0, H * 0.45, 0, W * 0.7, H * 0.4, L * 0.8)
      add(vmat('moto_seat', 0x3a2d22), 0, H * 0.66, L * 0.18, W * 0.6, 0.12, L * 0.3)
      add(vmat('moto_hbar', 0x4a4a4e), 0, H * 0.8, -L * 0.32, W * 1.1, 0.08, 0.08)
    } else if (cls.includes('van')) {
      bodyMat = vmat('van_body', 0xc98f3a)
      add(bodyMat, 0, H * 0.5, 0, W, H * 0.94, L * 0.98)
      add(vmat('van_glass', 0x23262b), 0, H * 0.68, -L * 0.44, W * 0.86, H * 0.3, 0.14)
    } else if (d.type === 'truck') {
      bodyMat = vmat('truck_cab', 0x8a8d90)
      add(bodyMat, 0, H * 0.45, -L * 0.3, W, H * 0.86, L * 0.36)
      add(vmat('truck_cargo', 0xb8b4aa), 0, H * 0.5, L * 0.16, W * 1.02, H * 0.94, L * 0.58)
    } else if (d.type === 'helicopter') {
      bodyMat = vmat('heli_body', 0xd8d2c4)
      add(bodyMat, 0, H * 0.5, 0, W * 0.9, H * 0.8, L * 0.4, UNIT_SPH)
      add(bodyMat, 0, H * 0.55, L * 0.35, 0.5, 0.5, L * 0.55) // tail boom
      add(vmat('heli_tail', 0x9a4a3a), 0, H * 0.72, L * 0.62, 0.2, 1.1, 0.5) // fin
      add(vmat('heli_skid', 0x4a4a4e), -W * 0.3, H * 0.12, 0, 0.12, 0.12, L * 0.5)
      add(vmat('heli_skid', 0x4a4a4e), W * 0.3, H * 0.12, 0, 0.12, 0.12, L * 0.5)
      // spinning rotor
      const rotor = new THREE.Object3D()
      rotor.position.set(0, H * 0.95, 0)
      for (const r of [0, Math.PI / 2]) {
        const blade = new THREE.Mesh(UNIT_BOX, vmat('heli_rotor', 0x2e2e32))
        blade.scale.set(L * 0.95, 0.06, 0.32)
        blade.rotation.y = r
        rotor.add(blade)
      }
      this.bodyGroup.add(rotor)
      this.rotor = rotor
      this.collectBodyMeshes(bodyMat)
      return // no wheels on a chopper
    } else {
      // sedan / default
      bodyMat = vmat('sedan_body', 0x6d7178)
      add(bodyMat, 0, H * 0.34, 0, W, H * 0.5, L * 0.96)
      add(vmat('sedan_cabin', 0x1f2226), 0, H * 0.64, 0.05, W * 0.84, H * 0.36, L * 0.5)
    }
    this.collectBodyMeshes(bodyMat)

    // wheels (dark cylinders, spinning) — skip motorcycles' extra pair
    const wheelR = Math.min(H * 0.32, 0.42)
    const wheelMat = vmat('wheel', 0x1c1c1f, { roughness: 0.9 })
    const wheelX = W / 2 - 0.06
    const wheelZF = -L * 0.32
    const wheelZB = L * 0.32
    const positions: [number, number][] =
      d.type === 'motorcycle'
        ? [
            [0, wheelZF],
            [0, wheelZB],
          ]
        : [
            [-wheelX, wheelZF],
            [wheelX, wheelZF],
            [-wheelX, wheelZB],
            [wheelX, wheelZB],
          ]
    for (const [px, pz] of positions) {
      const pivot = new THREE.Object3D()
      pivot.position.set(px, wheelR, pz)
      pivot.rotation.z = Math.PI / 2 // axle along X
      const mesh = new THREE.Mesh(UNIT_CYL, wheelMat)
      mesh.scale.set(wheelR * 2 * 0.7, 0.24, wheelR * 2 * 0.7) // diameter, width, diameter
      mesh.castShadow = true
      pivot.add(mesh)
      this.bodyGroup.add(pivot)
      this.wheels.push({ pivot, mesh, radius: wheelR })
    }

    // head / tail lights (emissive boxes)
    const headMat = emat('headlight', 0xffdfae, 0.0)
    const tailMat = emat('taillight', 0x8a1a14, 0.25)
    this.headMat = headMat
    if (d.type !== 'motorcycle') {
      add(headMat, -W * 0.32, H * 0.42, -L / 2 - 0.03, 0.28, 0.14, 0.08)
      add(headMat, W * 0.32, H * 0.42, -L / 2 - 0.03, 0.28, 0.14, 0.08)
      for (const side of [-W * 0.32, W * 0.32]) {
        const t = tailMat.clone()
        t.name = 'vehicle_cloned'
        this.brakeMats.push(
          add(t, side, H * 0.42, L / 2 + 0.03, 0.3, 0.12, 0.08).material as THREE.MeshStandardMaterial,
        )
      }
    } else {
      add(headMat, 0, H * 0.5, -L / 2 - 0.02, 0.22, 0.14, 0.08)
      const t = tailMat.clone()
      t.name = 'vehicle_cloned'
      this.brakeMats.push(
        add(t, 0, H * 0.45, L / 2 + 0.02, 0.22, 0.1, 0.08).material as THREE.MeshStandardMaterial,
      )
    }
  }

  // ------------------------------------------------------------------
  // Simulation
  // ------------------------------------------------------------------

  get forwardX(): number {
    return -Math.sin(this.yaw)
  }
  get forwardZ(): number {
    return -Math.cos(this.yaw)
  }
  getSpeedKmh(): number {
    return Math.hypot(this.velocity.x, this.velocity.z) * 3.6
  }
  /** Forward speed (signed, m/s). */
  getForwardSpeed(): number {
    return this.velocity.x * this.forwardX + this.velocity.z * this.forwardZ
  }

  // ------------------------------------------------------------------
  // Round 9: per-instance respray (garage customization)
  // ------------------------------------------------------------------

  /** Remember which meshes wear the body material (called once at build). */
  private collectBodyMeshes(bodyMat: THREE.MeshStandardMaterial): void {
    this.sharedBodyMat = bodyMat
    for (const child of this.bodyGroup.children) {
      const m = child as THREE.Mesh
      if (m.isMesh && m.material === bodyMat) this.bodyMeshes.push(m)
    }
  }

  /**
   * Apply a custom respray color to this instance only. The class-shared
   * body material is cloned once (named 'vehicle_cloned' so dispose()
   * reclaims it). Passing null restores the factory paint.
   */
  applyPaint(hex: number | null): void {
    this.paintColor = hex
    if (hex == null) {
      if (this.customBodyMat && this.sharedBodyMat) {
        for (const m of this.bodyMeshes) m.material = this.sharedBodyMat
        this.customBodyMat.dispose()
        this.customBodyMat = null
      }
      return
    }
    if (!this.customBodyMat && this.sharedBodyMat) {
      this.customBodyMat = this.sharedBodyMat.clone()
      this.customBodyMat.name = 'vehicle_cloned'
      for (const m of this.bodyMeshes) m.material = this.customBodyMat
    }
    this.customBodyMat?.color.setHex(hex)
  }

  update(dt: number, controls: VehicleControls, physics: PhysicsWorld): VehicleUpdateResult {
    const result: VehicleUpdateResult = { impactSpeed: 0, destroyedNow: false, ejectPlayer: false }
    this.time += dt

    // ---- helicopter: static display only ----
    if (!this.drivable) {
      this.updateVisuals(dt, 0)
      return result
    }

    const d = this.data
    const maxSpeed = d.maxSpeed / 3.6 // km/h → m/s
    const fx = this.forwardX
    const fz = this.forwardZ
    const rx = -fz // right = forward rotated -90°
    const rz = fx

    // Decompose world velocity into vehicle frame.
    let vF = this.velocity.x * fx + this.velocity.z * fz
    let vL = this.velocity.x * rx + this.velocity.z * rz

    const braking = this.destroyed || controls.throttle < 0

    if (!this.destroyed) {
      // ---- longitudinal ----
      if (controls.throttle > 0.01) {
        vF += d.acceleration * controls.throttle * dt
      } else if (controls.throttle < -0.01) {
        if (vF > 0.5) vF -= d.braking * dt // braking
        else vF -= d.acceleration * 0.5 * dt // reverse
      }
      // drag + rolling resistance
      vF -= vF * 0.32 * dt
      if (controls.handbrake) vF -= Math.sign(vF) * Math.min(Math.abs(vF), d.braking * 0.55 * dt)
      vF = THREE.MathUtils.clamp(vF, -maxSpeed * 0.35, maxSpeed)
    } else {
      vF -= vF * 2.2 * dt
    }

    // ---- steering ----
    const steerTarget = this.destroyed ? 0 : controls.steer
    this.steerSmoothed += (steerTarget - this.steerSmoothed) * Math.min(1, dt * 8)
    const steerAngle = this.steerSmoothed * (d.handling / 10) * (1 / (1 + Math.abs(vF) * 0.05))
    const speedFactor = Math.min(Math.abs(vF) / 6, 1)
    const yawRate = steerAngle * Math.min(Math.abs(vF), 22) * 0.1 * Math.sign(vF || 1) * speedFactor
    this.yaw += yawRate * dt

    // ---- traction / drift ----
    const gripK = controls.handbrake ? 1.1 : d.traction * 9
    vL *= Math.exp(-gripK * dt)
    // Turning injects lateral slip (counter-steer feel):
    vL -= yawRate * vF * dt * 0.55

    // Smoothed forward accel (drives the body-pitch juice).
    const prevVF = this.velocity.x * fx + this.velocity.z * fz
    this.accelSmoothed += ((vF - prevVF) / dt - this.accelSmoothed) * 0.2

    // ---- recompose + integrate ----
    this.velocity.x = fx * vF + rx * vL
    this.velocity.z = fz * vF + rz * vL
    this.position.x += this.velocity.x * dt
    this.position.z += this.velocity.z * dt

    // ---- ground / water height ----
    const inWater = physics.isWater(this.position.x, this.position.z)
    const targetY = inWater ? -0.35 : physics.getGroundHeight(this.position.x, this.position.z)
    if (inWater) {
      // Vehicles sink + slow in water; hull damage over time.
      this.velocity.multiplyScalar(Math.exp(-1.6 * dt))
      this.applyDamage(4 * dt)
    }
    this.position.y += (targetY - this.position.y) * Math.min(1, dt * (inWater ? 2 : 10))

    // ---- collisions vs buildings (sliding + bounce + damage) ----
    const radius = this.data.width * 0.55 + 0.45
    const hit = physics.collideCircle(this.position, radius, this.data.height * 0.7, false)
    if (hit.hit && hit.depth > 0.001) {
      // Impact speed along the wall normal.
      const into = this.velocity.x * hit.nx + this.velocity.z * hit.nz
      const impactSpeed = Math.max(0, -into)
      if (impactSpeed > result.impactSpeed) result.impactSpeed = impactSpeed
      // Reflect with restitution 0.35.
      this.velocity.x -= hit.nx * into * 1.35
      this.velocity.z -= hit.nz * into * 1.35
      if (impactSpeed > 3.2) {
        this.applyDamage((impactSpeed - 3.2) * Math.max(0.6, this.data.mass / 1500) * 1.6)
      }
      if (this.health <= 0 && !this.destroyed) {
        this.destroyed = true
        result.destroyedNow = true
        result.ejectPlayer = this.isPlayerDriving
      }
    }

    this.updateVisuals(dt, braking ? 1 : 0)
    return result
  }

  applyDamage(amount: number): void {
    if (this.destroyed) return
    this.health -= amount
    if (this.health <= 0) {
      this.health = 0
      this.destroyed = true
    }
  }

  /** World position of the driver-exit spot (left side of the vehicle). */
  getExitPosition(out: THREE.Vector3): THREE.Vector3 {
    const rx = -this.forwardZ
    const rz = this.forwardX
    return out.set(
      this.position.x - rx * (this.data.width / 2 + 1.0),
      this.position.y,
      this.position.z - rz * (this.data.width / 2 + 1.0),
    )
  }

  // ------------------------------------------------------------------
  // Visuals
  // ------------------------------------------------------------------

  /** @param brakeLight 0..1 flare intensity. */
  updateVisuals(dt: number, brakeLight: number): void {
    // helicopter hover bob + rotor
    if (this.rotor) {
      this.rotor.rotation.y += dt * 14
      this.group.position.set(
        this.position.x,
        this.baseY + Math.sin(this.time * 0.8) * 0.35,
        this.position.z,
      )
      this.group.rotation.y = this.yaw
      return
    }

    this.group.position.copy(this.position)
    this.group.rotation.y = this.yaw

    // wheel spin
    const spin = this.getForwardSpeed() * dt
    for (const w of this.wheels) {
      w.mesh.rotation.y += spin / w.radius
    }
    // body roll & pitch (juice)
    const speedNorm = Math.min(Math.abs(this.getForwardSpeed()) / 12, 1)
    const roll = -this.steerSmoothed * speedNorm * 0.07
    const pitch = THREE.MathUtils.clamp(-this.accelSmoothed * 0.004, -0.05, 0.05)
    this.bodyGroup.rotation.z += (roll - this.bodyGroup.rotation.z) * Math.min(1, dt * 6)
    this.bodyGroup.rotation.x += (pitch - this.bodyGroup.rotation.x) * Math.min(1, dt * 6)

    // brake lights
    const flare = 0.25 + brakeLight * 2.2
    for (const m of this.brakeMats) m.emissiveIntensity = flare

    // police lightbar blink (1.7 Hz alternating)
    if (this.lightbar) {
      const on = Math.floor(this.time * 1.7 * 2) % 2 === 0
      ;(this.lightbar.red.material as THREE.MeshStandardMaterial).emissiveIntensity = on ? 2.6 : 0.25
      ;(this.lightbar.amber.material as THREE.MeshStandardMaterial).emissiveIntensity = on ? 0.25 : 2.6
    }

    // ---- smoke by damage tier ------------------------------------------------
    // >50%: clean. ≤50%: wispy steam from the hood. ≤25%: dark smoke
    // billows. Destroyed: thick dark puffs from the whole wreck.
    if (this.destroyed) {
      this.smokeTimer -= dt
      if (this.smokeTimer <= 0) {
        this.smokeTimer = 0.32
        const hx = this.position.x + this.forwardX * this.data.length * 0.28
        const hz = this.position.z + this.forwardZ * this.data.length * 0.28
        this.onSmokePuff?.(hx, this.position.y + 0.9, hz, true)
        this.onSmokePuff?.(this.position.x, this.position.y + 1.1, this.position.z, true)
      }
    } else if (this.health < this.data.durability * 0.5) {
      const critical = this.health < this.data.durability * 0.25
      this.smokeTimer -= dt
      if (this.smokeTimer <= 0) {
        this.smokeTimer = critical ? 0.42 : 0.85
        const hx = this.position.x + this.forwardX * this.data.length * 0.3
        const hz = this.position.z + this.forwardZ * this.data.length * 0.3
        this.onSmokePuff?.(hx, this.position.y + 0.85, hz, critical)
      }
    }
  }

  /** Set by the manager (smoke particle pool hook). */
  onSmokePuff: ((x: number, y: number, z: number, dark?: boolean) => void) | null = null

  setHeadlightsOn(on: boolean): void {
    this.headMat.emissiveIntensity = on ? 2.2 : 0
  }

  /** Headlight beam origin + direction (for SpotLights on the player car). */
  getHeadlightOrigin(out: THREE.Vector3, side: -1 | 1): THREE.Vector3 {
    return out.set(
      this.position.x - this.forwardZ * side * this.data.width * 0.32 + this.forwardX * (this.data.length / 2),
      this.position.y + this.data.height * 0.55,
      this.position.z + this.forwardX * side * this.data.width * 0.32 + this.forwardZ * (this.data.length / 2),
    )
  }

  dispose(): void {
    this.group.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (mesh.isMesh) {
        // geometries & materials are shared/cached — only per-instance
        // clones (brake lights) get disposed.
        const mat = mesh.material as THREE.Material | THREE.Material[]
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
        else if (mat.name === 'vehicle_cloned') mat.dispose()
      }
    })
    this.group.clear()
  }

  /** Idle controls for parked cars. */
  static idleControls(): VehicleControls {
    return EMPTY_CONTROLS
  }
}
