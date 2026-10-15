/**
 * NPCManager — pedestrians, police, SWAT, gang members, mission enemies
 * and escort allies. THE gap fixes vs the original C++ project (whose
 * NPCManager had zero working states):
 *   - FULL state machine: idle / walk / run / flee / investigate /
 *     chase / follow / dead — the original's DRIVING and FLEEING states
 *     were declared but never implemented.
 *   - A* wandering via Pathfinder (runs every frame — the C++ A* was
 *     dead code).
 *   - Reactions parsed from .npc asset data (gunshot → flee/investigate,
 *     vehicle crash → investigate, player bump → complain speech).
 *   - Police + wanted system: foot pursuit at 1-2 stars, armed police
 *     at 3+, SWAT at 4-5, wanted decay (−1 per 45 s without crimes) and
 *     the BUSTED flow (3 s within 2.5 m while wanted, on foot).
 *
 * Registered as engine system 'npcs'. Each NPC "thinks" at 5 Hz
 * (staggered) and moves every fixed step. Ambient population caps at
 * ~40 near the player (despawn > 180 m, respawn from spawn areas).
 */
import * as THREE from 'three'
import type { EngineSystem, GameEngine } from '@/game/engine'
import type { NpcData, NpcReaction, Vec3 } from '@/game/types'
import { Pathfinder } from './Pathfinder'
import type { RoadGraph } from '@/game/world/RoadGraph'
import type { PickupManager } from '@/game/gameplay/Pickups'

// ---------------------------------------------------------------------
// Public shapes (used by WeaponSystem / TrafficSystem / MissionSystem)
// ---------------------------------------------------------------------

export interface SpawnEnemyOptions {
  hostile?: boolean
  missionId?: string
  /** Escort ally: friendly, follows the player loosely. */
  ally?: boolean
  healthOverride?: number
}

export interface NpcRayHit {
  npcId: string
  distance: number
  point: Vec3
}

export interface NpcInfo {
  id: string
  type: string
  position: Vec3
  hostile: boolean
  alive: boolean
}

export type NpcKilledCallback = (
  npcId: string,
  npcType: string,
  missionId: string | null,
  byPlayer: boolean,
) => void

interface AudioLike {
  play?: (name: string, opts?: { position?: Vec3; volume?: number }) => void
}
interface PickupLike {
  spawn?: (pos: Vec3, opts: Parameters<PickupManager['spawn']>[1]) => string
}

type NpcState = 'idle' | 'walk' | 'run' | 'flee' | 'investigate' | 'chase' | 'follow' | 'dead'

interface NPC {
  id: string
  contentId: string
  name: string
  type: string // police | swat | gang_member | pedestrian | worker | ...
  data: NpcData
  group: THREE.Group
  bodyMat: THREE.MeshStandardMaterial
  legMat: THREE.MeshStandardMaterial
  headMat: THREE.MeshStandardMaterial
  legPivots: THREE.Object3D[]
  armPivots: THREE.Object3D[]
  healthBar: { root: THREE.Object3D; fill: THREE.Sprite }
  speech: { sprite: THREE.Sprite; timer: number } | null
  position: THREE.Vector3
  yaw: number
  health: number
  maxHealth: number
  state: NpcState
  stateTimer: number
  path: Vec3[]
  pathIndex: number
  thinkTimer: number
  legPhase: number
  speed: number
  hostile: boolean
  armed: boolean
  duty: boolean // police duty (wanted-response spawn)
  missionId: string | null
  ally: boolean
  followTarget: boolean
  fleeFrom: THREE.Vector3 | null
  fireTimer: number
  meleeTimer: number
  complainTimer: number
  deadTimer: number
  fadeBase: number
  investigatePoint: THREE.Vector3 | null
  wanderAnchor: THREE.Vector3
  leaving: boolean
}

// ---------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------
const THINK_INTERVAL = 0.2 // 5 Hz
const HARD_NPC_CAP = 40
const AMBIENT_DESPAWN_M = 180
const POLICE_SPAWN_MIN_M = 35
const POLICE_SPAWN_MAX_M = 70
const WANTED_DECAY_SEC = 45
// Night cycle (21:00–06:00): heat lingers longer and the precinct fields
// more officers — the streets get meaner after dark.
const WANTED_DECAY_NIGHT_SEC = 70
const NIGHT_START_HOUR = 21
const NIGHT_END_HOUR = 6
const BUSTED_RANGE_M = 2.5
const BUSTED_HOLD_SEC = 3
const BUSTED_FINE = 200
const POLICE_MELEE_RANGE = 1.7
const POLICE_MELEE_DMG = 8
const POLICE_SHOOT_RANGE = 32
const CHASE_STOP_RANGE = 13
const FLEE_DURATION_SEC = 8
const DEAD_DESPAWN_SEC = 10
const DEAD_FADE_START_SEC = 6
const NPC_RADIUS = 0.35
const NPC_HEIGHT = 1.8

const HOSTILE_TYPES = new Set([
  'police', 'swat', 'gang_member', 'gang_leader', 'guard', 'criminal',
  'bodyguard', 'security', 'reinforcement', 'boss', 'vip', 'car_thief',
  'armed_robber', 'hostile',
])

const POLICE_TARGETS: Record<number, number> = { 0: 0, 1: 2, 2: 3, 3: 4, 4: 5, 5: 6 }

/**
 * Time-of-day crowd multiplier for the ambient pedestrian population:
 * dead of night 0.4 → dawn ramp → morning rush 1.25 → midday 1.0 →
 * evening rush 1.3 → winding down. Piecewise-linear, hour-valued.
 */
export function crowdFactorForHour(hour: number): number {
  const h = ((hour % 24) + 24) % 24
  // [hour, factor] anchor points across the day.
  const anchors: [number, number][] = [
    [0, 0.4],
    [5, 0.4],
    [7, 1.0],
    [8.5, 1.25],
    [10, 1.0],
    [16, 1.0],
    [17.5, 1.3],
    [19, 0.9],
    [21, 0.6],
    [24, 0.45],
  ]
  for (let i = 0; i < anchors.length - 1; i++) {
    const [h0, f0] = anchors[i]
    const [h1, f1] = anchors[i + 1]
    if (h >= h0 && h <= h1) {
      const t = (h - h0) / Math.max(0.001, h1 - h0)
      return f0 + (f1 - f0) * t
    }
  }
  return 1
}

// Palettes (muted, no blue/indigo)
const PED_TORSO = [0x8a8177, 0x6b705c, 0x7d6b5d, 0x5f6b66, 0x7a6a76, 0x665a4d, 0x58604f, 0x75655a]
const PED_LEGS = [0x3c3a36, 0x46423b, 0x35322e, 0x4a4440]
const SKIN_TONES = [0xc9a184, 0x8d6748, 0xe0b08e, 0x6e4f35]
const POLICE_TORSO = 0x2f3439 // dark slate (NOT blue)
const POLICE_LEGS = 0x23262b
const POLICE_CAP = 0x1b1f24
const SWAT_TORSO = 0x17181b
const SWAT_LEGS = 0x121316
const GANG_TORSO = 0x3a3d42
const BANDANA = 0x7f1d2b // dark crimson
const DRIVER_TORSO = 0x6b5d4a
const WORKER_TORSO = 0xa67c3d
const GUARD_TORSO = 0x3d4034
const CRIMINAL_TORSO = 0x4a3f35
const LEADER_TORSO = 0x26221f

