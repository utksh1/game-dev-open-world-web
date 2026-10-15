/**
 * GameEngine — the facade that wires EVERY subsystem together and runs the
 * fixed-timestep 60 Hz loop with variable-rate rendering. Implements the
 * IGameEngine contract from @/game/types EXACTLY (start / dispose /
 * setPaused / loadLevel / toggleCameraMode / enterOrExitVehicle /
 * cycleWeapon / fireWeapon / reloadWeapon / startMission / teleportPlayer /
 * damagePlayer / restorePlayer / getHudState / onHudSync / onEvent /
 * buildSavePayload / applySavePayload).
 *
 * =====================================================================
 * INPUT WIRING — handled HERE in the engine (Task 2-b: do NOT re-bind):
 *   W / A / S / D ....... move (camera-relative) | vehicle throttle/steer
 *   Shift ............... run (6.5 m/s vs walk 3 m/s)
 *   Space ............... jump (on foot, press) | handbrake (driving, held)
 *   Mouse move .......... look — pointer-lock (click canvas) or hold-drag
 *   Q / E (held) ........ yaw fallback look (headless-safe)
 *   E (press) ........... systems.missions?.onAction('interact')
 *   C ................... toggleCameraMode()  (fps ⇄ tps)
 *   F ................... enterOrExitVehicle()  (≤ 4 m from nearest vehicle)
 *   R ................... DRIVING: systems.radio?.nextStation() (radio hop)
 *                         ON FOOT:  systems.weapons?.onAction({type:'reload'})
 *   Digit 1..5 .......... systems.weapons?.onAction({ type: 'select', slot })
 *   LMB (held) .......... systems.weapons?.onAction({ type: 'fire' }) each
 *                         fixed step; release → { type: 'fireRelease' }
 *   V ................... togglePhotoMode() — sim freeze + free-fly
 *                         camera (WASD/Q-E/Shift/wheel; Space = PNG snap;
 *                         V/Esc/P exit, photo capture re-renders then
 *                         toDataURL → anchor download)
 *   Esc / P ............. setPaused(!paused) — while photo mode is active
 *                         these exit photo mode FIRST instead
 *   M ................... NOT engine-wired — Task 2-b UI (big map) binds it
 * Menu-driven actions (pause menu "resume", HUD weapon buttons) call the
 * public command methods directly — same code paths as the keys above.
 * =====================================================================
 *
 * =====================================================================
 * OPTIONAL SYSTEM HOOKS (Task 2-b registers via registerSystem):
 *   system.init?(engine)            — called once on registration (or at
 *                                     engine start when registered early)
 *   system.update?(dt)              — fixed step, SKIPPED while paused
 *   system.onAction?(action)        — weapons: { type:'cycle',dir } |
 *                                     { type:'select',slot:1..5 } |
 *                                     { type:'fire' } | { type:'fireRelease' }
 *                                     | { type:'reload' };
 *                                     missions: 'interact'
 *   system.startMission?(id)        — missions: return EngineCommandResult
 *                                     or void (engine wraps void as ok)
 *   system.getHudWeapon?()          — WeaponState | null (HUD weapon slot)
 *   system.getWeaponsOwned?()       — WeaponId[] (HUD weapon strip)
 *   system.getHudInventory?()       — InventoryItem[] (HUD inventory)
 *   system.getHudMission?()         — MissionRuntime | null (HUD tracker)
 *   system.getSaveData?()           — SystemSaveFragment (save payload)
 *   system.applySaveData?(fragment) — restore from save payload
 *   system.dispose?()               — engine.dispose() cascade
 * Known slots: 'npcs' | 'traffic' | 'missions' | 'weapons' | 'audio'
 * (+ any custom name — all receive update/dispose/save hooks).
 * Round 5 adds: 'pursuit' (cruisers), 'heli' (4★+ air unit), 'radio'
 * (procedural stations — see src/game/audio/RadioSystem.ts).
 * =====================================================================
 *
 * The engine also owns: notifications (last 5, ~4 s auto-expire), wanted
 * level 0..5 (+ wantedLevelChanged event), the WASTED respawn flow
 * (hospital respawn after 3 s, −$100, wanted cleared), camera shake, and
 * the day/night cycle driving lights + skybox.
 */
import * as THREE from 'three'
import type {
  ContentBundle,
  EngineCommandResult,
  EngineEvent,
  GarageVehicleSnapshot,
  HudState,
  IGameEngine,
  InventoryItem,
  LevelData,
  MissionRuntime,
  SaveGamePayload,
  Vec3,
  WeaponId,
  WeaponState,
} from '@/game/types'
import { Time } from '@/game/core/Time'
import { InputManager, type InputAction } from '@/game/core/InputManager'
import { PlayerController, PLAYER_EYE_HEIGHT } from '@/game/core/PlayerController'
import type { PhysicsWorld } from '@/game/physics/PhysicsWorld'
import { PhysicsWorld as PhysicsWorldClass } from '@/game/physics/PhysicsWorld'
import { Renderer } from '@/game/renderer/Renderer'
import { Lighting } from '@/game/renderer/Lighting'
import { Skybox } from '@/game/renderer/Skybox'
import { DayNightCycle, dayTimeFromString } from '@/game/renderer/DayNight'
import { CameraController } from '@/game/renderer/CameraController'
import type { CameraTarget } from '@/game/renderer/CameraController'
import { WorldStreamer } from '@/game/world/WorldStreamer'
import { VehicleManager } from '@/game/vehicles/VehicleManager'
import { VehicleController } from '@/game/vehicles/VehicleController'
import type { VehicleControls } from '@/game/vehicles/VehicleController'

// ---------------------------------------------------------------------
// Public system-hook types (see the header comment block for semantics)
// ---------------------------------------------------------------------
export type WeaponsAction =
  | { type: 'cycle'; dir: 1 | -1 }
  | { type: 'select'; slot: 1 | 2 | 3 | 4 | 5 }
  | { type: 'fire' }
  | { type: 'fireRelease' }
  | { type: 'reload' }

