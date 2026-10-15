/**
 * WorldStreamer — chunked open-world streaming.
 *
 *  - 100×100 m chunks, radius 3 around the player (7×7 loaded).
 *    Chunks are built on demand (2 per fixed step max to avoid hitches)
 *    and disposed beyond radius+1.
 *  - LOD: full detail < 150 m; merged vertex-colored boxes 150–400 m
 *    (no props/labels); culled beyond 400 m. Chunk-level frustum culling
 *    via THREE.Frustum against the chunk AABB.
 *  - Global per-level geometry: ground plane, water planes (animated
 *    shader), dock platforms (walkable, top at y=0.5).
 *  - Publishes street-lamp head positions for the Lighting pool and the
 *    RoadGraph for Task 2-b's traffic/AI systems.
 *  - Authored LevelData buildings always spawn (chunk containing them).
 */
import * as THREE from 'three'
import type { BuildingData, LevelData } from '@/game/types'
import type { PhysicsWorld } from '../physics/PhysicsWorld'
import { buildChunk, CHUNK_SIZE, LOD0_DISTANCE, LOD1_DISTANCE, type ChunkBuild } from './CityBuilder'
import { RoadGraph } from './RoadGraph'
import { WorldAssets, disposeLabelSprite } from './textures'

const STREAM_RADIUS = 3
const DISPOSE_RADIUS = STREAM_RADIUS + 1
const MAX_BUILDS_PER_STEP = 2
const LABEL_VISIBLE_DISTANCE = 80

interface ChunkRecord {
  build: ChunkBuild
  tier: number // 0 = detail, 1 = lod1, 2 = culled
}

export class WorldStreamer {
  readonly roadGraph: RoadGraph
  private scene: THREE.Scene
  private physics: PhysicsWorld
  private level: LevelData
  private assets: WorldAssets
  private chunks = new Map<string, ChunkRecord>()
  private buildQueue: { cx: number; cz: number; key: string }[] = []
  private sharedGeometries = new Set<THREE.BufferGeometry>()

  private globalGroup: THREE.Group
  private waterMeshes: THREE.Mesh[] = []
  private waterTimes: { value: number }[] = []
  private lampHeads: THREE.Vector3[] = []
  private lampHeadsDirty = true

  private frustum = new THREE.Frustum()
  private frustumMat = new THREE.Matrix4()
  private tmpCenter = new THREE.Vector3()
  private reservedRects: { minX: number; maxX: number; minZ: number; maxZ: number }[]

  constructor(
    scene: THREE.Scene,
    physics: PhysicsWorld,
    level: LevelData,
    /** Spots to keep clear of procedural buildings (vehicle spawns). */
    reservedSpots: { x: number; z: number; r: number }[] = [],
  ) {
    this.scene = scene
    this.physics = physics
    this.level = level
    this.assets = new WorldAssets()
    this.roadGraph = new RoadGraph(level)
    this.authoredIndex = this.authoredByChunk()
    this.reservedRects = reservedSpots.map((s) => ({
      minX: s.x - s.r,
      maxX: s.x + s.r,
      minZ: s.z - s.r,
      maxZ: s.z + s.r,
    }))
    this.globalGroup = new THREE.Group()
    this.globalGroup.name = 'world_global'
    scene.add(this.globalGroup)

    // Track shared geometries so chunk disposal skips them.
    this.sharedGeometries.add(this.assets.unitBox)
    this.sharedGeometries.add(this.assets.unitCyl)
    this.sharedGeometries.add(this.assets.pyramid)
    this.sharedGeometries.add(this.assets.unitSphere)

    this.physics.setWaterAreas(level.waterAreas)
    this.physics.setDocks(level.docks)
    this.buildGlobalGeometry()
  }

  // ------------------------------------------------------------------
  // Global (per-level) geometry: ground, water, docks
  // ------------------------------------------------------------------