const SPEECH_TEXTURES = new Map<string, THREE.Texture>()

function speechTexture(text: string): THREE.Texture {
  let tex = SPEECH_TEXTURES.get(text)
  if (tex) return tex
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 64
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = 'rgba(24,24,27,0.92)'
  ctx.strokeStyle = 'rgba(161,161,170,0.8)'
  ctx.lineWidth = 3
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath()
    ctx.roundRect(4, 4, 248, 48, 14)
    ctx.fill()
    ctx.stroke()
  } else {
    ctx.fillRect(4, 4, 248, 48)
    ctx.strokeRect(4, 4, 248, 48)
  }
  ctx.fillStyle = '#f4f4f5'
  ctx.font = 'bold 26px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, 128, 30)
  tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  SPEECH_TEXTURES.set(text, tex)
  return tex
}

const COMPLAINTS = ['Hey!', 'Watch it!', 'Out of the way!', 'Careful!']
const POLICE_SHOUTS = ['Freeze!', 'Stop right there!', 'Hands up!']
const FLEE_SHOUTS = ['Run!', "He's got a gun!", 'Take cover!', 'Look out!', 'Get down!']
const WOUNDED_GRUNTS = ['Argh!', 'Ow!', 'Ah!', 'Help!']
const AMBIENT_DAY = ['Lovely day…', 'Late for work…', 'Coffee time.', 'Busy streets today.', 'Nice weather.']
const AMBIENT_NIGHT = ['Cold night…', 'Late shift again…', 'Creepy after dark…', 'Almost home.', 'Where is a cab?']
const AMBIENT_CHATTER_SEC = 14

// Shared geometries
const GEO_TORSO = new THREE.BoxGeometry(0.44, 0.58, 0.26)
const GEO_HEAD = new THREE.BoxGeometry(0.27, 0.27, 0.27)
const GEO_LEG = new THREE.BoxGeometry(0.15, 0.75, 0.15)
const GEO_ARM = new THREE.BoxGeometry(0.12, 0.52, 0.12)
const GEO_CAP = new THREE.BoxGeometry(0.31, 0.09, 0.31)
const GEO_BRIM = new THREE.BoxGeometry(0.3, 0.03, 0.14)
const GEO_BANDANA = new THREE.BoxGeometry(0.29, 0.1, 0.29)
const GEO_HELMET = new THREE.BoxGeometry(0.33, 0.31, 0.33)
const GEO_VISOR = new THREE.BoxGeometry(0.26, 0.08, 0.04)
const GEO_BAR_BG = new THREE.PlaneGeometry(1, 1)
const BAR_BG_MAT = new THREE.SpriteMaterial({ color: 0x18181b, transparent: true, opacity: 0.85, depthWrite: false })
const BAR_FILL_MAT = new THREE.SpriteMaterial({ color: 0x34d399, depthWrite: false })

let idCounter = 0

/** Defensive fallback when the content bundle ships no .npc files. */
const DEFAULT_NPC_DATA: NpcData = {
  id: 'npc_default',
  name: 'Civilian',
  type: 'pedestrian',
  behavior: 'wander',
  health: 100,
  speedWalk: 1.5,
  speedRun: 4,
  wanderRadius: 40,
  fleeOnDanger: true,
  callPoliceOnCrime: false,
  spawnWeight: 50,
  spawnLocations: [],
  reactions: [],
}

export class NPCManager implements EngineSystem {
  /** Set by the MissionSystem to count objective kills (may be null). */
  onNpcKilled: NpcKilledCallback | null = null

  private engine: GameEngine | null = null
  private scene: THREE.Scene | null = null
  private pathfinder: Pathfinder | null = null
  private graph: RoadGraph | null = null
  private npcs: NPC[] = []
  private time = 0
  private popTimer = 0
  private policeTimer = 0
  private chatterTimer = 8
  private sinceLastCrime = 0
  private bustedTimer = 0
  private lastWanted = 0
  private isNight = false
  private levelSize = { x: 1000, z: 1000 }

  // =================================================================
  // EngineSystem hooks
  // =================================================================

  init(engine: GameEngine): void {
    this.engine = engine
    this.scene = engine.scene
    this.rebuildForLevel()
    // Level swaps rebuild the ambient population.
    engine.onEvent((evt) => {
      if (evt.type === 'levelLoaded') this.rebuildForLevel()
    })
  }

  /** One-shot nightfall/dawn notifications + police-pressure flag. */
  private updateNightCycle(engine: GameEngine): void {
    const hour = engine.dayTime
    const night = hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR
    if (night === this.isNight) return
    this.isNight = night
    if (night) {
      engine.notify('Night falls — police patrols double down', 'warning')
    } else {
      engine.notify('Dawn breaks — the streets calm down', 'info')
    }
  }

  update(dt: number): void {
    const engine = this.engine
    if (!engine) return
    this.time += dt

    const player = engine.player
    const wanted = player.wantedLevel
    const onFoot = engine.vehicles.playerVehicleId === null

    // ---- day/night transition watcher (one toast per transition) ----
    this.updateNightCycle(engine)

    // ---- wanted decay (45 s day / 70 s night → −1 star) -------------
    this.sinceLastCrime += dt
    const decaySec = this.isNight ? WANTED_DECAY_NIGHT_SEC : WANTED_DECAY_SEC
    if (wanted > 0 && this.sinceLastCrime >= decaySec) {
      this.sinceLastCrime = 0
      engine.setWantedLevel(wanted - 1)
      engine.notify('Wanted level decreased', 'info')
    }
    this.lastWanted = wanted

    // ---- population + police management (throttled) -----------------
    this.popTimer -= dt
    if (this.popTimer <= 0) {
      this.popTimer = 1.2
      this.manageAmbientPopulation()
      this.despawnFar()
    }
    this.policeTimer -= dt
    if (this.policeTimer <= 0) {
      this.policeTimer = 0.5
      this.managePolice(wanted, this.isNight)
    }

    // ---- ambient street chatter (one nearby civilian, ~14 s) --------
    this.chatterTimer -= dt
    if (this.chatterTimer <= 0) {
      this.chatterTimer = AMBIENT_CHATTER_SEC * (0.75 + Math.random() * 0.5)
      this.ambientChatter(engine)
    }

    // ---- BUSTED check ----------------------------------------------
    if (onFoot && wanted > 0 && !player.dead) {
      const near = this.nearestDutyPolice(player.position)
      if (near && near.position.distanceTo(player.position) <= BUSTED_RANGE_M) {
        this.bustedTimer += dt
        if (this.bustedTimer >= BUSTED_HOLD_SEC) this.executeBusted()
      } else {
        this.bustedTimer = 0
      }
    } else {
      this.bustedTimer = 0
    }

    // ---- per-NPC update ---------------------------------------------
    for (let i = this.npcs.length - 1; i >= 0; i--) {
      const npc = this.npcs[i]
      npc.thinkTimer -= dt
      if (npc.thinkTimer <= 0 && npc.state !== 'dead') {
        npc.thinkTimer = THINK_INTERVAL + Math.random() * 0.05
        this.think(npc)
      }
      this.moveNpc(npc, dt)
      this.animateNpc(npc, dt)
      if (npc.state === 'dead') {
        npc.deadTimer += dt
        if (npc.deadTimer > DEAD_FADE_START_SEC) {
          const t = Math.min(1, (npc.deadTimer - DEAD_FADE_START_SEC) / (DEAD_DESPAWN_SEC - DEAD_FADE_START_SEC))
          npc.bodyMat.opacity = npc.fadeBase * (1 - t)
          npc.legMat.opacity = npc.fadeBase * (1 - t)
          npc.headMat.opacity = npc.fadeBase * (1 - t)
        }
        if (npc.deadTimer >= DEAD_DESPAWN_SEC) {
          this.removeAt(i)
          continue
        }
      }
      // Leaving police fade-out
      if (npc.leaving) {
        npc.stateTimer -= dt
        if (npc.stateTimer <= 0) {
          this.removeAt(i)
          continue
        }
      }
    }
  }