export type MissionAction = 'interact'

export interface SystemSaveFragment {
  missionsCompleted?: string[]
  campaignProgress?: number
  weaponsOwned?: WeaponId[]
  currentWeapon?: WeaponId | null
  inventory?: InventoryItem[]
  [key: string]: unknown
}

export interface EngineSystem {
  init?(engine: GameEngine): void
  update?(dt: number): void
  onAction?(action: WeaponsAction | MissionAction): void
  startMission?(missionId: string): EngineCommandResult | void
  getHudWeapon?(): WeaponState | null
  getWeaponsOwned?(): WeaponId[] | null
  getHudInventory?(): InventoryItem[] | null
  getHudMission?(): MissionRuntime | null
  getSaveData?(): SystemSaveFragment
  applySaveData?(data: SystemSaveFragment): void
  dispose?(): void
}

export interface EngineSystems {
  npcs?: EngineSystem
  traffic?: EngineSystem
  missions?: EngineSystem
  weapons?: EngineSystem
  audio?: EngineSystem
  services?: EngineSystem
  [name: string]: EngineSystem | undefined
}

/** Everything a registered system may need, exposed via engine.services. */
export interface EngineServices {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  webglRenderer: THREE.WebGLRenderer
  time: Time
  input: InputManager
  physics: PhysicsWorld
  world: WorldStreamer
  vehicles: VehicleManager
  player: PlayerController
  content: ContentBundle
  level: LevelData
}

const DEFAULT_FISTS: WeaponState = {
  id: 'fists',
  name: 'Fists',
  ammo: 0,
  magazineSize: 0,
  reserveAmmo: 0,
  reloading: false,
  reloadProgress: 0,
  damage: 10,
  fireRate: 400,
  range: 2.2,
  auto: false,
}

const WEAPON_SELECT_ACTIONS: InputAction[] = [
  'weapon1',
  'weapon2',
  'weapon3',
  'weapon4',
  'weapon5',
]

const NOTIFICATION_LIFETIME = 4 // seconds (sim time)
const NOTIFICATION_MAX = 5
const HUD_PUBLISH_INTERVAL_MS = 100 // 10 Hz
const ENTER_VEHICLE_RANGE = 4
const RESPAWN_DELAY = 3 // seconds
const RESPAWN_MONEY_PENALTY = 100
const Q_E_YAW_RATE = 1.7 // rad/s fallback look

interface Notification {
  id: string
  text: string
  kind: 'info' | 'success' | 'warning' | 'danger'
  expiresAt: number
}

export class GameEngine implements IGameEngine {
  // ---- lifecycle -----------------------------------------------------
  private started = false
  private running = false
  private paused = false
  private rafId: number | null = null
  private disposed = false

  // ---- subsystems (private; public getters below throw pre-start) ----
  private _renderer!: Renderer
  private _lighting!: Lighting
  private _skybox!: Skybox
  private _dayNight!: DayNightCycle
  private _cameraCtl!: CameraController
  private _physics!: PhysicsWorldClass
  private _time!: Time
  private _input!: InputManager
  private _world!: WorldStreamer
  private _vehicles!: VehicleManager
  private _player!: PlayerController
  private _content!: ContentBundle
  private _level!: LevelData

  // ---- systems + hooks ------------------------------------------------
  readonly systems: EngineSystems = {}
  private updateHooks = new Set<(dt: number) => void>()
  private eventListeners = new Set<(evt: EngineEvent) => void>()
  private hudSyncCallbacks = new Set<(state: HudState) => void>()

  // ---- state ----------------------------------------------------------
  private notifications: Notification[] = []
  private notificationCounter = 0
  private simTime = 0
  private wastedTimer: number | null = null
  private respawnPoint = new THREE.Vector3()
  private currentSlot = 1
  private playerName = 'Player'
  /** Low-end GPU mode (set pre-boot via the persisted setting or live). */
  private _performanceMode = false
  /** Photo mode (V): simulation frozen, free-fly camera, HUD hidden. */
  private _photoMode = false
  /** Screenshot requested in photo mode (captured right after render). */
  private pendingPhotoSnap = false
  /** Photo snapshots taken this session (HUD flash + filename suffix). */
  private photoSnapCount = 0
  private pendingJump = false
  private prevFireHeld = false
  private lastHudPublish = 0
  private reservedSpots: { x: number; z: number; r: number }[] = []
  private tmpVec = new THREE.Vector3()
  private tmpFwd = new THREE.Vector3()
  private tmpRight = new THREE.Vector3()

  // =====================================================================
  // Lifecycle
  // =====================================================================

