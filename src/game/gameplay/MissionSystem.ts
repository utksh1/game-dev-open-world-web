/**
 * MissionSystem — the full 15-objective-type mission runtime. THE gap
 * fix: the original C++ MissionSystem ran on uninitialized pointers and
 * could load 0 of the 14 asset missions. This system loads ALL of them
 * via the content bundle and implements every objective type:
 *
 *   goto · interact · timer · survive · eliminate · defend · collect ·
 *   chase · race · steal · observe · locate · escort · escape · destroy
 *
 * Lifecycle: campaign missions unlock in chain order
 * (campaign.unlock === 'start' or unlock-mission completed); side
 * missions are always available and repeatable. One active mission at
 * a time. World markers (amber pulsing cylinders) show available
 * missions at their startPosition — walk up and press E, or let the
 * UI call startMission after a briefing (getAvailableMissions powers
 * the briefing screen).
 *
 * Registered as engine system 'missions'. It also bootstraps the
 * shared PickupManager as system 'pickups' during init and hooks
 * NPCManager.onNpcKilled for objective kill counting / escort fails.
 */
import * as THREE from 'three'
import type { EngineSystem, GameEngine, WeaponsAction, MissionAction } from '@/game/engine'
import type { SystemSaveFragment } from '@/game/engine'
import type {
  CampaignData,
  MissionData,
  MissionObjective,
  MissionOpponent,
  MissionStatus,
  MissionRuntime,
  RaceHudState,
  Vec3,
} from '@/game/types'
import type { RoadNode } from '@/game/world/RoadGraph'
import type { VehicleController } from '@/game/vehicles/VehicleController'
import { PickupManager } from './Pickups'

// ---------------------------------------------------------------------
// Public shapes (UI / other systems)
// ---------------------------------------------------------------------

export interface AvailableMission {
  id: string
  name: string
  description: string
  difficulty: string
  isSide: boolean
  repeatable: boolean
  status: MissionStatus
  rewardMoney: number
  rewardXp: number
  requiredItems: string[]
  startPosition: Vec3 | null
  /** Side-hustle fatigue: completed runs so far (drives payMultiplier). */
  repeatCount: number
  /** 1.0 on the first run, decaying to a 40% floor for grinders. */
  payMultiplier: number
  /** Best-ever race time (seconds) — race missions only. */
  bestTime: number | null
}

/** Live AI race opponent (minimap blips / debug views). */
export interface RaceOpponentInfo {
  id: string
  name: string
  position: Vec3
  place: number
  finished: boolean
}

interface NpcSystemLike {
  spawnEnemy?: (
    type: string,
    position: Vec3,
    opts?: { hostile?: boolean; missionId?: string; ally?: boolean; healthOverride?: number },
  ) => string
  removeMissionNpcs?: (missionId: string) => void
  getNPCById?: (id: string) => { id: string; position: Vec3; alive: boolean } | null
  getNPCs?: () => { id: string; position: Vec3; alive: boolean }[]
  onNpcKilled: ((npcId: string, npcType: string, missionId: string | null, byPlayer: boolean) => void) | null
  registerCrime?: (bump?: number) => void
  notifyCrash?: (position: Vec3, radius?: number) => void
}
interface WeaponsSystemLike {
  getWeaponsOwned?: () => string[]
}
interface AudioLike {
  play?: (name: string, opts?: { position?: Vec3; volume?: number }) => void
}

interface ObjState {
  timer: number
  zoneTimer: number
  waveTimer: number
  chaseCloseTime: number
  checkpoints: Vec3[]
  checkpointIndex: number
  treating: boolean
  ramCooldown: number
  /** Race: 3-2-1-GO! countdown remaining; ≤ 0 once the race is live. */
  countdown: number
  /** Race: seconds since GO!. */
  raceElapsed: number
  /** Race: remaining seconds of the big GO! flash in the HUD. */
  raceGoFlash: number
  /** Race: scale-pop timer on the checkpoint gate when it's claimed. */
  gateFlash: number
}

interface ActiveMission {
  data: MissionData
  objectiveIndex: number
  obj: ObjState
  spawnedTriggers: Set<number>
  targetVehicleId: string | null
  allyNpcId: string | null
  kills: number
  collected: number
  startedAt: number
  zoneCenter: Vec3 | null
  dangerPoint: Vec3 | null
}

// ---------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------
const MARKER_NEAR_M = 4
const MARKER_HINT_M = 4.5
const DEFAULT_GOTO_RADIUS = 10
const ELIMINATE_SPAWN_MIN = 22
const ELIMINATE_SPAWN_MAX = 48
const ZONE_GRACE_SEC = 5
const DEFEND_WAVE_SEC = 20
const CHASE_NEED_SEC = 5
const COLLECT_RADIUS = 35
const RACE_COUNTDOWN_SEC = 3
const RACE_GO_FLASH_SEC = 0.9
/** Race opponent base speed (m/s ≈ 86 km/h) — scaled by skill + rubber-band. */
const RACE_OPP_BASE_SPEED = 24
/** Opponent claim radius matches the player's checkpoint gate radius. */
const RACE_CP_RADIUS = 12
/** Max AI opponents per race (authored files cap at 7). */
const RACE_OPP_MAX = 7
/** Side-hustle fatigue: pay multiplier by number of PRIOR completions. */
const HUSTLE_PAY_MULT = [1, 0.7, 0.55, 0.45, 0.4]

export class MissionSystem implements EngineSystem {
  private engine: GameEngine | null = null
  private scene: THREE.Scene | null = null
  private time = 0

  private completed = new Set<string>()
  private campaignProgress = 0
  private campaignCompleted = false
  private active: ActiveMission | null = null
  private pendingRestartId: string | null = null

  // Race records + side-hustle fatigue (persisted via save fragments).
  private bestRaceTimes = new Map<string, number>()
  private sideHustleCounts = new Map<string, number>()

  // AI race opponents (round 4): authored count 3-7, kinematic road
  // racers with rubber-band speed + live standings.
  private racers: RaceOpponent[] = []
  /** Mirror of the night state used to flip rival headlights mid-race. */
  private racersNight = false
  /** Player's current place among all racers (null until GO, or solo race). */
  private playerPlace: number | null = null
  private lastNotifiedPlace: number | null = null

  // Checkpoint gate visual (race objectives): a standing torus you drive
  // through, plus an inner bright ring — replaces the flat ground beacon
  // as the race's focal marker.
  private raceGate: THREE.Group | null = null
  private raceGateOuter: THREE.Mesh | null = null
  private raceGateInner: THREE.Mesh | null = null

  // Chase/destroy target highlight: pulsing amber ground ring that hugs
  // the fleeing/wreckable vehicle so the target reads at a glance.
  private chaseRing: THREE.Mesh | null = null

  // Markers + beacon visuals
  private markers = new Map<string, THREE.Group>()
  private notifiedMarkers = new Set<string>()
  private markersDirty = true
  private beacon: THREE.Group | null = null
  private beaconColumn: THREE.Mesh | null = null
  private beaconRing: THREE.Mesh | null = null
  private beaconPos: Vec3 | null = null

  // Chase/destroy mission vehicle driver
  private fleeing: FleeingVehicle | null = null

  private tmp = new THREE.Vector3()

  // =================================================================
  // EngineSystem hooks
  // =================================================================

  init(engine: GameEngine): void {
    this.engine = engine
    this.scene = engine.scene

    // Bootstrap the shared pickup manager as its own engine system.
    if (!engine.systems.pickups) {
      engine.registerSystem('pickups', new PickupManager())
    }

    // Objective kill counting + escort death detection.
    const npcs = this.npcSystem()
    if (npcs) {
      npcs.onNpcKilled = (npcId, npcType, missionId, byPlayer) => {
        this.handleNpcKilled(npcId, npcType, missionId, byPlayer)
      }
    }

    // Global fail conditions.
    engine.onEvent((evt) => {
      if (evt.type === 'playerWasted') this.failMission('wasted')
      else if (evt.type === 'playerBusted') this.failMission('busted')
      else if (evt.type === 'levelLoaded' && this.active) this.failMission('level changed')
    })
  }

  update(dt: number): void {
    const engine = this.engine
    if (!engine) return
    this.time += dt

    // Save-driven restart of an interrupted mission.
    if (this.pendingRestartId) {
      const id = this.pendingRestartId
      this.pendingRestartId = null
      if (!this.active) this.startMission(id)
    }

    this.updateBeaconVisual(dt)
    this.updateRaceGateVisual(dt)
    this.updateChaseRingVisual(dt)

    if (this.markersDirty) this.rebuildMarkers()
    this.updateMarkers(dt)

    const mission = this.active
    if (!mission) return

    // Mission-wide time limit.
    if (mission.data.timeLimit && this.time - mission.startedAt > mission.data.timeLimit) {
      this.failMission('out of time')
      return
    }

    // Chase target driving.
    if (this.fleeing) this.fleeing.update(dt, engine.player.position, engine.physics)

    this.tickObjective(mission, dt)
  }

  dispose(): void {
    const engine = this.engine
    this.cleanupMission(false)
    if (engine) {
      for (const group of this.markers.values()) engine.scene.remove(group)
    }
    this.markers.clear()
    if (this.beacon && engine) engine.scene.remove(this.beacon)
    this.beacon = null
    if (this.chaseRing && engine) {
      engine.scene.remove(this.chaseRing)
      this.chaseRing.geometry.dispose()
      ;(this.chaseRing.material as THREE.Material).dispose()
      this.chaseRing = null
    }
    if (this.raceGate && engine) {
      engine.scene.remove(this.raceGate)
      this.raceGate.traverse((obj) => {
        const mesh = obj as THREE.Mesh
        if (mesh.geometry) mesh.geometry.dispose()
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
        else mat?.dispose()
      })
    }
    this.raceGate = null
    this.raceGateOuter = null
    this.raceGateInner = null
    this.engine = null
    this.scene = null
  }

  onAction(action: WeaponsAction | MissionAction): void {
    if (action !== 'interact') return
    const engine = this.engine
    if (!engine) return

    // 1) Active objective interact.
    const mission = this.active
    if (mission) {
      const o = mission.data.objectives[mission.objectiveIndex]
      if (o && o.type === 'interact') {
        const pos = this.objectiveTargetPosition(o)
        const radius = this.interactRadius(o)
        const player = engine.player.position
        if (pos && Math.hypot(player.x - pos.x, player.z - pos.z) <= radius) {
          if (o.duration && !mission.obj.treating) {
            mission.obj.treating = true
            mission.obj.timer = o.duration
            engine.notify('Hold on…', 'info')
            return
          }
          this.completeObjective()
          return
        }
      }
      return // a mission is active — markers cannot start another
    }

    // 2) Mission markers within reach.
    const player = engine.player.position
    for (const [missionId, group] of this.markers) {
      const wp = group.position
      if (Math.hypot(player.x - wp.x, player.z - wp.z) <= MARKER_NEAR_M) {
        const result = this.startMission(missionId)
        if (!result.ok) engine.notify(result.message ?? 'Cannot start mission', 'warning')
        return
      }
    }
  }

