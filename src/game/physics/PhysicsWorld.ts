/**
 * PhysicsWorld — lightweight analytic physics for the open world.
 *
 * What the original C++ project never had (PhysicsWorld was declared but
 * the collision code was dead): actual collision RESPONSE. Here:
 *   - Static AABB colliders for every building (authored + procedural),
 *     crane, container — registered by the WorldStreamer per chunk.
 *   - Dynamic AABBs for vehicles (refreshed once per fixed step by the
 *     VehicleManager) so players and bullets collide with cars too.
 *   - `collideCircle` resolves a vertical cylinder (player / vehicle)
 *     against boxes with SLIDING: pushed out along the minimal
 *     penetration axis, never stopping dead.
 *   - `raycast` is an analytic slab ray-AABB test (no THREE.Raycaster
 *     dependency, allocation-free) used by camera collision and by the
 *     weapon system (Task 2-b) for hitscan.
 *   - Ground model: walkable ground plane at y = 0, dock platforms at
 *     y = 0.5, water surfaces at y = -0.3 (swimmable, slows the player,
 *     NOT walkable).
 *
 * Broadphase: uniform spatial hash, 50×50 m cells. Boxes are inserted
 * into every cell they overlap; queries gather candidates from the cells
 * around the query volume. Cheap to rebuild per level, tiny memory.
 */
import type { DockData, Vec3, WaterArea } from '@/game/types'

export interface StaticBox {
  id: string
  minX: number
  minY: number
  minZ: number
  maxX: number
  maxY: number
  maxZ: number
}

export interface DynamicBox {
  id: string
  minX: number
  minY: number
  minZ: number
  maxX: number
  maxY: number
  maxZ: number
}

export interface CollisionHit {
  /** True if the circle overlapped at least one box. */
  hit: boolean
  /** Horizontal push-out normal of the DEEPEST contact (unit, XZ). */
  nx: number
  nz: number
  /** Penetration depth of the deepest contact (meters). */
  depth: number
}

export interface RayHit {
  distance: number
  point: Vec3
  normal: Vec3
  /** Id of the box that was hit (building id or vehicle instance id). */
  boxId: string
  /** 'building' for static boxes, 'vehicle' for dynamic ones. */
  kind: 'building' | 'vehicle'
}

export const GROUND_Y = 0
export const DOCK_TOP_Y = 0.5
export const WATER_SURFACE_Y = -0.3
export const WATER_DEPTH_Y = -0.5
/** Sea floor under water areas — below swim depth & sunken vehicles. */
export const WATER_FLOOR_Y = -1.35

interface DockFootprint {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

const CELL = 50

export class PhysicsWorld {
  private staticBoxes: StaticBox[] = []
  private dynamicBoxes: DynamicBox[] = []
  private grid = new Map<string, StaticBox[]>()
  private waterAreas: WaterArea[] = []
  private dockFootprints: DockFootprint[] = []

  // ------------------------------------------------------------------
  // Registration
  // ------------------------------------------------------------------

  /** Register a batch of static boxes (one chunk's buildings). */
  addStaticBoxes(boxes: StaticBox[]): void {
    for (const b of boxes) {
      this.staticBoxes.push(b)
      this.forEachGridCell(b, (key) => {
        let arr = this.grid.get(key)
        if (!arr) {
          arr = []
          this.grid.set(key, arr)
        }
        arr.push(b)
      })
    }
  }

  /** Remove all static boxes whose id starts with the given prefix. */
  removeStaticBoxesByPrefix(prefix: string): void {
    this.staticBoxes = this.staticBoxes.filter((b) => !b.id.startsWith(prefix))
    this.rebuildGrid()
  }

  /** Replace the dynamic (vehicle) box set. Called once per fixed step. */
  setDynamicBoxes(boxes: DynamicBox[]): void {
    this.dynamicBoxes = boxes
  }

  setWaterAreas(areas: WaterArea[]): void {
    this.waterAreas = areas
  }

  setDocks(docks: DockData[]): void {
    this.dockFootprints = docks.map((d) => ({
      minX: d.position.x - d.size.x / 2,
      maxX: d.position.x + d.size.x / 2,
      minZ: d.position.z - d.size.z / 2,
      maxZ: d.position.z + d.size.z / 2,
    }))
  }

  clearStatic(): void {
    this.staticBoxes = []
    this.grid.clear()
  }

  clearAll(): void {
    this.clearStatic()
    this.dynamicBoxes = []
    this.waterAreas = []
    this.dockFootprints = []
  }

  get staticBoxCount(): number {
    return this.staticBoxes.length
  }