  async start(
    container: HTMLElement,
    content: ContentBundle,
    opts?: { saveData?: SaveGamePayload | null },
  ): Promise<void> {
    if (this.started) return // idempotent
    this.disposed = false
    this._content = content
    const save = opts?.saveData ?? null

    // --- graphics / platform (Renderer throws a descriptive error when
    // WebGL is unavailable — the boot page catches and surfaces it) ---
    this._renderer = new Renderer(container)
    this._input = new InputManager(this._renderer.domElement)
    this._physics = new PhysicsWorldClass()
    this._time = new Time()
    this._cameraCtl = new CameraController(this._renderer.camera)

    // --- initial level (save level, else 'downtown', else first level) ---
    const wantedId = save?.levelId ?? 'downtown'
    const level =
      content.levels.find((l) => l.id === wantedId) ??
      content.levels.find((l) => l.id === 'downtown') ??
      content.levels[0]
    if (!level) throw new Error('Content bundle contains no levels')
    this._level = level
    this.currentSlot = save?.slot ?? 1
    this.playerName = save?.playerName ?? 'Player'

    // --- sky / lights / clock ---
    this._dayNight = new DayNightCycle(
      dayTimeFromString(level.timeOfDay),
      level.weather.toLowerCase().includes('fog'),
    )
    this._lighting = new Lighting(this._renderer.scene)
    this._skybox = new Skybox()
    this._renderer.scene.add(this._skybox.group)

    // --- player (spawns at the level's spawnPoint) ---
    this.respawnPoint.set(level.spawnPoint.x, level.spawnPoint.y, level.spawnPoint.z)
    this._player = new PlayerController(this.respawnPoint.clone(), {
      // Camera shake + a 'danger' notification event — Task 2-b's HUD uses
      // that event kind to trigger the red damage-flash overlay.
      onDamaged: (info) => {
        this._cameraCtl.addShake(0.3)
        this.notify(
          `−${Math.round(info.amount)} HP${info.source ? ` (${info.source})` : ''}`,
          'danger',
        )
      },
      onDeath: (source) => this.beginWastedFlow(source),
    })
    this._player.setWorldBounds(level.sizeX, level.sizeZ)
    this._renderer.scene.add(this._player.group)

    // --- world + vehicles ---
    this.reservedSpots = content.vehicles.flatMap((v) =>
      v.spawnLocations.map((p) => ({ x: p.x, z: p.z, r: 9 })),
    )
    this._world = new WorldStreamer(
      this._renderer.scene,
      this._physics,
      level,
      this.reservedSpots,
    )
    this._vehicles = new VehicleManager(this._renderer.scene, this._physics, {
      onShake: (amount) => this._cameraCtl.addShake(amount),
      onNotify: (text, kind) => this.notify(text, kind),
      onExplosion: (pos) => this.vehicleExplosion(pos),
    })
    this._vehicles.spawnFromContent(level, content.vehicles)
    this._world.prewarm(this._player.position, 1)

    // Performance mode requested before boot (persisted setting).
    if (this._performanceMode) {
      this._renderer.setPerformanceMode(true)
      this._lighting.setPerfMode(true)
    }

    // --- go ---
    this.started = true

    // Systems registered before start get their init() now.
    for (const system of Object.values(this.systems)) system?.init?.(this)

    // Restore save (after init so systems receive their save data).
    if (save) this.applySavePayload(save)
    else {
      this._cameraCtl.snap()
      this.notify(`Welcome to ${level.name}`, 'info')
    }

    this.running = true
    this.emitEvent({ type: 'levelLoaded', levelId: level.id })
    this.lastHudPublish = 0
    this.rafId = requestAnimationFrame(this.frame)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.running = false
    this.started = false
    this.paused = false
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    for (const system of Object.values(this.systems)) system?.dispose?.()
    for (const key of Object.keys(this.systems)) delete this.systems[key]
    this.updateHooks.clear()
    this.eventListeners.clear()
    this.hudSyncCallbacks.clear()
    this.notifications.length = 0
    this.wastedTimer = null
    this._player?.dispose()
    this._world?.dispose()
    this._vehicles?.dispose()
    if (this._lighting && this._renderer) this._lighting.dispose(this._renderer.scene)
    if (this._skybox && this._renderer) {
      this._renderer.scene.remove(this._skybox.group)
      this._skybox.dispose()
    }
    this._input?.dispose()
    this._renderer?.dispose()
    this._physics?.clearAll()
  }

  setPaused(paused: boolean): void {
    if (!this.started || this.paused === paused) return
    this.paused = paused
  }

  // =====================================================================
  // Photo mode (V) — freeze the world, detach a free camera
  // =====================================================================

  get photoMode(): boolean {
    return this._photoMode
  }

  /** Live photo-camera state for the HUD widget (fov + snap flash). */
  getPhotoState(): { active: boolean; fov: number; snappedAt: number } {
    return {
      active: this._photoMode,
      fov: this._photoMode ? Math.round(this._cameraCtl.photoFovValue) : 70,
      snappedAt: this.photoSnapCount,
    }
  }

  togglePhotoMode(): void {
    if (!this.started || this.paused || this._player.dead) return
    if (this._photoMode) this.exitPhotoMode()
    else this.enterPhotoMode()
  }

  private enterPhotoMode(): void {
    if (this._photoMode) return
    this._photoMode = true
    this._cameraCtl.enterPhoto()
    // Drain held action state so queued edges (jump/fire) don't fire on exit.
    this.pendingJump = false
    this.notify('PHOTO MODE — V exit · WASD fly · Shift boost · Space snap · wheel zoom', 'info')
  }

  private exitPhotoMode(): void {
    if (!this._photoMode) return
    this._photoMode = false
    this._cameraCtl.exitPhoto()
    this.notify('Photo mode off', 'info')
  }

  /** Force-exit hooks (teleport / level swap / save restore). */
  private exitPhotoIfActive(): void {
    if (this._photoMode) this.exitPhotoMode()
  }

  loadLevel(levelId: string): EngineCommandResult {
    if (!this.started) return { ok: false, message: 'Engine not started' }
    const level = this._content.levels.find((l) => l.id === levelId)
    if (!level) return { ok: false, message: `Unknown level "${levelId}"` }
    if (level.id === this._level.id) return { ok: true, message: 'Already there' }

    this.exitPhotoIfActive()
    // Tear down the old world + vehicles; keep renderer/physics/time.
    this._world.dispose()
    this._vehicles.clear()
    this._physics.setDynamicBoxes([])
    this._level = level
    this._dayNight = new DayNightCycle(
      dayTimeFromString(level.timeOfDay),
      level.weather.toLowerCase().includes('fog'),
    )
    this._world = new WorldStreamer(
      this._renderer.scene,
      this._physics,
      level,
      this.reservedSpots,
    )
    this._vehicles.spawnFromContent(level, this._content.vehicles)

    // Teleport the player to the new level's spawn point.
    this.respawnPoint.set(level.spawnPoint.x, level.spawnPoint.y, level.spawnPoint.z)
    this._player.setWorldBounds(level.sizeX, level.sizeZ)
    this._player.respawnAt(this.respawnPoint.clone())
    this._player.setVisible(this.playerVisible())
    this._world.prewarm(this._player.position, 1)
    this._cameraCtl.snap()
    this.notify(`Entering ${level.name}`, 'info')
    this.emitEvent({ type: 'levelLoaded', levelId: level.id })
    return { ok: true }
  }

