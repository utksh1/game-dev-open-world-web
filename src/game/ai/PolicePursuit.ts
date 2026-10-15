/**
 * PolicePursuit — THE last documented-but-missing gameplay pillar: police
 * CRUISERS that hunt the player's vehicle at wanted 3+. The original C++
 * project's pursuit existed only in its docs (foot cops + nothing else),
 * and the web rebuild previously stopped at foot pursuit too.
 *
 * Behavior:
 *   - ACTIVATION: wanted ≥ 3 while the player is DRIVING a vehicle
 *     (foot pursuit stays NPCManager's job). Cruiser count = wanted − 1
 *     (2 at three stars, 3 at four, 4 at five).
 *   - SPAWN: on a road graph node 70–150 m out, snapped to the right-hand
 *     lane, using the parsed `vehicle_police` .vehicle stats (150 km/h
 *     top speed, 1600 kg, lightbar + siren flags from the asset file).
 *   - CHASE (kinematic, like TrafficSystem but aggressive): pursuit
 *     target = player vehicle + velocity lead, rubber-banded speed
 *     (falls behind → speeds up; close → eases off to set up rams),
 *     yaw-steered with building collisions, inter-cruiser separation.
 *   - RAM: contact with the player's vehicle damages BOTH cars
 *     (player takes more — the cruiser is heavier), camera shake,
 *     crash audio, screen notification with cooldown.
 *   - ARREST: player vehicle stopped (< 1.5 m/s) with a cruiser within
 *     5.5 m for 3 s → BUSTED — yanked from the ride, $200 fine, wanted
 *     cleared, respawn at the police station (mirrors NPCManager's flow).
 *   - DEPLOY: player bails out on foot → cruisers brake, and the nearest
 *     one deploys 2 duty officers (NPCManager.spawnDutyPolice) before
 *     disengaging — a clean hand-off to the foot pursuit system.
 *   - DISENGAGE: wanted < 3 or player on foot → cruisers drive away and
 *     despawn beyond 140 m (or after 12 s).
 *
 * Registered as engine system 'pursuit'. Exposes getPursuit() for the
 * minimap blips and isPursuing() for the HUD banner.
 */
import * as THREE from 'three'
import type { EngineSystem, GameEngine } from '@/game/engine'
import type { Vec3, VehicleData } from '@/game/types'
import type { RoadNode } from '@/game/world/RoadGraph'
import type { VehicleController } from '@/game/vehicles/VehicleController'

export interface PursuitInfo {
  id: string
  position: Vec3
  speed: number
}

interface Cruiser {
  v: VehicleController
  speed: number
  /** 1 = active chase, 0 = disengaging/driving away. */
  active: boolean
  deployTimer: number // counts down once stopped near the on-foot player
  deployed: boolean // officers already handed off
  disengageTimer: number
  ramCooldown: number
  notifyCooldown: number
  destroyed: boolean
}

interface NpcLike {
  spawnDutyPolice?: (position: Vec3, count?: number) => void
  registerCrime?: (bump?: number) => void
}
interface AudioLike {
  play?: (name: string, opts?: { position?: Vec3; volume?: number }) => void
}

// ---------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------
const ACTIVATE_WANTED = 3
const MAX_CRUISERS = 4
const SPAWN_MIN_M = 70
const SPAWN_MAX_M = 150
const LANE_OFFSET = 2.5
const DESPAWN_M = 140
const DISENGAGE_SEC = 12
const BASE_SPEED = 26 // m/s (~94 km/h) — scaled per wanted + rubber-band
const LEAD_SEC = 0.55 // aim ahead of the player's velocity
const RAM_RANGE_FACTOR = 0.46 // (lenA + lenB) * factor = ram distance
const RAM_COOLDOWN = 0.9
const NOTIFY_COOLDOWN = 6
const ARREST_RANGE_M = 5.5
const ARREST_SPEED_MS = 1.5
const ARREST_HOLD_SEC = 3
const BOX_IN_HOLD_M = 6.5 // cruisers brake to a stop this far from a stopped car
const BUSTED_FINE = 200
const CRASH_AUDIO_COOLDOWN = 1.2
const DEPLOY_RANGE_M = 34
const SEPARATION_M = 6.5

