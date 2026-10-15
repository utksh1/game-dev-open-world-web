/**
 * PoliceHelicopter — the 4★+ AIR UNIT (round-5 feature). Escalates the
 * documented-but-cruiser-only pursuit into the sky:
 *
 *   - ACTIVATION: wanted ≥ 4 (on foot OR driving — unlike the cruisers,
 *     which need the player in a vehicle). One chopper.
 *   - APPROACH: spawns 170–220 m out at ~60 m altitude and flies to the
 *     player's block at ~33 m/s.
 *   - ORBIT: circles 30–40 m above at ~34 m radius, banking into the
 *     turn, nose pointed at the player.
 *   - SEARCHLIGHT: a spotlight from the belly sweeps a ground disc that
 *     tracks the player with a slight lag (dramatic misses on hard turns).
 *     While the disc has the player lit (≤ 6 m):
 *       · the wanted decay timer is suppressed (registerCrime(0)) — heat
 *         won't cool under the light;
 *       · one "SPOTTED" toast per engagement.
 *   - DEPART: wanted < 4 → climbs, banks away, despawns beyond 280 m or
 *     after 15 s. Rotors, lights and the audio loop tear down cleanly.
 *   - FX: spinning main rotor + tail rotor, blinking red/green nav lights
 *     + white belly strobe, positional rotor-wop audio (AudioSystem loop),
 *     minimap blip (rose rotor ring, engineViews.getHelicopter).
 *
 * Registered as engine system 'heli'.
 */
import * as THREE from 'three'
import type { EngineSystem, GameEngine } from '@/game/engine'
import type { Vec3 } from '@/game/types'

export interface HelicopterInfo {
  id: string
  position: Vec3
  /** True while the searchlight is tracking the player. */
  searchlightOn: boolean
  state: 'approach' | 'orbit' | 'depart'
  /** 5★: number of SWAT officers this engagement has put on the ground. */
  swatDeployed: number
  /** True while a squad is sliding down the ropes right now. */
  rappelling: boolean
}

interface NpcLike {
  registerCrime?: (bump?: number) => void
  spawnEnemy?: (
    type: string,
    position: Vec3,
    opts?: { hostile?: boolean },
  ) => string
}
interface AudioLike {
  startHelicopterLoop?: () => void
  updateHelicopterLoop?: (pos: Vec3) => void
  stopHelicopterLoop?: () => void
}

// ---------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------
const ACTIVATE_WANTED = 4
const APPROACH_SPEED = 33
const ORBIT_SPEED = 24
const ORBIT_RADIUS = 34
const ORBIT_ALT_MIN = 30
const ORBIT_ALT_MAX = 42
const SPAWN_DIST_MIN = 170
const SPAWN_DIST_MAX = 220
const SPAWN_ALT = 60
const DEPART_ALT = 90
const DEPART_SEC = 15
const DESPAWN_M = 280
const SPOT_RANGE_M = 85 // searchlight off beyond this (climb-out, buildings)
const SPOT_LIT_M = 6 // player "lit" radius on the ground
const SPOT_SWEEP = 5.2 // how fast the light tracks (higher = snappier)
const CRIME_SUPPRESS_SEC = 1.5

// ---- 5★ SWAT fast-rope deployment (round 6) ----
const SWAT_WANTED = 5
const SWAT_DROP_SIZE = 2 // officers per rope drop
const SWAT_MAX_PER_ENGAGEMENT = 6
const SWAT_DROP_COOLDOWN = 11 // seconds between drops while conditions hold
const SWAT_LAND_OFFSET_MIN = 7
const SWAT_LAND_OFFSET_MAX = 15
const RAPPEL_SLIDE_SPEED = 9 // m/s along the rope

const BOX = /* @__PURE__ */ new THREE.BoxGeometry(1, 1, 1)

function mat(key: string, color: number, opts: Partial<THREE.MeshStandardMaterialParameters> = {}): THREE.MeshStandardMaterial {
  // Small per-system cache (module-level, bounded).
  let m = heliMats.get(key)
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.3, ...opts })
    heliMats.set(key, m)
  }
  return m
}
const heliMats = new Map<string, THREE.MeshStandardMaterial>()

function emat(key: string, color: number, intensity: number): THREE.MeshStandardMaterial {
  let m = heliMats.get(key)
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: 0x141414,
      emissive: new THREE.Color(color),
      emissiveIntensity: intensity,
      roughness: 0.4,
    })
    heliMats.set(key, m)
  }
  return m
}