  dispose(): void {
    for (let i = this.npcs.length - 1; i >= 0; i--) this.removeAt(i)
    this.npcs.length = 0
    this.pathfinder = null
    this.graph = null
    this.engine = null
    this.scene = null
    this.onNpcKilled = null
  }

  // Placeholder conformances (NPC state is not persisted).
  getSaveData(): Record<string, unknown> {
    return {}
  }
  applySaveData(): void {
    /* nothing to restore */
  }

  // =================================================================
  // Public API (other systems call these)
  // =================================================================

  /** Spawn a named enemy/actor type near a position. Returns the npc id. */
  spawnEnemy(type: string, position: Vec3, opts?: SpawnEnemyOptions): string {
    const { data, contentId } = this.resolveNpcData(type)
    const hostile = opts?.hostile ?? HOSTILE_TYPES.has(type)
    const npc = this.createNPC(contentId, type, data, {
      position,
      hostile,
      missionId: opts?.missionId ?? null,
      ally: opts?.ally ?? false,
      health: opts?.healthOverride ?? data.health,
    })
    if (hostile) npc.state = 'chase'
    else if (opts?.ally) npc.state = 'follow'
    return npc.id
  }

  /**
   * Pursuit hand-off (PolicePursuit system): deploy duty officers that
   * count toward the wanted-response force and the foot-BUSTED check.
   * SWAT leads the deployment at wanted 4+.
   */
  spawnDutyPolice(position: Vec3, count = 2): void {
    const engine = this.engine
    if (!engine) return
    for (let i = 0; i < count; i++) {
      const type = engine.player.wantedLevel >= 4 && i === 0 ? 'swat' : 'police'
      const { data, contentId } = this.resolveNpcData(type)
      const npc = this.createNPC(contentId, type, data, {
        position: {
          x: position.x + (i === 0 ? -1.4 : 1.4) + (Math.random() - 0.5),
          y: 0,
          z: position.z + 2.2 + Math.random() * 1.2,
        },
        hostile: true,
        missionId: null,
        ally: false,
        health: data.health,
      })
      npc.duty = true
      npc.state = 'chase'
    }
  }

  /** Ray vs alive-NPC body AABBs. Nearest hit wins. */
  raycastNPCs(origin: Vec3, dir: Vec3, maxDist: number): NpcRayHit | null {
    let best: NpcRayHit | null = null
    for (const npc of this.npcs) {
      if (npc.state === 'dead') continue
      // Slab test vs AABB [x±0.4, y..y+1.85, z±0.4]
      const minX = npc.position.x - 0.4
      const maxX = npc.position.x + 0.4
      const minY = npc.position.y
      const maxY = npc.position.y + 1.85
      const minZ = npc.position.z - 0.4
      const maxZ = npc.position.z + 0.4
      let hit = true
      let tmin = 0
      let tmax = maxDist
      const bounds: [number, number, number, number][] = [
        [minX, maxX, origin.x, dir.x],
        [minY, maxY, origin.y, dir.y],
        [minZ, maxZ, origin.z, dir.z],
      ]
      for (const [bmin, bmax, o, d] of bounds) {
        if (Math.abs(d) < 1e-9) {
          if (o < bmin || o > bmax) {
            hit = false
            break
          }
          continue
        }
        const inv = 1 / d
        let t1 = (bmin - o) * inv
        let t2 = (bmax - o) * inv
        if (t1 > t2) {
          const tmp = t1
          t1 = t2
          t2 = tmp
        }
        if (t1 > tmin) tmin = t1
        if (t2 < tmax) tmax = t2
        if (tmin > tmax) {
          hit = false
          break
        }
      }
      if (hit && tmin >= 0 && tmin <= maxDist) {
        if (!best || tmin < best.distance) {
          best = {
            npcId: npc.id,
            distance: tmin,
            point: {
              x: origin.x + dir.x * tmin,
              y: origin.y + dir.y * tmin,
              z: origin.z + dir.z * tmin,
            },
          }
        }
      }
    }
    return best
  }

  /** Apply damage; handles death, drops, aggro and wanted changes. */
  damageNPC(id: string, amount: number, byPlayer: boolean): void {
    const engine = this.engine
    const npc = this.npcs.find((n) => n.id === id)
    if (!engine || !npc || npc.state === 'dead') return
    npc.health -= amount

    // Hit reactions
    if (npc.health > 0) {
      if (byPlayer) {
        if (npc.hostile || npc.duty) npc.state = 'chase' // aggro
        else if (npc.data.fleeOnDanger && !npc.missionId) this.startFlee(npc, engine.player.position)
        this.showHealthBar(npc)
      }
      // Wounded grunt (cooldown via complainTimer to avoid spam).
      if (npc.complainTimer <= 0) {
        npc.complainTimer = 2.5
        this.showSpeech(npc, WOUNDED_GRUNTS[Math.floor(Math.random() * WOUNDED_GRUNTS.length)])
      }
      return
    }

    // ---- death ------------------------------------------------------
    npc.health = 0
    npc.state = 'dead'
    npc.deadTimer = 0
    npc.path = []
    npc.healthBar.root.visible = false
    if (npc.speech) npc.speech.sprite.visible = false
    this.audio()?.play?.('damage_thud', { position: npc.position })
    engine.emitEvent({ type: 'npcKilled', npcType: npc.type })

    // MissionSystem kill counting.
    this.onNpcKilled?.(npc.id, npc.type, npc.missionId, byPlayer)

    if (byPlayer && !npc.missionId) {
      // Wanted: killing ped +1, killing police +2 (mission-spawned kills
      // are counted by the MissionSystem instead — no wanted bump).
      const isPolice = npc.type === 'police' || npc.type === 'swat'
      this.registerCrime(isPolice ? 2 : 1)
      if (isPolice) engine.notify('Cop killer! Wanted level up', 'danger')
    }

    if (!npc.missionId) {
      // Cash drop (40 %, $20-80) — 50/50 amount band.
      if (Math.random() < 0.4) {
        const cash = 20 + Math.floor(Math.random() * 61)
        this.pickups()?.spawn?.(
          { x: npc.position.x, y: npc.position.y, z: npc.position.z },
          { kind: 'cash', amount: cash },
        )
      }
      // Ammo drop (30 %, pistol/smg rounds) from hostiles.
      if (npc.hostile && Math.random() < 0.3) {
        const pistol = Math.random() < 0.5
        this.pickups()?.spawn?.(
          { x: npc.position.x + 0.8, y: npc.position.y, z: npc.position.z },
          {
            kind: 'ammo',
            amount: pistol ? 12 + Math.floor(Math.random() * 13) : 20 + Math.floor(Math.random() * 21),
            weaponId: pistol ? 'pistol' : 'smg',
          },
        )
      }
    }
  }

