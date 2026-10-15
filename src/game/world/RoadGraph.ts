/**
 * RoadGraph — the traffic/pedestrian navigation graph consumed by
 * Task 2-b's TrafficSystem & NPCManager (A* over these nodes).
 *
 * Nodes live at every grid intersection (roads run along chunk borders
 * every 100 m on both axes) plus the endpoints of authored roads
 * (which handles the diagonal residential road). Edges connect
 * adjacent nodes along road lines.
 */
import type { LevelData, RoadData, Vec3 } from '@/game/types'
import { mulberry32 } from './rng'

export interface RoadNode {
  id: string
  x: number
  z: number
  neighborIds: string[]
}

const key = (x: number, z: number) => `${Math.round(x)},${Math.round(z)}`

export class RoadGraph {
  readonly nodes = new Map<string, RoadNode>()

  constructor(level: LevelData) {
    const addNode = (x: number, z: number): RoadNode => {
      const id = key(x, z)
      let n = this.nodes.get(id)
      if (!n) {
        n = { id, x, z, neighborIds: [] }
        this.nodes.set(id, n)
      }
      return n
    }
    const link = (a: RoadNode, b: RoadNode): void => {
      if (a === b) return
      if (!a.neighborIds.includes(b.id)) a.neighborIds.push(b.id)
      if (!b.neighborIds.includes(a.id)) b.neighborIds.push(a.id)
    }

    // ---- grid intersections ----
    const nx = Math.floor(level.sizeX / 100) // number of 100m cells
    const nz = Math.floor(level.sizeZ / 100)
    for (let gx = 0; gx <= nx; gx++) {
      for (let gz = 0; gz <= nz; gz++) {
        const node = addNode(gx * 100, gz * 100)
        // link west & south neighbors (avoids duplicate edges)
        if (gx > 0) link(node, this.nodes.get(key((gx - 1) * 100, gz * 100))!)
        if (gz > 0) link(node, this.nodes.get(key(gx * 100, (gz - 1) * 100))!)
      }
    }

    // ---- authored roads (incl. diagonals) ----
    for (const road of level.roads as RoadData[]) {
      const a = addNode(road.start.x, road.start.z)
      const b = addNode(road.end.x, road.end.z)
      link(a, b)
      this.authoredSegments.push({
        ax: road.start.x,
        az: road.start.z,
        bx: road.end.x,
        bz: road.end.z,
      })
      // For long straight roads, also chain through intermediate grid
      // nodes so traffic can turn off mid-road.
      this.chainAlongAxis(a, b)
    }
  }

  /** If a and b share an axis, link every grid node between them. */
  private chainAlongAxis(a: RoadNode, b: RoadNode): void {
    if (Math.abs(a.x - b.x) < 1 && Math.abs(a.z - b.z) > 100) {
      const step = Math.sign(b.z - a.z) * 100
      let prev = a
      for (let z = a.z + step; Math.abs(z - b.z) > 1; z += step) {
        const cur = this.getOrCreate(a.x, z)
        this.linkNodes(prev, cur)
        prev = cur
      }
      this.linkNodes(prev, b)
    } else if (Math.abs(a.z - b.z) < 1 && Math.abs(a.x - b.x) > 100) {
      const step = Math.sign(b.x - a.x) * 100
      let prev = a
      for (let x = a.x + step; Math.abs(x - b.x) > 1; x += step) {
        const cur = this.getOrCreate(x, a.z)
        this.linkNodes(prev, cur)
        prev = cur
      }
      this.linkNodes(prev, b)
    }
  }

  private getOrCreate(x: number, z: number): RoadNode {
    return (
      this.nodes.get(key(x, z)) ?? (() => {
        const n: RoadNode = { id: key(x, z), x, z, neighborIds: [] }
        this.nodes.set(n.id, n)
        return n
      })()
    )
  }

  private linkNodes(a: RoadNode, b: RoadNode): void {
    if (a === b) return
    if (!a.neighborIds.includes(b.id)) a.neighborIds.push(b.id)
    if (!b.neighborIds.includes(a.id)) b.neighborIds.push(a.id)
  }

  getNode(id: string): RoadNode | undefined {
    return this.nodes.get(id)
  }

  /** Nearest graph node to a world position. */
  worldToNode(pos: Vec3): RoadNode {
    let best: RoadNode | null = null
    let bestD = Infinity
    for (const n of this.nodes.values()) {
      const dx = n.x - pos.x
      const dz = n.z - pos.z
      const d = dx * dx + dz * dz
      if (d < bestD) {
        bestD = d
        best = n
      }
    }
    if (!best) {
      // Degenerate level without roads — fabricate one at the position.
      best = { id: key(pos.x, pos.z), x: pos.x, z: pos.z, neighborIds: [] }
      this.nodes.set(best.id, best)
    }
    return best
  }

  /** Random node within `radius` meters of pos (falls back to nearest). */
  randomNodeNear(pos: Vec3, radius: number, rng: () => number = Math.random): RoadNode {
    const rSq = radius * radius
    const candidates: RoadNode[] = []
    for (const n of this.nodes.values()) {
      const dx = n.x - pos.x
      const dz = n.z - pos.z
      if (dx * dx + dz * dz <= rSq) candidates.push(n)
    }
    if (candidates.length === 0) return this.worldToNode(pos)
    return candidates[Math.floor(rng() * candidates.length) % candidates.length]
  }

  /** Deterministic RNG helper for traffic systems. */
  static rng(seed: number): () => number {
    return mulberry32(seed)
  }

  /**
   * Is the position on a road (within 7 m of a grid line or an authored
   * road segment)? Used for pedestrian/traffic spawn validation.
   */
  isOnRoad(pos: Vec3): boolean {
    const rx = ((pos.x % 100) + 100) % 100
    const rz = ((pos.z % 100) + 100) % 100
    if (rx <= 7 || rx >= 93 || rz <= 7 || rz >= 93) return true
    // authored segments
    for (const road of this.authoredSegments) {
      if (distToSegmentSq(pos.x, pos.z, road) < 49) return true
    }
    return false
  }

  private readonly authoredSegments: { ax: number; az: number; bx: number; bz: number }[] = []
}

function distToSegmentSq(
  px: number,
  pz: number,
  seg: { ax: number; az: number; bx: number; bz: number },
): number {
  const dx = seg.bx - seg.ax
  const dz = seg.bz - seg.az
  const lenSq = dx * dx + dz * dz
  let t = 0
  if (lenSq > 1e-6) {
    t = ((px - seg.ax) * dx + (pz - seg.az) * dz) / lenSq
    t = Math.max(0, Math.min(1, t))
  }
  const cx = seg.ax + t * dx
  const cz = seg.az + t * dz
  const ex = px - cx
  const ez = pz - cz
  return ex * ex + ez * ez
}