  // startMission hook used by the engine facade.
  startMission(missionId: string): { ok: boolean; message?: string } {
    const engine = this.engine
    if (!engine) return { ok: false, message: 'Mission system not ready' }
    if (this.active) return { ok: false, message: 'Finish your current mission first' }

    const mission = engine.content.missions.find((m) => m.id === missionId)
    if (!mission) return { ok: false, message: `Unknown mission "${missionId}"` }

    const status = this.statusOf(mission)
    if (status === 'locked') {
      const unlock = this.unlockRequirement(mission)
      return { ok: false, message: `Locked — complete "${unlock}" first` }
    }
    if (status === 'completed') return { ok: false, message: 'Mission already completed' }

    const missing = this.checkRequiredItems(mission)
    if (missing) return { ok: false, message: `Requires ${missing}` }

    this.active = {
      data: mission,
      objectiveIndex: -1,
      obj: {
        timer: 0, zoneTimer: 0, waveTimer: 0, chaseCloseTime: 0,
        checkpoints: [], checkpointIndex: 0, treating: false, ramCooldown: 0,
        countdown: 0, raceElapsed: 0, raceGoFlash: 0, gateFlash: 0,
      },
      spawnedTriggers: new Set(),
      targetVehicleId: null,
      allyNpcId: null,
      kills: 0,
      collected: 0,
      startedAt: this.time,
      zoneCenter: null,
      dangerPoint: null,
    }
    if (mission.startPosition) {
      engine.teleportPlayer(mission.startPosition)
    }
    this.markersDirty = true
    this.beginObjective(0)
    engine.emitEvent({ type: 'missionStarted', missionId: mission.id, name: mission.name })
    engine.notify(`Mission started — ${mission.name}`, 'success')
    return { ok: true }
  }

  getHudMission(): MissionRuntime | null {
    const engine = this.engine
    const mission = this.active
    if (!engine || !mission) return null
    const o = mission.data.objectives[mission.objectiveIndex]
    const elapsed = this.time - mission.startedAt
    const timeLeft = mission.data.timeLimit ? Math.max(0, mission.data.timeLimit - elapsed) : null
    let race: RaceHudState | null = null
    if (o?.type === 'race') {
      const ro = mission.obj
      const solo = this.racers.length === 0
      race = {
        checkpointIndex: ro.checkpointIndex,
        total: ro.checkpoints.length,
        elapsed: ro.countdown <= 0 ? Math.round(ro.raceElapsed * 10) / 10 : null,
        countdown: ro.countdown > 0 ? Math.ceil(ro.countdown) : ro.raceGoFlash > 0 ? 0 : null,
        best: this.bestRaceTimes.get(mission.data.id) ?? null,
        place: solo ? null : this.playerPlace,
        racerCount: this.racers.filter((r) => !r.disqualified).length + 1,
        leaderName: !solo && this.playerPlace !== null && this.playerPlace > 1
          ? this.raceLeaderName()
          : null,
      }
    }
    return {
      missionId: mission.data.id,
      name: mission.data.name,
      description: mission.data.description,
      status: 'active',
      currentObjectiveIndex: mission.objectiveIndex,
      objectiveDescription: o?.description ?? '',
      objectiveProgress: this.objectiveProgress(mission),
      objectiveTimer: this.objectiveTimer(mission),
      waypoint: this.beaconPos,
      timeLeft,
      race,
    }
  }

  getSaveData(): SystemSaveFragment {
    return {
      missionsCompleted: [...this.completed],
      campaignProgress: this.campaignProgress,
      campaignCompleted: this.campaignCompleted,
      activeMissionId: this.active?.data.id ?? null,
      bestRaceTimes: Object.fromEntries(this.bestRaceTimes),
      sideHustleCounts: Object.fromEntries(this.sideHustleCounts),
    }
  }

  applySaveData(data: SystemSaveFragment): void {
    this.completed = new Set((data.missionsCompleted as string[] | undefined) ?? [])
    this.campaignProgress = (data.campaignProgress as number | undefined) ?? 0
    this.campaignCompleted = (data.campaignCompleted as boolean | undefined) ?? false
    const activeId = data.activeMissionId as string | null | undefined
    this.pendingRestartId = activeId ?? null
    this.bestRaceTimes = new Map(
      Object.entries((data.bestRaceTimes as Record<string, number> | undefined) ?? {}),
    )
    this.sideHustleCounts = new Map(
      Object.entries((data.sideHustleCounts as Record<string, number> | undefined) ?? {}),
    )
    this.markersDirty = true
  }

  // =================================================================
  // Public API for the UI (Task 2-c briefing / mission list screens)
  // =================================================================

  /** All missions with resolved status — powers the briefing modal. */
  getAvailableMissions(): AvailableMission[] {
    const engine = this.engine
    if (!engine) return []
    return engine.content.missions.map((m) => {
      const repeatCount = m.isSide ? (this.sideHustleCounts.get(m.id) ?? 0) : 0
      return {
        id: m.id,
        name: m.name,
        description: m.description,
        difficulty: m.difficulty,
        isSide: m.isSide,
        repeatable: m.repeatable,
        status: this.statusOf(m),
        rewardMoney: m.rewardMoneyMax
          ? Math.round((m.rewardMoneyMin ?? m.rewardMoney) + Math.random() * ((m.rewardMoneyMax) - (m.rewardMoneyMin ?? m.rewardMoney)))
          : m.rewardMoney,
        rewardXp: m.rewardXp,
        requiredItems: m.requiredItems,
        startPosition: m.startPosition ?? null,
        repeatCount,
        payMultiplier: m.isSide
          ? HUSTLE_PAY_MULT[Math.min(repeatCount, HUSTLE_PAY_MULT.length - 1)]
          : 1,
        bestTime: this.bestRaceTimes.get(m.id) ?? null,
      }
    })
  }

  /** Debug cheat — force-complete the current objective. */
  debugCompleteObjective(): boolean {
    if (!this.active) return false
    this.completeObjective()
    return true
  }

  // =================================================================
  // Objective lifecycle
  // =================================================================

  private beginObjective(index: number): void {
    const engine = this.engine!
    const mission = this.active!
    if (index >= mission.data.objectives.length) {
      this.completeMission()
      return
    }
    mission.objectiveIndex = index
    const o = mission.data.objectives[index]
    const obj = mission.obj
    obj.treating = false
    // The checkpoint gate belongs to race objectives only — hide it when
    // the mission moves on to any other objective type. Same for the
    // chase/destroy target ring.
    if (o.type !== 'race') this.hideRaceGate()
    if (o.type !== 'chase' && o.type !== 'destroy') this.hideChaseRing()
    obj.zoneTimer = 0
    obj.chaseCloseTime = 0

    // Fire enemy spawn triggers bound to this objective index.
    this.fireEnemyTriggers(mission, index)

    switch (o.type) {
      case 'goto':
      case 'observe':
      case 'locate': {
        const pos = this.objectiveTargetPosition(o)
        if (pos) this.showBeacon(pos)
        obj.timer = o.type === 'goto' ? 0 : (o.duration ?? 5)
        if (o.type === 'locate') {
          // Locate: ensure a target enemy exists near the beacon.
          this.spawnObjectiveEnemy(mission, o)
        }
        break
      }
      case 'interact': {
        const pos = this.objectiveTargetPosition(o)
        if (pos) this.showBeacon(pos)
        obj.timer = o.duration ?? 0
        break
      }
      case 'timer': {
        obj.timer = o.duration ?? 60
        this.hideBeacon()
        break
      }
      case 'survive': {
        obj.timer = o.duration ?? 60
        const pos = this.objectiveTargetPosition(o)
        if (pos && o.radius) {
          mission.zoneCenter = pos
          this.showBeacon(pos)
        } else {
          mission.zoneCenter = null
          this.hideBeacon()
        }
        if (o.wantedLevel) engine.setWantedLevel(Math.max(engine.player.wantedLevel, o.wantedLevel))
        break
      }
      case 'eliminate': {
        this.spawnObjectiveEnemy(mission, o)
        this.hideBeacon()
        mission.kills = 0
        break
      }
      case 'defend': {
        obj.timer = o.duration ?? 60
        obj.waveTimer = 6
        const pos = this.objectiveTargetPosition(o)
        mission.zoneCenter = pos ?? {
          x: engine.player.position.x, y: 0, z: engine.player.position.z,
        }
        this.showBeacon(mission.zoneCenter)
        break
      }
      case 'collect': {
        this.spawnCollectibles(mission, o)
        const pos = this.objectiveTargetPosition(o)
        if (pos) this.showBeacon(pos)
        else this.hideBeacon()
        break
      }
      case 'chase': {
        this.spawnTargetVehicle(mission, o, 60, 100, 15 + Math.random() * 4)
        const v = this.getMissionVehicle(mission)
        if (v) this.showChaseRing(v)
        obj.timer = o.duration ?? o.timeLimit ?? 120
        break
      }
      case 'race': {
        // Authored circuit (mission_02's five fixed gates) when present,
        // else a generated road-node course.
        obj.checkpoints =
          o.checkpoints && o.checkpoints.length >= 2
            ? o.checkpoints.map((c) => ({ ...c }))
            : this.generateRaceCheckpoints(o.targetCount)
        obj.checkpointIndex = 0
        obj.timer = o.duration ?? o.timeLimit ?? 30
        obj.countdown = RACE_COUNTDOWN_SEC // ceil displays exactly 3 → 2 → 1
        obj.raceElapsed = 0
        obj.raceGoFlash = 0
        obj.gateFlash = 0
        this.spawnRaceOpponents(mission, o)
        this.showBeacon(obj.checkpoints[0])
        this.showRaceGate(obj.checkpoints[0], false)
        this.audio()?.play?.('race_countdown', { volume: 0.8 })
        engine.notify(
          this.racers.length > 0
            ? `Race! ${this.racers.length + 1} racers — beat them to the checkpoints`
            : 'Race! Reach the checkpoints',
          'warning',
        )
        break
      }
      case 'steal': {
        this.spawnTargetVehicle(mission, o, 15, 32, 0)
        const v = this.getMissionVehicle(mission)
        if (v) this.showBeacon({ x: v.position.x, y: 0, z: v.position.z })
        break
      }
      case 'escort': {
        const npcs = this.npcSystem()
        const player = engine.player.position
        const escortPos = this.objectiveTargetPosition(o)
        const spawnPos: Vec3 = escortPos ?? { x: player.x + 2, y: 0, z: player.z + 2 }
        mission.allyNpcId =
          npcs?.spawnEnemy?.('civilian', spawnPos, {
            hostile: false,
            ally: true,
            missionId: mission.data.id,
          }) ?? null
        if (escortPos) this.showBeacon(escortPos)
        break
      }
      case 'escape': {
        mission.dangerPoint = {
          x: engine.player.position.x, y: 0, z: engine.player.position.z,
        }
        obj.timer = o.duration ?? 0
        if (o.wantedLevel) engine.setWantedLevel(Math.max(engine.player.wantedLevel, o.wantedLevel))
        this.hideBeacon()
        engine.notify('Lose the heat — get away!', 'warning')
        break
      }
      case 'destroy': {
        if (!mission.targetVehicleId || !this.getMissionVehicle(mission)) {
          this.spawnTargetVehicle(mission, o, 40, 70, 9)
        }
        const v = this.getMissionVehicle(mission)
        if (v) {
          this.showBeacon({ x: v.position.x, y: 0, z: v.position.z })
          this.showChaseRing(v)
        }
        obj.timer = o.duration ?? 0
        break
      }
      default:
        this.hideBeacon()
        break
    }
  }