  private buildGlobalGeometry(): void {
    const level = this.level
    const kind = `${level.type} ${level.id}`.toLowerCase()

    // ---- ground plane ----
    const groundColors: Record<string, number> = {
      urban: 0x3a3a40,
      residential: 0x3d5238,
      industrial: 0x46443e,
      harbor: 0x34383b,
    }
    const groundColor =
      (kind.includes('harbor') && groundColors.harbor) ||
      (kind.includes('industr') && groundColors.industrial) ||
      (kind.includes('resident') && groundColors.residential) ||
      groundColors.urban
    const gw = level.sizeX + 600
    const gd = level.sizeZ + 600
    // Carve water areas out of the ground plane (exact axis-aligned rect
    // complement) so water is VISIBLE — the original single plane at y=0
    // would otherwise cover the water surface at y=-0.3.
    const groundRects = carveRects(
      {
        minX: level.sizeX / 2 - gw / 2,
        maxX: level.sizeX / 2 + gw / 2,
        minZ: level.sizeZ / 2 - gd / 2,
        maxZ: level.sizeZ / 2 + gd / 2,
      },
      level.waterAreas.map((a) => ({
        minX: Math.min(a.min.x, a.max.x),
        maxX: Math.max(a.min.x, a.max.x),
        minZ: Math.min(a.min.z, a.max.z),
        maxZ: Math.max(a.min.z, a.max.z),
      })),
    )
    for (const r of groundRects) {
      const w = r.maxX - r.minX
      const d = r.maxZ - r.minZ
      if (w < 1 || d < 1) continue
      const groundGeo = new THREE.PlaneGeometry(w, d)
      groundGeo.rotateX(-Math.PI / 2)
      const ground = new THREE.Mesh(
        groundGeo,
        new THREE.MeshStandardMaterial({ color: groundColor, roughness: 1 }),
      )
      ground.position.set((r.minX + r.maxX) / 2, 0, (r.minZ + r.maxZ) / 2)
      ground.receiveShadow = true
      this.globalGroup.add(ground)
      this.sharedGeometries.add(groundGeo) // disposed with global group
    }

    // ---- water ----
    for (const area of level.waterAreas) {
      const minX = Math.min(area.min.x, area.max.x)
      const maxX = Math.max(area.min.x, area.max.x)
      const minZ = Math.min(area.min.z, area.max.z)
      const maxZ = Math.max(area.min.z, area.max.z)
      const w = Math.max(maxX - minX, 10)
      const d = Math.max(maxZ - minZ, 10)
      const geo = new THREE.PlaneGeometry(w, d)
      geo.rotateX(-Math.PI / 2)
      const mat = new THREE.MeshStandardMaterial({
        color: 0x1a4542, // deep teal — no blue palette
        transparent: true,
        opacity: 0.86,
        roughness: 0.3,
        metalness: 0.15,
      })
      const uTime = { value: 0 }
      this.waterTimes.push(uTime)
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.uTime = uTime
        shader.vertexShader =
          'varying vec3 vWPos;\n' +
          shader.vertexShader.replace(
            '#include <begin_vertex>',
            '#include <begin_vertex>\n vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
          )
        shader.fragmentShader =
          'uniform float uTime;\nvarying vec3 vWPos;\n' +
          shader.fragmentShader.replace(
            '#include <color_fragment>',
            `#include <color_fragment>
            float wv = sin(vWPos.x * 0.09 + uTime * 1.15) * sin(vWPos.z * 0.07 - uTime * 0.8);
            wv = 0.5 + 0.5 * wv;
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.12, 0.34, 0.32), wv * 0.45);`,
          )
      }
      const water = new THREE.Mesh(geo, mat)
      water.position.set((minX + maxX) / 2, -0.3, (minZ + maxZ) / 2)
      water.receiveShadow = false
      this.globalGroup.add(water)
      this.waterMeshes.push(water)
      this.sharedGeometries.add(geo)

      // Dark seabed so the (transparent) water reads as deep, not void.
      const bedGeo = new THREE.PlaneGeometry(w, d)
      bedGeo.rotateX(-Math.PI / 2)
      const bed = new THREE.Mesh(
        bedGeo,
        new THREE.MeshStandardMaterial({ color: 0x101d1c, roughness: 1 }),
      )
      bed.position.set((minX + maxX) / 2, -1.8, (minZ + maxZ) / 2)
      this.globalGroup.add(bed)
      this.sharedGeometries.add(bedGeo)
    }