/** One officer sliding down a rope from the chopper's skid to a fixed
 * ground anchor. The rope LINE stretches between the (moving) heli and
 * the anchor; the officer rides it parametrically. */
interface Rappel {
  rope: THREE.Line
  ropeGeo: THREE.BufferGeometry
  officer: THREE.Group
  ground: THREE.Vector3
  /** 0 (heli) → 1 (ground) along the rope. */
  t: number
  /** Rope length in metres when spawned (slide speed scales with it). */
  length: number
}

export class PoliceHelicopter implements EngineSystem {
  private engine: GameEngine | null = null

  private group: THREE.Group | null = null
  private mainRotor: THREE.Object3D | null = null
  private tailRotor: THREE.Object3D | null = null
  private navRed: THREE.Mesh | null = null
  private navGreen: THREE.Mesh | null = null
  private bellyStrobe: THREE.Mesh | null = null
  private spotlight: THREE.SpotLight | null = null
  private spotTarget: THREE.Object3D | null = null
  /** Additive ground disc showing where the searchlight hits. */
  private groundDisc: THREE.Mesh | null = null

  private state: 'idle' | 'approach' | 'orbit' | 'depart' = 'idle'
  private time = 0
  private orbitPhase = 0
  private departTimer = 0
  private crimeSuppressTimer = 0
  private spottedWarned = false
  private levelSize = { x: 1000, z: 1000 }
  /** Searchlight aim point (lags the player). */
  private aim = new THREE.Vector3()
  private tmp = new THREE.Vector3()
  private tmp2 = new THREE.Vector3()
  /** Active fast-rope animations (5★). */
  private rappels: Rappel[] = []
  private swatDeployed = 0
  private swatCooldown = 0

  // =================================================================
  // EngineSystem hooks
  // =================================================================

  init(engine: GameEngine): void {
    this.engine = engine
    engine.onEvent((evt) => {
      if (evt.type === 'levelLoaded') {
        this.despawn(false)
        this.levelSize = { x: engine.level.sizeX, z: engine.level.sizeZ }
      }
    })
  }

  update(dt: number): void {
    const engine = this.engine
    if (!engine) return
    this.time += dt

    const wanted = engine.player.wantedLevel
    const active = this.state === 'approach' || this.state === 'orbit'

    if (wanted >= ACTIVATE_WANTED && this.state === 'idle') this.spawn()
    // Heat came back mid-departure → cancel the climb-out, re-engage.
    if (wanted >= ACTIVATE_WANTED && this.state === 'depart') {
      this.state = 'orbit'
      this.departTimer = 0
      this.audio()?.startHelicopterLoop?.()
      engine.notify('The air unit found you again', 'danger')
    }
    if (wanted < ACTIVATE_WANTED && active) this.beginDepart()

    if (this.state === 'idle') return

    if (this.state === 'depart') {
      this.departTimer -= dt
      const dist = this.group ? this.group.position.distanceTo(engine.player.position) : 0
      if (this.departTimer <= 0 || dist > DESPAWN_M) {
        this.despawn(true)
        return
      }
    }

    this.fly(dt)
    this.updateLights(dt)
    this.updateRappels(dt)
    this.updateAudio()

    // ---- 5★ SWAT deployment conditions ----------------------------
    // Orbiting + wanted 5 + within spotlight range + not mid-depart +
    // squad cap not reached. The chopper holds a steady hover drop after
    // drop — the player has to break line of sight or fight through them.
    this.swatCooldown -= dt
    if (
      wanted >= SWAT_WANTED &&
      this.state === 'orbit' &&
      this.swatCooldown <= 0 &&
      this.swatDeployed < SWAT_MAX_PER_ENGAGEMENT &&
      this.isSearchlightOn()
    ) {
      this.startSwatDrop()
    }
  }
  dispose(): void {
    this.despawn(false)
    this.engine = null
  }

  getSaveData(): Record<string, unknown> {
    return {}
  }
  applySaveData(): void {
    /* helicopter state is never persisted */
  }

  // =================================================================
  // Public API
  // =================================================================