  private tickObjective(mission: ActiveMission, dt: number): void {
    const engine = this.engine!
    const o = mission.data.objectives[mission.objectiveIndex]
    if (!o) return
    const obj = mission.obj
    const player = engine.player
    const playerPos = player.position

    switch (o.type) {
      // ------------------------------------------------------------
      case 'goto': {
        const pos = this.objectiveTargetPosition(o)
        if (!pos) {
          this.completeObjective()
          return
        }
        const radius = o.radius ?? DEFAULT_GOTO_RADIUS
        if (Math.hypot(playerPos.x - pos.x, playerPos.z - pos.z) <= radius) {
          this.completeObjective()
        }
        break
      }
      // ------------------------------------------------------------
      case 'interact': {
        if (obj.treating) {
          obj.timer -= dt
          if (obj.timer <= 0) this.completeObjective()
        }
        break
      }
      // ------------------------------------------------------------
      case 'timer': {
        obj.timer -= dt
        if (obj.timer <= 0) this.completeObjective()
        break
      }
      // ------------------------------------------------------------
      case 'observe':
      case 'locate': {
        const pos = this.objectiveTargetPosition(o)
        if (pos) {
          const radius = (o.radius ?? DEFAULT_GOTO_RADIUS) + 4
          const inside = Math.hypot(playerPos.x - pos.x, playerPos.z - pos.z) <= radius
          if (inside) {
            obj.timer -= dt
            if (obj.timer <= 0) this.completeObjective()
          }
        } else {
          obj.timer -= dt
          if (obj.timer <= 0) this.completeObjective()
        }
        break
      }
      // ------------------------------------------------------------
      case 'survive': {
        // Maintain police pressure.
        if (o.wantedLevel) {
          if (player.wantedLevel < o.wantedLevel) engine.setWantedLevel(o.wantedLevel)
          this.npcSystem()?.registerCrime?.(0) // suppress decay
        }
        // Optional zone requirement.
        if (mission.zoneCenter && o.radius) {
          const d = Math.hypot(
            playerPos.x - mission.zoneCenter.x,
            playerPos.z - mission.zoneCenter.z,
          )
          if (d > o.radius) {
            obj.zoneTimer += dt
            if (obj.zoneTimer > ZONE_GRACE_SEC) {
              this.failMission('left the area')
              return
            }
          } else obj.zoneTimer = 0
        }
        obj.timer -= dt
        if (obj.timer <= 0) this.completeObjective()
        break
      }
      // ------------------------------------------------------------
      case 'eliminate': {
        const need = o.targetCount ?? 3
        if (mission.kills >= need) this.completeObjective()
        break
      }
      // ------------------------------------------------------------
      case 'defend': {
        const zone = mission.zoneCenter!
        const radius = o.radius ?? 25
        const d = Math.hypot(playerPos.x - zone.x, playerPos.z - zone.z)
        if (d > radius) {
          obj.zoneTimer += dt
          if (obj.zoneTimer > ZONE_GRACE_SEC) {
            this.failMission('left the area')
            return
          }
        } else obj.zoneTimer = 0
        // Waves.
        obj.waveTimer -= dt
        if (obj.waveTimer <= 0) {
          obj.waveTimer = DEFEND_WAVE_SEC
          this.spawnWave(mission, o, zone)
        }
        obj.timer -= dt
        if (obj.timer <= 0) this.completeObjective()
        break
      }
      // ------------------------------------------------------------
      case 'collect': {
        const need = o.targetCount ?? 4
        if (mission.collected >= need) this.completeObjective()
        break
      }
      // ------------------------------------------------------------
      case 'chase': {
        const v = this.getMissionVehicle(mission)
        if (!v) {
          this.completeObjective()
          break
        }
        // Beacon follows the fleeing car.
        this.showBeacon({ x: v.position.x, y: 0, z: v.position.z })
        const d = v.position.distanceTo(playerPos)
        const maxD = o.maxDistance ?? 60
        if (d <= maxD) obj.chaseCloseTime += dt
        else obj.chaseCloseTime = Math.max(0, obj.chaseCloseTime - dt * 0.5)
        if (v.destroyed || obj.chaseCloseTime >= CHASE_NEED_SEC) {
          if (this.fleeing) this.fleeing.stopped = true
          this.completeObjective()
          break
        }
        if (o.duration || o.timeLimit) {
          obj.timer -= dt
          if (obj.timer <= 0) {
            this.failMission('lost the target')
            return
          }
        }
        break
      }
      // ------------------------------------------------------------
      case 'race': {
        const cp = obj.checkpoints[obj.checkpointIndex]
        if (!cp) {
          this.completeObjective()
          break
        }
        this.showBeacon(cp)
        this.showRaceGate(cp, obj.checkpointIndex >= obj.checkpoints.length - 1)

        // ---- 3-2-1-GO! countdown (timer frozen until GO) ---------------
        if (obj.countdown > 0) {
          const before = Math.ceil(obj.countdown)
          obj.countdown -= dt
          const after = Math.ceil(obj.countdown)
          // Beep on each ceil crossing (2 and 1; the "3" beep fired when
          // the objective began — beginObjective).
          if (after !== before && after >= 1) {
            this.audio()?.play?.('race_countdown', { volume: 0.8 })
          }
          if (obj.countdown <= 0) {
            obj.countdown = 0
            obj.raceGoFlash = RACE_GO_FLASH_SEC
            this.audio()?.play?.('race_go', { volume: 0.9 })
            engine.notify('GO!', 'success')
          }
          break
        }
        if (obj.raceGoFlash > 0) obj.raceGoFlash -= dt
        obj.raceElapsed += dt

        // ---- AI opponents drive + standings ----------------------------
        if (this.racers.length > 0) {
          this.updateRaceOpponents(mission, dt)
          if (!this.active) return // an opponent won → mission already failed
        }

        const d = Math.hypot(playerPos.x - cp.x, playerPos.z - cp.z)
        if (d <= 12) {
          obj.checkpointIndex++
          obj.gateFlash = 0.45
          obj.timer = o.duration ?? o.timeLimit ?? 30
          this.audio()?.play?.('checkpoint', { volume: 0.85 })
          if (obj.checkpointIndex >= obj.checkpoints.length) {
            // Record the lap and toast the time (NEW RECORD when beaten).
            const t = Math.round(obj.raceElapsed * 10) / 10
            const best = this.bestRaceTimes.get(mission.data.id)
            if (best === undefined || t < best) {
              if (best !== undefined) {
                engine.notify(`NEW RECORD — ${t.toFixed(1)}s (was ${best.toFixed(1)}s)`, 'success')
              }
              this.bestRaceTimes.set(mission.data.id, t)
            } else {
              engine.notify(`Final checkpoint — ${t.toFixed(1)}s (best ${best.toFixed(1)}s)`, 'info')
            }
            if (this.racers.length > 0) {
              engine.notify(`🏁 1st place — the circuit is yours`, 'success')
            }
            engine.notify('Final checkpoint reached!', 'success')
          } else {
            engine.notify(
              `Checkpoint ${obj.checkpointIndex}/${obj.checkpoints.length}`,
              'success',
            )
          }
          if (obj.checkpointIndex >= obj.checkpoints.length) this.completeObjective()
        } else {
          obj.timer -= dt
          if (obj.timer <= 0) {
            this.failMission('out of time')
            return
          }
        }
        break
      }
      // ------------------------------------------------------------
      case 'steal': {
        const v = this.getMissionVehicle(mission)
        if (v && engine.vehicles.playerVehicleId === v.id) this.completeObjective()
        break
      }
      // ------------------------------------------------------------
      case 'escort': {
        const npcs = this.npcSystem()
        if (!mission.allyNpcId) {
          this.failMission('escort lost')
          return
        }
        const ally = npcs?.getNPCById?.(mission.allyNpcId)
        if (!ally || !ally.alive) {
          this.failMission('the hostage died')
          return
        }
        const target = this.objectiveTargetPosition(o)
        if (target) {
          this.showBeacon(target)
          const radius = o.radius ?? 10
          const d = Math.hypot(ally.position.x - target.x, ally.position.z - target.z)
          if (d <= radius) this.completeObjective()
        }
        break
      }
      // ------------------------------------------------------------
      case 'escape': {
        const danger = mission.dangerPoint ?? { x: 0, y: 0, z: 0 }
        const need = o.maxDistance ?? 150
        const d = Math.hypot(playerPos.x - danger.x, playerPos.z - danger.z)
        const clean = player.wantedLevel === 0
        if (d >= need || clean) {
          this.completeObjective()
          return
        }
        if (o.duration) {
          obj.timer -= dt
          if (obj.timer <= 0) {
            this.failMission('failed to escape')
            return
          }
        }
        break
      }
      // ------------------------------------------------------------
      case 'destroy': {
        const v = this.getMissionVehicle(mission)
        if (!v) {
          this.failMission('target lost')
          return
        }
        this.showBeacon({ x: v.position.x, y: 0, z: v.position.z })
        if (v.destroyed) {
          this.completeObjective()
          return
        }
        // Ramming damage from the player's vehicle.
        obj.ramCooldown -= dt
        const pvId = engine.vehicles.playerVehicleId
        const pv = pvId ? engine.vehicles.getById(pvId) : null
        if (pv && obj.ramCooldown <= 0) {
          const dist = pv.position.distanceTo(v.position)
          const impact = Math.abs(pv.getForwardSpeed())
          if (dist < (pv.data.length + v.data.length) * 0.45 && impact > 6) {
            obj.ramCooldown = 0.5
            v.applyDamage(impact * 5)
            pv.applyDamage(impact * 2)
            this.audio()?.play?.('crash', { position: v.position, volume: 0.7 })
          }
        }
        break
      }
      default:
        break
    }
  }