  // =====================================================================
  // Services (public, for Task 2-b systems & debugging)
  // =====================================================================

  get services(): EngineServices {
    this.requireStarted()
    return {
      scene: this._renderer.scene,
      camera: this._renderer.camera,
      webglRenderer: this._renderer.webglRenderer,
      time: this._time,
      input: this._input,
      physics: this._physics,
      world: this._world,
      vehicles: this._vehicles,
      player: this._player,
      content: this._content,
      level: this._level,
    }
  }

  get scene(): THREE.Scene {
    return this.requireStarted()._renderer.scene
  }
  get camera(): THREE.PerspectiveCamera {
    return this.requireStarted()._renderer.camera
  }
  get webglRenderer(): THREE.WebGLRenderer {
    return this.requireStarted()._renderer.webglRenderer
  }
  get time(): Time {
    return this.requireStarted()._time
  }
  get input(): InputManager {
    return this.requireStarted()._input
  }
  get physics(): PhysicsWorld {
    return this.requireStarted()._physics
  }
  get world(): WorldStreamer {
    return this.requireStarted()._world
  }
  get vehicles(): VehicleManager {
    return this.requireStarted()._vehicles
  }
  get player(): PlayerController {
    return this.requireStarted()._player
  }
  get content(): ContentBundle {
    return this.requireStarted()._content
  }
  get level(): LevelData {
    return this.requireStarted()._level
  }

  /** Current in-game hour 0..24 (drives sky, lights, night gameplay). */
  get dayTime(): number {
    return this._dayNight ? ((this._dayNight.dayTime % 24) + 24) % 24 : 12
  }

  // =====================================================================
  // Systems + hooks
  // =====================================================================

  registerSystem(name: string, system: EngineSystem): void {
    this.systems[name]?.dispose?.()
    this.systems[name] = system
    if (this.started) system.init?.(this)
  }

  /** Register a fixed-step hook (skipped while paused). Returns disposer. */
  addUpdateHook(fn: (dt: number) => void): () => void {
    this.updateHooks.add(fn)
    return () => this.updateHooks.delete(fn)
  }

  emitEvent(evt: EngineEvent): void {
    for (const cb of this.eventListeners) cb(evt)
  }

  /**
   * Weapon recoil passthrough (Task 2-b WeaponSystem → CameraController
   * addRecoil) — the controller itself is not exposed via services.
   */
  addCameraRecoil(pitchKick: number, yawKick: number): void {
    if (!this.started) return
    this._cameraCtl.addRecoil(pitchKick, yawKick)
  }

  onEvent(cb: (evt: EngineEvent) => void): () => void {
    this.eventListeners.add(cb)
    return () => {
      this.eventListeners.delete(cb)
    }
  }

  onHudSync(cb: (state: HudState) => void): void {
    this.hudSyncCallbacks.add(cb)
  }

  notify(text: string, kind: 'info' | 'success' | 'warning' | 'danger' = 'info'): void {
    this.notifications.push({
      id: `n${++this.notificationCounter}`,
      text,
      kind,
      expiresAt: this.simTime + NOTIFICATION_LIFETIME,
    })
    if (this.notifications.length > NOTIFICATION_MAX) {
      this.notifications.splice(0, this.notifications.length - NOTIFICATION_MAX)
    }
    this.emitEvent({ type: 'notification', text, kind })
  }

  setWantedLevel(level: number): void {
    if (!this.started) return
    const clamped = Math.max(0, Math.min(5, Math.round(level)))
    if (this._player.wantedLevel === clamped) return
    this._player.wantedLevel = clamped
    this.emitEvent({ type: 'wantedLevelChanged', level: clamped })
  }

  /** Debug/UX helper: jump the in-game clock forward by `hours`. */
  advanceTime(hours: number): void {
    if (!this._dayNight || !Number.isFinite(hours)) return
    this._dayNight.dayTime = (((this._dayNight.dayTime + hours) % 24) + 24) % 24
  }

  /**
   * Performance mode for low-end GPUs: pixel ratio 1, shadows off, lamp
   * budget halved. Callable before start (stored, applied during boot)
   * or live while running.
   */
  setPerformanceMode(on: boolean): void {
    if (this._performanceMode === on) return
    this._performanceMode = on
    if (!this.started) return
    this._renderer.setPerformanceMode(on)
    this._lighting.setPerfMode(on)
    this.notify(on ? 'Performance mode ON — shadows off, sharper FPS' : 'Performance mode OFF', 'info')
  }

  get performanceMode(): boolean {
    return this._performanceMode
  }

  // =====================================================================
  // Player commands
  // =====================================================================

  toggleCameraMode(): void {
    if (!this.started) return
    this._cameraCtl.toggleMode()
    this._player.setVisible(this.playerVisible())
  }

  enterOrExitVehicle(): EngineCommandResult {
    if (!this.started) return { ok: false, message: 'Engine not started' }
    const drivingId = this._vehicles.playerVehicleId
    if (drivingId) {
      const v = this._vehicles.getById(drivingId)
      this._vehicles.setPlayerDriving(null)
      if (v) {
        const exit = v.getExitPosition(this.tmpVec)
        this._player.position.set(exit.x, exit.y, exit.z)
        this._player.velocity.set(0, 0, 0)
        this.emitEvent({ type: 'vehicleExited', name: v.data.name })
        this.notify(`Exited ${v.data.name}`, 'info')
      }
      this._player.setVisible(this.playerVisible())
      return { ok: true }
    }
    if (this._player.dead) return { ok: false, message: 'Cannot enter a vehicle while wasted' }
    const nearest = this._vehicles.getNearest(this._player.position, ENTER_VEHICLE_RANGE)
    if (!nearest) return { ok: false, message: 'No vehicle within 4 m' }
    this._vehicles.setPlayerDriving(nearest)
    this.emitEvent({ type: 'vehicleEntered', name: nearest.data.name })
    this.notify(`Entered ${nearest.data.name}`, 'success')
    this._player.setVisible(this.playerVisible())
    return { ok: true }
  }

