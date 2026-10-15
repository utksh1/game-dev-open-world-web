/**
 * TrafficSystem — ambient vehicles driving the road graph. THE gap fix:
 * the original C++ TrafficSystem was fully written but NEVER
 * instantiated (zero traffic ever spawned). Here every level gets
 * density-based traffic (low/medium/high → 6/10/16 concurrent cars)
 * spawned from authored traffic_spawn points near the player plus
 * ambient road-node spawns.
 *
 * Cars are spawned through VehicleManager.spawnVehicle(..., isTraffic)
 * and driven KINEMATICALLY by this system (position + yaw + velocity +
 * the controller's own visual update): follow the right-hand lane
 * (~2.5 m offset), 8-14 m/s, slow near intersections, stop for
 * obstacles ahead (player / vehicles / NPCs — box check 2-7 m), honk
 * after 2 s blocked. Despawn beyond 250 m.
 *
 * Player collisions: ramming a traffic car at speed damages both
 * vehicles, panics nearby NPCs and raises wanted level (+1, 10 s
 * cooldown). Cars hitting the player on foot deal damage.
 */
import * as THREE from 'three'
import type { EngineSystem, GameEngine } from '@/game/engine'
import type { Vec3, VehicleData } from '@/game/types'
import type { RoadGraph, RoadNode } from '@/game/world/RoadGraph'
import type { VehicleController } from '@/game/vehicles/VehicleController'
import type { VehicleManager } from '@/game/vehicles/VehicleManager'

export interface TrafficInfo {
  id: string
  position: Vec3
  speed: number
}

interface TrafficCar {
  v: VehicleController
  prevNode: RoadNode
  nextNode: RoadNode
  baseSpeed: number
  speed: number
  blockedTime: number
  honkCooldown: number
  crashCooldown: number
  pedCooldown: number
  wasDriven: boolean
  destroyed: boolean
}

interface NpcLike {
  getNPCs?: () => { id: string; position: Vec3; alive: boolean }[]
  damageNPC?: (id: string, amount: number, byPlayer: boolean) => void
  notifyCrash?: (position: Vec3, radius?: number) => void
  registerCrime?: (bump?: number) => void
  notifyGunshot?: (position: Vec3) => void
}
interface AudioLike {
  play?: (name: string, opts?: { position?: Vec3; volume?: number }) => void
}
interface PursuitLike {
  getPursuit?: () => { id: string; position: Vec3; speed: number }[]
}

const LANE_OFFSET = 2.5
const DESPAWN_M = 250
const SPAWN_MIN_M = 55
const SPAWN_MAX_M = 160
const HONK_AFTER_SEC = 2
const HONK_COOLDOWN = 4
const RAM_CRIME_COOLDOWN = 10
const ARRIVE_NODE_M = 3.2
const SLOW_NEAR_NODE_M = 14

export class TrafficSystem implements EngineSystem {
  private engine: GameEngine | null = null
  private graph: RoadGraph | null = null
  private cars: TrafficCar[] = []
  private popTimer = 0
  private time = 0
  private crimeCooldown = 0
  private levelSize = { x: 1000, z: 1000 }
  private tmp = new THREE.Vector3()

  // =================================================================
  // EngineSystem hooks
  // =================================================================

  init(engine: GameEngine): void {
    this.engine = engine
    this.rebuildForLevel()
    engine.onEvent((evt) => {
      if (evt.type === 'levelLoaded') this.rebuildForLevel()
    })
  }