  private completeObjective(): void {
    const engine = this.engine!
    const mission = this.active
    if (!mission) return
    const o = mission.data.objectives[mission.objectiveIndex]
    engine.emitEvent({
      type: 'objectiveCompleted',
      index: mission.objectiveIndex,
      description: o?.description ?? '',
    })
    if (o) engine.notify(`✓ ${o.description}`, 'success')
    this.beginObjective(mission.objectiveIndex + 1)
  }

  private completeMission(): void {
    const engine = this.engine!
    const mission = this.active!
    const data = mission.data

    // Rewards (side missions roll within their min-max band) — with
    // hustle fatigue: every repeat of the SAME side mission pays less
    // (100% → 70% → 55% → 45% → 40% floor). Keeps the authored 5k–20k
    // street-race band from being an infinite money printer while
    // replays still feel worth it.
    const rawMoney = data.rewardMoneyMax
      ? Math.round((data.rewardMoneyMin ?? data.rewardMoney) + Math.random() * (data.rewardMoneyMax - (data.rewardMoneyMin ?? data.rewardMoney)))
      : data.rewardMoney
    const priorRuns = data.isSide ? (this.sideHustleCounts.get(data.id) ?? 0) : 0
    const payMult = data.isSide ? HUSTLE_PAY_MULT[Math.min(priorRuns, HUSTLE_PAY_MULT.length - 1)] : 1
    const money = Math.round(rawMoney * payMult)
    if (data.isSide) this.sideHustleCounts.set(data.id, priorRuns + 1)
    engine.player.addMoney(money)
    engine.player.addXp(data.rewardXp)

    this.completed.add(data.id)
    this.refreshCampaignProgress()

    engine.emitEvent({
      type: 'missionCompleted',
      missionId: data.id,
      name: data.name,
      rewardMoney: money,
      rewardXp: data.rewardXp,
    })
    const fatigue = payMult < 1 ? ` · repeat ${Math.round(payMult * 100)}% pay` : ''
    engine.notify(`MISSION PASSED — ${data.name} (+$${money.toLocaleString()}, +${data.rewardXp} XP${fatigue})`, 'success')

    // Campaign completion bonus.
    const campaign = engine.content.campaign
    if (campaign && !this.campaignCompleted && this.campaignDone(campaign)) {
      this.campaignCompleted = true
      engine.player.addMoney(campaign.completionReward)
      engine.player.addXp(campaign.completionXp)
      engine.notify(
        `CAMPAIGN COMPLETE — "${campaign.name}"! Bonus $${campaign.completionReward.toLocaleString()}`,
        'success',
      )
    }

    this.cleanupMission(true)
  }

  private failMission(reason: string): void {
    const engine = this.engine
    const mission = this.active
    if (!engine || !mission) return
    engine.emitEvent({ type: 'missionFailed', missionId: mission.data.id, reason })
    engine.notify(`MISSION FAILED — ${reason}`, 'danger')
    this.cleanupMission(false)
  }

  /** Remove all mission-owned entities. */
  private cleanupMission(completed: boolean): void {
    const engine = this.engine
    const mission = this.active
    this.active = null
    this.fleeing = null
    this.hideBeacon()
    this.hideRaceGate()
    this.hideChaseRing()
    this.clearRaceOpponents()
    this.playerPlace = null
    this.lastNotifiedPlace = null
    if (!engine || !mission) return
    this.npcSystem()?.removeMissionNpcs?.(mission.data.id)
    const pickups = engine.systems.pickups as unknown as { removeByMission?: (id: string) => void } | undefined
    pickups?.removeByMission?.(mission.data.id)
    const v = mission.targetVehicleId ? engine.vehicles.getById(mission.targetVehicleId) : null
    if (v && engine.vehicles.playerVehicleId !== v.id) {
      engine.vehicles.removeVehicle(v.id)
    }
    this.markersDirty = true
    void completed
  }

  // =================================================================
  // Spawning helpers
  // =================================================================

  private fireEnemyTriggers(mission: ActiveMission, index: number): void {
    const engine = this.engine!
    mission.data.enemies.forEach((entry, i) => {
      if (mission.spawnedTriggers.has(i)) return
      if (this.parseObjectiveIndex(entry.spawnTrigger) !== index) return
      mission.spawnedTriggers.add(i)
      const npcs = this.npcSystem()
      if (!npcs?.spawnEnemy) return
      for (let k = 0; k < entry.count; k++) {
        const pos: Vec3 =
          entry.spawnPositions && entry.spawnPositions[k]
            ? entry.spawnPositions[k] // authored per-enemy spot
            : entry.spawnPosition
              ? {
                  x: entry.spawnPosition.x + (Math.random() - 0.5) * 14,
                  y: 0,
                  z: entry.spawnPosition.z + (Math.random() - 0.5) * 14,
                }
              : this.nearPlayer(ELIMINATE_SPAWN_MIN, ELIMINATE_SPAWN_MAX)
        npcs.spawnEnemy(entry.type, pos, { hostile: true, missionId: mission.data.id })
      }
      engine.notify(`Enemies incoming: ${entry.count} × ${entry.type}`, 'warning')
    })
  }

  private spawnObjectiveEnemy(mission: ActiveMission, o: MissionObjective): void {
    const npcs = this.npcSystem()
    if (!npcs?.spawnEnemy) return
    const type = o.enemyType ?? this.typeFromTarget(o.target) ?? 'gang_member'
    const count = o.targetCount ?? (o.type === 'eliminate' ? 3 : 1)
    const anchor = this.objectiveTargetPosition(o) ?? {
      x: this.engine!.player.position.x,
      y: 0,
      z: this.engine!.player.position.z,
    }
    for (let k = 0; k < count; k++) {
      const angle = Math.random() * Math.PI * 2
      const dist = o.type === 'eliminate' || o.type === 'defend'
        ? ELIMINATE_SPAWN_MIN + Math.random() * (ELIMINATE_SPAWN_MAX - ELIMINATE_SPAWN_MIN)
        : 4 + Math.random() * 8
      const pos: Vec3 = {
        x: THREE.MathUtils.clamp(anchor.x + Math.cos(angle) * dist, 5, this.engine!.level.sizeX - 5),
        y: 0,
        z: THREE.MathUtils.clamp(anchor.z + Math.sin(angle) * dist, 5, this.engine!.level.sizeZ - 5),
      }
      npcs.spawnEnemy(type, pos, { hostile: true, missionId: mission.data.id })
    }
  }

  private spawnWave(mission: ActiveMission, o: MissionObjective, zone: Vec3): void {
    const npcs = this.npcSystem()
    if (!npcs?.spawnEnemy) return
    const type = o.enemyType ?? 'police'
    for (let k = 0; k < 3; k++) {
      const angle = Math.random() * Math.PI * 2
      const dist = 28 + Math.random() * 20
      npcs.spawnEnemy(
        type,
        {
          x: THREE.MathUtils.clamp(zone.x + Math.cos(angle) * dist, 5, this.engine!.level.sizeX - 5),
          y: 0,
          z: THREE.MathUtils.clamp(zone.z + Math.sin(angle) * dist, 5, this.engine!.level.sizeZ - 5),
        },
        { hostile: true, missionId: mission.data.id },
      )
    }
    this.engine?.notify('Another wave incoming!', 'warning')
  }

  private spawnCollectibles(mission: ActiveMission, o: MissionObjective): void {
    const engine = this.engine!
    const pickups = engine.systems.pickups as unknown as {
      spawn?: (pos: Vec3, opts: {
        kind: 'item'; missionId: string; label: string; onCollect: () => void
      }) => string
    } | undefined
    if (!pickups?.spawn) return
    const count = o.targetCount ?? 4
    const anchor = this.objectiveTargetPosition(o) ?? {
      x: engine.player.position.x,
      y: 0,
      z: engine.player.position.z,
    }
    for (let k = 0; k < count; k++) {
      const angle = Math.random() * Math.PI * 2
      const dist = 8 + Math.random() * COLLECT_RADIUS
      pickups.spawn(
        {
          x: THREE.MathUtils.clamp(anchor.x + Math.cos(angle) * dist, 5, engine.level.sizeX - 5),
          y: 0,
          z: THREE.MathUtils.clamp(anchor.z + Math.sin(angle) * dist, 5, engine.level.sizeZ - 5),
        },
        {
          kind: 'item',
          missionId: mission.data.id,
          label: o.description || 'collectible',
          onCollect: () => {
            mission.collected++
          },
        },
      )
    }
  }

  /** Spawn the mission target vehicle (chase / steal / destroy). */
  private spawnTargetVehicle(
    mission: ActiveMission,
    o: MissionObjective,
    minR: number,
    maxR: number,
    speed: number,
  ): void {
    const engine = this.engine!
    const graph = engine.world.getRoadGraph()
    const player = engine.player.position
    let node = graph.randomNodeNear({ x: player.x, y: 0, z: player.z }, maxR)
    for (let i = 0; i < 8; i++) {
      const d = Math.hypot(node.x - player.x, node.z - player.z)
      if (d >= minR && d <= maxR) break
      node = graph.randomNodeNear({ x: player.x, y: 0, z: player.z }, maxR)
    }
    const data = this.vehicleDataForTarget(o.target)
    if (!data) return
    const next = node.neighborIds.length > 0
      ? graph.getNode(node.neighborIds[Math.floor(Math.random() * node.neighborIds.length)])
      : null
    const yaw = next ? Math.atan2(-(next.x - node.x), -(next.z - node.z)) : 0
    const v = engine.vehicles.spawnVehicle(
      data,
      new THREE.Vector3(node.x, 0, node.z),
      yaw,
      false,
      `mission_veh_${mission.data.id}`,
    )
    mission.targetVehicleId = v.id
    if (speed > 0 && next) {
      this.fleeing = new FleeingVehicle(v, node, next, speed, graph)
    } else {
      this.fleeing = null
    }
    engine.notify(`Target vehicle: ${data.name}`, 'warning')
  }

  private getMissionVehicle(mission: ActiveMission): VehicleController | null {
    const engine = this.engine
    if (!engine || !mission.targetVehicleId) return null
    return engine.vehicles.getById(mission.targetVehicleId)
  }

  private generateRaceCheckpoints(authoredCount?: number): Vec3[] {
    const engine = this.engine!
    const graph = engine.world.getRoadGraph()
    // Authored .mission files can specify the checkpoint count (the side
    // street race's "Downtown Circuit" documents 8); otherwise 4-6.
    const count = Math.max(
      3,
      Math.min(12, authoredCount ?? 4 + Math.floor(Math.random() * 3)),
    )
    const checkpoints: Vec3[] = []
    let cur = graph.worldToNode({
      x: engine.player.position.x, y: 0, z: engine.player.position.z,
    })
    for (let i = 0; i < count; i++) {
      let next = graph.randomNodeNear({ x: cur.x, y: 0, z: cur.z }, 220)
      for (let a = 0; a < 8; a++) {
        const d = Math.hypot(next.x - cur.x, next.z - cur.z)
        if (d > 90) break
        next = graph.randomNodeNear({ x: cur.x, y: 0, z: cur.z }, 220)
      }
      checkpoints.push({ x: next.x, y: 0, z: next.z })
      cur = next
    }
    return checkpoints
  }