  /** Live snapshot for the minimap + HUD banner; null when grounded. */
  getHelicopter(): HelicopterInfo | null {
    const s = this.state
    if (s === 'idle' || !this.group) return null
    return {
      id: 'police_heli',
      position: { x: this.group.position.x, y: this.group.position.y, z: this.group.position.z },
      searchlightOn: this.isSearchlightOn(),
      state: s === 'depart' ? 'depart' : s,
      swatDeployed: this.swatDeployed,
      rappelling: this.rappels.length > 0,
    }
  }

  /** True while the searchlight beam has the player pinned. */
  isPlayerLit(): boolean {
    const engine = this.engine
    if (!engine || !this.groundDisc || !this.isSearchlightOn()) return false
    const p = engine.player.position
    this.tmp.set(p.x, 0, p.z)
    const d = this.tmp.distanceTo(this.tmp2.set(this.groundDisc.position.x, 0, this.groundDisc.position.z))
    return d <= SPOT_LIT_M
  }

  // =================================================================
  // Internals
  // =================================================================

  private isSearchlightOn(): boolean {
    if (this.state === 'depart') return false
    const engine = this.engine
    if (!engine || !this.group) return false
    return this.group.position.distanceTo(engine.player.position) <= SPOT_RANGE_M
  }

  private spawn(): void {
    const engine = this.engine
    if (!engine || this.group) return
    const p = engine.player.position
    const angle = Math.random() * Math.PI * 2
    const dist = SPAWN_DIST_MIN + Math.random() * (SPAWN_DIST_MAX - SPAWN_DIST_MIN)
    this.buildMesh(engine.scene)
    const g = this.group!
    g.position.set(
      THREE.MathUtils.clamp(p.x + Math.cos(angle) * dist, 8, this.levelSize.x - 8),
      SPAWN_ALT,
      THREE.MathUtils.clamp(p.z + Math.sin(angle) * dist, 8, this.levelSize.z - 8),
    )
    engine.scene.add(g)
    this.orbitPhase = Math.atan2(g.position.z - p.z, g.position.x - p.x)
    this.aim.set(p.x, 0, p.z)
    this.state = 'approach'
    this.departTimer = 0
    this.spottedWarned = false
    this.crimeSuppressTimer = 0
    this.swatDeployed = 0
    this.swatCooldown = 3 // first 5★ drop comes quickly once heat hits 5
    engine.notify('AIR UNIT DISPATCHED — a chopper is on your tail', 'danger')
    this.audio()?.startHelicopterLoop?.()
  }

  private beginDepart(): void {
    if (this.state === 'depart' || this.state === 'idle') return
    this.state = 'depart'
    this.departTimer = DEPART_SEC
    // Ropers still on the line: they finish their slide instantly —
    // cutting them loose mid-air would look broken.
    this.landAllRappels(true)
    this.audio()?.stopHelicopterLoop?.()
    const engine = this.engine
    engine?.notify('Air unit peeling off — lost you', 'success')
  }

  private despawn(notify: boolean): void {
    const engine = this.engine
    if (this.state !== 'idle') this.audio()?.stopHelicopterLoop?.()
    // Finish any rope animations before tearing down (officers land +
    // become real NPCs — cutting them mid-air would strand visuals).
    this.landAllRappels(true)
    this.clearRappelVisuals()
    if (this.group && engine) engine.scene.remove(this.group)
    if (this.groundDisc && engine) engine.scene.remove(this.groundDisc)
    // Only dispose non-cached resources: spotlight + disc material/geometry.
    if (this.spotlight) {
      this.spotlight.dispose()
      this.spotlight = null
    }
    if (this.spotTarget) {
      if (engine) engine.scene.remove(this.spotTarget)
      this.spotTarget = null
    }
    if (this.groundDisc) {
      this.groundDisc.geometry.dispose()
      ;(this.groundDisc.material as THREE.Material).dispose()
      this.groundDisc = null
    }
    this.group = null
    this.mainRotor = null
    this.tailRotor = null
    this.navRed = null
    this.navGreen = null
    this.bellyStrobe = null
    this.state = 'idle'
    if (notify) engine?.notify('Air unit gone', 'info')
  }