  update(dt: number): void {
    const engine = this.engine
    if (!engine) return
    this.time += dt
    this.crimeCooldown -= dt

    const player = engine.player
    const playerVehId = engine.vehicles.playerVehicleId
    const playerVeh = playerVehId ? engine.vehicles.getById(playerVehId) : null

    // Cached NPC list for obstacle checks (refreshed at ~5 Hz).
    if (this.popTimer <= 0) {
      this.popTimer = 0.2
      this.npcsCache = this.npcs()?.getNPCs?.() ?? []
      this.pursuitCache = this.pursuit()?.getPursuit?.() ?? []
      // Night watcher: AI cars flip their headlight emissives after dark.
      const hour = engine.dayTime
      const night = hour >= 21 || hour < 6
      if (night !== this.night) {
        this.night = night
        for (const car of this.cars) car.v.setHeadlightsOn(night && !car.v.destroyed)
      }
    }
    this.popTimer -= dt

    // Population maintenance.
    if (this.time - this.lastPopCheck > 1.5) {
      this.lastPopCheck = this.time
      this.maintainPopulation()
    }

    for (let i = this.cars.length - 1; i >= 0; i--) {
      const car = this.cars[i]
      const v = car.v

      // Abandoned (player exited it) → drop from traffic control.
      if (car.wasDriven && !v.isPlayerDriving) {
        this.cars.splice(i, 1)
        continue
      }
      // Player is driving this car → physics handled by the engine.
      if (v.isPlayerDriving) {
        car.wasDriven = true
        continue
      }

      // Despawn far wrecks/cars.
      const distToPlayer = v.position.distanceTo(player.position)
      if (distToPlayer > DESPAWN_M) {
        engine.vehicles.removeVehicle(v.id)
        this.cars.splice(i, 1)
        continue
      }

      if (v.destroyed) {
        car.speed = 0
        v.velocity.set(0, 0, 0)
        continue // smoking wreck stays until despawn range
      }

      this.driveCar(car, dt)
      this.handlePlayerInteraction(car, playerVeh, dt)
    }
  }

  dispose(): void {
    const engine = this.engine
    if (!engine) return
    for (const car of this.cars) engine.vehicles.removeVehicle(car.v.id)
    this.cars.length = 0
    this.graph = null
    this.engine = null
  }

  getSaveData(): Record<string, unknown> {
    return {}
  }
  applySaveData(): void {
    /* traffic state is not persisted */
  }

  // =================================================================
  // Public API
  // =================================================================

  /** Live traffic snapshot for the minimap. */
  getTraffic(): TrafficInfo[] {
    return this.cars
      .filter((c) => !c.v.destroyed)
      .map((c) => ({
        id: c.v.id,
        position: { x: c.v.position.x, y: c.v.position.y, z: c.v.position.z },
        speed: Math.round(c.speed * 10) / 10,
      }))
  }

  /** Honk cluster + NPC panic around a crash point. */
  notifyCrash(position: Vec3): void {
    this.audio()?.play?.('crash', { position, volume: 0.8 })
    this.npcs()?.notifyCrash?.(position, 15)
  }

  /** Debug — spawn a burst of 6 cars near the player. */
  debugSpawnBurst(): void {
    const engine = this.engine
    if (!engine) return
    const player = engine.player.position
    for (let i = 0; i < 6; i++) {
      if (this.cars.length >= 24) break
      this.spawnOne({ x: player.x, y: 0, z: player.z }, 30 + i * 12)
    }
  }

  // =================================================================
  // Internals
  // =================================================================

  private npcsCache: { id: string; position: Vec3; alive: boolean }[] = []
  private pursuitCache: { id: string; position: Vec3; speed: number }[] = []
  private lastPopCheck = 0
  private night = false

  private rebuildForLevel(): void {
    const engine = this.engine
    if (!engine) return
    for (const car of this.cars) engine.vehicles.removeVehicle(car.v.id)
    this.cars.length = 0
    this.graph = engine.world.getRoadGraph()
    this.levelSize = { x: engine.level.sizeX, z: engine.level.sizeZ }
    this.npcsCache = []
    // Seed initial traffic around the player.
    const target = this.targetCount()
    for (let i = 0; i < target; i++) this.spawnOne(engine.player.position, 40 + i * 35)
  }