  // ------------------------------------------------------------------
  // AI race opponents (round 4) — the authored files document 3-7
  // opponents per race; until now races were a solo time trial.
  // ------------------------------------------------------------------

  /** Spawn the AI opponents on a starting grid beside the player. */
  private spawnRaceOpponents(mission: ActiveMission, o: MissionObjective): void {
    const engine = this.engine!
    this.clearRaceOpponents()
    // Stolen rival cars from an earlier run of THIS mission still roam the
    // world (they are the player's now). Sweep the non-driven leftovers so
    // the grid never spawns duplicate ids; if the player is currently
    // driving one, the fresh grid slot gets a suffixed id instead.
    const prefix = `race_opp_${mission.data.id}_`
    for (const v of [...engine.vehicles.vehicles]) {
      if (v.id.startsWith(prefix) && engine.vehicles.playerVehicleId !== v.id) {
        engine.vehicles.removeVehicle(v.id)
      }
    }
    const checkpoints = mission.obj.checkpoints
    if (checkpoints.length === 0) return
    const authored = o.opponents ?? 3
    const count = Math.max(1, Math.min(RACE_OPP_MAX, Math.round(authored)))
    const pool = engine.content.vehicles.filter((v) => v.type !== 'helicopter')
    if (pool.length === 0) return
    const sports = pool.filter((v) => v.vehicleClass.toLowerCase().includes('sport'))
    const sedan = pool.filter((v) => v.vehicleClass.toLowerCase().includes('sedan'))
    const van = pool.filter((v) => v.vehicleClass.toLowerCase().includes('van'))

    // Authored roster (mission_02: "Racer 1/2/3" with skill levels) when
    // the count matches the objective's, else generic.
    const roster: MissionOpponent[] = mission.data.opponents ?? []
    const player = engine.player.position
    const first = checkpoints[0]
    const dirX = first.x - player.x
    const dirZ = first.z - player.z
    const dirLen = Math.hypot(dirX, dirZ) || 1
    const fx = dirX / dirLen
    const fz = dirZ / dirLen
    // Perpendicular (right of the facing direction).
    const px = -fz
    const pz = fx
    const skillMult: Record<string, number> = { high: 1.08, medium: 1.0, low: 0.92 }

    for (let i = 0; i < count; i++) {
      const rosterEntry = roster[i]
      const name = rosterEntry?.name ?? `Racer ${i + 1}`
      const skill = skillMult[(rosterEntry?.skill ?? '').toLowerCase()] ?? 0.95 + Math.random() * 0.14
      // Vehicle: prefer the authored vehicle class, then rotate sports/sedan/van.
      let data = pool[0]
      const want = (rosterEntry?.vehicle ?? '').toLowerCase()
      if (want.includes('sport')) data = sports[0] ?? sedan[0] ?? van[0] ?? data
      else if (want.includes('sedan')) data = sedan[0] ?? sports[0] ?? data
      else if (want.includes('van')) data = van[0] ?? sedan[0] ?? data
      else data = sports[i % Math.max(1, sports.length)] ?? sedan[i % Math.max(1, sedan.length)] ?? data

      // Two-wide grid behind the player, staggered 3.5 m apart.
      const lateral = (i % 2 === 0 ? -1 : 1) * 2.6
      const back = 3.5 + Math.floor(i / 2) * 5.5
      const x = THREE.MathUtils.clamp(player.x + px * lateral - fx * back, 4, engine.level.sizeX - 4)
      const z = THREE.MathUtils.clamp(player.z + pz * lateral - fz * back, 4, engine.level.sizeZ - 4)
      const yaw = Math.atan2(-fx, -fz)
      const baseId = `race_opp_${mission.data.id}_${i}`
      const forceId = engine.vehicles.getById(baseId) ? `${baseId}x2` : baseId
      const v = engine.vehicles.spawnVehicle(
        data,
        new THREE.Vector3(x, 0, z),
        yaw,
        true, // kinematic — VehicleManager only refreshes visuals (traffic fix pattern)
        forceId,
      )
      // Racing lights at night (spawn-time state; updateRaceOpponents'
      // night watcher keeps them in sync across dusk/dawn mid-race).
      const h = engine.dayTime
      this.racersNight = h >= 19.5 || h < 6.5
      if (this.racersNight) v.setHeadlightsOn(true)

      this.racers.push(new RaceOpponent(v, name, skill, checkpoints, i + 1))
    }
    if (this.racers.length > 0) {
      const names = this.racers.map((r) => r.name).join(', ')
      engine.notify(`Grid set: ${this.racers.length} rivals — ${names}`, 'info')
    }
    this.playerPlace = null
    this.lastNotifiedPlace = null
  }

  /** Drive all opponents, update standings, detect the loss condition. */
  private updateRaceOpponents(mission: ActiveMission, dt: number): void {
    const engine = this.engine!
    const obj = mission.obj
    // ---- night watcher (round 6) ------------------------------------
    // Races that cross dusk/dawn mid-flight used to leave the rivals'
    // headlight emissives stuck at their spawn-time state. Mirror the
    // TrafficSystem watcher: flip every surviving rival on the boundary.
    const hour = engine.dayTime
    const night = hour >= 19.5 || hour < 6.5
    if (night !== this.racersNight) {
      this.racersNight = night
      for (const r of this.racers) {
        if (!r.disqualified && !r.vehicle.destroyed) r.vehicle.setHeadlightsOn(night)
      }
    }
    // ---- carjack detection (round 6) --------------------------------
    // The player ENTERED a rival's ride (getNearest reaches the kinematic
    // racers). Without this, the rival AI kept teleporting the player's
    // new car toward checkpoints — the racer appeared "frozen" while the
    // two writers fought over position. GTA street rules: steal the car,
    // end their run — the driver bails as a panicking pedestrian.
    const pvId = engine.vehicles.playerVehicleId
    if (pvId !== null) {
      const victim = this.racers.find(
        (r) => !r.disqualified && !r.finished && r.vehicle.id === pvId,
      )
      if (victim) this.carjackRacer(victim)
    }
    const playerProgress = this.raceProgress(
      obj.checkpointIndex,
      obj.checkpoints[Math.min(obj.checkpointIndex, obj.checkpoints.length - 1)],
      engine.player.position,
      obj.checkpoints.length,
    )
    let beatenBy: string | null = null
    for (const r of this.racers) {
      r.update(dt, playerProgress, engine, this.racers)
      if (r.finished && beatenBy === null) beatenBy = r.name
    }
    // Opponent crossed the final gate first → the race is lost (GTA
    // street rules: no prize for second).
    if (beatenBy !== null && obj.checkpointIndex < obj.checkpoints.length) {
      this.failMission(`beaten to the finish by ${beatenBy}`)
      return
    }
    // Standings + overtake notifications.
    const place = 1 + this.racers.filter((r) => r.progress() > playerProgress).length
    this.playerPlace = place
    if (this.lastNotifiedPlace === null) {
      this.lastNotifiedPlace = place
    } else if (place !== this.lastNotifiedPlace) {
      const engine2 = this.engine!
      if (place < this.lastNotifiedPlace) {
        if (place === 1) engine2.notify('You took the lead!', 'success')
        else {
          const passed = this.racerAt(place)
          if (passed) engine2.notify(`P${place} — passed ${passed.name}`, 'success')
        }
      } else {
        const ahead = this.racerAt(place - 1)
        if (ahead) engine2.notify(`${ahead.name} blew past you — P${place}`, 'warning')
      }
      this.lastNotifiedPlace = place
    }
  }

  /** Rival's ride was stolen by the player: disqualify them, drop the
   * overhead number pill, panic the area and take the heat for the jack. */
  private carjackRacer(r: RaceOpponent): void {
    const engine = this.engine!
    r.disqualified = true
    r.dispose(null) // detaches the #number sprite from the stolen car
    const v = r.vehicle
    const bail = v.getExitPosition(new THREE.Vector3())
    // The driver bails beside the car and panics — the crash-style panic
    // radius also spooks bystanders around the jack.
    const npcs = this.npcSystem()
    npcs?.spawnEnemy?.('pedestrian', { x: bail.x, y: 0, z: bail.z })
    npcs?.notifyCrash?.({ x: bail.x, y: 0, z: bail.z }, 11)
    npcs?.registerCrime?.(1) // grand theft auto is still grand theft auto
    this.audio()?.play?.('crash', { position: { x: bail.x, y: bail.y, z: bail.z }, volume: 0.45 })
    engine.notify(`${r.name} carjacked — they are OUT of the race`, 'warning')
    // Recompute the standings baseline so the next place-change toast is
    // relative to the post-jack pack size.
    this.lastNotifiedPlace = null
  }

  /** Shared progress metric: checkpoints claimed minus distance to next. */
  private raceProgress(cpIndex: number, nextCp: Vec3 | null, pos: THREE.Vector3, total: number): number {
    if (cpIndex >= total) return Infinity
    if (!nextCp) return cpIndex * 1000
    const d = Math.hypot(pos.x - nextCp.x, pos.z - nextCp.z)
    return cpIndex * 1000 - Math.min(d, 1000)
  }

  private racerAt(place: number): RaceOpponent | null {
    // place is 1-based among all racers; place-1 among opponents = the
    // opponent ranked directly at that overall slot.
    const sorted = [...this.racers].sort((a, b) => b.progress() - a.progress())
    return sorted[place - 1] ?? null
  }

  private raceLeaderName(): string | null {
    return this.racerAt(1)?.name ?? null
  }

  /** Remove opponent vehicles + their overhead number sprites.
   * Carjacked rivals' cars are KEPT — GTA rules: you jacked it, you
   * drive it. They persist as ordinary world vehicles after the race. */
  private clearRaceOpponents(): void {
    const engine = this.engine
    for (const r of this.racers) {
      if (engine && !r.disqualified) engine.vehicles.removeVehicle(r.vehicle.id)
      r.dispose(engine ? engine.scene : null)
    }
    this.racers.length = 0
  }

  /** Live opponents for the minimap / debug views. */
  getRaceOpponents(): RaceOpponentInfo[] {
    // Carjacked rivals are excluded — their car IS the player's car now,
    // a rival blip on top of the player's own dot would be a lie.
    const alive = this.racers.filter((r) => !r.disqualified)
    const sorted = [...alive].sort((a, b) => b.progress() - a.progress())
    return alive.map((r) => ({
      id: r.vehicle.id,
      name: r.name,
      position: { x: r.vehicle.position.x, y: r.vehicle.position.y, z: r.vehicle.position.z },
      place: sorted.indexOf(r) + 2, // player is at least P1; opponents slot after
      finished: r.finished,
    }))
  }

