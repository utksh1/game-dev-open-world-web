/**
 * Renderer — WebGL renderer + scene + fog + resize handling.
 * ACES filmic tone mapping, soft PCF shadows, SRGB output.
 * Throws a descriptive Error when WebGL is unavailable (the boot page
 * catches it and shows a fallback message).
 */
import * as THREE from 'three'

export class Renderer {
  readonly scene: THREE.Scene
  readonly camera: THREE.PerspectiveCamera
  readonly webglRenderer: THREE.WebGLRenderer
  readonly container: HTMLElement

  private resizeObserver: ResizeObserver | null = null
  private disposed = false

  constructor(container: HTMLElement) {
    this.container = container

    // --- WebGL support probe with a readable error ---
    const probe = document.createElement('canvas')
    const gl = probe.getContext('webgl2') ?? probe.getContext('webgl')
    if (!gl) {
      throw new Error(
        'WebGL is not supported by this browser/GPU. The 3D open world requires WebGL.',
      )
    }

    this.scene = new THREE.Scene()
    this.scene.fog = new THREE.Fog(0x1a1d24, 120, 650)

    this.camera = new THREE.PerspectiveCamera(
      70, // fov
      Math.max(container.clientWidth, 1) / Math.max(container.clientHeight, 1),
      0.1,
      1400,
    )
    this.camera.position.set(0, 2, 0)

    try {
      this.webglRenderer = new THREE.WebGLRenderer({
        antialias: true,
        powerPreference: 'high-performance',
      })
    } catch (err) {
      throw new Error(
        `Failed to create WebGL renderer: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    this.webglRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.webglRenderer.setSize(
      Math.max(container.clientWidth, 1),
      Math.max(container.clientHeight, 1),
    )
    this.webglRenderer.outputColorSpace = THREE.SRGBColorSpace
    this.webglRenderer.toneMapping = THREE.ACESFilmicToneMapping
    this.webglRenderer.toneMappingExposure = 1.05
    this.webglRenderer.shadowMap.enabled = true
    // three r186: PCFSoftShadowMap is deprecated/removed — PCFShadowMap is
    // the supported soft filter now (avoids a WebGL console warning).
    this.webglRenderer.shadowMap.type = THREE.PCFShadowMap

    // Canvas fills the container; container must be positioned.
    const canvas = this.webglRenderer.domElement
    canvas.style.display = 'block'
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    canvas.style.outline = 'none'
    canvas.tabIndex = 0
    container.appendChild(canvas)

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize())
      this.resizeObserver.observe(container)
    }
    window.addEventListener('resize', this.resize)
  }

  get domElement(): HTMLCanvasElement {
    return this.webglRenderer.domElement
  }

  /**
   * Performance mode for low-end GPUs: pixel ratio drops to 1 and shadow
   * maps turn off (materials recompile — toggling shadowMap.enabled at
   * runtime requires needsUpdate on every material).
   */
  setPerformanceMode(on: boolean): void {
    if (this.disposed) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    this.webglRenderer.setPixelRatio(on ? 1 : dpr)
    const shadows = !on
    if (this.webglRenderer.shadowMap.enabled !== shadows) {
      this.webglRenderer.shadowMap.enabled = shadows
      this.scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined
        if (Array.isArray(mat)) mat.forEach((m) => (m.needsUpdate = true))
        else if (mat) mat.needsUpdate = true
      })
    }
    this.resize()
  }

  resize = (): void => {
    if (this.disposed) return
    const w = Math.max(this.container.clientWidth, 1)
    const h = Math.max(this.container.clientHeight, 1)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.webglRenderer.setSize(w, h, false)
  }

  render(): void {
    if (this.disposed) return
    this.webglRenderer.render(this.scene, this.camera)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.resizeObserver?.disconnect()
    window.removeEventListener('resize', this.resize)
    this.webglRenderer.dispose()
    if (this.webglRenderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.webglRenderer.domElement)
    }
    this.scene.clear()
  }
}
