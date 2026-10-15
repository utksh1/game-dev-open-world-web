/**
 * SHARED TYPE CONTRACT — GTA-like Open World Engine (Web Rebuild)
 * =================================================================
 * This file is the CONTRACT between engine core (Task 2-a), game
 * systems + UI (Task 2-b) and the integration layer.
 * All parsed asset shapes mirror the original repo's content files
 * (content/levels/*.level, content/missions/*.mission, ...).
 * DO NOT change these shapes without updating the worklog contract.
 */

// ------------------------------------------------------------------
// Primitives
// ------------------------------------------------------------------
export interface Vec3 {
  x: number
  y: number
  z: number
}

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z })

// ------------------------------------------------------------------
// Parsed content (server ContentLoader → client via /api/content)
// ------------------------------------------------------------------
export interface BuildingData {
  name: string
  position: Vec3
  size: Vec3
  type: string // police | bank | hospital | shop | warehouse | office | ...
}

export interface DockData {
  position: Vec3
  size: Vec3
  type: string
}

export interface WaterArea {
  min: Vec3
  max: Vec3
  type: string
}

export interface RoadData {
  start: Vec3
  end: Vec3
  width: number
  lanes: number
}

export interface TrafficSpawnData {
  position: Vec3
  direction: Vec3
  vehicleType?: string
}

export interface NpcSpawnData {
  position: Vec3
  count: number
  behavior: string
}

export interface LevelData {
  id: string // downtown | industrial | residential | harbor
  name: string
  type: string
  sizeX: number
  sizeZ: number
  spawnPoint: Vec3
  buildings: BuildingData[]
  docks: DockData[]
  waterAreas: WaterArea[]
  roads: RoadData[]
  trafficSpawns: TrafficSpawnData[]
  npcSpawns: NpcSpawnData[]
  timeOfDay: string
  weather: string
  trafficDensity: string
  pedestrianDensity: string
}

export type ObjectiveType =
  | 'goto'
  | 'interact'
  | 'timer'
  | 'survive'
  | 'eliminate'
  | 'defend'
  | 'collect'
  | 'chase'
  | 'race'
  | 'steal'
  | 'observe'
  | 'locate'
  | 'escort'
  | 'escape'
  | 'destroy'

export interface MissionObjective {
  id: string
  type: ObjectiveType
  description: string
  targetPosition?: Vec3 | 'random'
  radius?: number
  target?: string
  duration?: number
  timeLimit?: number
  wantedLevel?: number
  targetCount?: number
  enemyType?: string
  maxDistance?: number
  method?: string
  /** Race: how many AI opponent racers to spawn (authored; default 3). */
  opponents?: number
  /** Race: authored checkpoint positions (mission_02's fixed circuit). */
  checkpoints?: Vec3[]
}

/** Authored race opponent (mission_02 documents names + skill levels). */
export interface MissionOpponent {
  name: string
  vehicle?: string
  skill?: string // high | medium | low
}

export interface MissionEnemy {
  type: string // police | swat | gang_member | guard | ...
  count: number
  spawnTrigger: string
  spawnPosition?: Vec3
  /** Authored per-enemy spawn spots (mission_06's bodyguard positions). */
  spawnPositions?: Vec3[]
}

export interface MissionData {
  id: string
  name: string
  description: string
  difficulty: string
  rewardMoney: number
  rewardMoneyMin?: number
  rewardMoneyMax?: number
  rewardXp: number
  isSide: boolean
  repeatable: boolean
  objectives: MissionObjective[]
  /** Authored race opponents (name / vehicle / skill). */
  opponents?: MissionOpponent[]
  startPosition?: Vec3
  enemies: MissionEnemy[]
  requiredItems: string[]
  timeLimit?: number
  maxRepeats?: string
}

export interface CampaignMission {
  id: string
  name: string
  unlock: string
  required: boolean
}

export interface CampaignData {
  id: string
  name: string
  description: string
  missions: CampaignMission[]
  totalMissions: number
  requiredMissions: number
  completionReward: number
  completionXp: number
}

