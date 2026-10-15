/**
 * VehicleManager — spawns every vehicle from content.vehicles at its
 * authored spawnLocations (levels are 1000×1000 so ~15 vehicles total,
 * all spawned), exposes the enter/exit + nearest-vehicle queries used
 * by the engine, drives headlight SpotLights for the player's vehicle
 * at night, runs a tiny smoke-sprite particle pool for destroyed
 * vehicles, and publishes dynamic collision boxes to the PhysicsWorld.
 *
 * Task 2-b API: `spawnVehicle(...)` / `removeVehicle(id)` for the
 * TrafficSystem, `getNearby()` for HUD, `setPlayerDriving()` for
 * engine-driven enter/exit.
 */
import * as THREE from 'three'
import type { VehicleData, LevelData } from '@/game/types'
import type { PhysicsWorld, DynamicBox } from '../physics/PhysicsWorld'
import { VehicleController, type VehicleControls } from './VehicleController'

export interface VehicleManagerCallbacks {
  /** Engine hook — camera shake on hard impacts. */
  onShake: (amount: number) => void
  /** Engine hook — engine events (vehicle destroyed etc.). */
  onNotify: (text: string, kind: 'info' | 'success' | 'warning' | 'danger') => void
  /** Engine hook — explosion: audio boom + area damage (NPCs + player). */
  onExplosion?: (position: { x: number; y: number; z: number }) => void
}

interface SmokeParticle {
  sprite: THREE.Sprite
  vx: number
  vy: number
  vz: number
  life: number
  maxLife: number
}

interface Fireball {
  sprite: THREE.Sprite
  life: number
  maxLife: number
  delay: number
}

const SMOKE_POOL_SIZE = 24
const FIREBALL_POOL_SIZE = 6

export class VehicleManager {
  readonly vehicles: VehicleController[] = []
  private scene: THREE.Scene
  private physics: PhysicsWorld
  private callbacks: VehicleManagerCallbacks
  private playerVehicle: VehicleController | null = null
  private night = false

  // headlight pool (player vehicle only)
  private headlights: THREE.SpotLight[] = []
  private headlightTargets: THREE.Object3D[] = []

  // smoke particles
  private smokePool: SmokeParticle[] = []
  private smokeTexture: THREE.Texture | null = null

  // explosion fireballs
  private fireballPool: Fireball[] = []
  private fireballTexture: THREE.Texture | null = null

  private idCounter = new Map<string, number>()