  /** All live NPCs (minimap, siren positioning). */
  getNPCs(): NpcInfo[] {
    return this.npcs
      .filter((n) => n.state !== 'dead')
      .map((n) => ({
        id: n.id,
        type: n.type,
        position: { x: n.position.x, y: n.position.y, z: n.position.z },
        hostile: n.hostile || n.duty,
        alive: true,
      }))
  }

  /** Get one NPC's info by id (mission escort checks). */
  getNPCById(id: string): NpcInfo | null {
    const n = this.npcs.find((x) => x.id === id)
    if (!n) return null
    return {
      id: n.id,
      type: n.type,
      position: { x: n.position.x, y: n.position.y, z: n.position.z },
      hostile: n.hostile,
      alive: n.state !== 'dead',
    }
  }

  /** Gunshot panic: reactions + flee within radius. */
  notifyGunshot(position: Vec3): void {
    const engine = this.engine
    if (!engine) return
    for (const npc of this.npcs) {
      if (npc.state === 'dead' || npc.missionId) continue
      const d = Math.hypot(npc.position.x - position.x, npc.position.z - position.z)
      const reaction = this.reactionFor(npc, 'gunshot')
      const radius = reaction?.radius ?? 28
      if (d > radius) continue
      if (npc.duty || (npc.hostile && npc.type !== 'pedestrian')) {
        npc.state = 'chase' // police / hostiles converge on the shooter
      } else if (npc.type === 'worker') {
        this.startInvestigate(npc, position)
      } else if (npc.data.fleeOnDanger) {
        this.startFlee(npc, position)
      }
    }
  }

  /** Vehicle crash near → pedestrians investigate/complain. */
  notifyCrash(position: Vec3, radius = 12): void {
    for (const npc of this.npcs) {
      if (npc.state === 'dead' || npc.missionId) continue
      const d = Math.hypot(npc.position.x - position.x, npc.position.z - position.z)
      if (d > radius) continue
      if (npc.hostile || npc.duty) continue
      if (this.reactionFor(npc, 'vehicle_crash') || npc.type === 'worker') {
        this.startInvestigate(npc, position)
      }
    }
  }

  /** Panic everyone (non-hostile) within radius. */
  fleeAll(position: Vec3, radius: number): void {
    for (const npc of this.npcs) {
      if (npc.state === 'dead' || npc.hostile || npc.duty || npc.missionId) continue
      const d = Math.hypot(npc.position.x - position.x, npc.position.z - position.z)
      if (d <= radius && npc.data.fleeOnDanger) this.startFlee(npc, position)
    }
  }

  /**
   * Register a crime: bumps wanted level (optional) and resets the
   * 45 s decay timer. bump 0 = just suppress decay (mission pressure).
   */
  registerCrime(bump = 0): void {
    const engine = this.engine
    if (!engine) return
    this.sinceLastCrime = 0
    if (bump > 0) {
      const next = Math.min(5, engine.player.wantedLevel + bump)
      if (next > engine.player.wantedLevel) engine.setWantedLevel(next)
    }
  }

  /** Remove every mission-spawned NPC (mission cleanup). */
  removeMissionNpcs(missionId: string): void {
    for (let i = this.npcs.length - 1; i >= 0; i--) {
      if (this.npcs[i].missionId === missionId) this.removeAt(i)
    }
  }

  /** Debug helper — one police officer 12 m ahead of the player. */
  debugSpawnPolice(): void {
    const engine = this.engine
    if (!engine) return
    const p = engine.player.position
    this.spawnEnemy('police', { x: p.x + 6, y: p.y, z: p.z + 6 }, { hostile: true })
  }

  // =================================================================
  // Population / police management
  // =================================================================

  private rebuildForLevel(): void {
    const engine = this.engine
    if (!engine) return
    // Clear everything (level geometry/positions changed).
    for (let i = this.npcs.length - 1; i >= 0; i--) this.removeAt(i)
    const level = engine.level
    this.graph = engine.world.getRoadGraph()
    this.pathfinder = new Pathfinder(this.graph, engine.physics)
    this.levelSize = { x: level.sizeX, z: level.sizeZ }
    // Seed the initial ambient crowd near the player.
    this.manageAmbientPopulation()
  }

  private ambientTarget(): number {
    const density = this.engine?.level.pedestrianDensity.toLowerCase() ?? 'medium'
    const base = density === 'low' ? 10 : density === 'high' ? 30 : 20
    // Round-3 carry-over: pedestrian density now follows the CLOCK —
    // rush-hour peaks (07-10 / 16-19), quiet lunchtime, thin late-night
    // streets. The city's rhythm reads alive from a rooftop at any hour.
    const factor = crowdFactorForHour(this.engine?.dayTime ?? 12)
    return Math.max(4, Math.round(base * factor))
  }

  private manageAmbientPopulation(): void {
    const engine = this.engine
    if (!engine) return
    const ambient = this.npcs.filter(
      (n) => !n.duty && !n.missionId && !n.hostile && n.state !== 'dead',
    ).length
    let target = this.ambientTarget()
    target = Math.min(target, HARD_NPC_CAP - this.policeCount() - this.missionCount())
    if (ambient >= target) return

    const level = engine.level
    const player = engine.player.position

    // Prefer authored npc spawn areas near the player.
    const spawnAreas = level.npcSpawns.filter((s) => {
      const d = Math.hypot(s.position.x - player.x, s.position.z - player.z)
      return d > 25 && d < 130
    })
    for (let k = 0; k < 2 && ambient + k < target; k++) {
      let x: number
      let z: number
      let behavior = 'pedestrian'
      if (spawnAreas.length > 0) {
        const area = spawnAreas[Math.floor(Math.random() * spawnAreas.length)]
        x = area.position.x + (Math.random() - 0.5) * 18
        z = area.position.z + (Math.random() - 0.5) * 18
        behavior = area.behavior
      } else if (this.graph) {
        const node = this.graph.randomNodeNear(
          { x: player.x, y: 0, z: player.z },
          40 + Math.random() * 80,
        )
        x = node.x + (Math.random() - 0.5) * 6
        z = node.z + (Math.random() - 0.5) * 6
      } else {
        x = player.x + (Math.random() - 0.5) * 60
        z = player.z + (Math.random() - 0.5) * 60
      }
      x = THREE.MathUtils.clamp(x, 5, this.levelSize.x - 5)
      z = THREE.MathUtils.clamp(z, 5, this.levelSize.z - 5)
      const isWorker = behavior.toLowerCase().includes('worker')
      const { data, contentId } = this.resolveNpcData(isWorker ? 'worker' : 'pedestrian')
      const npc = this.createNPC(contentId, isWorker ? 'worker' : 'pedestrian', data, {
        position: { x, y: 0, z },
        hostile: false,
        missionId: null,
        ally: false,
        health: data.health,
      })
      npc.state = 'idle'
      npc.stateTimer = Math.random() * 6
    }
  }