export interface VehicleData {
  id: string
  name: string
  type: string
  vehicleClass: string
  mass: number
  maxSpeed: number
  acceleration: number
  braking: number
  handling: number
  traction: number
  length: number
  width: number
  height: number
  durability: number
  fuelCapacity: number
  seats: number
  trunkSpace: number
  price: number
  spawnLocations: Vec3[]
}

export interface NpcReaction {
  trigger: string
  action: string
  radius: number
}

export interface NpcData {
  id: string
  name: string
  type: string // pedestrian | police | gang_member | swat | driver
  behavior: string // wander | patrol | guard | chase
  health: number
  speedWalk: number
  speedRun: number
  wanderRadius: number
  fleeOnDanger: boolean
  callPoliceOnCrime: boolean
  spawnWeight: number
  spawnLocations: string[]
  reactions: NpcReaction[]
}

export interface ContentBundle {
  levels: LevelData[]
  missions: MissionData[]
  campaign: CampaignData | null
  vehicles: VehicleData[]
  npcs: NpcData[]
}

// ------------------------------------------------------------------
// Runtime game state (engine → UI, published via zustand store)
// ------------------------------------------------------------------
export type WeaponId = 'fists' | 'pistol' | 'smg' | 'rifle' | 'shotgun'

export interface WeaponState {
  id: WeaponId
  name: string
  ammo: number
  magazineSize: number
  reserveAmmo: number
  reloading: boolean
  reloadProgress: number // 0..1
  damage: number
  fireRate: number // ms between shots
  range: number
  auto: boolean
}

export interface PlayerState {
  position: Vec3
  health: number
  maxHealth: number
  armor: number
  maxArmor: number
  money: number
  xp: number
  level: number
  wantedLevel: number // 0..5
  onFoot: boolean
  inVehicleId: string | null
  vehicleName: string | null
  speedKmh: number
  cameraMode: 'fps' | 'tps'
  weapon: WeaponState
  weaponsOwned: WeaponId[]
  inventory: InventoryItem[]
}

export interface InventoryItem {
  id: string
  name: string
  quantity: number
  icon: string
  description?: string
}

export interface VehicleRuntime {
  id: string
  vehicleId: string // asset id e.g. vehicle_sedan
  name: string
  position: Vec3
  rotationY: number
  speedKmh: number
  health: number
  isPlayerDriving: boolean
  isTraffic: boolean
}

export interface NpcRuntimeState {
  id: string
  name: string
  type: string
  health: number
  state: string // idle | walk | run | flee | chase | dead
  position: Vec3
  isHostile: boolean
}

export type MissionStatus = 'locked' | 'available' | 'active' | 'completed' | 'failed'

export interface MissionRuntime {
  missionId: string
  name: string
  description: string
  status: MissionStatus
  currentObjectiveIndex: number
  objectiveDescription: string
  objectiveProgress: string
  objectiveTimer: number | null // seconds remaining, if any
  waypoint: Vec3 | null
  timeLeft: number | null // mission time limit
  /** Live race state (present only while a race objective is active). */
  race?: RaceHudState | null
}

export interface RaceHudState {
  checkpointIndex: number // zero-based index of the NEXT checkpoint
  total: number
  elapsed: number | null // seconds since GO! (null during countdown)
  countdown: number | null // 3/2/1 during countdown, 0 during "GO!" flash, null otherwise
  best: number | null // best-ever race time for this mission (seconds)
  /** Player's current place among ALL racers (1-based; null when solo). */
  place: number | null
  /** Total racers including the player. */
  racerCount: number
  /** Name of the current leader when an opponent leads (null = player leads). */
  leaderName: string | null
}

export interface HudState {
  player: PlayerState
  mission: MissionRuntime | null
  nearbyVehicles: { id: string; name: string; distance: number }[]
  fps: number
  dayTime: number // 0..24 hours
  paused: boolean
  gameOver: boolean
  gameStarted: boolean
  /** Photo mode (V): sim frozen, free camera, HUD hidden. */
  photoMode: boolean
  notifications: { id: string; text: string; kind: 'info' | 'success' | 'warning' | 'danger' }[]
}