  constructor(scene: THREE.Scene, physics: PhysicsWorld, callbacks: VehicleManagerCallbacks) {
    this.scene = scene
    this.physics = physics
    this.callbacks = callbacks

    for (let i = 0; i < 2; i++) {
      const spot = new THREE.SpotLight(0xffe2b0, 0, 55, 0.55, 0.45, 1.4)
      spot.visible = false
      spot.castShadow = false
      const target = new THREE.Object3D()
      spot.target = target
      scene.add(spot)
      scene.add(target)
      this.headlights.push(spot)
      this.headlightTargets.push(target)
    }

    // smoke sprite pool
    this.smokeTexture = makeSmokeTexture()
    for (let i = 0; i < SMOKE_POOL_SIZE; i++) {
      const mat = new THREE.SpriteMaterial({
        map: this.smokeTexture,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      })
      const sprite = new THREE.Sprite(mat)
      sprite.visible = false
      sprite.scale.setScalar(1.6)
      scene.add(sprite)
      this.smokePool.push({ sprite, vx: 0, vy: 0, vz: 0, life: 0, maxLife: 1 })
    }

    // explosion fireball pool (core flash + flame skirt)
    this.fireballTexture = makeFireballTexture()
    for (let i = 0; i < FIREBALL_POOL_SIZE; i++) {
      const mat = new THREE.SpriteMaterial({
        map: this.fireballTexture,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
      const sprite = new THREE.Sprite(mat)
      sprite.visible = false
      scene.add(sprite)
      this.fireballPool.push({ sprite, life: 0, maxLife: 0.55, delay: 0 })
    }
  }

  // ------------------------------------------------------------------
  // Spawning
  // ------------------------------------------------------------------

  /** Spawn every content vehicle at every authored spawn location. */
  spawnFromContent(level: LevelData, vehiclesData: VehicleData[]): void {
    for (const data of vehiclesData) {
      const locs = data.spawnLocations.length > 0 ? data.spawnLocations : []
      if (locs.length === 0) {
        // No authored spots → park a couple near the level spawn roads.
        const base = level.spawnPoint
        this.spawnVehicle(data, new THREE.Vector3(base.x + 8, 0, base.z + 8), Math.PI / 2, false)
        this.spawnVehicle(data, new THREE.Vector3(base.x - 8, 0, base.z - 8), -Math.PI / 2, false)
        continue
      }
      locs.forEach((pos, i) => {
        // Face along the nearest grid road direction.
        const yaw = snapYawToRoad(pos.x, pos.z)
        this.spawnVehicle(data, new THREE.Vector3(pos.x, pos.y, pos.z), yaw, false, `${data.id}#${i}`)
      })
    }
  }

  /**
   * Spawn one vehicle instance (used for content spawns AND by Task 2-b's
   * TrafficSystem for AI traffic).
   */
  spawnVehicle(
    data: VehicleData,
    pos: THREE.Vector3,
    yaw: number,
    isTraffic: boolean,
    forceId?: string,
  ): VehicleController {
    const count = this.idCounter.get(data.id) ?? 0
    this.idCounter.set(data.id, count + 1)
    const id = forceId ?? `${data.id}#${count}`
    // Nudge out of buildings (e.g. police cruiser inside the station lot).
    const spot = this.findFreeSpot(pos, data)
    const v = new VehicleController(id, data, spot, yaw)
    v.isTraffic = isTraffic
    v.onSmokePuff = (x, y, z, dark) => this.emitSmoke(x, y, z, dark)
    this.scene.add(v.group)
    this.vehicles.push(v)
    return v
  }

  removeVehicle(id: string): boolean {
    const idx = this.vehicles.findIndex((v) => v.id === id)
    if (idx < 0) return false
    const v = this.vehicles[idx]
    if (v === this.playerVehicle) this.setPlayerDriving(null)
    this.scene.remove(v.group)
    v.dispose()
    this.vehicles.splice(idx, 1)
    return true
  }

  clear(): void {
    this.setPlayerDriving(null)
    for (const v of this.vehicles) {
      this.scene.remove(v.group)
      v.dispose()
    }
    this.vehicles.length = 0
    this.idCounter.clear()
  }

  private findFreeSpot(pos: THREE.Vector3, data: VehicleData): THREE.Vector3 {
    const r = Math.max(data.width, 2) * 0.5 + 0.6
    for (let ring = 0; ring < 7; ring++) {
      const off = ring * 7
      const tries: [number, number][] =
        ring === 0 ? [[0, 0]] : ringDirs.map(([dx, dz]) => [dx * off, dz * off])
      for (const [dx, dz] of tries) {
        const test = { x: pos.x + dx, y: pos.y, z: pos.z + dz }
        const res = this.physics.collideCircle(test, r, data.height * 0.7, false)
        if (!res.hit) return new THREE.Vector3(test.x, pos.y, test.z)
      }
    }
    return pos.clone()
  }

  // ------------------------------------------------------------------
  // Player driving
  // ------------------------------------------------------------------

  get playerVehicleId(): string | null {
    return this.playerVehicle?.id ?? null
  }

  setPlayerDriving(v: VehicleController | null): void {
    if (this.playerVehicle === v) return
    if (this.playerVehicle) this.playerVehicle.isPlayerDriving = false
    this.playerVehicle = v
    if (v) v.isPlayerDriving = true
    if (!v) {
      for (const h of this.headlights) h.visible = false
    }
  }

  /** Nearest DRIVABLE vehicle within maxDist (wrecks are not enterable). */
  getNearest(pos: THREE.Vector3, maxDist: number): VehicleController | null {
    let best: VehicleController | null = null
    let bestD = maxDist * maxDist
    for (const v of this.vehicles) {
      if (!v.drivable || v.isPlayerDriving || v.destroyed) continue
      const d = v.position.distanceToSquared(pos)
      if (d < bestD) {
        bestD = d
        best = v
      }
    }
    return best
  }

  getNearby(pos: THREE.Vector3, radius: number): { id: string; name: string; distance: number }[] {
    const out: { id: string; name: string; distance: number }[] = []
    for (const v of this.vehicles) {
      const d = v.position.distanceTo(pos)
      if (d <= radius) out.push({ id: v.id, name: v.data.name, distance: Math.round(d * 10) / 10 })
    }
    out.sort((a, b) => a.distance - b.distance)
    return out.slice(0, 6)
  }

  getById(id: string): VehicleController | null {
    return this.vehicles.find((v) => v.id === id) ?? null
  }

  // ------------------------------------------------------------------
  // Per-step update
  // ------------------------------------------------------------------

  /**
   * @param playerVehicleId the vehicle the player currently drives (gets
   * the input controls); all others idle.
   */
  update(dt: number, playerPos: THREE.Vector3, playerVehicleId: string | null, controls: VehicleControls): void {
    const idle = VehicleController.idleControls()
    for (const v of this.vehicles) {
      // Manager-level destroyed detection: covers external damage paths
      // (police rams, traffic crashes, debug cheats) that bypass the
      // controller's internal collision-branch destroyedNow flag.
      const wasDestroyed = v.destroyed
      const isDriven = v.id === playerVehicleId && v.drivable
      if (v.isTraffic && !isDriven) {
        // AI traffic is driven KINEMATICALLY by the TrafficSystem — running
        // the full controller here would double-integrate position (2×
        // speed), drag its velocity and accumulate phantom building
        // damage. Visuals only; motion belongs to TrafficSystem.
        v.updateVisuals(dt, 0)
      } else {
        const res = v.update(dt, isDriven ? controls : idle, this.physics)
        if (res.impactSpeed > 4) {
          this.callbacks.onShake(Math.min(0.6, res.impactSpeed * 0.035))
        }
      }
      if (!wasDestroyed && v.destroyed) {
        this.callbacks.onNotify(`${v.data.name} destroyed!`, 'danger')
        this.callbacks.onShake(0.5)
        this.explode(v)
      }
    }

    // Publish dynamic collision boxes (vehicles) to the physics world.
    const boxes: DynamicBox[] = []
    for (const v of this.vehicles) {
      const r = Math.max(v.data.length, v.data.width) / 2
      boxes.push({
        id: v.id,
        minX: v.position.x - r,
        maxX: v.position.x + r,
        minY: v.position.y,
        maxY: v.position.y + v.data.height * 0.8,
        minZ: v.position.z - r,
        maxZ: v.position.z + r,
      })
    }
    this.physics.setDynamicBoxes(boxes)

    this.updateSmoke(dt)
    this.updateFireballs(dt)
    this.updateHeadlights(playerPos)
  }

  private updateHeadlights(_playerPos: THREE.Vector3): void {
    const v = this.playerVehicle
    if (!v || !v.drivable || v.destroyed || !this.night) {
      for (const h of this.headlights) h.visible = false
      if (v) v.setHeadlightsOn(false)
      return
    }
    v.setHeadlightsOn(true)
    const fx = v.forwardX
    const fz = v.forwardZ
    for (let i = 0; i < this.headlights.length; i++) {
      const side = i === 0 ? -1 : 1
      const spot = this.headlights[i]
      v.getHeadlightOrigin(spot.position, side as -1 | 1)
      const t = this.headlightTargets[i]
      t.position.set(
        spot.position.x + fx * 22,
        spot.position.y - 1.2,
        spot.position.z + fz * 22,
      )
      spot.intensity = 120
      spot.visible = true
    }
  }

  setNight(night: boolean): void {
    this.night = night
  }

  // ------------------------------------------------------------------
  // Smoke particles
  // ------------------------------------------------------------------

  private emitSmoke(x: number, y: number, z: number, dark = false): void {
    const p = this.smokePool.find((s) => s.life <= 0)
    if (!p) return
    p.life = p.maxLife = 1.6
    p.vx = (Math.random() - 0.5) * 0.7
    p.vy = 1.3 + Math.random() * 0.8
    p.vz = (Math.random() - 0.5) * 0.7
    p.sprite.position.set(x, y, z)
    p.sprite.visible = true
    const mat = p.sprite.material as THREE.SpriteMaterial
    // Damage-tier tint: wispy steam stays warm-gray, critical/destroyed
    // smoke is near-black.
    mat.color.setHex(dark ? 0x35302c : 0x8d8781)
    mat.opacity = 0.55
    p.sprite.scale.setScalar(dark ? 1.6 : 1.2)
  }

  private updateSmoke(dt: number): void {
    for (const p of this.smokePool) {
      if (p.life <= 0) continue
      p.life -= dt
      if (p.life <= 0) {
        p.sprite.visible = false
        continue
      }
      p.sprite.position.x += p.vx * dt
      p.sprite.position.y += p.vy * dt
      p.sprite.position.z += p.vz * dt
      p.vy *= Math.exp(-0.4 * dt)
      const t = p.life / p.maxLife
      ;(p.sprite.material as THREE.SpriteMaterial).opacity = 0.5 * t
      p.sprite.scale.setScalar(1.2 + (1 - t) * 2.6)
    }
  }

  // ------------------------------------------------------------------
  // Explosion FX
  // ------------------------------------------------------------------

  /** Detonate a vehicle: double fireball flash + area effects. */
  private explode(v: VehicleController): void {
    const x = v.position.x
    const y = v.position.y + 0.8
    const z = v.position.z
    let started = 0
    for (const f of this.fireballPool) {
      if (f.life > 0 || f.delay > 0) continue
      if (started === 0) {
        f.life = f.maxLife
        f.delay = 0
      } else if (started === 1) {
        f.delay = 0.12 // secondary pop
      } else {
        break
      }
      f.sprite.position.set(x + (Math.random() - 0.5) * 1.2, y, z + (Math.random() - 0.5) * 1.2)
      f.sprite.visible = f.delay === 0
      f.sprite.scale.setScalar(1.4)
      ;(f.sprite.material as THREE.SpriteMaterial).opacity = 1
      started++
    }
    // Kick out a burst of dark smoke too.
    for (let i = 0; i < 3; i++) {
      this.emitSmoke(x + (Math.random() - 0.5) * 2, y + 0.6, z + (Math.random() - 0.5) * 2, true)
    }
    this.callbacks.onShake(0.7)
    this.callbacks.onExplosion?.({ x, y, z })
  }

  private updateFireballs(dt: number): void {
    for (const f of this.fireballPool) {
      if (f.delay > 0) {
        f.delay -= dt
        if (f.delay <= 0) {
          f.life = f.maxLife
          f.sprite.visible = true
          ;(f.sprite.material as THREE.SpriteMaterial).opacity = 1
        }
        continue
      }
      if (f.life <= 0) continue
      f.life -= dt
      if (f.life <= 0) {
        f.sprite.visible = false
        continue
      }
      const t = f.life / f.maxLife // 1 → 0
      const mat = f.sprite.material as THREE.SpriteMaterial
      mat.opacity = Math.min(1, t * 1.6)
      f.sprite.scale.setScalar(1.4 + (1 - t) * 5.2)
      f.sprite.position.y += dt * 2.2
    }
  }

  dispose(): void {
    this.clear()
    for (const h of this.headlights) {
      this.scene.remove(h)
      h.dispose()
    }
    for (const t of this.headlightTargets) this.scene.remove(t)
    for (const p of this.smokePool) {
      this.scene.remove(p.sprite)
      ;(p.sprite.material as THREE.SpriteMaterial).dispose()
    }
    for (const f of this.fireballPool) {
      this.scene.remove(f.sprite)
      ;(f.sprite.material as THREE.SpriteMaterial).dispose()
    }
    this.fireballTexture?.dispose()
    this.smokeTexture?.dispose()
  }
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

const ringDirs: [number, number][] = [
  [1, 0],
  [0.707, 0.707],
  [0, 1],
  [-0.707, 0.707],
  [-1, 0],
  [-0.707, -0.707],
  [0, -1],
  [0.707, -0.707],
]

/** Snap a spawn yaw to the nearest grid-road direction (0 / 90 / 180 / 270). */
function snapYawToRoad(x: number, z: number): number {
  const rx = ((x % 100) + 100) % 100
  const rz = ((z % 100) + 100) % 100
  const distV = Math.min(rx, 100 - rx) // distance to a vertical road (along Z)
  const distH = Math.min(rz, 100 - rz) // distance to a horizontal road (along X)
  return distV < distH ? 0 : Math.PI / 2
}

function makeSmokeTexture(): THREE.Texture {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 64
  const ctx = canvas.getContext('2d')!
  const grad = ctx.createRadialGradient(32, 32, 4, 32, 32, 30)
  grad.addColorStop(0, 'rgba(70, 66, 62, 0.9)')
  grad.addColorStop(0.6, 'rgba(88, 84, 80, 0.45)')
  grad.addColorStop(1, 'rgba(100, 96, 92, 0)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, 64, 64)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function makeFireballTexture(): THREE.Texture {
  // White-hot core → orange flame → dark red skirt (additive-blended).
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 128
  const ctx = canvas.getContext('2d')!
  const grad = ctx.createRadialGradient(64, 64, 4, 64, 64, 62)
  grad.addColorStop(0, 'rgba(255, 250, 235, 1)')
  grad.addColorStop(0.25, 'rgba(255, 190, 80, 0.95)')
  grad.addColorStop(0.55, 'rgba(240, 90, 30, 0.7)')
  grad.addColorStop(0.8, 'rgba(150, 30, 10, 0.28)')
  grad.addColorStop(1, 'rgba(60, 10, 5, 0)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, 128, 128)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}