  private policeCount(): number {
    return this.npcs.filter((n) => n.duty && n.state !== 'dead' && !n.leaving).length
  }

  private missionCount(): number {
    return this.npcs.filter((n) => n.missionId).length
  }

  private managePolice(wanted: number, night = false): void {
    const engine = this.engine
    if (!engine || !this.graph) return
    let target = POLICE_TARGETS[Math.min(5, Math.max(0, wanted))] ?? 0
    // After dark the precinct fields an extra unit per response tier.
    if (night && wanted > 0) target += 1
    const current = this.policeCount()

    if (wanted === 0) {
      // Stand down: duty police walk away and despawn.
      for (const npc of this.npcs) {
        if (npc.duty && !npc.leaving && npc.state !== 'dead') {
          npc.leaving = true
          npc.stateTimer = 4 + Math.random() * 2
          npc.state = 'walk'
          npc.path = []
        }
      }
      return
    }

    if (current >= target) return
    const player = engine.player.position
    for (let k = current; k < target; k++) {
      // Spawn ring 35-70 m out on a road node.
      let x = player.x + 45
      let z = player.z + 45
      for (let attempt = 0; attempt < 6; attempt++) {
        const node = this.graph.randomNodeNear(
          { x: player.x, y: 0, z: player.z },
          POLICE_SPAWN_MAX_M,
        )
        const d = Math.hypot(node.x - player.x, node.z - player.z)
        if (d >= POLICE_SPAWN_MIN_M) {
          x = node.x
          z = node.z
          break
        }
      }
      // 4-5 stars: every other spawn is SWAT.
      const useSwat = wanted >= 4 && k >= target - Math.floor(target / 3)
      const type = useSwat ? 'swat' : 'police'
      const { data, contentId } = this.resolveNpcData(type)
      const npc = this.createNPC(contentId, type, data, {
        position: { x, y: 0, z },
        hostile: true,
        missionId: null,
        ally: false,
        health: data.health,
      })
      npc.duty = true
      npc.state = 'chase'
    }
  }

  private nearestDutyPolice(pos: THREE.Vector3): NPC | null {
    let best: NPC | null = null
    let bestD = BUSTED_RANGE_M + 20
    for (const npc of this.npcs) {
      if (!npc.duty || npc.state === 'dead' || npc.leaving) continue
      const d = npc.position.distanceTo(pos)
      if (d < bestD) {
        bestD = d
        best = npc
      }
    }
    return best
  }

  private executeBusted(): void {
    const engine = this.engine
    if (!engine) return
    this.bustedTimer = 0
    engine.emitEvent({ type: 'playerBusted' })
    engine.notify('BUSTED — released with a $200 fine', 'danger')
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
    // Stand the police down.
    this.managePolice(0)
  }

  private despawnFar(): void {
    const engine = this.engine
    if (!engine) return
    const player = engine.player.position
    for (let i = this.npcs.length - 1; i >= 0; i--) {
      const npc = this.npcs[i]
      if (npc.missionId) continue // mission-owned, MissionSystem disposes
      const d = npc.position.distanceTo(player)
      if (d > AMBIENT_DESPAWN_M && !npc.leaving) {
        if (npc.duty && engine.player.wantedLevel > 0) {
          // Duty police persist longer; recycle when very far.
          if (d > 260) this.removeAt(i)
        } else {
          this.removeAt(i)
        }
      }
    }
  }

  // =================================================================
  // NPC AI
  // =================================================================

  private reactionFor(npc: NPC, trigger: string): NpcReaction | undefined {
    return npc.data.reactions.find((r) => r.trigger.toLowerCase().includes(trigger))
  }

  private think(npc: NPC): void {
    const engine = this.engine
    if (!engine || npc.state === 'dead') return
    const player = engine.player

    switch (npc.state) {
      case 'idle': {
        npc.stateTimer -= THINK_INTERVAL
        if (npc.stateTimer <= 0) this.startWander(npc)
        break
      }
      case 'walk':
      case 'run': {
        if (npc.path.length === 0) this.startIdle(npc)
        break
      }
      case 'flee': {
        npc.stateTimer -= THINK_INTERVAL
        if (npc.path.length === 0) {
          if (npc.stateTimer > 0 && npc.fleeFrom) this.startFlee(npc, npc.fleeFrom)
          else this.startIdle(npc)
        }
        break
      }
      case 'investigate': {
        npc.stateTimer -= THINK_INTERVAL
        if (npc.stateTimer <= 0 && npc.path.length === 0) this.startIdle(npc)
        break
      }
      case 'chase': {
        // Hostile pursuit: keep a fresh path to the player.
        const dist = npc.position.distanceTo(player.position)
        npc.armed = npc.type === 'swat' || (npc.duty && player.wantedLevel >= 3) ||
          (npc.hostile && npc.type !== 'pedestrian' && npc.type !== 'worker')
        if (dist > CHASE_STOP_RANGE + 8) {
          npc.path = this.pathTo(npc, player.position)
          npc.pathIndex = 0
        } else {
          npc.path = [] // close enough — hold position and shoot/shove
        }
        // One-time police shout
        if (npc.duty && npc.complainTimer <= 0 && dist < 25) {
          npc.complainTimer = 8
          this.showSpeech(npc, POLICE_SHOUTS[Math.floor(Math.random() * POLICE_SHOUTS.length)])
        }
        break
      }
      case 'follow': {
        // Escort ally: trail the player loosely.
        const dist = npc.position.distanceTo(player.position)
        if (dist > 6) {
          npc.path = this.pathTo(npc, player.position)
          npc.pathIndex = 0
        } else if (dist < 3) {
          npc.path = []
        }
        break
      }
      default:
        break
    }
  }