export class PolicePursuit implements EngineSystem {
  private engine: GameEngine | null = null
  private cruisers: Cruiser[] = []
  private policeData: VehicleData | null = null
  private time = 0
  private spawnTimer = 0
  private arrestTimer = 0
  private boxedInWarned = false
  private crashAudioCooldown = 0
  private levelSize = { x: 1000, z: 1000 }
  private tmp = new THREE.Vector3()

  // =================================================================
  // EngineSystem hooks
  // =================================================================

  init(engine: GameEngine): void {
    this.engine = engine
    this.policeData =
      engine.content.vehicles.find(
        (v) =>
          v.vehicleClass.toLowerCase().includes('police') ||
          v.id.toLowerCase().includes('police'),
      ) ?? null
    this.rebuildForLevel()
    engine.onEvent((evt) => {
      if (evt.type === 'levelLoaded') this.rebuildForLevel()
    })
  }

  update(dt: number): void {
    const engine = this.engine
    if (!engine) return
    this.time += dt
    this.crashAudioCooldown -= dt

    const player = engine.player
    const wanted = player.wantedLevel
    const pvId = engine.vehicles.playerVehicleId
    const playerVeh = pvId ? engine.vehicles.getById(pvId) : null
    const driving = !!playerVeh && !playerVeh.destroyed
    const engaging = wanted >= ACTIVATE_WANTED && driving

    // ---- population management (throttled) ---------------------------
    this.spawnTimer -= dt
    if (this.spawnTimer <= 0) {
      this.spawnTimer = 0.8
      this.manageCruisers(engaging, wanted)
    }

    // ---- arrest check (stopped + boxed in) ---------------------------
    if (engaging) {
      const boxed =
        Math.abs(playerVeh!.getForwardSpeed()) < ARREST_SPEED_MS &&
        this.nearestCruiserDist(playerVeh!.position) <= ARREST_RANGE_M
      if (boxed) {
        this.arrestTimer += dt
        // One-shot warning the moment the arrest clock starts ticking —
        // the player has ARREST_HOLD_SEC seconds to floor it.
        if (this.arrestTimer >= 1 && !this.boxedInWarned) {
          this.boxedInWarned = true
          engine.notify('BOXED IN — floor it or get busted!', 'danger')
        }
        if (this.arrestTimer >= ARREST_HOLD_SEC) this.executeArrest()
      } else {
        this.arrestTimer = 0
        this.boxedInWarned = false
      }
    } else {
      this.arrestTimer = 0
      this.boxedInWarned = false
    }

    // ---- per-cruiser update ------------------------------------------
    for (let i = this.cruisers.length - 1; i >= 0; i--) {
      const c = this.cruisers[i]
      const v = c.v

      // Player commandeered a pursuit cruiser → it leaves the fleet.
      if (v.isPlayerDriving) {
        this.cruisers.splice(i, 1)
        engine.notify('You stole a police cruiser! Heat rising', 'warning')
        this.npcs()?.registerCrime?.(1)
        continue
      }

      if (v.destroyed) {
        if (!c.destroyed) {
          c.destroyed = true
          engine.notify('Cruiser disabled — heat rising', 'warning')
          this.npcs()?.registerCrime?.(1)
        }
        v.velocity.multiplyScalar(Math.exp(-2.4 * dt))
        if (v.position.distanceTo(player.position) > DESPAWN_M * 0.55) {
          engine.vehicles.removeVehicle(v.id)
          this.cruisers.splice(i, 1)
        }
        continue
      }

      // Despawn far-away or expired cruisers.
      const dist = v.position.distanceTo(player.position)
      if (dist > DESPAWN_M || (c.active === false && c.disengageTimer <= 0)) {
        engine.vehicles.removeVehicle(v.id)
        this.cruisers.splice(i, 1)
        continue
      }
      if (!c.active) c.disengageTimer -= dt

      // Deploy officers for the on-foot hand-off.
      if (!c.active && !c.deployed && dist < DEPLOY_RANGE_M) {
        c.deployTimer -= dt
        if (c.deployTimer <= 0 && c.speed < 2.5) {
          c.deployed = true
          this.npcs()?.spawnDutyPolice?.(v.position, 2)
          engine.notify('Officers deployed — they are on foot now', 'danger')
        }
      }

      this.driveCruiser(c, dt, playerVeh, engaging)
    }
  }

  dispose(): void {
    const engine = this.engine
    if (engine) {
      for (const c of this.cruisers) engine.vehicles.removeVehicle(c.v.id)
    }
    this.cruisers.length = 0
    this.engine = null
    this.policeData = null
  }