    // ---- docks (walkable concrete platforms, top at y = 0.5) ----
    const dockMat = new THREE.MeshStandardMaterial({ color: 0x7c7a72, roughness: 0.95 })
    const bollardMat = new THREE.MeshStandardMaterial({ color: 0x4a4a46, roughness: 0.9 })
    for (const dock of level.docks) {
      const geo = new THREE.BoxGeometry(dock.size.x, 1.7, dock.size.z)
      const m = new THREE.Mesh(geo, dockMat)
      m.position.set(dock.position.x, -0.35, dock.position.z)
      m.receiveShadow = true
      m.castShadow = true
      this.globalGroup.add(m)
      this.sharedGeometries.add(geo)
      // bollards along the water-facing edge
      const count = Math.max(2, Math.floor(dock.size.x / 10))
      for (let i = 0; i <= count; i++) {
        const bx = dock.position.x - dock.size.x / 2 + (dock.size.x / count) * i
        const bz = dock.position.z - dock.size.z / 2 - 0.8
        const bollard = new THREE.Mesh(this.assets.unitCyl, bollardMat)
        bollard.position.set(bx, 0.6, bz)
        bollard.scale.set(0.35, 0.9, 0.35)
        this.globalGroup.add(bollard)
      }
    }
  }

  // ------------------------------------------------------------------
  // Authored building → chunk index
  // ------------------------------------------------------------------

  private authoredByChunk(): Map<string, BuildingData[]> {
    const map = new Map<string, BuildingData[]>()
    const maxCx = Math.max(1, Math.round(this.level.sizeX / CHUNK_SIZE)) - 1
    const maxCz = Math.max(1, Math.round(this.level.sizeZ / CHUNK_SIZE)) - 1
    for (const b of this.level.buildings) {
      const cx = Math.min(maxCx, Math.max(0, Math.floor(b.position.x / CHUNK_SIZE)))
      const cz = Math.min(maxCz, Math.max(0, Math.floor(b.position.z / CHUNK_SIZE)))
      const key = `${cx},${cz}`
      let arr = map.get(key)
      if (!arr) {
        arr = []
        map.set(key, arr)
      }
      arr.push(b)
    }
    return map
  }
  private authoredIndex: Map<string, BuildingData[]> = new Map()

  // ------------------------------------------------------------------
  // Streaming (fixed step)
  // ------------------------------------------------------------------

  update(playerPos: THREE.Vector3): void {
    const maxCx = Math.max(1, Math.round(this.level.sizeX / CHUNK_SIZE)) - 1
    const maxCz = Math.max(1, Math.round(this.level.sizeZ / CHUNK_SIZE)) - 1
    const pcx = Math.floor(playerPos.x / CHUNK_SIZE)
    const pcz = Math.floor(playerPos.z / CHUNK_SIZE)

    // Dispose far chunks.
    for (const [key, rec] of this.chunks) {
      const [cx, cz] = key.split(',').map(Number)
      const dist = Math.max(Math.abs(cx - pcx), Math.abs(cz - pcz))
      if (dist > DISPOSE_RADIUS) {
        this.disposeChunk(key, rec)
      }
    }

    // Queue missing chunks by distance.
    this.buildQueue.length = 0
    for (let dx = -STREAM_RADIUS; dx <= STREAM_RADIUS; dx++) {
      for (let dz = -STREAM_RADIUS; dz <= STREAM_RADIUS; dz++) {
        const cx = pcx + dx
        const cz = pcz + dz
        if (cx < 0 || cz < 0 || cx > maxCx || cz > maxCz) continue
        const key = `${cx},${cz}`
        if (this.chunks.has(key)) continue
        this.buildQueue.push({ cx, cz, key })
      }
    }
    this.buildQueue.sort(
      (a, b) =>
        (Math.abs(a.cx - pcx) + Math.abs(a.cz - pcz)) - (Math.abs(b.cx - pcx) + Math.abs(b.cz - pcz)),
    )
    let built = 0
    for (const item of this.buildQueue) {
      if (built >= MAX_BUILDS_PER_STEP) break
      this.buildChunkNow(item.cx, item.cz)
      built++
    }
  }

  private buildChunkNow(cx: number, cz: number): void {
    const key = `${cx},${cz}`
    if (this.chunks.has(key)) return
    const build = buildChunk(
      cx,
      cz,
      this.level,
      this.assets,
      this.authoredIndex.get(key) ?? [],
      this.reservedRects.filter(
        (r) => r.maxX > cx * CHUNK_SIZE && r.minX < (cx + 1) * CHUNK_SIZE && r.maxZ > cz * CHUNK_SIZE && r.minZ < (cz + 1) * CHUNK_SIZE,
      ),
    )
    this.scene.add(build.group)
    this.physics.addStaticBoxes(build.colliders)
    this.chunks.set(key, { build, tier: 0 })
    this.lampHeadsDirty = true
  }

  /** Synchronously build chunks within `radius` of a position (load-time).
   *  Lets vehicles spawn with full collision awareness around the player. */
  prewarm(pos: THREE.Vector3, radius = 1): void {
    const maxCx = Math.max(1, Math.round(this.level.sizeX / CHUNK_SIZE)) - 1
    const maxCz = Math.max(1, Math.round(this.level.sizeZ / CHUNK_SIZE)) - 1
    const pcx = Math.floor(pos.x / CHUNK_SIZE)
    const pcz = Math.floor(pos.z / CHUNK_SIZE)
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const cx = pcx + dx
        const cz = pcz + dz
        if (cx < 0 || cz < 0 || cx > maxCx || cz > maxCz) continue
        this.buildChunkNow(cx, cz)
      }
    }
  }

  private disposeChunk(key: string, rec: ChunkRecord): void {
    this.scene.remove(rec.build.group)
    this.physics.removeStaticBoxesByPrefix(rec.build.colliderPrefix)
    // Dispose chunk-owned GPU resources (skip shared assets geometries).
    rec.build.group.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (mesh.isMesh || (obj as THREE.Sprite).isSprite) {
        const geo = mesh.geometry
        if (geo && !this.sharedGeometries.has(geo)) geo.dispose()
      }
    })
    for (const label of rec.build.labels) disposeLabelSprite(label.sprite)
    // NOTE: materials come from the shared WorldAssets pool and are only
    // disposed once, in dispose() (per-chunk disposal would break siblings).
    this.chunks.delete(key)
    this.lampHeadsDirty = true
  }

  // ------------------------------------------------------------------
  // Per-frame: LOD tiers, frustum culling, labels, water animation
  // ------------------------------------------------------------------

  updateVisibility(camera: THREE.PerspectiveCamera, playerPos: THREE.Vector3, dt: number): void {
    // Water animation.
    for (const t of this.waterTimes) t.value += dt

    // Frustum.
    this.frustumMat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    this.frustum.setFromProjectionMatrix(this.frustumMat)

    for (const rec of this.chunks.values()) {
      const { build } = rec
      const center = this.tmpCenter.copy(build.bounds.min).add(build.bounds.max).multiplyScalar(0.5)
      const dist = Math.hypot(center.x - playerPos.x, center.z - playerPos.z)
      const tier = dist < LOD0_DISTANCE ? 0 : dist < LOD1_DISTANCE ? 1 : 2
      const frustumHit = this.frustum.intersectsBox(build.bounds)

      build.group.visible = frustumHit && tier !== 2

      if (tier !== rec.tier) {
        rec.tier = tier
        // Detail children visible only in tier 0; lod1 only in tier 1.
        for (const child of build.group.children) {
          child.visible = child !== build.lod1
        }
        build.lod1.visible = tier === 1
      }

      // Building name labels: detail tier only, within 80 m.
      if (tier === 0 && build.labels.length > 0) {
        for (const label of build.labels) {
          label.sprite.visible =
            label.position.distanceToSquared(playerPos) <
            LABEL_VISIBLE_DISTANCE * LABEL_VISIBLE_DISTANCE
        }
      } else if (build.labels.length > 0 && tier !== 0) {
        for (const label of build.labels) label.sprite.visible = false
      }
    }
  }

  // ------------------------------------------------------------------
  // Accessors for other systems
  // ------------------------------------------------------------------

  /** Street-lamp head world positions (for the Lighting point-light pool). */
  getLampHeadPositions(): THREE.Vector3[] {
    if (this.lampHeadsDirty) {
      this.lampHeads.length = 0
      for (const rec of this.chunks.values()) {
        for (const p of rec.build.lampHeads) this.lampHeads.push(p)
      }
      this.lampHeadsDirty = false
    }
    return this.lampHeads
  }

  /** Traffic/pedestrian navigation graph (Task 2-b). */
  getRoadGraph(): RoadGraph {
    return this.roadGraph
  }

  /** True if a horizontal position is on a road (within 7 m). */
  isOnRoad(x: number, z: number): boolean {
    return this.roadGraph.isOnRoad({ x, y: 0, z })
  }

  setNightFactor(night: number): void {
    this.assets.setNightFactor(night)
  }

  get loadedChunkCount(): number {
    return this.chunks.size
  }

  dispose(): void {
    for (const [key, rec] of this.chunks) this.disposeChunk(key, rec)
    this.chunks.clear()
    // Dispose global geometry + materials.
    this.globalGroup.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (mesh.isMesh) {
        mesh.geometry?.dispose()
        const mat = mesh.material
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
        else mat?.dispose()
      }
    })
    this.scene.remove(this.globalGroup)
    this.assets.dispose()
    this.physics.clearStatic()
    this.lampHeads.length = 0
  }
}

