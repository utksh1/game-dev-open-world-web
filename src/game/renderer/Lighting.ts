/**
 * Lighting — sun (directional, shadow-casting, tight frustum following the
 * player), hemisphere ambient, and a pooled set of 8 warm sodium-amber
 * street-lamp PointLights assigned to the lamps nearest the player at
 * night. NO blue-tinted scheme — night is lit by warm amber.
 */
import * as THREE from 'three'
import type { DayNightState } from './DayNight'

const SHADOW_MAP_SIZE = 2048
const SHADOW_BOX = 70 // half-extent of the sun shadow camera around player
const LAMP_POOL_SIZE = 10
const LAMP_COLOR = 0xffb066 // warm sodium amber
const LAMP_INTENSITY = 44
const LAMP_DISTANCE = 38

export class Lighting {
  readonly sun: THREE.DirectionalLight
  readonly hemi: THREE.HemisphereLight
  readonly lampPool: THREE.PointLight[]

  private sunTarget: THREE.Object3D
  private lampPositions: THREE.Vector3[] = []
  private assigned = new Map<THREE.PointLight, THREE.Vector3>()
  /** Performance mode halves the active lamp budget + kills sun shadows. */
  private perfMode = false

  constructor(scene: THREE.Scene) {
    this.sun = new THREE.DirectionalLight(0xfff1da, 1.2)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE)
    this.sun.shadow.camera.near = 10
    this.sun.shadow.camera.far = 420
    this.sun.shadow.camera.left = -SHADOW_BOX
    this.sun.shadow.camera.right = SHADOW_BOX
    this.sun.shadow.camera.top = SHADOW_BOX
    this.sun.shadow.camera.bottom = -SHADOW_BOX
    this.sun.shadow.bias = -0.0006
    this.sun.shadow.normalBias = 0.02
    this.sunTarget = new THREE.Object3D()
    this.sun.target = this.sunTarget
    scene.add(this.sun)
    scene.add(this.sunTarget)

    this.hemi = new THREE.HemisphereLight(0xbcc7cc, 0x6a6156, 0.6)
    scene.add(this.hemi)

    // Street lamp pool — reused, never more than LAMP_POOL_SIZE real lights.
    this.lampPool = []
    for (let i = 0; i < LAMP_POOL_SIZE; i++) {
      const l = new THREE.PointLight(LAMP_COLOR, 0, LAMP_DISTANCE, 2)
      l.visible = false
      scene.add(l)
      this.lampPool.push(l)
    }
  }

  /**
   * @param lampPositions the current set of lamp head positions around the
   * player (published by the WorldStreamer each frame).
   */
  setLampPositions(positions: THREE.Vector3[]): void {
    this.lampPositions = positions
  }

  /** Performance mode: no sun shadows, half the lamp lights (low-end GPUs). */
  setPerfMode(on: boolean): void {
    this.perfMode = on
    this.sun.castShadow = !on
  }

  /** Called once per rendered frame. */
  update(state: DayNightState, playerPos: THREE.Vector3): void {
    // --- sun / moon ---
    this.sun.color.copy(state.sunColor)
    this.sun.intensity = state.sunIntensity
    this.sun.position.copy(playerPos).addScaledVector(state.sunDir, 180)
    this.sunTarget.position.copy(playerPos)
    this.sunTarget.updateMatrixWorld()

    // --- hemisphere ambient ---
    this.hemi.color.copy(state.hemiSky)
    this.hemi.groundColor.copy(state.hemiGround)
    this.hemi.intensity = state.hemiIntensity

    // --- street lamps (nearest N at night; halved in performance mode) ---
    const lampsOn = state.lampsOn
    if (lampsOn && this.lampPositions.length > 0) {
      const budget = this.perfMode ? Math.ceil(LAMP_POOL_SIZE / 2) : LAMP_POOL_SIZE
      // Find the nearest `budget` lamp positions.
      const sorted = this.lampPositions
        .map((p) => ({ p, d: p.distanceToSquared(playerPos) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, budget)
      for (let i = 0; i < this.lampPool.length; i++) {
        const light = this.lampPool[i]
        if (i < sorted.length) {
          light.position.copy(sorted[i].p)
          light.intensity = LAMP_INTENSITY
          light.visible = true
          this.assigned.set(light, sorted[i].p)
        } else {
          light.visible = false
          this.assigned.delete(light)
        }
      }
    } else {
      for (const light of this.lampPool) light.visible = false
      this.assigned.clear()
    }
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.sun)
    scene.remove(this.sunTarget)
    scene.remove(this.hemi)
    for (const l of this.lampPool) scene.remove(l)
    this.sun.dispose()
    this.hemi.dispose()
    for (const l of this.lampPool) l.dispose()
    this.assigned.clear()
  }
}