  getSaveData(): Record<string, unknown> {
    return {}
  }
  applySaveData(): void {
    /* pursuit state is not persisted */
  }

  // =================================================================
  // Public API
  // =================================================================

  /** Live pursuit snapshot for the minimap (rose blips). */
  getPursuit(): PursuitInfo[] {
    return this.cruisers
      .filter((c) => !c.destroyed)
      .map((c) => ({
        id: c.v.id,
        position: { x: c.v.position.x, y: c.v.position.y, z: c.v.position.z },
        speed: Math.round(c.speed * 10) / 10,
      }))
  }

  /** True when at least one cruiser is actively chasing the player. */
  isPursuing(): boolean {
    return this.cruisers.some((c) => c.active && !c.destroyed)
  }

  /**
   * Seconds remaining until BUSTED while the player is boxed in and
   * stopped, or null when no arrest is in progress. Drives the HUD's
   * flashing ARREST IN 3… banner.
   */
  getArrestCountdown(): number | null {
    if (this.arrestTimer <= 0) return null
    return Math.max(0, Math.ceil(ARREST_HOLD_SEC - this.arrestTimer))
  }

  // =================================================================
  // Internals
  // =================================================================

  private rebuildForLevel(): void {
    const engine = this.engine
    if (!engine) return
    for (const c of this.cruisers) engine.vehicles.removeVehicle(c.v.id)
    this.cruisers.length = 0
    this.levelSize = { x: engine.level.sizeX, z: engine.level.sizeZ }
    this.arrestTimer = 0
  }

  private manageCruisers(engaging: boolean, wanted: number): void {
    const engine = this.engine
    if (!engine || !this.policeData) return

    if (!engaging) {
      for (const c of this.cruisers) {
        if (c.active) {
          c.active = false
          c.disengageTimer = DISENGAGE_SEC
          c.deployTimer = 2.5
        }
      }
      return
    }

    const target = Math.min(MAX_CRUISERS, Math.max(0, wanted - 1))
    const current = this.cruisers.filter((c) => c.active && !c.destroyed).length
    if (current >= target) return

    const wasEmpty = current === 0
    for (let k = current; k < target; k++) {
      this.spawnCruiser(engine.player.position)
    }
    if (wasEmpty && this.cruisers.length > 0) {
      engine.notify('Cruisers on your tail — police pursuit engaged', 'danger')
    }
  }