  cycleWeapon(dir: 1 | -1): EngineCommandResult {
    const weapons = this.systems.weapons
    if (!weapons?.onAction) return { ok: false, message: 'Weapon system not available' }
    weapons.onAction({ type: 'cycle', dir })
    return { ok: true }
  }

  fireWeapon(): void {
    this.systems.weapons?.onAction?.({ type: 'fire' })
  }

  reloadWeapon(): void {
    this.systems.weapons?.onAction?.({ type: 'reload' })
  }

  // ---- radio (round 5) — routed from R while driving ----------------

  private radio(): { nextStation?: () => void; prevStation?: () => void; setStation?: (i: number | null) => void } | undefined {
    return this.systems.radio as
      | { nextStation?: () => void; prevStation?: () => void; setStation?: (i: number | null) => void }
      | undefined
  }

  /** Next station (wraps through OFF). No-op without the radio system. */
  radioNext(): void {
    this.radio()?.nextStation?.()
  }

  /** Previous station. */
  radioPrev(): void {
    this.radio()?.prevStation?.()
  }

  /** Absolute station select (null / -1 = OFF). */
  radioSetStation(index: number | null): void {
    this.radio()?.setStation?.(index)
  }

  startMission(missionId: string): EngineCommandResult {
    const missions = this.systems.missions
    if (!missions?.startMission) return { ok: false, message: 'Mission system not available' }
    const result = missions.startMission(missionId)
    if (result && typeof result === 'object') return result
    return { ok: true }
  }

  teleportPlayer(pos: Vec3): void {
    if (!this.started) return
    this.exitPhotoIfActive()
    if (this._vehicles.playerVehicleId) {
      this._vehicles.setPlayerDriving(null)
      this._player.setVisible(this.playerVisible())
    }
    this._player.position.set(pos.x, pos.y, pos.z)
    this._player.velocity.set(0, 0, 0)
    this._player.dead = false
    this._player.deadPose = false
    this.wastedTimer = null
    this._cameraCtl.snap()
    this._world.prewarm(this._player.position, 1)
  }

  damagePlayer(amount: number, source?: string): void {
    if (!this.started) return
    this._player.damage(amount, source) // onDamaged → shake, onDeath → wasted
  }

  restorePlayer(health?: number, armor?: number): void {
    if (!this.started) return
    this._player.restore(health, armor)
  }

  // =====================================================================
  // HUD state
  // =====================================================================

  getHudState(): HudState {
    if (!this.started) return makeDefaultHudState()
    const p = this._player
    const drivingId = this._vehicles.playerVehicleId
    const vehicle = drivingId ? (this._vehicles.getById(drivingId) ?? null) : null
    const weapons = this.systems.weapons
    const missions = this.systems.missions
    return {
      player: {
        position: { x: p.position.x, y: p.position.y, z: p.position.z },
        health: p.health,
        maxHealth: p.maxHealth,
        armor: p.armor,
        maxArmor: p.maxArmor,
        money: p.money,
        xp: p.xp,
        level: p.getLevel(),
        wantedLevel: Math.max(0, Math.min(5, p.wantedLevel)),
        onFoot: drivingId === null,
        inVehicleId: drivingId,
        vehicleName: vehicle?.data.name ?? null,
        speedKmh: vehicle
          ? Math.round(Math.abs(vehicle.getSpeedKmh()) * 10) / 10
          : Math.round(p.getSpeedKmh() * 10) / 10,
        cameraMode: this._cameraCtl.mode,
        weapon: weapons?.getHudWeapon?.() ?? DEFAULT_FISTS,
        weaponsOwned: weapons?.getWeaponsOwned?.() ?? ['fists'],
        inventory: weapons?.getHudInventory?.() ?? [],
      },
      mission: missions?.getHudMission?.() ?? null,
      nearbyVehicles: this._vehicles.getNearby(p.position, 25),
      fps: Math.round(this._time.fps),
      dayTime: this._dayNight.dayTime,
      paused: this.paused,
      gameOver: false,
      gameStarted: this.started,
      photoMode: this._photoMode,
      notifications: this.notifications.map((n) => ({ id: n.id, text: n.text, kind: n.kind })),
    }
  }

  // =====================================================================
  // Save / load
  // =====================================================================

  buildSavePayload(): SaveGamePayload {
    if (!this.started) throw new Error('Engine not started')
    const p = this._player
    const missionsFragment = this.systems.missions?.getSaveData?.() ?? {}
    const weaponsFragment = this.systems.weapons?.getSaveData?.() ?? {}
    const garageFragment = this.systems.garage?.getSaveData?.() ?? {}
    return {
      slot: this.currentSlot,
      playerName: this.playerName,
      levelId: this._level.id,
      money: p.money,
      health: p.health,
      armor: p.armor,
      xp: p.xp,
      wantedLevel: Math.max(0, Math.min(5, p.wantedLevel)),
      position: { x: p.position.x, y: p.position.y, z: p.position.z },
      missionsCompleted: missionsFragment.missionsCompleted ?? [],
      campaignProgress: missionsFragment.campaignProgress ?? 0,
      weaponsOwned: weaponsFragment.weaponsOwned ?? ['fists'],
      inventory: weaponsFragment.inventory ?? [],
      garageOwned: garageFragment.garageOwned === true,
      garageVehicle: (garageFragment.garageVehicle as GarageVehicleSnapshot | null) ?? null,
      garageBays: typeof garageFragment.garageBays === 'number' ? garageFragment.garageBays : undefined,
      garageSlotsData: Array.isArray(garageFragment.garageSlotsData)
        ? (garageFragment.garageSlotsData as (GarageVehicleSnapshot | null)[])
        : undefined,
      playTimeSec: Math.floor(this._time.elapsed),
      savedAt: new Date().toISOString(),
    }
  }