  private buildMesh(scene: THREE.Scene): void {
    const g = new THREE.Group()

    // Fuselage (faces -Z like every other vehicle/aircraft here).
    const body = new THREE.Mesh(BOX, mat('heli_body', 0x23262b))
    body.scale.set(2.0, 1.9, 4.6)
    body.position.y = 0.2
    body.castShadow = true
    g.add(body)
    const nose = new THREE.Mesh(BOX, mat('heli_glass', 0x111318, { roughness: 0.15, metalness: 0.6 }))
    nose.scale.set(1.7, 1.4, 1.2)
    nose.position.set(0, 0.15, -2.6)
    g.add(nose)
    // White "POLICE" side stripe
    const stripe = new THREE.Mesh(BOX, mat('heli_stripe', 0xe8e6e0))
    stripe.scale.set(2.06, 0.5, 2.6)
    stripe.position.set(0, 0.45, 0.2)
    g.add(stripe)
    // Tail boom + fin
    const boom = new THREE.Mesh(BOX, mat('heli_body', 0x23262b))
    boom.scale.set(0.55, 0.55, 4.4)
    boom.position.set(0, 0.55, 4.2)
    g.add(boom)
    const fin = new THREE.Mesh(BOX, mat('heli_fin', 0xb01e14))
    fin.scale.set(0.16, 1.5, 1.0)
    fin.position.set(0, 1.3, 5.6)
    g.add(fin)
    // Skids
    for (const side of [-1, 1]) {
      const skid = new THREE.Mesh(BOX, mat('heli_skid', 0x3f3f46))
      skid.scale.set(0.14, 0.14, 3.4)
      skid.position.set(side * 0.95, -0.95, 0)
      g.add(skid)
      const strut = new THREE.Mesh(BOX, mat('heli_skid', 0x3f3f46))
      strut.scale.set(0.12, 0.9, 0.12)
      strut.position.set(side * 0.95, -0.5, 0.8)
      g.add(strut)
      const strut2 = strut.clone()
      strut2.position.z = -0.8
      g.add(strut2)
    }

    // Main rotor (two crossed blades on a hub).
    const rotor = new THREE.Object3D()
    rotor.position.set(0, 1.45, 0)
    for (const r of [0, Math.PI / 2]) {
      const blade = new THREE.Mesh(BOX, mat('heli_rotor', 0x18181b))
      blade.scale.set(10.4, 0.07, 0.42)
      blade.rotation.y = r
      rotor.add(blade)
    }
    g.add(rotor)
    this.mainRotor = rotor

    // Tail rotor (small vertical pair at the boom end).
    const tail = new THREE.Object3D()
    tail.position.set(0.35, 1.0, 6.2)
    for (const r of [0, Math.PI / 2]) {
      const blade = new THREE.Mesh(BOX, mat('heli_rotor', 0x18181b))
      blade.scale.set(0.05, 2.1, 0.26)
      blade.rotation.z = r
      tail.add(blade)
    }
    g.add(tail)
    this.tailRotor = tail

    // Nav lights: port red / starboard green + white belly strobe.
    const navL = new THREE.Mesh(BOX, emat('nav_red', 0xff2233, 2.4))
    navL.scale.set(0.22, 0.22, 0.22)
    navL.position.set(-1.05, 0.1, 0.4)
    g.add(navL)
    this.navRed = navL
    const navG = new THREE.Mesh(BOX, emat('nav_green', 0x22ff55, 2.4))
    navG.scale.set(0.22, 0.22, 0.22)
    navG.position.set(1.05, 0.1, 0.4)
    g.add(navG)
    this.navGreen = navG
    const strobe = new THREE.Mesh(BOX, emat('nav_white', 0xffffff, 3.2))
    strobe.scale.set(0.26, 0.18, 0.26)
    strobe.position.set(0, -0.85, 1.2)
    g.add(strobe)
    this.bellyStrobe = strobe

    // Searchlight: spotlight from the belly. The TARGET lives in world
    // space (a child of the group would move with the airframe — the beam
    // must aim at the ground independently).
    const spot = new THREE.SpotLight(0xfff2cc, 1300, 170, 0.33, 0.55, 1.0)
    spot.position.set(0, -0.9, 0.6)
    const target = new THREE.Object3D()
    spot.target = target
    scene.add(target)
    g.add(spot)
    this.spotlight = spot
    this.spotTarget = target

    // Ground disc (additive) at the beam's hit point — reads great at
    // night and still shows as a bright ring by day.
    const discGeo = new THREE.CircleGeometry(4.6, 28)
    const discMat = new THREE.MeshBasicMaterial({
      color: 0xfff0c2,
      transparent: true,
      opacity: 0.28,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
    const disc = new THREE.Mesh(discGeo, discMat)
    disc.rotation.x = -Math.PI / 2
    disc.position.y = 0.12
    disc.visible = false
    scene.add(disc)
    this.groundDisc = disc

    this.group = g
  }

  /** Fly toward / around the player. Kinematic — no physics up here. */
  private fly(dt: number): void {
    const engine = this.engine
    const g = this.group
    if (!engine || !g) return
    const p = engine.player.position

    if (this.state === 'approach') {
      this.tmp.set(p.x, ORBIT_ALT_MAX + 8, p.z)
      const d = g.position.distanceTo(this.tmp)
      if (d < 12) {
        this.state = 'orbit'
      } else {
        const speed = Math.min(APPROACH_SPEED, 8 + d * 0.35)
        this.tmp.sub(g.position).normalize().multiplyScalar(speed * dt)
        g.position.add(this.tmp)
      }
      // Face the flight direction.
      g.rotation.y = Math.atan2(-this.tmp.x, -this.tmp.z)
      // Level flight, slight forward pitch.
      this.lerpRotation(g, 'x', 0.12, dt)
      this.lerpRotation(g, 'z', 0, dt)
      return
    }

    if (this.state === 'orbit') {
      this.orbitPhase += (ORBIT_SPEED / ORBIT_RADIUS) * dt
      const alt = ORBIT_ALT_MIN + (Math.sin(this.time * 0.4) * 0.5 + 0.5) * (ORBIT_ALT_MAX - ORBIT_ALT_MIN)
      const x = p.x + Math.cos(this.orbitPhase) * ORBIT_RADIUS
      const z = p.z + Math.sin(this.orbitPhase) * ORBIT_RADIUS
      this.tmp.set(
        THREE.MathUtils.clamp(x, 10, this.levelSize.x - 10),
        alt,
        THREE.MathUtils.clamp(z, 10, this.levelSize.z - 10),
      )
      this.tmp.sub(g.position)
      // Tangential velocity for facing.
      this.tmp2.set(-Math.sin(this.orbitPhase), 0, Math.cos(this.orbitPhase))
      const move = this.tmp.length()
      if (move > 0.001) {
        const step = Math.min(move, (ORBIT_SPEED + 4) * dt)
        g.position.addScaledVector(this.tmp.normalize(), step)
      }
      // Nose at the player, bank into the turn.
      const toPlayer = Math.atan2(-(p.x - g.position.x), -(p.z - g.position.z))
      g.rotation.y = toPlayer
      this.lerpRotation(g, 'z', 0.3, dt)
      this.lerpRotation(g, 'x', 0.08, dt)
      return
    }

    // DEPART: climb hard, fly away from the player.
    const away = this.tmp.set(
      g.position.x - p.x,
      0,
      g.position.z - p.z,
    )
    if (away.lengthSq() < 0.01) away.set(1, 0, 0)
    away.normalize()
    g.position.addScaledVector(away, 40 * dt)
    g.position.y = Math.min(DEPART_ALT, g.position.y + 22 * dt)
    g.rotation.y = Math.atan2(-away.x, -away.z)
    this.lerpRotation(g, 'x', -0.18, dt)
    this.lerpRotation(g, 'z', 0, dt)
  }

  /** Smoothly approach a target euler axis (bank/pitch juice). */
  private lerpRotation(g: THREE.Object3D, axis: 'x' | 'z', target: number, dt: number): void {
    g.rotation[axis] += (target - g.rotation[axis]) * Math.min(1, 4 * dt)
  }

  private updateLights(dt: number): void {
    const engine = this.engine
    const g = this.group
    if (!engine || !g) return

    // Spin rotors (visual rate — fast enough to blur).
    if (this.mainRotor) this.mainRotor.rotation.y += dt * 21
    if (this.tailRotor) this.tailRotor.rotation.x += dt * 32

    // Nav blink: red 1.6 Hz, green offset, strobe double-flash.
    const t = this.time
    if (this.navRed) {
      ;(this.navRed.material as THREE.MeshStandardMaterial).emissiveIntensity =
        Math.floor(t * 1.6 * 2) % 2 === 0 ? 2.8 : 0.15
    }
    if (this.navGreen) {
      ;(this.navGreen.material as THREE.MeshStandardMaterial).emissiveIntensity =
        Math.floor(t * 1.6 * 2 + 1) % 2 === 0 ? 2.8 : 0.15
    }
    if (this.bellyStrobe) {
      const phase = t % 1.2
      const flash = (phase < 0.06 || (phase > 0.16 && phase < 0.22)) ? 4.2 : 0.1
      ;(this.bellyStrobe.material as THREE.MeshStandardMaterial).emissiveIntensity = flash
    }

    // Searchlight aim: lag behind the player, then clamp into range.
    const on = this.isSearchlightOn()
    if (this.spotlight) this.spotlight.visible = on
    if (this.groundDisc) this.groundDisc.visible = on
    if (on) {
      const p = engine.player.position
      // Smooth pursuit with deliberately finite sweep speed.
      this.aim.x += (p.x - this.aim.x) * Math.min(1, SPOT_SWEEP * dt)
      this.aim.z += (p.z - this.aim.z) * Math.min(1, SPOT_SWEEP * dt)
      if (this.spotTarget) this.spotTarget.position.copy(this.aim).setY(0.1)
      if (this.groundDisc) {
        this.groundDisc.position.set(this.aim.x, 0.12, this.aim.z)
        const pulse = 0.24 + 0.08 * Math.sin(this.time * 6)
        ;(this.groundDisc.material as THREE.MeshBasicMaterial).opacity = pulse
      }

      // Gameplay hook: while lit, the wanted decay stays suppressed.
      if (this.isPlayerLit()) {
        this.crimeSuppressTimer -= dt
        if (this.crimeSuppressTimer <= 0) {
          this.crimeSuppressTimer = CRIME_SUPPRESS_SEC
          this.npcs()?.registerCrime?.(0)
        }
        if (!this.spottedWarned) {
          this.spottedWarned = true
          engine.notify('SPOTTED by the air unit — your heat will not cool', 'danger')
        }
      } else {
        this.spottedWarned = false
      }
    }
  }

  // =================================================================
  // 5★ SWAT fast-rope deployment
  // =================================================================

  /** Drop one squad (SWAT_DROP_SIZE officers on individual ropes). */
  private startSwatDrop(): void {
    const engine = this.engine
    const g = this.group
    if (!engine || !g || this.rappels.length > 0) return
    this.swatCooldown = SWAT_DROP_COOLDOWN
    engine.notify('ROPES OUT — SWAT fast-roping from the air unit', 'danger')
    const p = engine.player.position
    for (let i = 0; i < SWAT_DROP_SIZE; i++) {
      // Landing anchors ring the player (offset so they don't drop ON
      // them — they land to intercept, and the pack closes in).
      const ang = Math.random() * Math.PI * 2
      const off = SWAT_LAND_OFFSET_MIN + Math.random() * (SWAT_LAND_OFFSET_MAX - SWAT_LAND_OFFSET_MIN)
      const ground = new THREE.Vector3(
        THREE.MathUtils.clamp(p.x + Math.cos(ang) * off, 6, this.levelSize.x - 6),
        0,
        THREE.MathUtils.clamp(p.z + Math.sin(ang) * off, 6, this.levelSize.z - 6),
      )
      this.buildRappel(g, ground)
    }
  }

  /** Build the rope line + a small officer figure riding it. */
  private buildRappel(heli: THREE.Object3D, ground: THREE.Vector3): void {
    const engine = this.engine
    if (!engine) return
    const geo = new THREE.BufferGeometry()
    geo.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(6), 3),
    )
    const rope = new THREE.Line(
      geo,
      new THREE.LineBasicMaterial({ color: 0xd6d3d1, transparent: true, opacity: 0.85 }),
    )
    rope.frustumCulled = false
    engine.scene.add(rope)

    // Officer: dark torso + helmet + a tiny gun box — reads as a figure
    // at distance without any animation cost.
    const officer = new THREE.Group()
    const torso = new THREE.Mesh(BOX, mat('swat_body', 0x1c2127))
    torso.scale.set(0.5, 0.72, 0.3)
    officer.add(torso)
    const helmet = new THREE.Mesh(BOX, mat('swat_helmet', 0x2d3540))
    helmet.scale.set(0.34, 0.26, 0.34)
    helmet.position.y = 0.52
    officer.add(helmet)
    const gun = new THREE.Mesh(BOX, mat('swat_gun', 0x0c0d10))
    gun.scale.set(0.1, 0.1, 0.62)
    gun.position.set(0.24, 0.1, -0.1)
    officer.add(gun)
    officer.position.copy(heli.position)
    engine.scene.add(officer)

    const length = heli.position.distanceTo(ground)
    this.rappels.push({ rope, ropeGeo: geo, officer, ground, t: 0, length })
  }