// ------------------------------------------------------------------
// Save data (persisted to Prisma via /api/saves and localStorage)
// ------------------------------------------------------------------
export interface SaveGamePayload {
  slot: number
  playerName: string
  levelId: string
  money: number
  health: number
  armor: number
  xp: number
  wantedLevel: number
  position: Vec3
  missionsCompleted: string[]
  campaignProgress: number
  weaponsOwned: WeaponId[]
  inventory: InventoryItem[]
  /** Round 8: garage lockup ownership + the car parked inside it. */
  garageOwned?: boolean
  garageVehicle?: GarageVehicleSnapshot | null
  /** Round 9: number of unlocked garage bays (1..3). */
  garageBays?: number
  /** Round 9: per-bay parked cars (null = empty bay), length ≤ 3. */
  garageSlotsData?: (GarageVehicleSnapshot | null)[]
  playTimeSec: number
  savedAt?: string
}

/** A vehicle snapshot parked in the player's garage lockup. */
export interface GarageVehicleSnapshot {
  vehicleDataId: string
  name: string
  /** 0..maxHealth at the moment it was stored (damage persists). */
  health: number
  maxHealth: number
  /** Round 9: custom respray color (hex), null = factory paint. */
  paintColor?: number | null
}

export interface SaveGameRecord extends SaveGamePayload {
  id: string
  createdAt: string
  updatedAt: string
}

// ------------------------------------------------------------------
// Engine facade contract (implemented in Task 2-a/2-b, integrated by lead)
// ------------------------------------------------------------------
export interface EngineCommandResult {
  ok: boolean
  message?: string
}

export interface IGameEngine {
  /** Boot the engine with parsed content. Idempotent. */
  start(container: HTMLElement, content: ContentBundle, opts?: { saveData?: SaveGamePayload | null }): Promise<void>
  /** Stop loop, dispose all GPU resources. */
  dispose(): void
  /** Pause / resume simulation. */
  setPaused(paused: boolean): void
  /** Load a different level (streaming swap). */
  loadLevel(levelId: string): EngineCommandResult
  /** Camera toggle fps/tps. */
  toggleCameraMode(): void
  /** Enter nearest vehicle within range / exit current. */
  enterOrExitVehicle(): EngineCommandResult
  /** Cycle owned weapons. */
  cycleWeapon(dir: 1 | -1): EngineCommandResult
  /** Fire current weapon (called by input while held). */
  fireWeapon(): void
  /** Reload current weapon. */
  reloadWeapon(): void
  /** Start a mission by id. */
  startMission(missionId: string): EngineCommandResult
  /** Teleport player (used for mission start / respawn). */
  teleportPlayer(pos: Vec3): void
  /** Apply damage to player (used by AI). */
  damagePlayer(amount: number, source?: string): void
  /** Heal / give armor (pickups, mission rewards). */
  restorePlayer(health?: number, armor?: number): void
  /** Photo mode (V): freeze the world + detach a free camera. */
  togglePhotoMode(): void
  /** Snapshot for HUD. */
  getHudState(): HudState
  /** Register per-frame UI sync callback (called at ~10Hz). */
  onHudSync(cb: (state: HudState) => void): void
  /** Register engine event callback (mission complete, busted, wasted...). */
  onEvent(cb: (evt: EngineEvent) => void): () => void
  /** Get current save payload. */
  buildSavePayload(): SaveGamePayload
  /** Restore from save payload. */
  applySavePayload(data: SaveGamePayload): void
}

export type EngineEvent =
  | { type: 'missionStarted'; missionId: string; name: string }
  | { type: 'missionCompleted'; missionId: string; name: string; rewardMoney: number; rewardXp: number }
  | { type: 'missionFailed'; missionId: string; reason: string }
  | { type: 'objectiveCompleted'; index: number; description: string }
  | { type: 'vehicleEntered'; name: string }
  | { type: 'vehicleExited'; name: string }
  | { type: 'playerWasted' }
  | { type: 'playerBusted' }
  | { type: 'wantedLevelChanged'; level: number }
  | { type: 'weaponFired'; weapon: WeaponId }
  | { type: 'npcKilled'; npcType: string }
  | { type: 'levelLoaded'; levelId: string }
  | { type: 'garagePanel'; open: boolean }
  | { type: 'gunShopPanel'; open: boolean }
  | { type: 'photoCaptured'; filename: string }
  | { type: 'notification'; text: string; kind: 'info' | 'success' | 'warning' | 'danger' }
