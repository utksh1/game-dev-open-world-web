/**
 * CameraController — FPS / TPS / vehicle-chase camera.
 *
 *  - FPS: camera at the player's head (+ walk bob), player mesh hidden.
 *  - TPS: ~6 m behind, 2.5 m up, smooth follow; the player mesh is visible.
 *  - Driving: chase cam ~8.5 m behind the vehicle, auto-aligning to the
 *    vehicle heading while still allowing the player to look around.
 *  - Camera collision: ray from the look target to the desired camera
 *    position; if a building is in the way the camera is pulled in.
 *  - Shake support (damage / vehicle crashes) with exponential decay.
 *
 * Yaw/pitch convention matches three.js YXZ euler:
 *   forward = (-sin(yaw)·cos(pitch), sin(pitch), -cos(yaw)·cos(pitch))
 *   yaw 0 → looking toward -Z; positive yaw turns left.
 */
import * as THREE from 'three'
import type { PhysicsWorld } from '../physics/PhysicsWorld'

export type CameraMode = 'fps' | 'tps'

export interface CameraTarget {
  /** Feet position (player) or vehicle base position. */
  position: THREE.Vector3
  /** Eye/head height above position (player 1.65). */
  eyeHeight: number
  /** Facing yaw of the followed body (radians). */
  headingYaw: number
  /** Horizontal speed in m/s (drives bob + chase auto-align). */
  speed: number
}

const LOOK_SENSITIVITY = 0.0024 // radians per pixel
const PITCH_LIMIT = THREE.MathUtils.degToRad(85)
/** Base gameplay FOV (matches the Renderer's PerspectiveCamera). */
const BASE_FOV = 70
const PHOTO_FOV_MIN = 16
const PHOTO_FOV_MAX = 92
const PHOTO_FLY_SPEED = 9 // m/s (sprint ×3)
const PHOTO_FLY_FAST = 27
const PHOTO_HEIGHT_MAX = 320

export class CameraController {
  mode: CameraMode = 'tps'
  yaw = 0
  pitch = -0.12
  /** 0..1 strength of shake; decays each frame. */
  shakeAmount = 0
  /** Photo mode (V): detached free-fly camera, world frozen. */
  photoActive = false