  /** Slide every active officer down their rope; land → real SWAT NPC. */
  private updateRappels(dt: number): void {
    if (this.rappels.length === 0) return
    const engine = this.engine
    const g = this.group
    if (!engine || !g) return
    for (let i = this.rappels.length - 1; i >= 0; i--) {
      const r = this.rappels[i]
      const speed = RAPPEL_SLIDE_SPEED / Math.max(8, r.length)
      r.t = Math.min(1, r.t + speed * dt)
      // Rope: belly → ground anchor (the heli keeps orbiting, so the top
      // end rides the airframe while the bottom stays pinned).
      const pos = r.ropeGeo.getAttribute('position') as THREE.BufferAttribute
      pos.setXYZ(0, g.position.x, g.position.y - 1.0, g.position.z)
      pos.setXYZ(1, r.ground.x, r.ground.y, r.ground.z)
      pos.needsUpdate = true
      // Officer position + slight sway perpendicular to the rope.
      const sway = Math.sin(this.time * 7 + i * 2.1) * 0.22 * (1 - r.t)
      r.officer.position.set(
        THREE.MathUtils.lerp(g.position.x, r.ground.x, r.t) + sway,
        THREE.MathUtils.lerp(g.position.y - 1.0, r.ground.y + 0.85, r.t),
        THREE.MathUtils.lerp(g.position.z, r.ground.z, r.t) + sway * 0.6,
      )
      if (r.t >= 1) {
        this.landRappel(r)
        this.rappels.splice(i, 1)
      }
    }
  }