  // ------------------------------------------------------------------
  // Ground / water queries
  // ------------------------------------------------------------------

  /** Walkable ground height at a horizontal position (docks > sea floor over water > plain ground). */
  getGroundHeight(x: number, z: number): number {
    for (const f of this.dockFootprints) {
      if (x >= f.minX && x <= f.maxX && z >= f.minZ && z <= f.maxZ) return DOCK_TOP_Y
    }
    // Over water the walkable "ground" is the sea floor — the player
    // swims near the surface instead of walking on an invisible plane.
    if (this.isWater(x, z)) return WATER_FLOOR_Y
    return GROUND_Y
  }

  /** True if the position is over water (and not on a dock platform). */
  isWater(x: number, z: number): boolean {
    for (const f of this.dockFootprints) {
      if (x >= f.minX && x <= f.maxX && z >= f.minZ && z <= f.maxZ) return false
    }
    for (const w of this.waterAreas) {
      if (
        x >= Math.min(w.min.x, w.max.x) &&
        x <= Math.max(w.min.x, w.max.x) &&
        z >= Math.min(w.min.z, w.max.z) &&
        z <= Math.max(w.min.z, w.max.z)
      ) {
        return true
      }
    }
    return false
  }

  // ------------------------------------------------------------------
  // Circle (cylinder) vs boxes — sliding resolution
  // ------------------------------------------------------------------

  /**
   * Resolve a vertical cylinder against all nearby boxes.
   * MUTATES `pos` to the resolved position (slid out along the minimum
   * penetration axis). Vertical overlap test: cylinder spans
   * [pos.y, pos.y + height].
   */
  collideCircle(
    pos: { x: number; y: number; z: number },
    radius: number,
    height: number,
    includeDynamic = true,
  ): CollisionHit {
    const result: CollisionHit = { hit: false, nx: 0, nz: 0, depth: 0 }
    // Two resolution passes handle corner cases (two walls) gracefully.
    for (let pass = 0; pass < 2; pass++) {
      let bestDepth = 0
      let bestNx = 0
      let bestNz = 0
      let anyHit = false

      const candidates = this.gatherCandidates(
        pos.x - radius,
        pos.z - radius,
        pos.x + radius,
        pos.z + radius,
      )
      const testBox = (
        b: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number },
      ) => {
        // Vertical overlap?
        if (pos.y + height <= b.minY || pos.y >= b.maxY) return
        // Horizontal closest point on box to circle center.
        const cx = Math.max(b.minX, Math.min(pos.x, b.maxX))
        const cz = Math.max(b.minZ, Math.min(pos.z, b.maxZ))
        const dx = pos.x - cx
        const dz = pos.z - cz
        const distSq = dx * dx + dz * dz
        if (distSq >= radius * radius) return

        let nx: number
        let nz: number
        let depth: number
        if (distSq > 1e-9) {
          // Center outside the box in XZ: push away from the closest point.
          const dist = Math.sqrt(distSq)
          nx = dx / dist
          nz = dz / dist
          depth = radius - dist
        } else {
          // Center inside the box: push out along the min-penetration axis.
          const penLeft = pos.x - b.minX // distance to -X face
          const penRight = b.maxX - pos.x
          const penBack = pos.z - b.minZ
          const penFront = b.maxZ - pos.z
          const minPen = Math.min(penLeft, penRight, penBack, penFront)
          if (minPen === penLeft) {
            nx = -1
            nz = 0
            depth = penLeft + radius
          } else if (minPen === penRight) {
            nx = 1
            nz = 0
            depth = penRight + radius
          } else if (minPen === penBack) {
            nx = 0
            nz = -1
            depth = penBack + radius
          } else {
            nx = 0
            nz = 1
            depth = penFront + radius
          }
        }
        anyHit = true
        if (depth > bestDepth) {
          bestDepth = depth
          bestNx = nx
          bestNz = nz
        }
      }

      for (const b of candidates) testBox(b)
      if (includeDynamic) for (const b of this.dynamicBoxes) testBox(b)

      if (!anyHit) break
      // Slide: push out along the normal; tangential motion is preserved
      // because we only remove the normal component of the position.
      pos.x += bestNx * bestDepth
      pos.z += bestNz * bestDepth
      result.hit = true
      result.nx = bestNx
      result.nz = bestNz
      result.depth = Math.max(result.depth, bestDepth)
    }
    return result
  }

  // ------------------------------------------------------------------
  // Analytic raycast (slab method)
  // ------------------------------------------------------------------