  private targetCount(): number {
    const density = this.engine?.level.trafficDensity.toLowerCase() ?? 'medium'
    if (density === 'low') return 6
    if (density === 'high') return 16
    return 10
  }

  private maintainPopulation(): void {
    const engine = this.engine
    if (!engine) return
    const alive = this.cars.filter((c) => !c.v.destroyed).length
    if (alive >= this.targetCount()) return
    this.spawnOne(engine.player.position, SPAWN_MIN_M + Math.random() * (SPAWN_MAX_M - SPAWN_MIN_M))
  }

  /** Spawn one traffic car on a road node `minR..maxR` from `center`. */
  private spawnOne(center: Vec3, radius: number): void {
    const engine = this.engine
    if (!engine || !this.graph) return
    const node = this.pickNode(center, radius)
    if (!node) return
    const next = this.pickNextNode(node, null)
    if (!next) return

    const data = this.pickVehicleData()
    if (!data) return

    // Position on the right-hand lane of the prev→next segment.
    const dir = norm2(node.x - 0, node.z - 0, next.x - node.x, next.z - node.z)
    const right = { x: -dir.z, z: dir.x }
    const pos = new THREE.Vector3(
      node.x + right.x * LANE_OFFSET,
      0,
      node.z + right.z * LANE_OFFSET,
    )
    const yaw = Math.atan2(-dir.x, -dir.z)
    const v = engine.vehicles.spawnVehicle(data, pos, yaw, true)
    v.setHeadlightsOn(this.night)
    const car: TrafficCar = {
      v,
      prevNode: node,
      nextNode: next,
      baseSpeed: 10 + Math.random() * 7,
      speed: 0,
      blockedTime: 0,
      honkCooldown: 0,
      crashCooldown: 0,
      pedCooldown: 0,
      wasDriven: false,
      destroyed: false,
    }
    this.cars.push(car)
  }

  private pickNode(center: Vec3, radius: number): RoadNode | null {
    if (!this.graph) return null
    for (let attempt = 0; attempt < 8; attempt++) {
      const node = this.graph.randomNodeNear(center, radius)
      const d = Math.hypot(node.x - center.x, node.z - center.z)
      if (d >= Math.min(25, radius * 0.5) && node.neighborIds.length > 0) return node
    }
    return null
  }

  private pickNextNode(from: RoadNode, avoid: RoadNode | null): RoadNode | null {
    if (!this.graph) return null
    const options = from.neighborIds
      .map((id) => this.graph!.getNode(id))
      .filter((n): n is RoadNode => !!n && n !== avoid)
    const pool = options.length > 0 ? options : from.neighborIds.map((id) => this.graph!.getNode(id)).filter((n): n is RoadNode => !!n)
    if (pool.length === 0) return null
    return pool[Math.floor(Math.random() * pool.length)]
  }

  private pickVehicleData(): VehicleData | null {
    const engine = this.engine
    if (!engine) return null
    const drivable = engine.content.vehicles.filter(
      (v) => v.type !== 'helicopter' && v.vehicleClass !== 'helicopter',
    )
    if (drivable.length === 0) return null
    // Weighted-ish: sedans/vans dominate, sports/police rarer.
    const roll = Math.random()
    let pool = drivable.filter((v) => v.vehicleClass.includes('sedan') || v.type === 'car')
    if (roll > 0.85) pool = drivable.filter((v) => v.vehicleClass.includes('police'))
    else if (roll > 0.7) pool = drivable.filter((v) => v.vehicleClass.includes('sport'))
    else if (roll > 0.6) pool = drivable.filter((v) => v.vehicleClass.includes('van') || v.type === 'truck' || v.type === 'motorcycle')
    if (pool.length === 0) pool = drivable
    return pool[Math.floor(Math.random() * pool.length)]
  }