  private spawnCruiser(playerPos: THREE.Vector3): void {
    const engine = this.engine
    if (!engine || !this.policeData) return
    const graph = engine.world.getRoadGraph()
    let x = playerPos.x + 90
    let z = playerPos.z + 90
    if (graph) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const node = graph.randomNodeNear(
          { x: playerPos.x, y: 0, z: playerPos.z },
          SPAWN_MAX_M,
        )
        const d = Math.hypot(node.x - playerPos.x, node.z - playerPos.z)
        if (d >= SPAWN_MIN_M && node.neighborIds.length > 0) {
          x = node.x
          z = node.z
          break
        }
      }
    }
    const v = engine.vehicles.spawnVehicle(
      this.policeData,
      new THREE.Vector3(x + LANE_OFFSET, 0, z),
      0,
      false,
    )
    v.setHeadlightsOn(true)
    this.cruisers.push({
      v,
      speed: 0,
      active: true,
      deployTimer: 2.5,
      deployed: false,
      disengageTimer: 0,
      ramCooldown: 0,
      notifyCooldown: 0,
      destroyed: false,
    })
  }

  /** Kinematic pursuit drive step. */
  private driveCruiser(
    c: Cruiser,
    dt: number,
    playerVeh: VehicleController | null,
    engaging: boolean,
  ): void {
    const engine = this.engine!
    const v = c.v
    c.ramCooldown -= dt
    c.notifyCooldown -= dt

    // ---- target -------------------------------------------------------
    let tx: number
    let tz: number
    if (c.active && playerVeh) {
      // Lead the player's velocity so rams land during evasion turns.
      tx = playerVeh.position.x + playerVeh.velocity.x * LEAD_SEC
      tz = playerVeh.position.z + playerVeh.velocity.z * LEAD_SEC
    } else {
      // Disengaging: drive away from the player.
      const dx = v.position.x - engine.player.position.x
      const dz = v.position.z - engine.player.position.z
      const len = Math.hypot(dx, dz) || 1
      tx = v.position.x + (dx / len) * 50
      tz = v.position.z + (dz / len) * 50
    }

    const toX = tx - v.position.x
    const toZ = tz - v.position.z
    const toDist = Math.hypot(toX, toZ) || 0.001

    // ---- speed control (rubber-banded) --------------------------------
    const playerMax = playerVeh ? playerVeh.data.maxSpeed / 3.6 : 33
    const wanted = engine.player.wantedLevel
    let targetSpeed = BASE_SPEED + wanted * 1.8
    let playerStopped = false
    if (c.active && playerVeh) {
      const dist = v.position.distanceTo(playerVeh.position)
      playerStopped = Math.abs(playerVeh.getForwardSpeed()) < ARREST_SPEED_MS
      if (playerStopped) {
        // BOX-IN: close the last meters slowly, then plant the cruiser for
        // the arrest hold. Rams are for FLEEING vehicles only — ramming a
        // stopped car shoves it over the speed threshold, resetting the
        // arrest clock forever while the car gets wrecked (round-2 QA bug).
        targetSpeed = dist > BOX_IN_HOLD_M ? Math.min(targetSpeed, 6) : 0
      } else {
        // Rubber-band: far behind → catch up; very close → ease (set up a ram).
        if (dist > 60) targetSpeed = Math.min(playerMax + 3, targetSpeed + (dist - 60) * 0.22)
        else if (dist < 12) targetSpeed = Math.max(12, targetSpeed * 0.6)
      }
    } else {
      targetSpeed = 16 // leaving the scene
    }
    const rate = targetSpeed < c.speed ? 14 : 7
    c.speed += THREE.MathUtils.clamp(targetSpeed - c.speed, -rate * dt, rate * dt)
    if (c.speed < 0.05) c.speed = 0

    // ---- steering + movement -------------------------------------------
    if (c.speed > 0) {
      const inv = 1 / toDist
      const mx = toX * inv
      const mz = toZ * inv
      v.position.x += mx * c.speed * dt
      v.position.z += mz * c.speed * dt
      v.position.x = THREE.MathUtils.clamp(v.position.x, 3, this.levelSize.x - 3)
      v.position.z = THREE.MathUtils.clamp(v.position.z, 3, this.levelSize.z - 3)
      v.velocity.set(mx * c.speed, 0, mz * c.speed)

      const targetYaw = Math.atan2(-mx, -mz)
      let deltaYaw = targetYaw - v.yaw
      while (deltaYaw > Math.PI) deltaYaw -= Math.PI * 2
      while (deltaYaw < -Math.PI) deltaYaw += Math.PI * 2
      v.yaw += deltaYaw * Math.min(1, dt * 4.2)
    } else {
      v.velocity.set(0, 0, 0)
    }

    // ---- ground / water -------------------------------------------------
    const ground = engine.physics.getGroundHeight(v.position.x, v.position.z)
    v.position.y += (ground - v.position.y) * Math.min(1, dt * 8)

    // ---- building collisions (slide + bounce) ---------------------------
    const radius = v.data.width * 0.55 + 0.45
    const hit = engine.physics.collideCircle(v.position, radius, v.data.height * 0.7, false)
    if (hit.hit && hit.depth > 0.001) {
      v.position.x += hit.nx * hit.depth
      v.position.z += hit.nz * hit.depth
      const into = v.velocity.x * hit.nx + v.velocity.z * hit.nz
      if (into < -3) {
        v.applyDamage(Math.min(18, -into * 1.4))
        c.speed *= 0.45
      }
      v.velocity.x -= hit.nx * into * 1.2
      v.velocity.z -= hit.nz * into * 1.2
    }

    // ---- separation from other cruisers ----------------------------------
    for (const other of this.cruisers) {
      if (other === c || other.v.destroyed) continue
      const dx = v.position.x - other.v.position.x
      const dz = v.position.z - other.v.position.z
      const d = Math.hypot(dx, dz)
      if (d < SEPARATION_M && d > 0.01) {
        const push = ((SEPARATION_M - d) / SEPARATION_M) * 4.5 * dt
        v.position.x += (dx / d) * push
        v.position.z += (dz / d) * push
      }
    }

    // ---- push-apart from traffic (round-2 QA: cruisers could clip -----
    // through traffic cars — kinematic chase vs kinematic lanes had no
    // inter-vehicle physics; traffic brakes for us, this catches the rest).
    for (const near of engine.vehicles.getNearby(v.position, 6)) {
      if (near.id === v.id) continue
      if (playerVeh && near.id === playerVeh.id) continue // ram block owns player contact
      if (this.cruisers.some((cc) => cc.v.id === near.id)) continue // handled above
      const other = engine.vehicles.getById(near.id)
      if (!other || other.destroyed) continue
      const dx = v.position.x - other.position.x
      const dz = v.position.z - other.position.z
      const d = Math.hypot(dx, dz)
      const minD = (v.data.length + other.data.length) * 0.42
      if (d < minD && d > 0.01) {
        const push = (minD - d) * 0.5
        v.position.x += (dx / d) * push
        v.position.z += (dz / d) * push
        other.position.x -= (dx / d) * push * 0.6
        other.position.z -= (dz / d) * push * 0.6
      }
    }

    // ---- ramming the player's vehicle -------------------------------------
    // Only while the player is FLEEING (≥ arrest speed). Stopped cars get
    // boxed in, not wrecked — that's the arrest flow's whole point.
    if (
      engaging &&
      playerVeh &&
      !playerStopped &&
      Math.abs(playerVeh.getForwardSpeed()) >= ARREST_SPEED_MS &&
      c.ramCooldown <= 0
    ) {
      const d = v.position.distanceTo(playerVeh.position)
      const ramRange = (v.data.length + playerVeh.data.length) * RAM_RANGE_FACTOR
      if (d < ramRange) {
        c.ramCooldown = RAM_COOLDOWN
        const impact = Math.abs(c.speed - Math.abs(playerVeh.getForwardSpeed()))
        const dmg = Math.max(6, impact * 3.4)
        playerVeh.applyDamage(dmg)
        v.applyDamage(dmg * 0.55)
        // Shove the player's car along the contact normal.
        this.tmp.copy(playerVeh.position).sub(v.position).setY(0)
        if (this.tmp.lengthSq() < 0.001) this.tmp.set(1, 0, 0)
        this.tmp.normalize()
        playerVeh.position.addScaledVector(this.tmp, ramRange - d + 0.1)
        playerVeh.velocity.addScaledVector(this.tmp, Math.min(6, impact * 0.5))
        if (this.crashAudioCooldown <= 0) {
          this.crashAudioCooldown = CRASH_AUDIO_COOLDOWN
          this.audio()?.play?.('crash', { position: v.position, volume: 0.9 })
        }
        if (c.notifyCooldown <= 0) {
          c.notifyCooldown = NOTIFY_COOLDOWN
          engine.notify('Rammed by a cruiser!', 'danger')
        }
      }
    }

    v.updateVisuals(dt, c.speed < targetSpeed * 0.6 ? 1 : 0)
  }

  private nearestCruiserDist(pos: THREE.Vector3): number {
    let best = Infinity
    for (const c of this.cruisers) {
      if (c.destroyed) continue
      const d = c.v.position.distanceTo(pos)
      if (d < best) best = d
    }
    return best
  }

  /** BUSTED while driving: mirrors NPCManager.executeBusted. */
  private executeArrest(): void {
    const engine = this.engine
    if (!engine) return
    this.arrestTimer = 0
    engine.emitEvent({ type: 'playerBusted' })
    engine.notify('BUSTED — pulled from your ride, $200 fine', 'danger')
    engine.setWantedLevel(0)
    const fine = Math.min(BUSTED_FINE, engine.player.money)
    if (fine > 0) engine.player.addMoney(-fine)
    // Respawn at the police station (fallback: level spawn).
    const station = engine.level.buildings.find((b) => b.type.toLowerCase().includes('police'))
    if (station) {
      engine.teleportPlayer({
        x: station.position.x,
        y: 0,
        z: station.position.z + station.size.z / 2 + 4,
      })
    } else {
      const sp = engine.level.spawnPoint
      engine.teleportPlayer({ x: sp.x, y: sp.y, z: sp.z })
    }
    // Cruisers disengage once the wanted level is cleared.
    this.manageCruisers(false, 0)
  }

  private npcs(): NpcLike | null {
    return (this.engine?.systems.npcs as unknown as NpcLike | undefined) ?? null
  }
  private audio(): AudioLike | null {
    return (this.engine?.systems.audio as unknown as AudioLike | undefined) ?? null
  }
}