  private moveNpc(npc: NPC, dt: number): void {
    const engine = this.engine
    if (!engine) return

    if (npc.state === 'dead') return

    // Leaving police drift away from the player and fade.
    if (npc.leaving) {
      const away = npc.position.clone().sub(engine.player.position)
      away.y = 0
      if (away.lengthSq() > 0.01) away.normalize()
      this.stepPosition(npc, away.x * 1.4, away.z * 1.4, dt)
      return
    }

    // Chase shooting / melee (per-frame, cooldown-gated).
    if (npc.state === 'chase' && !engine.player.dead) {
      this.combatStep(npc, dt)
    }

    // Follow the current path.
    if (npc.path.length > 0) {
      const wp = npc.path[npc.pathIndex]
      if (!wp) {
        npc.path = []
      } else {
        const dx = wp.x - npc.position.x
        const dz = wp.z - npc.position.z
        const dist = Math.hypot(dx, dz)
        if (dist < 0.7) {
          npc.pathIndex++
          if (npc.pathIndex >= npc.path.length) {
            npc.path = []
            npc.pathIndex = 0
          }
        } else {
          const inv = 1 / dist
          this.stepPosition(npc, dx * inv * npc.speed, dz * inv * npc.speed, dt)
        }
      }
    }

    // Player bump → complain (once per few seconds).
    npc.complainTimer -= dt
    if (npc.complainTimer <= 0) {
      const d = npc.position.distanceTo(engine.player.position)
      const playerSpeed = Math.hypot(engine.player.velocity.x, engine.player.velocity.z)
      if (d < 1.0 && playerSpeed > 2.5 && !npc.hostile && !npc.duty) {
        npc.complainTimer = 5
        const reaction = this.reactionFor(npc, 'player_bump')
        if (!reaction || reaction.action !== 'ignore') {
          this.showSpeech(npc, COMPLAINTS[Math.floor(Math.random() * COMPLAINTS.length)])
        }
        // Sidestep out of the player's way.
        const away = npc.position.clone().sub(engine.player.position).setY(0).normalize()
        this.stepPosition(npc, away.x * 2.5, away.z * 2.5, dt)
      }
    }
  }

  /** Move + collide + ground-follow + facing. */
  private stepPosition(npc: NPC, vx: number, vz: number, dt: number): void {
    const engine = this.engine!
    const pos = { x: npc.position.x + vx * dt, y: npc.position.y, z: npc.position.z + vz * dt }
    pos.x = THREE.MathUtils.clamp(pos.x, 2, this.levelSize.x - 2)
    pos.z = THREE.MathUtils.clamp(pos.z, 2, this.levelSize.z - 2)
    const hit = engine.physics.collideCircle(pos, NPC_RADIUS, NPC_HEIGHT, true)
    npc.position.x = pos.x
    npc.position.z = pos.z
    const ground = engine.physics.getGroundHeight(pos.x, pos.z)
    const targetY = engine.physics.isWater(pos.x, pos.z) ? -0.3 : ground
    npc.position.y += (targetY - npc.position.y) * Math.min(1, dt * 10)
    if (hit.hit) {
      // Slide was applied by collideCircle; small speed penalty.
      npc.speed *= 0.995
    }
    // Face movement direction
    if (Math.abs(vx) > 0.02 || Math.abs(vz) > 0.02) {
      const targetYaw = Math.atan2(-vx, -vz)
      let delta = targetYaw - npc.yaw
      while (delta > Math.PI) delta -= Math.PI * 2
      while (delta < -Math.PI) delta += Math.PI * 2
      npc.yaw += delta * Math.min(1, dt * 10)
    }
    npc.group.position.copy(npc.position)
    npc.group.rotation.y = npc.yaw
  }

  /** Armed/melee combat for chasing NPCs. */
  private combatStep(npc: NPC, dt: number): void {
    const engine = this.engine!
    const player = engine.player
    const dist = npc.position.distanceTo(player.position)

    npc.fireTimer -= dt
    npc.meleeTimer -= dt

    if (npc.armed && dist < POLICE_SHOOT_RANGE) {
      if (npc.fireTimer <= 0) {
        npc.fireTimer = (npc.type === 'swat' ? 0.9 : 1.4) + Math.random() * 0.7
        // Line of sight check (buildings/vehicles block).
        const origin = { x: npc.position.x, y: npc.position.y + 1.5, z: npc.position.z }
        const to = {
          x: player.position.x - origin.x,
          y: player.position.y + 1.2 - origin.y,
          z: player.position.z - origin.z,
        }
        const d = Math.hypot(to.x, to.y, to.z)
        if (d < 0.5) return
        const dir = { x: to.x / d, y: to.y / d, z: to.z / d }
        const blockHit = engine.physics.raycast(origin, dir, d - 0.6, true)
        this.audio()?.play?.(
          npc.type === 'swat' ? 'gunshot_rifle' : 'gunshot_pistol',
          { position: npc.position, volume: 0.7 },
        )
        if (!blockHit) {
          const accuracy = npc.type === 'swat' ? 0.85 : npc.type === 'police' ? 0.7 : 0.5
          if (Math.random() < accuracy) {
            const dmg = npc.type === 'swat' ? 11 : npc.type === 'police' ? 8 : 7
            engine.damagePlayer(dmg, npc.type)
          }
        }
      }
    } else if (dist < POLICE_MELEE_RANGE && npc.meleeTimer <= 0) {
      // Unarmed pursuit (wanted 1-2): shove damage.
      npc.meleeTimer = 1.2
      engine.damagePlayer(POLICE_MELEE_DMG, npc.type)
      this.showSpeech(npc, 'Gotcha!')
    }
  }

  private animateNpc(npc: NPC, dt: number): void {
    // Dead: keel over.
    if (npc.state === 'dead') {
      const target = -Math.PI / 2
      npc.group.rotation.x += (target - npc.group.rotation.x) * Math.min(1, dt * 6)
      npc.group.position.y = npc.position.y + 0.15
      return
    }
    npc.group.rotation.x = 0
    npc.group.position.copy(npc.position)

    // Leg swing by horizontal speed (path-empty chasers hold position).
    const moving = npc.path.length > 0 ? npc.speed : 0
    if (moving > 0.05) {
      npc.legPhase += dt * (2.2 + moving * 1.6)
      const swing = Math.sin(npc.legPhase) * 0.55
      if (npc.legPivots[0]) npc.legPivots[0].rotation.x = swing
      if (npc.legPivots[1]) npc.legPivots[1].rotation.x = -swing
      if (npc.armPivots[0]) npc.armPivots[0].rotation.x = -swing * 0.7
      if (npc.armPivots[1]) npc.armPivots[1].rotation.x = swing * 0.7
    } else {
      const idle = Math.sin(this.time * 1.4 + npc.legPhase) * 0.04
      for (const p of npc.legPivots) p.rotation.x = idle
      for (const p of npc.armPivots) p.rotation.x = -idle
    }

    // Health bar orientation/visibility.
    const showBar = (npc.hostile || npc.duty || npc.health < npc.maxHealth) && npc.health > 0
    npc.healthBar.root.visible = showBar
    if (showBar) {
      const frac = Math.max(0, npc.health / npc.maxHealth)
      npc.healthBar.fill.scale.set(0.92 * frac, 0.1, 1)
      npc.healthBar.fill.position.x = -0.46 * (1 - frac)
    }

    // Speech bubble countdown.
    if (npc.speech) {
      npc.speech.timer -= dt
      if (npc.speech.timer <= 0) {
        npc.group.remove(npc.speech.sprite)
        ;(npc.speech.sprite.material as THREE.Material).dispose()
        npc.speech = null
      }
    }
  }