  applySavePayload(data: SaveGamePayload): void {
    if (!this.started) return
    this.exitPhotoIfActive()
    this.currentSlot = data.slot
    this.playerName = data.playerName
    if (data.levelId && data.levelId !== this._level.id) {
      const result = this.loadLevel(data.levelId)
      if (!result.ok) this.notify(`Save level missing: ${result.message}`, 'warning')
    }
    const p = this._player
    p.respawnAt(new THREE.Vector3(data.position.x, data.position.y, data.position.z))
    p.health = Math.max(1, Math.min(p.maxHealth, Math.round(data.health)))
    p.armor = Math.max(0, Math.min(p.maxArmor, Math.round(data.armor)))
    p.money = Math.max(0, Math.round(data.money))
    p.xp = Math.max(0, Math.round(data.xp))
    p.wantedLevel = Math.max(0, Math.min(5, Math.round(data.wantedLevel)))
    this.wastedTimer = null
    this._cameraCtl.snap()
    this._world.prewarm(p.position, 1)

    // Hand each system its slice of the save payload.
    const fragment: SystemSaveFragment = {
      missionsCompleted: data.missionsCompleted,
      campaignProgress: data.campaignProgress,
      weaponsOwned: data.weaponsOwned,
      inventory: data.inventory,
      garageOwned: data.garageOwned === true,
      garageVehicle: data.garageVehicle ?? null,
      garageBays: data.garageBays,
      garageSlotsData: data.garageSlotsData,
    }
    this.systems.missions?.applySaveData?.(fragment)
    this.systems.weapons?.applySaveData?.(fragment)
    this.systems.garage?.applySaveData?.(fragment)
    this.notify('Save loaded', 'success')
  }

  // =====================================================================
  // Main loop
  // =====================================================================

  private frame = (nowMs: number): void => {
    if (!this.running) return
    const steps = this._time.tick(nowMs)

    // ---- photo mode intercepts ALL keys while active -----------------
    // V / Esc / P exit (Escape must not fall through to the pause menu
    // on the SAME press); Space requests a snapshot; everything else
    // feeds the free camera below. The simulation never steps.
    if (this._photoMode) {
      const exitKeys = this._input.consumePress('photoMode') || this._input.consumePress('pause')
      if (exitKeys) {
        this.exitPhotoMode()
        // Fall through to the normal branch this same frame (look + sim
        // resume immediately — no dead frame).
      } else if (!this.paused) {
        if (this._input.consumePress('jump')) this.pendingPhotoSnap = true
        const look = this._input.consumeLookDelta()
        if (look.dx !== 0 || look.dy !== 0) this._cameraCtl.addLook(look.dx, look.dy)
        const wheel = this._input.consumeWheel()
        if (wheel !== 0) this._cameraCtl.photoZoom(wheel)
        // Q/E double as rise/fall in photo mode (yaw fallback is useless
        // here — the mouse owns yaw).
        const fly =
          (this._input.isDown('forward') ? 1 : 0) - (this._input.isDown('back') ? 1 : 0)
        const strafe =
          (this._input.isDown('right') ? 1 : 0) - (this._input.isDown('left') ? 1 : 0)
        const rise =
          (this._input.isDown('yawRight') ? 1 : 0) - (this._input.isDown('yawLeft') ? 1 : 0)
        this.updatePhotoVisuals(this._time.frameDt, fly, strafe, rise, this._input.isDown('sprint'))
      } else {
        this._input.consumeLookDelta()
        this._input.consumeWheel()
      }
    } else {
      // Pause toggle works in both states (edge, per frame).
      if (this._input.consumePress('pause')) this.setPaused(!this.paused)
      if (this._input.consumePress('photoMode')) this.enterPhotoMode()
    }

    if (!this.paused && !this._photoMode) {
      // Look input (per rendered frame).
      const look = this._input.consumeLookDelta()
      if (look.dx !== 0 || look.dy !== 0) this._cameraCtl.addLook(look.dx, look.dy)

      // Per-frame edge actions (see header comment for the full map).
      if (this._input.consumePress('cameraToggle')) this.toggleCameraMode()
      if (this._input.consumePress('enterExitVehicle')) this.enterOrExitVehicle()
      if (this._input.consumePress('reload')) {
        // R is contextual: radio hop while driving, weapon reload on foot.
        if (this._vehicles.playerVehicleId !== null) this.radioNext()
        else this.reloadWeapon()
      }
      for (let slot = 1; slot <= WEAPON_SELECT_ACTIONS.length; slot++) {
        if (this._input.consumePress(WEAPON_SELECT_ACTIONS[slot - 1])) {
          this.systems.weapons?.onAction?.({
            type: 'select',
            slot: slot as 1 | 2 | 3 | 4 | 5,
          })
        }
      }
      if (this._input.consumePress('interact')) {
        // Mission markers, city services (clinic / gun shop /
        // Pay'n'Spray) and the garage lockup all listen on the same E
        // press — proximity is checked inside each system (pads are kept
        // ≥ 12 m apart, so only one can be in reach at a time).
        this.systems.missions?.onAction?.('interact')
        this.systems.services?.onAction?.('interact')
        this.systems.garage?.onAction?.('interact')
      }
      // Fire release edge.
      const fireHeld = this._input.isDown('fire')
      if (this.prevFireHeld && !fireHeld) {
        this.systems.weapons?.onAction?.({ type: 'fireRelease' })
      }
      this.prevFireHeld = fireHeld
      // Jump press (consumed by the first fixed step below).
      if (this._input.consumePress('jump')) this.pendingJump = true

      for (let i = 0; i < steps; i++) this.simStep(this._time.fixedDt)

      this.updateCameraAndVisuals(this._time.frameDt)
    } else if (!this._photoMode) {
      // Paused: drain look + press edges so nothing queues up.
      this._input.consumeLookDelta()
    }

    this.publishHud(nowMs)
    this._input.endFrame()
    this._renderer.render()
    // Snapshot AFTER render (same JS task — the WebGL drawing buffer is
    // still complete; a re-render guarantees it even on strict drivers).
    if (this.pendingPhotoSnap) {
      this.pendingPhotoSnap = false
      this.capturePhoto()
    }
    if (this.running) this.rafId = requestAnimationFrame(this.frame)
  }