  /** Kinematic lane-following drive step. */
  private driveCar(car: TrafficCar, dt: number): void {
    const engine = this.engine!
    const v = car.v

    // Lane target: next node offset to the right of travel direction.
    const dirX = car.nextNode.x - car.prevNode.x
    const dirZ = car.nextNode.z - car.prevNode.z
    const len = Math.hypot(dirX, dirZ) || 1
    const dx = dirX / len
    const dz = dirZ / len
    const rightX = -dz
    const rightZ = dx
    const targetX = car.nextNode.x + rightX * LANE_OFFSET
    const targetZ = car.nextNode.z + rightZ * LANE_OFFSET

    const toX = targetX - v.position.x
    const toZ = targetZ - v.position.z
    const toDist = Math.hypot(toX, toZ)

    // Arrived at the node → choose the next segment.
    if (toDist < ARRIVE_NODE_M) {
      const next = this.pickNextNode(car.nextNode, car.prevNode)
      if (next) {
        car.prevNode = car.nextNode
        car.nextNode = next
        return // re-aim next step
      }
    }

    // ---- obstacle check ahead (player, vehicles, NPCs) --------------
    const lookAhead = 2.5 + car.speed * 0.5
    const aheadX = v.position.x + dx * lookAhead * 0.7
    const aheadZ = v.position.z + dz * lookAhead * 0.7
    let blocked = false

    // Player on foot
    const player = engine.player
    const pd = Math.hypot(player.position.x - aheadX, player.position.z - aheadZ)
    if (pd < 1.9) blocked = true

    // Player vehicle
    const pvId = engine.vehicles.playerVehicleId
    const pv = pvId ? engine.vehicles.getById(pvId) : null
    if (!blocked && pv && pv !== v) {
      const vd = Math.hypot(pv.position.x - aheadX, pv.position.z - aheadZ)
      if (vd < 3.3) blocked = true
    }

    // Other traffic
    if (!blocked) {
      for (const other of this.cars) {
        if (other.v === v || other.v.destroyed) continue
        const od = Math.hypot(other.v.position.x - aheadX, other.v.position.z - aheadZ)
        if (od < 3.4) {
          blocked = true
          break
        }
      }
    }

    // Police pursuit cruisers (ram anything in their way — civilians brake)
    if (!blocked) {
      for (const pc of this.pursuitCache) {
        const pd = Math.hypot(pc.position.x - aheadX, pc.position.z - aheadZ)
        if (pd < 4.0) {
          blocked = true
          break
        }
      }
    }

    // NPCs crossing
    if (!blocked) {
      for (const npc of this.npcsCache) {
        if (!npc.alive) continue
        const nd = Math.hypot(npc.position.x - aheadX, npc.position.z - aheadZ)
        if (nd < 1.7) {
          blocked = true
          // Actually ran someone over?
          if (nd < 1.1 && car.speed > 2.5 && car.pedCooldown <= 0) {
            car.pedCooldown = 1.5
            this.npcs()?.damageNPC?.(npc.id, 30, false)
          }
          break
        }
      }
    }
    car.pedCooldown -= dt

    // ---- speed control ----------------------------------------------
    let targetSpeed = car.baseSpeed
    if (toDist < SLOW_NEAR_NODE_M) targetSpeed *= 0.55 // intersection caution
    if (blocked) targetSpeed = 0
    const rate = targetSpeed < car.speed ? 12 : 5
    car.speed += THREE.MathUtils.clamp(targetSpeed - car.speed, -rate * dt, rate * dt)
    if (car.speed < 0.05) car.speed = 0

    if (blocked) {
      car.blockedTime += dt
      car.honkCooldown -= dt
      if (car.blockedTime > HONK_AFTER_SEC && car.honkCooldown <= 0) {
        car.honkCooldown = HONK_COOLDOWN
        this.audio()?.play?.('horn', { position: v.position, volume: 0.55 })
      }
    } else {
      car.blockedTime = 0
    }

    // ---- move --------------------------------------------------------
    if (car.speed > 0 && toDist > 0.01) {
      const inv = 1 / toDist
      const mx = toX * inv
      const mz = toZ * inv
      v.position.x += mx * car.speed * dt
      v.position.z += mz * car.speed * dt
      v.position.x = THREE.MathUtils.clamp(v.position.x, 3, this.levelSize.x - 3)
      v.position.z = THREE.MathUtils.clamp(v.position.z, 3, this.levelSize.z - 3)
      const ground = engine.physics.getGroundHeight(v.position.x, v.position.z)
      v.position.y += (ground - v.position.y) * Math.min(1, dt * 8)
      v.velocity.set(mx * car.speed, 0, mz * car.speed)
      const targetYaw = Math.atan2(-mx, -mz)
      let deltaYaw = targetYaw - v.yaw
      while (deltaYaw > Math.PI) deltaYaw -= Math.PI * 2
      while (deltaYaw < -Math.PI) deltaYaw += Math.PI * 2
      v.yaw += deltaYaw * Math.min(1, dt * 5)
    } else {
      v.velocity.set(0, 0, 0)
    }
    v.updateVisuals(dt, blocked ? 1 : 0)
  }

