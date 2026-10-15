/**
 * Pathfinder — A* over the world's RoadGraph. THE gap fix: the original
 * C++ project allocated a Pathfinder but findPath was NEVER called (dead
 * code). This implementation runs every frame for pedestrian wandering,
 * police pursuit and traffic routing.
 *
 *  - Nodes = grid intersections + authored road endpoints (RoadGraph).
 *  - `findPath(from, to)` returns WORLD positions (start + smoothed
 *    waypoints + destination). Smoothing = string-pulling: intermediate
 *    nodes are dropped when the direct segment is unobstructed (analytic
 *    raycast vs building AABBs when a PhysicsWorld is provided).
 *  - Iteration cap 500; when no path exists (or the cap trips) the
 *    fallback is the straight line [from, to].
 */
import type { Vec3 } from '@/game/types'
import type { RoadGraph, RoadNode } from '@/game/world/RoadGraph'
import type { PhysicsWorld } from '@/game/physics/PhysicsWorld'

const MAX_ITERATIONS = 500

interface AStarRecord {
  node: RoadNode
  g: number
  f: number
  parent: RoadNode | null
  closed: boolean
}

export class Pathfinder {
  private graph: RoadGraph
  private physics: PhysicsWorld | null

  constructor(graph: RoadGraph, physics?: PhysicsWorld) {
    this.graph = graph
    this.physics = physics ?? null
  }

  /** Nearest road node to a world position. */
  nearestNode(pos: Vec3): RoadNode {
    return this.graph.worldToNode(pos)
  }

  /**
   * A* path as world-space waypoints. Always includes `from` and `to`
   * (so callers can walk the raw line on degenerate graphs).
   */
  findPath(from: Vec3, to: Vec3): Vec3[] {
    const start = this.nearestNode(from)
    const goal = this.nearestNode(to)

    // Degenerate: same node (or empty graph) → straight line.
    if (start === goal || start.neighborIds.length === 0) {
      return [{ ...from }, { ...to }]
    }

    const records = new Map<string, AStarRecord>()
    const open: AStarRecord[] = []
    const heuristic = (n: RoadNode): number => Math.hypot(n.x - goal.x, n.z - goal.z)

    const startRec: AStarRecord = { node: start, g: 0, f: heuristic(start), parent: null, closed: false }
    records.set(start.id, startRec)
    open.push(startRec)

    let iterations = 0
    let found: AStarRecord | null = null

    while (open.length > 0 && iterations < MAX_ITERATIONS) {
      iterations++
      // Pop the lowest-f record (linear scan — graphs are ~100 nodes).
      let bestIdx = 0
      for (let i = 1; i < open.length; i++) {
        if (open[i].f < open[bestIdx].f) bestIdx = i
      }
      const current = open.splice(bestIdx, 1)[0]
      if (current.node === goal) {
        found = current
        break
      }
      current.closed = true
      for (const nid of current.node.neighborIds) {
        const nb = this.graph.getNode(nid)
        if (!nb) continue
        const step = Math.hypot(nb.x - current.node.x, nb.z - current.node.z)
        const tentativeG = current.g + step
        let rec = records.get(nb.id)
        if (!rec) {
          rec = { node: nb, g: tentativeG, f: tentativeG + heuristic(nb), parent: current.node, closed: false }
          records.set(nb.id, rec)
          open.push(rec)
        } else if (tentativeG < rec.g) {
          rec.g = tentativeG
          rec.f = tentativeG + heuristic(nb)
          rec.parent = current.node
          if (rec.closed) {
            rec.closed = false
            open.push(rec)
          }
        }
      }
    }

    if (!found) return [{ ...from }, { ...to }] // fallback: straight line

    // ---- reconstruct node chain --------------------------------------
    const chain: RoadNode[] = []
    let cursor: RoadNode | null = found.node
    while (cursor) {
      chain.unshift(cursor)
      const rec = records.get(cursor.id)
      cursor = rec?.parent ?? null
    }

    // ---- world-space waypoints with string-pull smoothing -------------
    const points: Vec3[] = chain.map((n) => ({ x: n.x, y: 0, z: n.z }))
    const smoothed: Vec3[] = [{ ...from }]
    let i = 0
    while (i < points.length) {
      // Furthest point directly reachable from the last kept waypoint.
      let furthest = i
      for (let j = points.length - 1; j > i; j--) {
        if (this.segmentClear(smoothed[smoothed.length - 1], points[j])) {
          furthest = j
          break
        }
      }
      smoothed.push(points[furthest])
      i = furthest + 1
    }
    // Replace the final node with the exact destination.
    smoothed[smoothed.length - 1] = { ...to }
    if (smoothed.length < 2) smoothed.push({ ...to })
    return smoothed
  }

  /** True when the horizontal segment a→b hits no building AABB. */
  private segmentClear(a: Vec3, b: Vec3): boolean {
    const dx = b.x - a.x
    const dz = b.z - a.z
    const len = Math.hypot(dx, dz)
    if (len < 0.01) return true
    if (!this.physics) return true // no obstacle data → assume clear
    const dir = { x: dx / len, y: 0, z: dz / len }
    const origin = { x: a.x, y: 1.0, z: a.z } // chest height ray
    const hit = this.physics.raycast(origin, dir, len + 0.5, false)
    return hit === null
  }
}
