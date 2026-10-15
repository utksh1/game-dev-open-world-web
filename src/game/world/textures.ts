/**
 * Procedural textures + shared material/geometry cache.
 *
 * All city materials are generated at runtime on <canvas> — no external
 * asset downloads. Materials are cached by key and SHARED between chunks
 * (never disposed per chunk, disposed once per level via WorldAssets).
 *
 * "Night materials" (window facades, lamp heads, shop signs) have their
 * emissiveIntensity animated by the day/night cycle.
 */
import * as THREE from 'three'
import { mulberry32 } from './rng'

// ------------------------------------------------------------------
// Canvas helpers
// ------------------------------------------------------------------

function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D canvas context unavailable')
  return { canvas, ctx }
}

function canvasTexture(canvas: HTMLCanvasElement, repeatWrap = true): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  if (repeatWrap) {
    tex.wrapS = THREE.RepeatWrapping
    tex.wrapT = THREE.RepeatWrapping
  }
  tex.anisotropy = 4
  return tex
}

// ------------------------------------------------------------------
// Road texture — dark asphalt, warm-yellow dashed center, edge lines
// Lines run along the U axis (canvas x) so the texture tiles along the
// road length; v edges are the road sides.
// ------------------------------------------------------------------

let roadTexCache: THREE.Texture | null = null
export function getRoadTexture(): THREE.Texture {
  if (roadTexCache) return roadTexCache
  const { canvas, ctx } = makeCanvas(512, 512)
  // asphalt base
  ctx.fillStyle = '#26262b'
  ctx.fillRect(0, 0, 512, 512)
  // asphalt noise speckle
  const rng = mulberry32(1337)
  for (let i = 0; i < 900; i++) {
    const v = Math.floor(rng() * 34) + 22
    ctx.fillStyle = `rgb(${v},${v},${v + 4})`
    ctx.fillRect(rng() * 512, rng() * 512, 2, 2)
  }
  // edge lines (top / bottom = road sides)
  ctx.fillStyle = '#b9b3a4'
  ctx.fillRect(0, 26, 512, 5)
  ctx.fillRect(0, 481, 512, 5)
  // dashed center line — warm yellow
  ctx.fillStyle = '#c9a23f'
  for (let x = 6; x < 512; x += 84) {
    ctx.fillRect(x, 253, 48, 6)
  }
  roadTexCache = canvasTexture(canvas)
  return roadTexCache
}

// ------------------------------------------------------------------
// Facade textures — building base + window grid, plus an emissive map
// where a random subset of windows glows warm at night.
// ------------------------------------------------------------------

export interface FacadePair {
  map: THREE.Texture
  emissiveMap: THREE.Texture
}

const facadeCache = new Map<string, FacadePair>()

export function getFacadeTextures(
  key: string,
  baseColor: string,
  frameColor: string,
  litChance: number,
  seed: number,
): FacadePair {
  const cached = facadeCache.get(key)
  if (cached) return cached

  const SIZE = 256
  const COLS = 8
  const ROWS = 8
  const rng = mulberry32(seed)

  // --- diffuse map ---
  const d = makeCanvas(SIZE, SIZE)
  d.ctx.fillStyle = baseColor
  d.ctx.fillRect(0, 0, SIZE, SIZE)
  // subtle concrete noise
  for (let i = 0; i < 300; i++) {
    const v = rng()
    d.ctx.fillStyle = `rgba(0,0,0,${v * 0.08})`
    d.ctx.fillRect(rng() * SIZE, rng() * SIZE, 3, 3)
  }

  // --- emissive map (lit windows) ---
  const e = makeCanvas(SIZE, SIZE)
  e.ctx.fillStyle = '#000000'
  e.ctx.fillRect(0, 0, SIZE, SIZE)

  const cw = SIZE / COLS
  const ch = SIZE / ROWS
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      const x = c * cw + cw * 0.18
      const y = r * ch + ch * 0.2
      const w = cw * 0.64
      const h = ch * 0.58
      // window recess on diffuse
      const shade = 18 + Math.floor(rng() * 14)
      d.ctx.fillStyle = `rgb(${shade},${shade + 2},${shade + 5})`
      d.ctx.fillRect(x, y, w, h)
      d.ctx.strokeStyle = frameColor
      d.ctx.lineWidth = 1.5
      d.ctx.strokeRect(x, y, w, h)
      // lit?
      if (rng() < litChance) {
        const warm = rng()
        e.ctx.fillStyle =
          warm < 0.6 ? '#ffb45e' : warm < 0.85 ? '#ffd9a0' : '#a8d8c0'
        e.ctx.fillRect(x, y, w, h)
      }
    }
  }

  const pair: FacadePair = {
    map: canvasTexture(d.canvas),
    emissiveMap: canvasTexture(e.canvas),
  }
  facadeCache.set(key, pair)
  return pair
}