  private camera: THREE.PerspectiveCamera
  private bobPhase = 0
  private smoothPos = new THREE.Vector3()
  private smoothInit = false
  private tmpDir = new THREE.Vector3()
  private tmpTarget = new THREE.Vector3()
  private photoPos = new THREE.Vector3()
  private photoFov = BASE_FOV

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera
  }

  toggleMode(): CameraMode {
    this.mode = this.mode === 'fps' ? 'tps' : 'fps'
    return this.mode
  }

  /** Drop the TPS smoothing history so the next update lands exactly on the
   *  target (used after teleports / level loads / respawns). */
  snap(): void {
    this.smoothInit = false
  }

  /** Apply look input (pixels, from mouse/pointer-lock/drag). */
  addLook(dxPixels: number, dyPixels: number): void {
    this.yaw -= dxPixels * LOOK_SENSITIVITY
    this.pitch -= dyPixels * LOOK_SENSITIVITY
    this.pitch = THREE.MathUtils.clamp(this.pitch, -PITCH_LIMIT, PITCH_LIMIT)
  }

  addYaw(deltaRadians: number): void {
    this.yaw += deltaRadians
  }

  addShake(amount: number): void {
    this.shakeAmount = Math.min(1, this.shakeAmount + amount)
  }

  /**
   * Weapon recoil kick (Task 2-b WeaponSystem): nudges aim pitch/yaw
   * directly so shots pull the camera up/sideways. Clamped to the
   * pitch limits; decays naturally as the player re-aims.
   */
  addRecoil(pitchKick: number, yawKick: number): void {
    this.pitch = THREE.MathUtils.clamp(this.pitch + pitchKick, -PITCH_LIMIT, PITCH_LIMIT)
    this.yaw += yawKick
  }

  /** Camera world-space forward (horizontal) for movement input mapping. */
  getForward(out: THREE.Vector3): THREE.Vector3 {
    return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw))
  }

  getRight(out: THREE.Vector3): THREE.Vector3 {
    return out.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw))
  }

  // ---------------------------------------------------------------------
  // Photo mode — detached free-fly camera (V). The engine freezes the
  // simulation; this camera owns look/move/zoom until exit.
  // ---------------------------------------------------------------------

  /** Detach from the current world-space pose (seamless entry). */
  enterPhoto(): void {
    if (this.photoActive) return
    this.photoActive = true
    this.photoPos.copy(this.camera.position)
    this.photoFov = this.camera.fov
  }

  /** Wheel zoom while in photo mode: cinematic FOV, clamped. */
  photoZoom(wheelSteps: number): void {
    if (!this.photoActive || wheelSteps === 0) return
    // Steps of ~3.5° with finer control at long zoom.
    this.photoFov = THREE.MathUtils.clamp(
      this.photoFov - wheelSteps * 3.5,
      PHOTO_FOV_MIN,
      PHOTO_FOV_MAX,
    )
  }

  /** Current photo-mode FOV (HUD readout). */
  get photoFovValue(): number {
    return this.photoFov
  }

  /**
   * One photo-mode frame: fly the free camera. Axes are -1..1 in the
   * camera's local frame (fly = pitch-aware forward, strafe horizontal,
   * rise vertical). Ground + bounds keep the camera inside the level.
   */
  updatePhoto(
    dt: number,
    fly: number,
    strafe: number,
    rise: number,
    sprint: boolean,
    groundY: number,
    bounds: { sizeX: number; sizeZ: number },
  ): void {
    if (!this.photoActive) return
    const speed = sprint ? PHOTO_FLY_FAST : PHOTO_FLY_SPEED
    const cosP = Math.cos(this.pitch)
    // Pitch-aware forward (looking up flies up — drone-style).
    const fx = -Math.sin(this.yaw) * cosP
    const fy = Math.sin(this.pitch)
    const fz = -Math.cos(this.yaw) * cosP
    // Horizontal-only right.
    const rx = Math.cos(this.yaw)
    const rz = -Math.sin(this.yaw)
    let dx = fx * fly + rx * strafe
    let dy = fy * fly + rise
    let dz = fz * fly + rz * strafe
    const len = Math.hypot(dx, dy, dz)
    if (len > 1e-6) {
      dx = (dx / len) * speed * dt
      dy = (dy / len) * speed * dt
      dz = (dz / len) * speed * dt
      this.photoPos.x = THREE.MathUtils.clamp(this.photoPos.x + dx, 2, bounds.sizeX - 2)
      this.photoPos.z = THREE.MathUtils.clamp(this.photoPos.z + dz, 2, bounds.sizeZ - 2)
      this.photoPos.y = THREE.MathUtils.clamp(this.photoPos.y + dy, 1, PHOTO_HEIGHT_MAX)
    }
    // Soft floor: never sink under the terrain under the lens.
    this.photoPos.y = Math.max(this.photoPos.y, groundY + 0.6)

    this.camera.position.copy(this.photoPos)
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ')
    if (Math.abs(this.camera.fov - this.photoFov) > 0.01) {
      this.camera.fov = this.photoFov
      this.camera.updateProjectionMatrix()
    }
  }

  /** Reattach to the follow camera; restore the gameplay FOV. */
  exitPhoto(): void {
    if (!this.photoActive) return
    this.photoActive = false
    this.camera.fov = BASE_FOV
    this.camera.updateProjectionMatrix()
    this.snap() // the follow cam lands on target without lagging
  }

  /**
   * @param driving when true, chase-cam behavior + auto-align to heading.
   */
  update(
    dt: number,
    target: CameraTarget,
    driving: boolean,
    physics: PhysicsWorld,
  ): void {
    // Chase auto-align: blend camera yaw toward the vehicle heading.
    if (driving && Math.abs(target.speed) > 1.5) {
      const blend = 1 - Math.exp(-1.8 * dt)
      this.yaw = lerpAngle(this.yaw, target.headingYaw, blend)
    }

    const eyeY = target.position.y + target.eyeHeight
    const cosP = Math.cos(this.pitch)
    const fx = -Math.sin(this.yaw) * cosP
    const fy = Math.sin(this.pitch)
    const fz = -Math.cos(this.yaw) * cosP

    if (this.mode === 'fps' && !driving) {
      // ---- first person ----
      const speedFactor = Math.min(target.speed / 6, 1)
      this.bobPhase += target.speed * dt * 1.6
      const bob = Math.sin(this.bobPhase * 2) * 0.05 * speedFactor
      this.camera.position.set(target.position.x, eyeY + bob, target.position.z)
      this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ')
      this.smoothInit = false
    } else {
      // ---- third person / chase ----
      const dist = driving ? 8.5 : 6
      const height = driving ? 3.2 : 2.5
      this.tmpTarget.set(target.position.x, eyeY, target.position.z)

      // Desired camera position: behind the look direction, raised.
      this.tmpDir.set(fx, 0, fz).normalize()
      const desired = new THREE.Vector3(
        this.tmpTarget.x - this.tmpDir.x * dist,
        this.tmpTarget.y + height - target.eyeHeight + 0.9,
        this.tmpTarget.z - this.tmpDir.z * dist,
      )

      // Camera collision: pull in if a building blocks the view.
      const origin = this.tmpTarget
      const toCam = desired.clone().sub(origin)
      const desiredDist = toCam.length()
      if (desiredDist > 0.001) {
        toCam.normalize()
        const hit = physics.raycast(origin, toCam, desiredDist + 0.4, false)
        if (hit) {
          const d = Math.max(0.8, hit.distance - 0.45)
          desired.copy(origin).addScaledVector(toCam, d)
        }
      }

      // Smooth follow.
      if (!this.smoothInit) {
        this.smoothPos.copy(desired)
        this.smoothInit = true
      } else {
        this.smoothPos.lerp(desired, 1 - Math.exp(-9 * dt))
      }
      this.camera.position.copy(this.smoothPos)
      this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ')
    }

    // ---- shake ----
    if (this.shakeAmount > 0.001) {
      const s = this.shakeAmount * 0.35
      this.camera.position.x += (Math.random() - 0.5) * s
      this.camera.position.y += (Math.random() - 0.5) * s
      this.camera.position.z += (Math.random() - 0.5) * s
      this.shakeAmount *= Math.exp(-6 * dt)
    }
    this.camera.updateMatrixWorld()
  }
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  return a + d * t
}