  /** Debug: one-line race diagnostic for the QA toolbar. */
  debugRaceStatus(): string {
    const m = this.active
    if (!m) return 'no active mission'
    const o = m.data.objectives[m.objectiveIndex]
    if (o?.type !== 'race') return 'active mission is not a race'
    const obj = m.obj
    return (
      `race · cp ${obj.checkpointIndex}/${obj.checkpoints.length} · cd ${obj.countdown.toFixed(1)} · ` +
      `elapsed ${obj.raceElapsed.toFixed(1)}s · place ${this.playerPlace ?? '-'} of ${
        this.racers.filter((r) => !r.disqualified).length + 1
      } · ` +
      `opponents ${this.racers.filter((r) => !r.finished && !r.disqualified).length}/${
        this.racers.length
      } running`
    )
  }

  // ------------------------------------------------------------------
  // Chase/destroy target highlight ring
  // ------------------------------------------------------------------

  private showChaseRing(v: VehicleController): void {
    const engine = this.engine
    if (!engine) return
    const radius = Math.max(2.6, v.data.length * 0.42)
    if (!this.chaseRing) {
      this.chaseRing = new THREE.Mesh(
        new THREE.RingGeometry(0.86, 1, 36),
        new THREE.MeshBasicMaterial({
          color: 0xfbbf24,
          transparent: true,
          opacity: 0.75,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      )
      this.chaseRing.rotation.x = -Math.PI / 2
      engine.scene.add(this.chaseRing)
    }
    this.chaseRing.visible = true
    this.chaseRing.scale.setScalar(radius)
    this.chaseRing.position.set(v.position.x, v.position.y + 0.22, v.position.z)
    this.chaseRing.userData.vehicleId = v.id
  }

  private hideChaseRing(): void {
    if (this.chaseRing) this.chaseRing.visible = false
    if (this.chaseRing) this.chaseRing.userData.vehicleId = null
  }

  private updateChaseRingVisual(dt: number): void {
    const ring = this.chaseRing
    const engine = this.engine
    if (!ring || !ring.visible || !engine || !this.active) return
    // Hug the target vehicle (chase targets move; destroy targets may too).
    const id = ring.userData.vehicleId as string | null
    const v = id ? engine.vehicles.getById(id) : null
    if (v && !v.destroyed) {
      ring.position.set(v.position.x, v.position.y + 0.22, v.position.z)
      const pulse = 1 + Math.sin(this.time * 4.2) * 0.08
      ring.scale.setScalar(Math.max(2.6, v.data.length * 0.42) * pulse)
      const mat = ring.material as THREE.MeshBasicMaterial
      mat.opacity = 0.6 + 0.25 * (0.5 + 0.5 * Math.sin(this.time * 4.2))
    } else {
      this.hideChaseRing()
    }
    void dt
  }

  private vehicleDataForTarget(target: string | undefined) {
    const engine = this.engine!
    const vehicles = engine.content.vehicles.filter((v) => v.type !== 'helicopter')
    if (vehicles.length === 0) return null
    const t = (target ?? '').toLowerCase()
    if (t.includes('van')) return vehicles.find((v) => v.vehicleClass.includes('van')) ?? vehicles[0]
    if (t.includes('sport') || t.includes('criminal')) {
      return vehicles.find((v) => v.vehicleClass.includes('sport')) ?? vehicles[0]
    }
    if (t.includes('police')) return vehicles.find((v) => v.vehicleClass.includes('police')) ?? vehicles[0]
    return vehicles.find((v) => v.vehicleClass.includes('sedan')) ?? vehicles[0]
  }

  private handleNpcKilled(npcId: string, npcType: string, missionId: string | null, _byPlayer: boolean): void {
    const mission = this.active
    if (!mission || !missionId || missionId !== mission.data.id) return
    // Escort ally death → fail.
    if (mission.allyNpcId && npcId === mission.allyNpcId) return // handled in escort tick
    // Eliminate / defend kill counting.
    const o = mission.data.objectives[mission.objectiveIndex]
    if (o && (o.type === 'eliminate' || o.type === 'defend')) {
      const wanted = o.enemyType ?? this.typeFromTarget(o.target) ?? 'gang_member'
      if (npcType === wanted || wanted === 'any') mission.kills++
    }
  }

  // =================================================================
  // Targets / status / required items
  // =================================================================

  /** Resolve an objective's world-space target position. */
  private objectiveTargetPosition(o: MissionObjective): Vec3 | null {
    const engine = this.engine!
    if (o.targetPosition && o.targetPosition !== 'random') {
      return o.targetPosition
    }
    if (o.targetPosition === 'random') {
      // Random road node within 300 m of the player.
      const player = engine.player.position
      const node = engine.world.getRoadGraph().randomNodeNear(
        { x: player.x, y: 0, z: player.z },
        300,
      )
      return { x: node.x, y: 0, z: node.z }
    }
    // Named target: building match (Bank, hospital, warehouse...).
    if (o.target) {
      const t = o.target.toLowerCase()
      const building = engine.level.buildings.find(
        (b) =>
          b.name.toLowerCase().includes(t) ||
          t.includes(b.type.toLowerCase()) ||
          b.type.toLowerCase().includes(t),
      )
      if (building) {
        return {
          x: building.position.x,
          y: 0,
          z: building.position.z + building.size.z / 2 + 3,
        }
      }
    }
    return null
  }

  private interactRadius(o: MissionObjective): number {
    const engine = this.engine!
    if (o.target) {
      const t = o.target.toLowerCase()
      const building = engine.level.buildings.find(
        (b) => b.name.toLowerCase().includes(t) || t.includes(b.type.toLowerCase()),
      )
      if (building) return Math.max(o.radius ?? 6, building.size.x / 2 + 4)
    }
    return o.radius ?? 6
  }

  private typeFromTarget(target: string | undefined): string | null {
    if (!target) return null
    const t = target.toLowerCase()
    if (t.includes('criminal') || t.includes('thief') || t.includes('robber')) return 'criminal'
    if (t.includes('vip')) return 'criminal'
    if (t.includes('police')) return 'police'
    if (t.includes('gang')) return 'gang_member'
    if (t.includes('guard') || t.includes('security')) return 'guard'
    return null
  }

  private parseObjectiveIndex(trigger: string): number {
    const m = trigger.match(/(\d+)/)
    if (!m) return -1
    return parseInt(m[1], 10) - 1
  }

  private nearPlayer(min: number, max: number): Vec3 {
    const engine = this.engine!
    const player = engine.player.position
    const angle = Math.random() * Math.PI * 2
    const dist = min + Math.random() * (max - min)
    return {
      x: THREE.MathUtils.clamp(player.x + Math.cos(angle) * dist, 5, engine.level.sizeX - 5),
      y: 0,
      z: THREE.MathUtils.clamp(player.z + Math.sin(angle) * dist, 5, engine.level.sizeZ - 5),
    }
  }

  private statusOf(mission: MissionData): MissionStatus {
    if (this.completed.has(mission.id) && !mission.repeatable) return 'completed'
    if (mission.isSide) return 'available'
    const campaign = this.engine?.content.campaign
    if (!campaign) return 'available'
    const entry = campaign.missions.find((m) => m.id === mission.id)
    if (!entry) return 'available'
    if (entry.unlock === 'start' || this.completed.has(entry.unlock)) return 'available'
    return 'locked'
  }

  private unlockRequirement(mission: MissionData): string {
    const campaign = this.engine?.content.campaign
    const entry = campaign?.missions.find((m) => m.id === mission.id)
    return entry?.unlock ?? 'previous missions'
  }

  private checkRequiredItems(mission: MissionData): string | null {
    const engine = this.engine!
    const weapons = this.weaponsSystem()?.getWeaponsOwned?.() ?? ['fists']
    const nearby = engine.vehicles.getNearby(engine.player.position, 80)
    for (const item of mission.requiredItems) {
      const t = item.toLowerCase()
      if (t.startsWith('weapon_')) {
        const map: Record<string, string> = {
          weapon_pistol: 'pistol',
          weapon_smg: 'smg',
          weapon_assault_rifle: 'rifle',
          weapon_sniper_rifle: 'rifle',
          weapon_sniper: 'rifle',
          weapon_shotgun: 'shotgun',
        }
        const need = map[t]
        if (need && !weapons.includes(need)) {
          return `a ${need} (the gun shop counter sells them — amber ring on the map)`
        }
      } else if (t.startsWith('vehicle_')) {
        if (t === 'vehicle_sports_car') {
          const sports = nearby.find((n) => {
            const v = engine.vehicles.getById(n.id)
            return v?.data.vehicleClass.toLowerCase().includes('sport')
          })
          if (!sports) return 'a sports car nearby (Turbo GT spawns downtown)'
        } else if (nearby.length === 0) {
          return 'any vehicle nearby'
        }
      }
      // armor_vest & unknown items are soft requirements.
    }
    return null
  }

  private refreshCampaignProgress(): void {
    const campaign = this.engine?.content.campaign
    if (!campaign) {
      this.campaignProgress = this.completed.size
      return
    }
    let done = 0
    for (const entry of campaign.missions) {
      if (this.completed.has(entry.id)) done++
    }
    this.campaignProgress = done
  }

  private campaignDone(campaign: CampaignData): boolean {
    return campaign.missions.every((m) => this.completed.has(m.id))
  }

  // =================================================================
  // Beacon + marker visuals
  // =================================================================

  private ensureBeacon(): THREE.Group {
    if (this.beacon) return this.beacon
    const group = new THREE.Group()
    const column = new THREE.Mesh(
      new THREE.CylinderGeometry(1.4, 1.4, 26, 12, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0x34d399, transparent: true, opacity: 0.22,
        side: THREE.DoubleSide, depthWrite: false,
      }),
    )
    column.position.y = 13
    group.add(column)
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(1.6, 2.2, 28),
      new THREE.MeshBasicMaterial({
        color: 0x34d399, transparent: true, opacity: 0.55,
        side: THREE.DoubleSide, depthWrite: false,
      }),
    )
    ring.rotation.x = -Math.PI / 2
    ring.position.y = 0.15
    group.add(ring)
    group.visible = false
    this.scene?.add(group)
    this.beacon = group
    this.beaconColumn = column
    this.beaconRing = ring
    return group
  }

  private showBeacon(pos: Vec3): void {
    const beacon = this.ensureBeacon()
    beacon.position.set(pos.x, 0, pos.z)
    beacon.visible = true
    this.beaconPos = { x: pos.x, y: 0, z: pos.z }
  }