// ---------------------------------------------------------------------
// Axis-aligned rect complement: subtract `holes` from `base`, returning
// the remaining ground pieces (used to carve water out of the ground).
// ---------------------------------------------------------------------
interface PlainRect {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

function carveRects(base: PlainRect, holes: PlainRect[]): PlainRect[] {
  let rects: PlainRect[] = [base]
  for (const h of holes) {
    if (h.maxX <= h.minX || h.maxZ <= h.minZ) continue
    const next: PlainRect[] = []
    for (const r of rects) {
      const ix0 = Math.max(r.minX, h.minX)
      const ix1 = Math.min(r.maxX, h.maxX)
      const iz0 = Math.max(r.minZ, h.minZ)
      const iz1 = Math.min(r.maxZ, h.maxZ)
      if (ix0 >= ix1 || iz0 >= iz1) {
        next.push(r) // no overlap
        continue
      }
      if (h.minX > r.minX) next.push({ minX: r.minX, maxX: h.minX, minZ: r.minZ, maxZ: r.maxZ })
      if (h.maxX < r.maxX) next.push({ minX: h.maxX, maxX: r.maxX, minZ: r.minZ, maxZ: r.maxZ })
      if (h.minZ > r.minZ) next.push({ minX: ix0, maxX: ix1, minZ: r.minZ, maxZ: h.minZ })
      if (h.maxZ < r.maxZ) next.push({ minX: ix0, maxX: ix1, minZ: h.maxZ, maxZ: r.maxZ })
    }
    rects = next
  }
  return rects
}