  // =================================================================
  // State transitions
  // =================================================================

  private startIdle(npc: NPC): void {
    npc.state = 'idle'
    npc.stateTimer = 5 + Math.random() * 10 // idle 5-15 s
    npc.path = []
  }

  private startWander(npc: NPC): void {
    const anchor = npc.wanderAnchor
    const radius = npc.data.wanderRadius || 40
    const tx = THREE.MathUtils.clamp(anchor.x + (Math.random() - 0.5) * 2 * radius, 5, this.levelSize.x - 5)
    const tz = THREE.MathUtils.clamp(anchor.z + (Math.random() - 0.5) * 2 * radius, 5, this.levelSize.z - 5)
    npc.path = this.pathTo(npc, new THREE.Vector3(tx, 0, tz))
    npc.pathIndex = 0
    npc.speed = npc.data.speedWalk || 1.5
    npc.state = 'walk'
    if (npc.path.length === 0) this.startIdle(npc)
  }

  private startFlee(npc: NPC, danger: Vec3): void {
    // Panic shout (one-shot, only when not already fleeing).
    if (npc.state !== 'flee' && Math.random() < 0.45) {
      this.showSpeech(npc, FLEE_SHOUTS[Math.floor(Math.random() * FLEE_SHOUTS.length)])
    }
    // Run away from the danger point for ~8 s toward a far node.
    const engine = this.engine
    if (!engine || !this.graph) {
      npc.state = 'idle'
      npc.stateTimer = 8
      return
    }
    const dx = npc.position.x - danger.x
    const dz = npc.position.z - danger.z
    const len = Math.hypot(dx, dz) || 1
    let best = this.graph.randomNodeNear(
      { x: npc.position.x, y: 0, z: npc.position.z },
      70,
    )
    let bestScore = -Infinity
    for (let i = 0; i < 6; i++) {
      const cand = this.graph.randomNodeNear({ x: npc.position.x, y: 0, z: npc.position.z }, 80)
      const away = (cand.x - danger.x) * dx / len + (cand.z - danger.z) * dz / len
      const near = 40 - Math.abs(Math.hypot(cand.x - npc.position.x, cand.z - npc.position.z) - 55)
      const score = away + near
      if (score > bestScore) {
        bestScore = score
        best = cand
      }
    }
    npc.path = this.pathfinder?.findPath(
      { x: npc.position.x, y: 0, z: npc.position.z },
      { x: best.x, y: 0, z: best.z },
    ) ?? []
    npc.pathIndex = 0
    npc.speed = npc.data.speedRun || 4
    npc.state = 'flee'
    npc.stateTimer = FLEE_DURATION_SEC
    npc.fleeFrom = new THREE.Vector3(danger.x, 0, danger.z)
  }

  private startInvestigate(npc: NPC, point: Vec3): void {
    npc.path = this.pathfinder?.findPath(
      { x: npc.position.x, y: 0, z: npc.position.z },
      { x: point.x, y: 0, z: point.z },
    ) ?? []
    npc.pathIndex = 0
    npc.speed = npc.data.speedWalk * 1.6 || 2.4
    npc.state = 'investigate'
    npc.stateTimer = 4 // look around on arrival
    npc.investigatePoint = new THREE.Vector3(point.x, 0, point.z)
  }

  private pathTo(npc: NPC, target: THREE.Vector3): Vec3[] {
    if (!this.pathfinder) return [{ x: target.x, y: 0, z: target.z }]
    return this.pathfinder.findPath(
      { x: npc.position.x, y: 0, z: npc.position.z },
      { x: target.x, y: 0, z: target.z },
    )
  }

  // =================================================================
  // Construction / visuals
  // =================================================================

  private resolveNpcData(type: string): { data: NpcData; contentId: string } {
    const engine = this.engine!
    const npcs = engine.content.npcs.length > 0 ? engine.content.npcs : [DEFAULT_NPC_DATA]
    const byType = (t: string) => npcs.find((n) => n.type === t)
    switch (type) {
      case 'police':
        return { data: byType('law_enforcement') ?? npcs[0], contentId: 'npc_police' }
      case 'swat': {
        const swat = npcs.find((n) => n.id.includes('swat')) ?? byType('law_enforcement') ?? npcs[0]
        return { data: swat, contentId: swat.id }
      }
      case 'gang_member': {
        const gang = npcs.find((n) => n.id.includes('gang')) ?? npcs[0]
        return { data: gang, contentId: gang.id }
      }
      case 'driver': {
        const driver = npcs.find((n) => n.id.includes('driver')) ?? npcs[0]
        return { data: driver, contentId: driver.id }
      }
      default:
        return { data: byType('pedestrian') ?? npcs[0], contentId: 'npc_pedestrian' }
    }
  }