// ------------------------------------------------------------------
// Text label sprite (authored building names — a promise from the
// original docs, never delivered there)
// ------------------------------------------------------------------

export function makeLabelSprite(text: string): THREE.Sprite {
  const pad = 16
  const font = 'bold 30px "Arial", sans-serif'
  const measure = makeCanvas(8, 8)
  measure.ctx.font = font
  const textW = measure.ctx.measureText(text).width
  const w = Math.ceil(textW + pad * 2)
  const h = 56
  const { canvas, ctx } = makeCanvas(w, h)
  // dark translucent pill
  ctx.fillStyle = 'rgba(12, 14, 18, 0.72)'
  roundRect(ctx, 2, 2, w - 4, h - 4, 12)
  ctx.fill()
  ctx.strokeStyle = 'rgba(201, 162, 63, 0.8)' // amber trim
  ctx.lineWidth = 2
  roundRect(ctx, 2, 2, w - 4, h - 4, 12)
  ctx.stroke()
  ctx.font = font
  ctx.fillStyle = '#ffd98f'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, w / 2, h / 2 + 1)

  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthTest: true,
    depthWrite: false,
  })
  const sprite = new THREE.Sprite(mat)
  // Constant-ish world size regardless of canvas width.
  const aspect = w / h
  const height = 1.9
  sprite.scale.set(height * aspect, height, 1)
  return sprite
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/** Dispose a label sprite's GPU resources. */
export function disposeLabelSprite(sprite: THREE.Sprite): void {
  const mat = sprite.material as THREE.SpriteMaterial
  mat.map?.dispose()
  mat.dispose()
}

// ------------------------------------------------------------------
// WorldAssets — per-level cache of shared materials & geometries
// ------------------------------------------------------------------

interface NightMaterial {
  mat: THREE.MeshStandardMaterial
  dayEmissive: number
  nightEmissive: number
}

export class WorldAssets {
  private materials = new Map<string, THREE.Material>()
  private geometries = new Map<string, THREE.BufferGeometry>()
  private nightMaterials: NightMaterial[] = []

  /** Cached material factory. */
  mat<T extends THREE.Material = THREE.Material>(key: string, factory: () => T): T {
    let m = this.materials.get(key)
    if (!m) {
      m = factory()
      this.materials.set(key, m)
    }
    return m as T
  }

  /** Cached geometry factory. */
  geo<T extends THREE.BufferGeometry = THREE.BufferGeometry>(key: string, factory: () => T): T {
    let g = this.geometries.get(key)
    if (!g) {
      g = factory()
      this.geometries.set(key, g)
    }
    return g as T
  }

  /** Register an emissive material whose intensity follows the night factor. */
  registerNightMaterial(mat: THREE.MeshStandardMaterial, dayEmissive: number, nightEmissive: number): void {
    this.nightMaterials.push({ mat, dayEmissive, nightEmissive })
  }

  /** 0 = day, 1 = night — animate window glow / lamp heads / signs. */
  setNightFactor(night: number): void {
    for (const nm of this.nightMaterials) {
      nm.mat.emissiveIntensity = THREE.MathUtils.lerp(nm.dayEmissive, nm.nightEmissive, night)
    }
  }

  dispose(): void {
    for (const m of this.materials.values()) m.dispose()
    for (const g of this.geometries.values()) g.dispose()
    this.materials.clear()
    this.geometries.clear()
    this.nightMaterials = []
  }