  /**
   * Ray vs all static + dynamic AABBs. `dir` must be normalized.
   * Returns the closest hit within maxDist or null. Allocation-free.
   */
  raycast(origin: Vec3, dir: Vec3, maxDist: number, includeDynamic = true): RayHit | null {
    let bestT = maxDist
    let bestBox: (StaticBox | DynamicBox) | null = null
    let bestKind: 'building' | 'vehicle' = 'building'
    let bestNormal: Vec3 = { x: 0, y: 1, z: 0 }

    const testBox = (b: StaticBox | DynamicBox, kind: 'building' | 'vehicle') => {
      // Slab test.
      let tmin = 0
      let tmax = bestT
      let axis = 0 // 0=x,1=y,2=z
      let sign = 1
      const o = [origin.x, origin.y, origin.z]
      const d = [dir.x, dir.y, dir.z]
      const bmin = [b.minX, b.minY, b.minZ]
      const bmax = [b.maxX, b.maxY, b.maxZ]
      for (let a = 0; a < 3; a++) {
        if (Math.abs(d[a]) < 1e-9) {
          if (o[a] < bmin[a] || o[a] > bmax[a]) return
          continue
        }
        const inv = 1 / d[a]
        let t1 = (bmin[a] - o[a]) * inv
        let t2 = (bmax[a] - o[a]) * inv
        let s = -1
        if (t1 > t2) {
          const tmp = t1
          t1 = t2
          t2 = tmp
          s = 1
        }
        if (t1 > tmin) {
          tmin = t1
          axis = a
          sign = s
        }
        if (t2 < tmax) tmax = t2
        if (tmin > tmax) return
      }
      if (tmin < bestT && tmin >= 0 && tmin <= maxDist) {
        bestT = tmin
        bestBox = b
        bestKind = kind
        bestNormal = { x: 0, y: 0, z: 0 }
        if (axis === 0) bestNormal.x = sign
        else if (axis === 1) bestNormal.y = sign
        else bestNormal.z = sign
      }
    }

    // Broadphase: walk the ray through grid cells, test each unique box.
    const visited = new Set<StaticBox>()
    const steps = Math.ceil(maxDist / CELL) + 1
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * maxDist
      const px = origin.x + dir.x * t
      const pz = origin.z + dir.z * t
      const key = `${Math.floor(px / CELL)},${Math.floor(pz / CELL)}`
      const arr = this.grid.get(key)
      if (!arr) continue
      for (const b of arr) {
        if (visited.has(b)) continue
        visited.add(b)
        testBox(b, 'building')
      }
    }
    if (includeDynamic) {
      for (const b of this.dynamicBoxes) testBox(b, 'vehicle')
    }

    // TS can't track assignments made inside the testBox closure —
    // re-widen the narrowed type explicitly.
    const hitBox = bestBox as StaticBox | DynamicBox | null
    if (!hitBox) return null
    return {
      distance: bestT,
      point: {
        x: origin.x + dir.x * bestT,
        y: origin.y + dir.y * bestT,
        z: origin.z + dir.z * bestT,
      },
      normal: bestNormal,
      boxId: hitBox.id,
      kind: bestKind,
    }
  }

  // ------------------------------------------------------------------
  // Spatial hash internals
  // ------------------------------------------------------------------

  private forEachGridCell(
    b: { minX: number; minZ: number; maxX: number; maxZ: number },
    fn: (key: string) => void,
  ): void {
    const x0 = Math.floor(b.minX / CELL)
    const x1 = Math.floor(b.maxX / CELL)
    const z0 = Math.floor(b.minZ / CELL)
    const z1 = Math.floor(b.maxZ / CELL)
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) fn(`${x},${z}`)
    }
  }

  private gatherCandidates(
    minX: number,
    minZ: number,
    maxX: number,
    maxZ: number,
  ): StaticBox[] {
    const out: StaticBox[] = []
    const seen = new Set<StaticBox>()
    const x0 = Math.floor(minX / CELL)
    const x1 = Math.floor(maxX / CELL)
    const z0 = Math.floor(minZ / CELL)
    const z1 = Math.floor(maxZ / CELL)
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const arr = this.grid.get(`${x},${z}`)
        if (!arr) continue
        for (const b of arr) {
          if (seen.has(b)) continue
          seen.add(b)
          out.push(b)
        }
      }
    }
    return out
  }

  private rebuildGrid(): void {
    this.grid.clear()
    for (const b of this.staticBoxes) {
      this.forEachGridCell(b, (key) => {
        let arr = this.grid.get(key)
        if (!arr) {
          arr = []
          this.grid.set(key, arr)
        }
        arr.push(b)
      })
    }
  }
}