  /** Photo-mode visuals: free camera + the frozen-world render state
   * (lights / skybox / chunk visibility follow the LENS, not the player). */
  private updatePhotoVisuals(
    frameDt: number,
    fly: number,
    strafe: number,
    rise: number,
    sprint: boolean,
  ): void {
    // Ground under the current lens position (soft floor for the fly cam).
    const groundY = this._physics.getGroundHeight(
      this._renderer.camera.position.x,
      this._renderer.camera.position.z,
    )
    this._cameraCtl.updatePhoto(
      Math.max(frameDt, 1 / 240),
      fly,
      strafe,
      rise,
      sprint,
      groundY,
      { sizeX: this._level.sizeX, sizeZ: this._level.sizeZ },
    )
    const dayState = this._dayNight.getState()
    this._lighting.setLampPositions(this._world.getLampHeadPositions())
    this._lighting.update(dayState, this._player.position)
    this._skybox.update(dayState, this._renderer.camera.position)
    this._world.updateVisibility(this._renderer.camera, this._player.position, frameDt)
  }

  /** Save the current frame as a PNG download (photo mode → Space). */
  private capturePhoto(): void {
    try {
      this._renderer.render() // fresh, complete drawing buffer
      const url = this._renderer.domElement.toDataURL('image/png')
      const stamp = new Date()
      const hh = String(stamp.getHours()).padStart(2, '0')
      const mm = String(stamp.getMinutes()).padStart(2, '0')
      const ss = String(stamp.getSeconds()).padStart(2, '0')
      this.photoSnapCount++
      const name = `openworld-${this._level.id}-${hh}${mm}${ss}-${this.photoSnapCount}.png`
      const a = document.createElement('a')
      a.href = url
      a.download = name
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      a.remove()
      this.notify(`📸 Photo saved — ${name}`, 'success')
      this.emitEvent({ type: 'photoCaptured', filename: name })
    } catch (err) {
      this.notify(
        `Photo capture failed: ${err instanceof Error ? err.message : 'unknown error'}`,
        'warning',
      )
    }
  }

  /** One fixed 1/60 s simulation step. */
  private simStep(dt: number): void {
    this.simTime += dt

    // Expire notifications.
    for (let i = this.notifications.length - 1; i >= 0; i--) {
      if (this.simTime >= this.notifications[i].expiresAt) this.notifications.splice(i, 1)
    }

    // WASTED respawn countdown.
    if (this.wastedTimer !== null) {
      this.wastedTimer -= dt
      if (this.wastedTimer <= 0) this.respawnPlayer()
    }

    // ---- player / vehicle input ----
    const drivingId = this._vehicles.playerVehicleId
    const vehicle = drivingId ? (this._vehicles.getById(drivingId) ?? null) : null
    let controls: VehicleControls = VehicleController.idleControls()

    if (vehicle && !vehicle.destroyed && vehicle.drivable) {
      // Driving: WASD → throttle/steer, Space → handbrake.
      const throttle =
        (this._input.isDown('forward') ? 1 : 0) - (this._input.isDown('back') ? 1 : 0)
      const steer = (this._input.isDown('left') ? 1 : 0) - (this._input.isDown('right') ? 1 : 0)
      controls = {
        throttle,
        steer,
        handbrake: this._input.isDown('jump'),
      }
      this.pendingJump = false
      this._player.velocity.set(0, 0, 0)
    } else {
      // On foot: camera-relative movement.
      const moveF = (this._input.isDown('forward') ? 1 : 0) - (this._input.isDown('back') ? 1 : 0)
      const moveR = (this._input.isDown('right') ? 1 : 0) - (this._input.isDown('left') ? 1 : 0)
      let dirX = 0
      let dirZ = 0
      if (moveF !== 0 || moveR !== 0) {
        this._cameraCtl.getForward(this.tmpFwd)
        this._cameraCtl.getRight(this.tmpRight)
        dirX = this.tmpFwd.x * moveF + this.tmpRight.x * moveR
        dirZ = this.tmpFwd.z * moveF + this.tmpRight.z * moveR
        const len = Math.hypot(dirX, dirZ)
        if (len > 1e-6) {
          dirX /= len
          dirZ /= len
        } else {
          dirX = 0
          dirZ = 0
        }
      }
      const jump = this.pendingJump
      this.pendingJump = false
      this._player.update(dt, { dirX, dirZ, run: this._input.isDown('sprint'), jump }, this._physics)
    }

    // ---- vehicles (all of them; the driven one got `controls`) ----
    this._vehicles.update(dt, this._player.position, drivingId, controls)

    // Player rides along (streaming/HUD/minimap follow the car).
    if (vehicle) {
      this._player.position.copy(vehicle.position)
      if (vehicle.destroyed) {
        // Wrecked while driving — eject next to the wreck.
        this._vehicles.setPlayerDriving(null)
        const exit = vehicle.getExitPosition(this.tmpVec)
        this._player.position.set(exit.x, exit.y, exit.z)
        this._player.velocity.set(0, 0, 0)
        this._player.damage(25, 'vehicle-wreck')
        this._player.setVisible(this.playerVisible())
        this.emitEvent({ type: 'vehicleExited', name: vehicle.data.name })
      }
    }

    // ---- world streaming + clock ----
    this._world.update(this._player.position)
    this._dayNight.advance(dt)

    // ---- registered systems + update hooks ----
    for (const system of Object.values(this.systems)) system?.update?.(dt)
    for (const hook of this.updateHooks) hook(dt)

    // ---- Q/E yaw fallback look ----
    if (this._input.isDown('yawLeft')) this._cameraCtl.addYaw(Q_E_YAW_RATE * dt)
    if (this._input.isDown('yawRight')) this._cameraCtl.addYaw(-Q_E_YAW_RATE * dt)

    // ---- fire held (weapons system rate-limits) ----
    if (this._input.isDown('fire')) this.systems.weapons?.onAction?.({ type: 'fire' })
  }