  private hideBeacon(): void {
    if (this.beacon) this.beacon.visible = false
    this.beaconPos = null
  }

  // ------------------------------------------------------------------
  // Race checkpoint gate: a standing torus pair you drive through.
  // The outer ring pulses emerald (gold on the final checkpoint); the
  // inner ring spins. Claiming a checkpoint pops the gate's scale.
  // ------------------------------------------------------------------
  private ensureRaceGate(): THREE.Group {
    if (this.raceGate) return this.raceGate
    const group = new THREE.Group()
    const outer = new THREE.Mesh(
      new THREE.TorusGeometry(5.4, 0.5, 10, 40),
      new THREE.MeshBasicMaterial({
        color: 0x34d399,
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    )
    outer.position.y = 5.4
    const inner = new THREE.Mesh(
      new THREE.TorusGeometry(5.4, 0.14, 8, 40),
      new THREE.MeshBasicMaterial({
        color: 0xa7f3d0,
        transparent: true,
        opacity: 0.95,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    )
    inner.position.y = 5.4
    // Ground disc so the gate reads at street level too.
    const disc = new THREE.Mesh(
      new THREE.RingGeometry(4.6, 5.9, 40),
      new THREE.MeshBasicMaterial({
        color: 0x34d399,
        transparent: true,
        opacity: 0.4,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    )
    disc.rotation.x = -Math.PI / 2
    disc.position.y = 0.08
    group.add(outer, inner, disc)
    group.visible = false
    this.scene?.add(group)
    this.raceGate = group
    this.raceGateOuter = outer
    this.raceGateInner = inner
    return group
  }

  private showRaceGate(pos: Vec3, isFinal: boolean): void {
    const gate = this.ensureRaceGate()
    gate.position.set(pos.x, 0, pos.z)
    gate.visible = true
    // Face the gate roughly toward the player so it reads as a gate,
    // not a pole: yaw toward the player's current bearing.
    const engine = this.engine
    if (engine) {
      const p = engine.player.position
      gate.rotation.y = Math.atan2(p.x - pos.x, p.z - pos.z)
    }
    const color = isFinal ? 0xfbbf24 : 0x34d399
    const bright = isFinal ? 0xfde68a : 0xa7f3d0
    if (this.raceGateOuter) (this.raceGateOuter.material as THREE.MeshBasicMaterial).color.setHex(color)
    if (this.raceGateInner) (this.raceGateInner.material as THREE.MeshBasicMaterial).color.setHex(bright)
    const disc = gate.children[2] as THREE.Mesh | undefined
    if (disc) (disc.material as THREE.MeshBasicMaterial).color.setHex(color)
  }

  private hideRaceGate(): void {
    if (this.raceGate) this.raceGate.visible = false
  }

  private updateRaceGateVisual(dt: number): void {
    const gate = this.raceGate
    if (!gate || !gate.visible || !this.active) return
    const obj = this.active.obj
    const pulse = 1 + Math.sin(this.time * 3.4) * 0.06
    const flash = obj.gateFlash > 0 ? obj.gateFlash / 0.45 : 0
    if (obj.gateFlash > 0) obj.gateFlash -= dt
    const scale = pulse + flash * 0.55
    gate.scale.setScalar(scale)
    if (this.raceGateInner) this.raceGateInner.rotation.z += dt * 0.9
    if (this.raceGateOuter) {
      const mat = this.raceGateOuter.material as THREE.MeshBasicMaterial
      mat.opacity = 0.72 + 0.2 * (0.5 + 0.5 * Math.sin(this.time * 3.4)) + flash * 0.25
    }
  }

  private updateBeaconVisual(dt: number): void {
    if (!this.beacon || !this.beacon.visible) return
    const pulse = 1 + Math.sin(this.time * 3.2) * 0.22
    if (this.beaconRing) this.beaconRing.scale.setScalar(pulse)
    if (this.beaconColumn) {
      const mat = this.beaconColumn.material as THREE.MeshBasicMaterial
      mat.opacity = 0.16 + 0.1 * (0.5 + 0.5 * Math.sin(this.time * 2.1))
    }
    void dt
  }

  private rebuildMarkers(): void {
    const engine = this.engine
    if (!engine) return
    this.markersDirty = false
    for (const group of this.markers.values()) engine.scene.remove(group)
    this.markers.clear()
    this.notifiedMarkers.clear()
    if (this.active) return // no markers while a mission runs

    let fallbackIndex = 0
    for (const mission of engine.content.missions) {
      const status = this.statusOf(mission)
      if (status !== 'available') continue
      const pos = mission.startPosition ?? (() => {
        const sp = engine.level.spawnPoint
        const i = fallbackIndex++
        return { x: sp.x + 14 + (i % 4) * 8, y: 0, z: sp.z + 14 + Math.floor(i / 4) * 8 }
      })()

      const group = new THREE.Group()
      const pillar = new THREE.Mesh(
        new THREE.CylinderGeometry(1.1, 1.1, 3.2, 10, 1, true),
        new THREE.MeshBasicMaterial({
          color: 0xfbbf24, transparent: true, opacity: 0.4,
          side: THREE.DoubleSide, depthWrite: false,
        }),
      )
      pillar.position.y = 1.6
      group.add(pillar)
      const cap = new THREE.Mesh(
        new THREE.SphereGeometry(0.45, 12, 10),
        new THREE.MeshStandardMaterial({
          color: 0xfbbf24, emissive: new THREE.Color(0xfbbf24), emissiveIntensity: 0.9,
        }),
      )
      cap.position.y = 3.4
      group.add(cap)
      group.position.set(pos.x, 0, pos.z)
      engine.scene.add(group)
      this.markers.set(mission.id, group)
    }
  }

  private updateMarkers(dt: number): void {
    const engine = this.engine
    if (!engine) return
    const player = engine.player.position
    let i = 0
    for (const [missionId, group] of this.markers) {
      const pulse = 1 + Math.sin(this.time * 2.6 + i) * 0.12
      group.scale.setScalar(pulse)
      group.rotation.y += dt * 0.6
      i++
      if (!this.notifiedMarkers.has(missionId)) {
        const d = Math.hypot(player.x - group.position.x, player.z - group.position.z)
        if (d < MARKER_HINT_M) {
          this.notifiedMarkers.add(missionId)
          const mission = engine.content.missions.find((m) => m.id === missionId)
          if (mission) engine.notify(`Mission available: ${mission.name} — press E`, 'info')
        }
      }
    }
  }

  // =================================================================
  // HUD progress strings
  // =================================================================

  private objectiveProgress(mission: ActiveMission): string {
    const engine = this.engine!
    const o = mission.data.objectives[mission.objectiveIndex]
    if (!o) return ''
    const player = engine.player.position
    switch (o.type) {
      case 'goto':
      case 'observe':
      case 'locate': {
        const pos = this.objectiveTargetPosition(o)
        if (!pos) return ''
        const d = Math.hypot(player.x - pos.x, player.z - pos.z)
        return `${Math.max(0, Math.round(d - (o.radius ?? DEFAULT_GOTO_RADIUS)))} m`
      }
      case 'interact':
        return mission.obj.treating ? `${mission.obj.timer.toFixed(1)}s` : 'Press E'
      case 'timer':
      case 'survive':
      case 'defend':
        return `${Math.max(0, mission.obj.timer).toFixed(0)}s left`
      case 'eliminate':
        return `${mission.kills}/${o.targetCount ?? 3}`
      case 'collect':
        return `${mission.collected}/${o.targetCount ?? 4}`
      case 'chase':
        return `${mission.obj.chaseCloseTime.toFixed(1)}/${CHASE_NEED_SEC.toFixed(0)}s close`
      case 'race': {
        const total = mission.obj.checkpoints.length
        if (mission.obj.countdown > 0) return 'Get ready…'
        const t =
          mission.obj.raceElapsed >= 60
            ? `${Math.floor(mission.obj.raceElapsed / 60)}m ${Math.floor(mission.obj.raceElapsed % 60)}s`
            : `${mission.obj.raceElapsed.toFixed(1)}s`
        return `${Math.min(mission.obj.checkpointIndex + 1, total)}/${total} · ${t}`
      }
      case 'steal': {
        const v = this.getMissionVehicle(mission)
        if (!v) return ''
        const d = Math.hypot(player.x - v.position.x, player.z - v.position.z)
        return `${Math.round(d)} m — enter it`
      }
      case 'escort': {
        const npcs = this.npcSystem()
        const ally = mission.allyNpcId ? npcs?.getNPCById?.(mission.allyNpcId) : null
        const target = this.objectiveTargetPosition(o)
        if (!ally || !target) return 'protect the hostage'
        const d = Math.hypot(
          ally.position.x - target.x,
          ally.position.z - target.z,
        )
        return `${Math.round(d)} m to safety`
      }
      case 'escape': {
        const danger = mission.dangerPoint
        if (!danger) return ''
        const d = Math.hypot(player.x - danger.x, player.z - danger.z)
        return `${Math.max(0, Math.round((o.maxDistance ?? 150) - d))} m to freedom`
      }
      case 'destroy': {
        const v = this.getMissionVehicle(mission)
        return v ? `${Math.max(0, Math.round(v.health))} HP left` : ''
      }
      default:
        return ''
    }
  }

  private objectiveTimer(mission: ActiveMission): number | null {
    const o = mission.data.objectives[mission.objectiveIndex]
    if (!o) return null
    switch (o.type) {
      case 'timer':
      case 'survive':
      case 'defend':
      case 'observe':
      case 'locate':
        return Math.max(0, mission.obj.timer)
      case 'race':
      case 'chase':
        return o.duration || o.timeLimit ? Math.max(0, mission.obj.timer) : null
      default:
        return null
    }
  }

  // =================================================================
  // System accessors
  // =================================================================

  private npcSystem(): NpcSystemLike | null {
    return (this.engine?.systems.npcs as unknown as NpcSystemLike | undefined) ?? null
  }

  private weaponsSystem(): WeaponsSystemLike | null {
    return (this.engine?.systems.weapons as unknown as WeaponsSystemLike | undefined) ?? null
  }

  private audio(): AudioLike | null {
    return (this.engine?.systems.audio as unknown as AudioLike | undefined) ?? null
  }
}

// =====================================================================
// Fleeing mission vehicle (chase / destroy target) — kinematic road
// follower that runs away from the player.
// =====================================================================
class FleeingVehicle {
  stopped = false
  private v: VehicleController
  private prevNode: RoadNode
  private nextNode: RoadNode
  private speed: number
  private getNode: (id: string) => RoadNode | undefined

  constructor(
    v: VehicleController,
    start: RoadNode,
    next: RoadNode,
    speed: number,
    graph: { getNode: (id: string) => RoadNode | undefined },
  ) {
    this.v = v
    this.prevNode = start
    this.nextNode = next
    this.speed = speed
    this.getNode = (id) => graph.getNode(id)
  }

  update(dt: number, playerPos: THREE.Vector3, physics: { getGroundHeight: (x: number, z: number) => number }): void {
    if (this.stopped || this.v.destroyed) {
      this.v.velocity.set(0, 0, 0)
      return
    }
    const targetX = this.nextNode.x
    const targetZ = this.nextNode.z
    const toX = targetX - this.v.position.x
    const toZ = targetZ - this.v.position.z
    const dist = Math.hypot(toX, toZ)
    if (dist < 3.5) {
      // Pick the neighbor that runs furthest from the player (prefer
      // continuing straight).
      const options = this.prevNode.neighborIds
        .map((id) => this.getNode(id))
        .filter((n): n is RoadNode => !!n)
      let best: RoadNode | null = null
      let bestScore = -Infinity
      for (const cand of options) {
        const dPlayer = Math.hypot(cand.x - playerPos.x, cand.z - playerPos.z)
        const straight = 1 - Math.min(
          1,
          Math.abs(
            Math.atan2(cand.x - this.prevNode.x, cand.z - this.prevNode.z) -
              Math.atan2(this.nextNode.x - this.prevNode.x, this.nextNode.z - this.prevNode.z),
          ) / Math.PI,
        )
        const score = dPlayer * 0.02 + straight
        if (score > bestScore) {
          bestScore = score
          best = cand
        }
      }
      const pool = options.length > 0 ? options : [this.prevNode]
      const chosen = best ?? pool[Math.floor(Math.random() * pool.length)]
      this.prevNode = this.nextNode
      this.nextNode = chosen
      return
    }
    const inv = 1 / dist
    const mx = toX * inv
    const mz = toZ * inv
    this.v.position.x += mx * this.speed * dt
    this.v.position.z += mz * this.speed * dt
    const ground = physics.getGroundHeight(this.v.position.x, this.v.position.z)
    this.v.position.y += (ground - this.v.position.y) * Math.min(1, dt * 8)
    this.v.velocity.set(mx * this.speed, 0, mz * this.speed)
    const targetYaw = Math.atan2(-mx, -mz)
    let dYaw = targetYaw - this.v.yaw
    while (dYaw > Math.PI) dYaw -= Math.PI * 2
    while (dYaw < -Math.PI) dYaw += Math.PI * 2
    this.v.yaw += dYaw * Math.min(1, dt * 4)
    this.v.updateVisuals(dt, 0)
  }
}

// =====================================================================
// RaceOpponent — one AI racer (round 4). Kinematic checkpoint-to-
// checkpoint driver with skill-scaled speed, rubber-band pacing vs the
// player's progress, corner braking, building slide collisions and
// inter-racer separation. Motion is owned HERE — the vehicle is spawned
// with isTraffic=true so VehicleManager only refreshes its visuals (the
// round-2 traffic double-integration fix pattern).
//
// A numbered overhead sprite (canvas texture) marks each rival so the
// grid reads instantly during the 3-2-1-GO countdown.
// =====================================================================
class RaceOpponent {
  readonly vehicle: VehicleController
  readonly name: string
  finished = false
  finishTime: number | null = null
  /** Carjacked by the player mid-race: out of the standings, no AI. */
  disqualified = false

  private checkpoints: Vec3[]
  private checkpointIndex = 0
  private speed = 0
  private skill: number
  private marker: THREE.Sprite | null = null
  private markerTexture: THREE.CanvasTexture | null = null

  constructor(v: VehicleController, name: string, skill: number, checkpoints: Vec3[], gridNumber: number) {
    this.vehicle = v
    this.name = name
    this.skill = skill
    this.checkpoints = checkpoints
    this.marker = makeRacerNumberSprite(gridNumber, name)
    if (this.marker) {
      v.group.add(this.marker)
      this.marker.position.set(0, v.data.height + 1.7, 0)
    }
  }

  /** Progress metric shared with the player's standings math. */
  progress(): number {
    if (this.disqualified) return Number.NEGATIVE_INFINITY
    if (this.finished) return Number.POSITIVE_INFINITY
    const cp = this.checkpoints[this.checkpointIndex]
    if (!cp) return this.checkpointIndex * 1000
    const d = Math.hypot(this.vehicle.position.x - cp.x, this.vehicle.position.z - cp.z)
    return this.checkpointIndex * 1000 - Math.min(d, 1000)
  }

  update(dt: number, playerProgress: number, engine: GameEngine, others: RaceOpponent[]): void {
    const v = this.vehicle

    // Carjacked: the player owns this vehicle now — NEVER write to it
    // from the AI side (that position tug-of-war was the freeze bug).
    if (this.disqualified) return

    if (this.finished) {
      // Crossed the line — brake to a stop, keep visuals settling.
      this.speed = Math.max(0, this.speed - 16 * dt)
      v.velocity.multiplyScalar(Math.exp(-3 * dt))
      v.updateVisuals(dt, 1)
      return
    }

    const cp = this.checkpoints[this.checkpointIndex]
    if (!cp) {
      this.finished = true
      return
    }

    const toX = cp.x - v.position.x
    const toZ = cp.z - v.position.z
    const dist = Math.hypot(toX, toZ)

    // ---- claim checkpoint ------------------------------------------
    if (dist <= RACE_CP_RADIUS) {
      this.checkpointIndex++
      if (this.checkpointIndex >= this.checkpoints.length) {
        this.finished = true
        this.finishTime = null // elapsed tracked by the mission, not here
        v.velocity.set(0, 0, 0)
        return
      }
      return
    }

    // ---- speed: skill × rubber-band × corner braking ----------------
    const maxSpeed = v.data.maxSpeed / 3.6
    let target = RACE_OPP_BASE_SPEED * this.skill
    const margin = this.progress() - playerProgress
    if (margin > 900) target *= 0.86 // way ahead → let the pack catch up
    else if (margin < -900) target = Math.min(target * 1.2, maxSpeed * 1.05) // behind → hunt
    if (dist < 28) target = Math.min(target, RACE_OPP_BASE_SPEED * 0.74) // set up the turn
    target = Math.min(target, maxSpeed)
    const rate = target < this.speed ? 13 : 6.5
    this.speed += THREE.MathUtils.clamp(target - this.speed, -rate * dt, rate * dt)
    if (this.speed < 0.05) this.speed = 0

    // ---- steering + movement ----------------------------------------
    if (this.speed > 0) {
      const inv = 1 / dist
      const mx = toX * inv
      const mz = toZ * inv
      v.position.x += mx * this.speed * dt
      v.position.z += mz * this.speed * dt
      v.position.x = THREE.MathUtils.clamp(v.position.x, 4, engine.level.sizeX - 4)
      v.position.z = THREE.MathUtils.clamp(v.position.z, 4, engine.level.sizeZ - 4)
      v.velocity.set(mx * this.speed, 0, mz * this.speed)
      const targetYaw = Math.atan2(-mx, -mz)
      let dYaw = targetYaw - v.yaw
      while (dYaw > Math.PI) dYaw -= Math.PI * 2
      while (dYaw < -Math.PI) dYaw += Math.PI * 2
      v.yaw += dYaw * Math.min(1, dt * 3.6)
    } else {
      v.velocity.set(0, 0, 0)
    }

    // ---- ground -------------------------------------------------------
    const ground = engine.physics.getGroundHeight(v.position.x, v.position.z)
    v.position.y += (ground - v.position.y) * Math.min(1, dt * 8)

    // ---- building collisions (slide) ----------------------------------
    const radius = v.data.width * 0.55 + 0.45
    const hit = engine.physics.collideCircle(v.position, radius, v.data.height * 0.7, false)
    if (hit.hit && hit.depth > 0.001) {
      v.position.x += hit.nx * hit.depth
      v.position.z += hit.nz * hit.depth
      const into = v.velocity.x * hit.nx + v.velocity.z * hit.nz
      if (into < -3) {
        v.applyDamage(Math.min(14, -into * 1.1))
        this.speed *= 0.5
      }
      v.velocity.x -= hit.nx * into * 1.2
      v.velocity.z -= hit.nz * into * 1.2
    }

    // ---- separation from other racers + the player's car ---------------
    const separate = (ox: number, oz: number, minD: number, pushSelf: number, pushOther: number): void => {
      const dx = v.position.x - ox
      const dz = v.position.z - oz
      const d = Math.hypot(dx, dz)
      if (d < minD && d > 0.01) {
        v.position.x += (dx / d) * (minD - d) * pushSelf
        v.position.z += (dz / d) * (minD - d) * pushSelf
        void pushOther
      }
    }
    for (const other of others) {
      if (other === this || other.finished) continue
      const ov = other.vehicle
      const minD = (v.data.length + ov.data.length) * 0.42
      separate(ov.position.x, ov.position.z, minD, 0.5, 0)
    }
    // Light avoidance of the player's vehicle (player physics stays
    // authoritative — only this opponent gets nudged).
    const pvId = engine.vehicles.playerVehicleId
    const pv = pvId ? engine.vehicles.getById(pvId) : null
    if (pv && !pv.destroyed) {
      const minD = (v.data.length + pv.data.length) * 0.4
      separate(pv.position.x, pv.position.z, minD, 0.65, 0)
    }

    v.updateVisuals(dt, this.speed < target * 0.6 ? 1 : 0)
  }

  dispose(scene: THREE.Scene | null): void {
    if (this.marker) {
      this.marker.parent?.remove(this.marker)
      this.markerTexture?.dispose()
      ;(this.marker.material as THREE.Material).dispose()
      this.marker = null
      this.markerTexture = null
    }
    void scene
  }
}

/** Numbered overhead pill sprite marking each race opponent. */
function makeRacerNumberSprite(gridNumber: number, name: string): THREE.Sprite | null {
  try {
    const canvas = document.createElement('canvas')
    canvas.width = 160
    canvas.height = 64
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    // dark pill w/ amber border — reads on any backdrop, matches the
    // HUD's amber racing accents (no blue per the design rules).
    ctx.clearRect(0, 0, 160, 64)
    roundRect(ctx, 6, 10, 148, 44, 12)
    ctx.fillStyle = 'rgba(9, 9, 11, 0.88)'
    ctx.fill()
    ctx.lineWidth = 3
    ctx.strokeStyle = 'rgba(251, 191, 36, 0.95)'
    ctx.stroke()
    ctx.font = '900 26px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.fillStyle = '#fde68a'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(`#${gridNumber}`, 16, 33)
    ctx.font = '700 17px system-ui, sans-serif'
    ctx.fillStyle = '#e4e4e7'
    ctx.textAlign = 'right'
    ctx.fillText(name.slice(0, 10), 148, 33)
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false })
    const sprite = new THREE.Sprite(mat)
    sprite.scale.set(3.4, 1.36, 1)
    return sprite
  } catch {
    return null
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}
