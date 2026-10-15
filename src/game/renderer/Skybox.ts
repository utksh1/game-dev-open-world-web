/**
 * Skybox — gradient sky dome (custom ShaderMaterial), sun disc, moon,
 * and a star field that fades in at night.
 *
 * The dome follows the camera (never gets fogged: material.fog = false)
 * and its two uniforms (topColor / bottomColor) are driven by the
 * DayNightCycle keyframes.
 */
import * as THREE from 'three'
import type { DayNightState } from './DayNight'

const STAR_COUNT = 700

export class Skybox {
  readonly group: THREE.Group
  private domeMat: THREE.ShaderMaterial
  private sunMesh: THREE.Mesh
  private moonMesh: THREE.Mesh
  private stars: THREE.Points
  private starsMat: THREE.PointsMaterial

  constructor() {
    this.group = new THREE.Group()
    this.group.name = 'skybox'

    // ---- gradient dome ----
    this.domeMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        topColor: { value: new THREE.Color(0x6ea2c9) },
        bottomColor: { value: new THREE.Color(0xd9e0e0) },
        offset: { value: 60.0 },
        exponent: { value: 0.7 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorldPosition;
        void main() {
          vec4 worldPosition = modelMatrix * vec4(position, 1.0);
          vWorldPosition = worldPosition.xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 topColor;
        uniform vec3 bottomColor;
        uniform float offset;
        uniform float exponent;
        varying vec3 vWorldPosition;
        void main() {
          float h = normalize(vWorldPosition + vec3(0.0, offset, 0.0)).y;
          float f = pow(max(h, 0.0), exponent);
          gl_FragColor = vec4(mix(bottomColor, topColor, f), 1.0);
        }
      `,
    })
    const dome = new THREE.Mesh(new THREE.SphereGeometry(900, 24, 14), this.domeMat)
    dome.frustumCulled = false
    dome.renderOrder = -100
    this.group.add(dome)

    // ---- sun disc ----
    const sunMat = new THREE.MeshBasicMaterial({
      color: 0xffd9a0,
      fog: false,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    })
    this.sunMesh = new THREE.Mesh(new THREE.SphereGeometry(28, 16, 12), sunMat)
    this.sunMesh.frustumCulled = false
    this.sunMesh.renderOrder = -99
    this.group.add(this.sunMesh)

    // ---- moon ----
    const moonMat = new THREE.MeshBasicMaterial({
      color: 0xd8d4c8,
      fog: false,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    })
    this.moonMesh = new THREE.Mesh(new THREE.SphereGeometry(16, 16, 12), moonMat)
    this.moonMesh.frustumCulled = false
    this.moonMesh.renderOrder = -99
    this.group.add(this.moonMesh)

    // ---- stars (upper hemisphere points) ----
    const starPos = new Float32Array(STAR_COUNT * 3)
    for (let i = 0; i < STAR_COUNT; i++) {
      // Random direction on upper hemisphere at radius ~820.
      const u = Math.random()
      const v = Math.random()
      const theta = 2 * Math.PI * u
      const phi = Math.acos(Math.max(0.02, v)) // keep above horizon-ish
      const r = 820
      starPos[i * 3] = r * Math.sin(phi) * Math.cos(theta)
      starPos[i * 3 + 1] = r * Math.cos(phi)
      starPos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta)
    }
    const starGeo = new THREE.BufferGeometry()
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3))
    this.starsMat = new THREE.PointsMaterial({
      color: 0xfff4dc,
      size: 2.2,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0,
      fog: false,
      depthWrite: false,
    })
    this.stars = new THREE.Points(starGeo, this.starsMat)
    this.stars.frustumCulled = false
    this.stars.renderOrder = -98
    this.group.add(this.stars)
  }

  /**
   * @param cameraPos the skybox group is recentered on the camera so the
   * dome never clips and celestial bodies sit at "infinite" distance.
   */
  update(state: DayNightState, cameraPos: THREE.Vector3): void {
    this.group.position.copy(cameraPos)

    this.domeMat.uniforms.topColor.value.copy(state.skyTop)
    this.domeMat.uniforms.bottomColor.value.copy(state.skyBottom)

    const dir = state.sunDir
    this.sunMesh.position.copy(dir).multiplyScalar(800)
    this.sunMesh.visible = dir.y > 0.02 && state.nightFactor < 0.9
    ;(this.sunMesh.material as THREE.MeshBasicMaterial).color.copy(state.sunColor)

    // Moon opposite the sun, visible at night.
    this.moonMesh.position.copy(dir).multiplyScalar(-780)
    this.moonMesh.position.y = Math.abs(this.moonMesh.position.y)
    this.moonMesh.visible = state.nightFactor > 0.25
    ;(this.moonMesh.material as THREE.MeshBasicMaterial).opacity =
      Math.min(state.nightFactor * 1.2, 0.9)

    this.starsMat.opacity = state.nightFactor * 0.9
    this.stars.rotation.y += 0.00001 // imperceptible drift, feels alive
  }

  dispose(): void {
    this.domeMat.dispose()
    this.sunMesh.geometry.dispose()
    ;(this.sunMesh.material as THREE.Material).dispose()
    this.moonMesh.geometry.dispose()
    ;(this.moonMesh.material as THREE.Material).dispose()
    this.stars.geometry.dispose()
    this.starsMat.dispose()
  }
}