  /** Per-rendered-frame visuals: camera, lights, skybox, LOD/culling. */
  private updateCameraAndVisuals(frameDt: number): void {
    const drivingId = this._vehicles.playerVehicleId
    const vehicle = drivingId ? (this._vehicles.getById(drivingId) ?? null) : null
    const target: CameraTarget = vehicle
      ? {
          position: vehicle.position,
          eyeHeight: vehicle.data.height * 0.6,
          headingYaw: vehicle.yaw,
          speed: Math.abs(vehicle.getForwardSpeed()),
        }
      : {
          position: this._player.position,
          eyeHeight: PLAYER_EYE_HEIGHT,
          headingYaw: this._player.group.rotation.y,
          speed: Math.hypot(this._player.velocity.x, this._player.velocity.z),
        }
    this._cameraCtl.update(Math.max(frameDt, 1 / 240), target, !!vehicle, this._physics)

    const dayState = this._dayNight.getState()
    this._lighting.setLampPositions(this._world.getLampHeadPositions())
    this._lighting.update(dayState, this._player.position)
    this._skybox.update(dayState, this._renderer.camera.position)
    this._world.setNightFactor(dayState.nightFactor)
    this._vehicles.setNight(dayState.lampsOn)
    this._world.updateVisibility(this._renderer.camera, this._player.position, frameDt)
  }

  private publishHud(nowMs: number): void {
    if (this.hudSyncCallbacks.size === 0) return
    if (nowMs - this.lastHudPublish < HUD_PUBLISH_INTERVAL_MS) return
    this.lastHudPublish = nowMs
    const state = this.getHudState()
    for (const cb of this.hudSyncCallbacks) cb(state)
  }

  // =====================================================================
  // Wasted / respawn flow
  // =====================================================================

  /** Vehicle detonation: boom audio + area damage (NPCs, player, panic). */
  private vehicleExplosion(pos: { x: number; y: number; z: number }): void {
    const audio = this.systems.audio as
      | { play?: (name: string, opts?: { position?: Vec3; volume?: number }) => void }
      | undefined
    audio?.play?.('explosion', { position: pos, volume: 1 })
    const npcs = this.systems.npcs as
      | {
          getNPCs?: () => { id: string; position: Vec3; alive: boolean }[]
          damageNPC?: (id: string, amount: number, byPlayer: boolean) => void
          notifyCrash?: (position: Vec3, radius?: number) => void
        }
      | undefined
    for (const npc of npcs?.getNPCs?.() ?? []) {
      if (!npc.alive) continue
      const d = Math.hypot(npc.position.x - pos.x, npc.position.z - pos.z)
      if (d < 5.5) {
        // Blast falls off with distance.
        npcs?.damageNPC?.(npc.id, Math.round(70 * (1 - d / 5.5)), false)
      }
    }
    // Panic the crowd around the blast.
    npcs?.notifyCrash?.(pos, 28)
    // Player caught in the blast?
    const pd = Math.hypot(this._player.position.x - pos.x, this._player.position.z - pos.z)
    if (pd < 5.5) {
      this.damagePlayer(Math.max(12, Math.round(38 * (1 - pd / 5.5))), 'explosion')
    }
  }

  private beginWastedFlow(source?: string): void {
    if (this.wastedTimer !== null) return
    if (this._vehicles.playerVehicleId) {
      this._vehicles.setPlayerDriving(null)
      this._player.setVisible(this.playerVisible())
    }
    this.emitEvent({ type: 'playerWasted' })
    this.notify(source ? `WASTED (${source})` : 'WASTED', 'danger')
    this.wastedTimer = RESPAWN_DELAY
  }

  private respawnPlayer(): void {
    this.wastedTimer = null
    // Prefer the hospital building; fall back to the level spawn point.
    const hospital = this._level.buildings.find((b) =>
      b.type.toLowerCase().includes('hospital'),
    )
    const pos = hospital
      ? new THREE.Vector3(
          hospital.position.x,
          0,
          hospital.position.z + hospital.size.z / 2 + 4,
        )
      : this.respawnPoint.clone()
    this._player.respawnAt(pos)
    this._player.addMoney(-RESPAWN_MONEY_PENALTY)
    this.setWantedLevel(0)
    this._cameraCtl.snap()
    this._world.prewarm(this._player.position, 1)
    this.notify(
      hospital ? 'Patched up at the hospital (−$100)' : 'Respawned (−$100)',
      'warning',
    )
  }

  // =====================================================================
  // Internals
  // =====================================================================

  private playerVisible(): boolean {
    // Hidden in FPS mode and while driving; visible in TPS.
    return this._cameraCtl.mode === 'tps' && this._vehicles.playerVehicleId === null
  }

  private requireStarted(): this {
    if (!this.started) throw new Error('Engine not started — call start() first')
    return this
  }
}

// ---------------------------------------------------------------------
// Default HUD state (pre-start / disposed)
// ---------------------------------------------------------------------
function makeDefaultHudState(): HudState {
  return {
    player: {
      position: { x: 0, y: 0, z: 0 },
      health: 100,
      maxHealth: 100,
      armor: 0,
      maxArmor: 100,
      money: 500,
      xp: 0,
      level: 1,
      wantedLevel: 0,
      onFoot: true,
      inVehicleId: null,
      vehicleName: null,
      speedKmh: 0,
      cameraMode: 'tps',
      weapon: { ...DEFAULT_FISTS },
      weaponsOwned: ['fists'],
      inventory: [],
    },
    mission: null,
    nearbyVehicles: [],
    fps: 0,
    dayTime: 12,
    paused: false,
    gameOver: false,
    gameStarted: false,
    photoMode: false,
    notifications: [],
  }
}

/** Factory used by the boot page (keeps page.tsx free of class imports). */
export function createGameEngine(): IGameEngine {
  return new GameEngine()
}