  /** Land one officer: dispose rope/figure, spawn a real SWAT NPC there. */
  private landRappel(r: Rappel): void {
    const engine = this.engine
    if (!engine) return
    engine.scene.remove(r.rope)
    r.ropeGeo.dispose()
    ;(r.rope.material as THREE.Material).dispose()
    engine.scene.remove(r.officer)
    this.swatDeployed++
    this.npcs()?.spawnEnemy?.('swat', { x: r.ground.x, y: 0, z: r.ground.z }, { hostile: true })
    engine.notify('SWAT on the ground — rifles up', 'danger')
  }

  /** Instantly finish every rope (used on depart/despawn so no visual is
   * stranded mid-air). SILENT mode skips the per-officer toast. */
  private landAllRappels(silent = false): void {
    if (silent) {
      // Land without spamming toasts: still spawn the ground units.
      for (const r of this.rappels) {
        const engine = this.engine
        if (!engine) break
        engine.scene.remove(r.rope)
        r.ropeGeo.dispose()
        ;(r.rope.material as THREE.Material).dispose()
        engine.scene.remove(r.officer)
        this.swatDeployed++
        this.npcs()?.spawnEnemy?.('swat', { x: r.ground.x, y: 0, z: r.ground.z }, { hostile: true })
      }
      this.rappels.length = 0
    } else {
      for (let i = this.rappels.length - 1; i >= 0; i--) {
        this.landRappel(this.rappels[i])
        this.rappels.splice(i, 1)
      }
    }
  }

  /** Hard teardown of rope visuals (scene already dissolving). */
  private clearRappelVisuals(): void {
    const engine = this.engine
    for (const r of this.rappels) {
      engine?.scene.remove(r.rope)
      r.ropeGeo.dispose()
      ;(r.rope.material as THREE.Material).dispose()
      engine?.scene.remove(r.officer)
    }
    this.rappels.length = 0
  }

  private updateAudio(): void {
    const engine = this.engine
    const g = this.group
    if (!engine || !g || this.state === 'idle' || this.state === 'depart') return
    this.audio()?.updateHelicopterLoop?.({ x: g.position.x, y: g.position.y, z: g.position.z })
  }

  private npcs(): NpcLike | null {
    return (this.engine?.systems.npcs as unknown as NpcLike | undefined) ?? null
  }
  private audio(): AudioLike | null {
    return (this.engine?.systems.audio as unknown as AudioLike | undefined) ?? null
  }
}