  /** Ramming / run-over interactions with the player. */
  private handlePlayerInteraction(car: TrafficCar, playerVeh: VehicleController | null, dt: number): void {
    const engine = this.engine!
    const v = car.v
    car.crashCooldown -= dt

    if (playerVeh && playerVeh !== v) {
      const d = playerVeh.position.distanceTo(v.position)
      const minD = (playerVeh.data.length + v.data.length) * 0.42
      if (d < minD) {
        // Push the traffic car out along the contact normal.
        this.tmp.copy(v.position).sub(playerVeh.position).setY(0)
        if (this.tmp.lengthSq() < 0.001) this.tmp.set(1, 0, 0)
        this.tmp.normalize()
        v.position.addScaledVector(this.tmp, minD - d + 0.05)

        const playerSpeed = Math.abs(playerVeh.getForwardSpeed())
        const impact = Math.max(0, playerSpeed - car.speed)
        if (impact > 6 && car.crashCooldown <= 0) {
          car.crashCooldown = 1
          v.applyDamage(impact * 6)
          playerVeh.applyDamage(impact * 3)
          this.notifyCrash({ x: v.position.x, y: v.position.y, z: v.position.z })
          // Wanted +1 on a hard hit (10 s cooldown across all hits).
          if (this.crimeCooldown <= 0) {
            this.crimeCooldown = RAM_CRIME_COOLDOWN
            this.npcs()?.registerCrime?.(1)
            engine.notify('Hit-and-run! Wanted level up', 'warning')
          }
        }
      }
    } else if (!playerVeh) {
      // Player on foot vs this car.
      const player = engine.player
      const d = player.position.distanceTo(v.position)
      if (d < 1.8 && car.speed > 3 && car.crashCooldown <= 0) {
        car.crashCooldown = 1.5
        engine.damagePlayer(Math.min(45, car.speed * 6), 'traffic')
        car.speed *= 0.3 // screech to a halt
      }
    }
  }

  private npcs(): NpcLike | null {
    return (this.engine?.systems.npcs as unknown as NpcLike | undefined) ?? null
  }

  private audio(): AudioLike | null {
    return (this.engine?.systems.audio as unknown as AudioLike | undefined) ?? null
  }
  private pursuit(): PursuitLike | null {
    return (this.engine?.systems.pursuit as unknown as PursuitLike | undefined) ?? null
  }
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
function norm2(_ox: number, _oz: number, dx: number, dz: number): { x: number; z: number } {
  const len = Math.hypot(dx, dz) || 1
  return { x: dx / len, z: dz / len }
}

/** Re-exported for MissionSystem's mission-vehicle driver (shared shape). */
export type { VehicleManager }