  // ---- shared unit geometries ----
  get unitBox(): THREE.BoxGeometry {
    return this.geo('unitBox', () => new THREE.BoxGeometry(1, 1, 1))
  }
  get unitCyl(): THREE.CylinderGeometry {
    return this.geo('unitCyl', () => new THREE.CylinderGeometry(0.5, 0.5, 1, 8))
  }
  get pyramid(): THREE.ConeGeometry {
    return this.geo('pyramid', () => {
      const g = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1)
      g.rotateY(Math.PI / 4) // align the 4 faces to the axes
      return g
    })
  }
  get unitSphere(): THREE.SphereGeometry {
    return this.geo('unitSphere', () => new THREE.SphereGeometry(0.5, 10, 8))
  }

  // ---- shared key materials ----
  roadMat(): THREE.MeshStandardMaterial {
    return this.mat('road', () => {
      const tex = getRoadTexture().clone()
      tex.needsUpdate = true
      tex.repeat.set(1, 1)
      return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.94, metalness: 0 })
    })
  }
  asphaltPatchMat(): THREE.MeshStandardMaterial {
    return this.mat('asphaltPatch', () =>
      new THREE.MeshStandardMaterial({ color: 0x2a2a2f, roughness: 0.95 }),
    )
  }
  sidewalkMat(): THREE.MeshStandardMaterial {
    return this.mat('sidewalk', () =>
      new THREE.MeshStandardMaterial({ color: 0x8a8377, roughness: 0.9 }),
    )
  }
  concreteMat(): THREE.MeshStandardMaterial {
    return this.mat('concrete', () =>
      new THREE.MeshStandardMaterial({ color: 0x6f6d66, roughness: 0.92 }),
    )
  }
  darkConcreteMat(): THREE.MeshStandardMaterial {
    return this.mat('darkConcrete', () =>
      new THREE.MeshStandardMaterial({ color: 0x3f4045, roughness: 0.92 }),
    )
  }
  lampHeadMat(): THREE.MeshStandardMaterial {
    const key = 'lampHead'
    const existing = this.materials.get(key) as THREE.MeshStandardMaterial | undefined
    if (existing) return existing
    const m = new THREE.MeshStandardMaterial({
      color: 0x3a3a3e,
      emissive: new THREE.Color(0xffb066),
      emissiveIntensity: 0,
      roughness: 0.6,
    })
    this.materials.set(key, m)
    this.registerNightMaterial(m, 0, 3.2)
    return m
  }
  trunkMat(): THREE.MeshStandardMaterial {
    return this.mat('trunk', () =>
      new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 1 }),
    )
  }
  foliageMats(): THREE.MeshStandardMaterial[] {
    const out: THREE.MeshStandardMaterial[] = []
    const shades = [0x3e6b3a, 0x4e7a40, 0x35592f]
    shades.forEach((c, i) => {
      out.push(
        this.mat(`foliage${i}`, () => new THREE.MeshStandardMaterial({ color: c, roughness: 1 })),
      )
    })
    return out
  }
  containerMats(): THREE.MeshStandardMaterial[] {
    const colors = [0x8a3b2e, 0xb8702d, 0x2e6e5e, 0x4a5560, 0xb09a3f]
    return colors.map((c, i) =>
      this.mat(
        `container${i}`,
        () => new THREE.MeshStandardMaterial({ color: c, roughness: 0.85, metalness: 0.15 }),
      ),
    )
  }
  /** Emissive facade material (window glow at night). variant 0..2 */
  facadeMat(variant: number): THREE.MeshStandardMaterial {
    const key = `facade${variant}`
    const existing = this.materials.get(key) as THREE.MeshStandardMaterial | undefined
    if (existing) return existing
    const configs = [
      { base: '#4c5158', frame: '#2c2f34', lit: 0.42, seed: 101 },
      { base: '#5a5750', frame: '#38352f', lit: 0.5, seed: 202 },
      { base: '#43484a', frame: '#26292b', lit: 0.34, seed: 303 },
    ]
    const cfg = configs[variant % configs.length]
    const pair = getFacadeTextures(key, cfg.base, cfg.frame, cfg.lit, cfg.seed)
    const m = new THREE.MeshStandardMaterial({
      map: pair.map,
      emissiveMap: pair.emissiveMap,
      emissive: new THREE.Color(0xffc98a),
      emissiveIntensity: 0,
      roughness: 0.85,
    })
    this.materials.set(key, m)
    this.registerNightMaterial(m, 0, 2.1)
    return m
  }
  lod1Mat(): THREE.MeshLambertMaterial {
    return this.mat('lod1', () => new THREE.MeshLambertMaterial({ vertexColors: true }))
  }
}