  private createNPC(
    contentId: string,
    type: string,
    data: NpcData,
    opts: {
      position: Vec3
      hostile: boolean
      missionId: string | null
      ally: boolean
      health: number
    },
  ): NPC {
    const engine = this.engine!
    const scene = this.scene!
    const group = new THREE.Group()

    // ---- palette ------------------------------------------------------
    let torsoColor: number
    let legColor: number
    let hat: 'none' | 'cap' | 'helmet' | 'bandana' = 'none'
    const skin = SKIN_TONES[Math.floor(Math.random() * SKIN_TONES.length)]
    switch (type) {
      case 'police':
        torsoColor = POLICE_TORSO
        legColor = POLICE_LEGS
        hat = 'cap'
        break
      case 'swat':
        torsoColor = SWAT_TORSO
        legColor = SWAT_LEGS
        hat = 'helmet'
        break
      case 'gang_member':
        torsoColor = GANG_TORSO
        legColor = 0x2c2e33
        hat = 'bandana'
        break
      case 'gang_leader':
        torsoColor = LEADER_TORSO
        legColor = 0x1f1d1a
        hat = 'bandana'
        break
      case 'driver':
        torsoColor = DRIVER_TORSO
        legColor = PED_LEGS[Math.floor(Math.random() * PED_LEGS.length)]
        break
      case 'worker':
        torsoColor = WORKER_TORSO
        legColor = 0x4a4440
        hat = 'cap'
        break
      case 'guard':
        torsoColor = GUARD_TORSO
        legColor = 0x2e3129
        hat = 'cap'
        break
      case 'criminal':
      case 'car_thief':
      case 'armed_robber':
        torsoColor = CRIMINAL_TORSO
        legColor = 0x332e28
        hat = Math.random() < 0.5 ? 'bandana' : 'none'
        break
      default:
        torsoColor = PED_TORSO[Math.floor(Math.random() * PED_TORSO.length)]
        legColor = PED_LEGS[Math.floor(Math.random() * PED_LEGS.length)]
    }

    // Per-instance materials (fade on death needs independent opacity).
    const bodyMat = new THREE.MeshStandardMaterial({ color: torsoColor, roughness: 0.85 })
    const legMat = new THREE.MeshStandardMaterial({ color: legColor, roughness: 0.9 })
    const headMat = new THREE.MeshStandardMaterial({ color: skin, roughness: 0.75 })
    bodyMat.transparent = true
    legMat.transparent = true
    headMat.transparent = true

    // ---- body parts ---------------------------------------------------
    const torso = new THREE.Mesh(GEO_TORSO, bodyMat)
    torso.position.y = 1.03
    torso.castShadow = true
    group.add(torso)

    const head = new THREE.Mesh(GEO_HEAD, headMat)
    head.position.y = 1.46
    head.castShadow = true
    group.add(head)

    const legPivots: THREE.Object3D[] = []
    for (const side of [-0.11, 0.11]) {
      const pivot = new THREE.Object3D()
      pivot.position.set(side, 0.75, 0)
      const leg = new THREE.Mesh(GEO_LEG, legMat)
      leg.position.y = -0.375
      leg.castShadow = true
      pivot.add(leg)
      group.add(pivot)
      legPivots.push(pivot)
    }
    const armPivots: THREE.Object3D[] = []
    for (const side of [-0.29, 0.29]) {
      const pivot = new THREE.Object3D()
      pivot.position.set(side, 1.26, 0)
      const arm = new THREE.Mesh(GEO_ARM, bodyMat)
      arm.position.y = -0.24
      pivot.add(arm)
      group.add(pivot)
      armPivots.push(pivot)
    }

    // ---- headgear -----------------------------------------------------
    const hatMat = new THREE.MeshStandardMaterial({
      color: type === 'swat' ? 0x101114 : type === 'police' || type === 'worker' || type === 'guard' ? POLICE_CAP : BANDANA,
      roughness: 0.8,
    })
    if (hat === 'cap') {
      const cap = new THREE.Mesh(GEO_CAP, hatMat)
      cap.position.y = 1.63
      group.add(cap)
      const brim = new THREE.Mesh(GEO_BRIM, hatMat)
      brim.position.set(0, 1.6, -0.2)
      group.add(brim)
    } else if (hat === 'helmet') {
      const helmet = new THREE.Mesh(GEO_HELMET, hatMat)
      helmet.position.y = 1.5
      group.add(helmet)
      const visor = new THREE.Mesh(
        GEO_VISOR,
        new THREE.MeshStandardMaterial({
          color: 0x27251f,
          emissive: new THREE.Color(0xfbbf24),
          emissiveIntensity: 0.35,
        }),
      )
      visor.position.set(0, 1.5, -0.17)
      group.add(visor)
    } else if (hat === 'bandana') {
      const bandana = new THREE.Mesh(GEO_BANDANA, hatMat)
      bandana.position.y = 1.56
      group.add(bandana)
    }

    // ---- health bar (hostile/damaged only) ----------------------------
    const barRoot = new THREE.Object3D()
    barRoot.position.y = 1.95
    barRoot.visible = false
    const bg = new THREE.Sprite(BAR_BG_MAT)
    bg.scale.set(1.0, 0.14, 1)
    barRoot.add(bg)
    const fill = new THREE.Sprite(BAR_FILL_MAT)
    fill.scale.set(0.92, 0.1, 1)
    fill.position.x = 0
    barRoot.add(fill)
    group.add(barRoot)

    group.position.set(opts.position.x, opts.position.y, opts.position.z)
    group.rotation.y = Math.random() * Math.PI * 2
    scene.add(group)

    const npc: NPC = {
      id: `npc_${++idCounter}`,
      contentId,
      name: data.name,
      type,
      data,
      group,
      bodyMat,
      legMat,
      headMat,
      legPivots,
      armPivots,
      healthBar: { root: barRoot, fill },
      speech: null,
      position: new THREE.Vector3(opts.position.x, opts.position.y, opts.position.z),
      yaw: group.rotation.y,
      health: opts.health,
      maxHealth: opts.health,
      state: 'idle',
      stateTimer: Math.random() * 4,
      path: [],
      pathIndex: 0,
      thinkTimer: Math.random() * THINK_INTERVAL,
      legPhase: Math.random() * Math.PI * 2,
      speed: data.speedWalk || 1.5,
      hostile: opts.hostile,
      armed: type === 'swat',
      duty: false,
      missionId: opts.missionId,
      ally: opts.ally,
      followTarget: opts.ally,
      fleeFrom: null,
      fireTimer: 1 + Math.random(),
      meleeTimer: 0,
      complainTimer: 0,
      deadTimer: 0,
      fadeBase: 1,
      investigatePoint: null,
      wanderAnchor: new THREE.Vector3(opts.position.x, 0, opts.position.z),
      leaving: false,
    }
    this.npcs.push(npc)
    return npc
  }

  private showSpeech(npc: NPC, text: string): void {
    if (npc.state === 'dead') return
    if (npc.speech) {
      npc.group.remove(npc.speech.sprite)
      ;(npc.speech.sprite.material as THREE.Material).dispose()
    }
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: speechTexture(text), transparent: true, depthWrite: false }),
    )
    sprite.scale.set(1.6, 0.4, 1)
    sprite.position.set(0, 2.25, 0)
    sprite.center.set(0.5, 0)
    npc.group.add(sprite)
    npc.speech = { sprite, timer: 2 }
  }

  /**
   * Ambient street chatter: one nearby civilian mutters a contextual line
   * every ~14 s (day vs night flavor) — the crowd feels alive.
   */
  private ambientChatter(engine: GameEngine): void {
    const player = engine.player.position
    const pool: NPC[] = []
    for (const npc of this.npcs) {
      if (npc.state === 'dead' || npc.hostile || npc.duty || npc.missionId) continue
      if (npc.speech) continue
      if (npc.position.distanceTo(player) < 45) pool.push(npc)
    }
    if (pool.length === 0) return
    const npc = pool[Math.floor(Math.random() * pool.length)]
    const lines = this.isNight ? AMBIENT_NIGHT : AMBIENT_DAY
    this.showSpeech(npc, lines[Math.floor(Math.random() * lines.length)])
  }

  private showHealthBar(npc: NPC): void {
    // Bar auto-shows while damaged — nothing extra needed (visibility
    // handled in animateNpc); kept as an explicit API for clarity.
    npc.healthBar.root.visible = true
  }

  private removeAt(index: number): void {
    const npc = this.npcs[index]
    this.scene?.remove(npc.group)
    if (npc.speech) {
      ;(npc.speech.sprite.material as THREE.Material).dispose()
      npc.speech = null
    }
    npc.bodyMat.dispose()
    npc.legMat.dispose()
    npc.headMat.dispose()
    npc.group.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (mesh.isMesh) {
        const mat = mesh.material as THREE.Material
        // Only dispose per-instance materials (hat/visor clones).
        if (mat !== npc.bodyMat && mat !== npc.legMat && mat !== npc.headMat &&
            mat !== BAR_BG_MAT && mat !== BAR_FILL_MAT) {
          mat.dispose()
        }
      }
    })
    npc.group.clear()
    this.npcs.splice(index, 1)
  }

  private audio(): AudioLike | null {
    return (this.engine?.systems.audio as unknown as AudioLike | undefined) ?? null
  }

  private pickups(): PickupLike | null {
    return (this.engine?.systems.pickups as unknown as PickupLike | undefined) ?? null
  }
}
