/**
 * CityBuilder — deterministic procedural city generation per 100×100 m
 * chunk + distinctive authored buildings from LevelData.
 *
 * Every chunk gets:
 *   - grid roads along its south & west borders (12 m wide, canvas lane
 *     markings), intersection patches, 3 m sidewalk ring,
 *   - 2–6 procedural buildings (type-driven: urban towers with emissive
 *     windows / residential houses with pyramid roofs / industrial
 *     warehouses & silos / harbor cranes & container stacks),
 *   - street lamps every 50 m (emissive heads; nearest 8 get real
 *     PointLights via Lighting pool),
 *   - trees in residential chunks,
 *   - a merged low-poly LOD1 mesh (vertex-colored boxes) for 150–400 m,
 *   - static AABB colliders registered with the PhysicsWorld.
 *
 * Authored buildings (Police Station, Bank, Hospital, ...) always spawn
 * in the chunk containing them, with type-specific meshes and a floating
 * name label — the original docs promised building names and never
 * delivered them.
 */
import * as THREE from 'three'
import type { BuildingData, LevelData } from '@/game/types'
import type { StaticBox } from '../physics/PhysicsWorld'
import { mergeBoxes, type MergeBox } from './merge'
import { chunkSeed, mulberry32, pick, randInt, randRange } from './rng'
import { WorldAssets, makeLabelSprite } from './textures'

export const CHUNK_SIZE = 100
export const ROAD_HALF_WIDTH = 6 // grid roads are 12 m wide, centered on borders
export const SIDEWALK_BAND = 3 // sidewalk strip width
export const SIDEWALK_INNER = ROAD_HALF_WIDTH + SIDEWALK_BAND // 9 m from chunk edge
export const PLOT_INSET = 12 // buildings start 12 m in (sidewalk margin + buffer)
export const LOD0_DISTANCE = 150
export const LOD1_DISTANCE = 400

export interface ChunkLabel {
  sprite: THREE.Sprite
  position: THREE.Vector3
}

export interface ChunkBuild {
  group: THREE.Group
  lod1: THREE.Mesh
  labels: ChunkLabel[]
  lampHeads: THREE.Vector3[]
  colliders: StaticBox[]
  colliderPrefix: string
  bounds: THREE.Box3
}

type LevelKind = 'urban' | 'residential' | 'industrial' | 'harbor'

function levelKind(level: LevelData): LevelKind {
  const t = `${level.type} ${level.id}`.toLowerCase()
  if (t.includes('harbor') || t.includes('port')) return 'harbor'
  if (t.includes('industr')) return 'industrial'
  if (t.includes('resident')) return 'residential'
  return 'urban'
}

interface PlacedRect {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

export function buildChunk(
  cx: number,
  cz: number,
  level: LevelData,
  assets: WorldAssets,
  authored: BuildingData[],
  /** Rects to keep clear of procedural buildings (e.g. parked vehicles). */
  reserved: PlacedRect[] = [],
): ChunkBuild {
  const rng = mulberry32(chunkSeed(cx, cz, level.id))
  const x0 = cx * CHUNK_SIZE
  const z0 = cz * CHUNK_SIZE
  const x1 = x0 + CHUNK_SIZE
  const z1 = z0 + CHUNK_SIZE
  const kind = levelKind(level)
  const maxCx = Math.max(1, Math.round(level.sizeX / CHUNK_SIZE)) - 1
  const maxCz = Math.max(1, Math.round(level.sizeZ / CHUNK_SIZE)) - 1

  const group = new THREE.Group()
  group.name = `chunk_${cx}_${cz}`
  const labels: ChunkLabel[] = []
  const lampHeads: THREE.Vector3[] = []
  const colliders: StaticBox[] = []
  const colliderPrefix = `chunk:${cx}:${cz}:`
  const mergeList: MergeBox[] = []
  let topY = 20

  // ---- water awareness ------------------------------------------------
  // Chunks that are mostly water (harbor ocean strip) get NO roads /
  // sidewalks / lamps / procedural buildings — only authored buildings
  // (harbor cranes legitimately stand in the water). Partially-wet
  // chunks keep everything but reserve the water rect against builds.
  const waterRects = level.waterAreas
    .map((a) => ({
      minX: Math.min(a.min.x, a.max.x),
      maxX: Math.max(a.min.x, a.max.x),
      minZ: Math.min(a.min.z, a.max.z),
      maxZ: Math.max(a.min.z, a.max.z),
    }))
    .filter((w) => w.maxX > x0 && w.minX < x1 && w.maxZ > z0 && w.minZ < z1)
  let waterArea = 0
  for (const w of waterRects) {
    waterArea +=
      (Math.min(w.maxX, x1) - Math.max(w.minX, x0)) *
      (Math.min(w.maxZ, z1) - Math.max(w.minZ, z0))
  }
  const waterFraction = waterArea / (CHUNK_SIZE * CHUNK_SIZE)
  const waterChunk = waterFraction >= 0.5

  const box = assets.unitBox
  const cyl = assets.unitCyl
  const pyramid = assets.pyramid

  /** Add a scaled unit-box mesh. */
  const addBox = (
    mat: THREE.Material,
    px: number,
    py: number,
    pz: number,
    sx: number,
    sy: number,
    sz: number,
    castShadow = true,
  ): THREE.Mesh => {
    const m = new THREE.Mesh(box, mat)
    m.position.set(px, py, pz)
    m.scale.set(sx, sy, sz)
    m.castShadow = castShadow
    m.receiveShadow = false
    group.add(m)
    return m
  }
  const addCyl = (
    mat: THREE.Material,
    px: number,
    py: number,
    pz: number,
    diameter: number,
    height: number,
    castShadow = true,
  ): THREE.Mesh => {
    const m = new THREE.Mesh(cyl, mat)
    m.position.set(px, py, pz)
    m.scale.set(diameter, height, diameter)
    m.castShadow = castShadow
    group.add(m)
    return m
  }
  const pushCollider = (id: string, px: number, py: number, pz: number, sx: number, sy: number, sz: number) => {
    colliders.push({
      id: colliderPrefix + id,
      minX: px - sx / 2,
      maxX: px + sx / 2,
      minY: py - sy / 2,
      maxY: py + sy / 2,
      minZ: pz - sz / 2,
      maxZ: pz + sz / 2,
    })
  }

  // ==================================================================
  // ROADS + SIDEWALKS (skipped in mostly-water chunks)
  // ==================================================================
  const roadMat = assets.roadMat()
  const roadGeo = new THREE.PlaneGeometry(CHUNK_SIZE, ROAD_HALF_WIDTH * 2)
  roadGeo.rotateX(-Math.PI / 2)

  const addRoad = (px: number, pz: number, alongZ: boolean) => {
    const m = new THREE.Mesh(roadGeo, roadMat)
    m.position.set(px, 0.02, pz)
    if (alongZ) m.rotateY(Math.PI / 2)
    m.receiveShadow = true
    group.add(m)
  }
  if (!waterChunk) {
    addRoad(x0 + CHUNK_SIZE / 2, z0, false) // south
    addRoad(x0, z0 + CHUNK_SIZE / 2, true) // west
    if (cz === maxCz) addRoad(x0 + CHUNK_SIZE / 2, z1, false) // level north edge
    if (cx === maxCx) addRoad(x1, z0 + CHUNK_SIZE / 2, true) // level east edge
  }

  // Intersection patches (plain asphalt, no markings crossing).
  const patchMat = assets.asphaltPatchMat()
  const patch = (px: number, pz: number) => {
    addBox(patchMat, px, 0.035, pz, ROAD_HALF_WIDTH * 2 + 0.8, 0.07, ROAD_HALF_WIDTH * 2 + 0.8, false)
  }
  if (!waterChunk) {
    patch(x0, z0)
    if (cx === maxCx) patch(x1, z0)
    if (cz === maxCz) patch(x0, z1)
    if (cx === maxCx && cz === maxCz) patch(x1, z1)
  }

  // Sidewalk ring (3 m band inside each edge, 5 cm above ground).
  const swMat = assets.sidewalkMat()
  const wIn = ROAD_HALF_WIDTH
  const wOut = SIDEWALK_INNER
  const eIn = CHUNK_SIZE - SIDEWALK_INNER
  const eOut = CHUNK_SIZE - ROAD_HALF_WIDTH
  const swY = 0.05
  if (!waterChunk) {
    addBox(swMat, x0 + (wIn + wOut) / 2, swY, z0 + CHUNK_SIZE / 2, wOut - wIn, 0.1, CHUNK_SIZE, false).receiveShadow = true
    addBox(swMat, x0 + (eIn + eOut) / 2, swY, z0 + CHUNK_SIZE / 2, eOut - eIn, 0.1, CHUNK_SIZE, false).receiveShadow = true
    addBox(swMat, x0 + (wOut + eOut) / 2, swY, z0 + (wIn + wOut) / 2, eOut - wOut, 0.1, wOut - wIn, false).receiveShadow = true
    addBox(swMat, x0 + (wOut + eOut) / 2, swY, z0 + (eIn + eOut) / 2, eOut - wOut, 0.1, eOut - eIn, false).receiveShadow = true
  }

  // ==================================================================
  // STREET LAMPS (2 on south road, 2 on west road, every ~50 m)
  // ==================================================================
  const poleMat = assets.darkConcreteMat()
  const headMat = assets.lampHeadMat()
  const addLamp = (px: number, pz: number, armDirX: number, armDirZ: number) => {
    addCyl(poleMat, px, 2.4, pz, 0.16, 4.8, false)
    addBox(poleMat, px + armDirX * 0.75, 4.7, pz + armDirZ * 0.75, armDirZ !== 0 ? 1.5 : 0.18, 0.14, armDirX !== 0 ? 1.5 : 0.18, false)
    const head = addBox(headMat, px + armDirX * 1.4, 4.62, pz + armDirZ * 1.4, 0.6, 0.16, 0.34, false)
    head.receiveShadow = false
    lampHeads.push(new THREE.Vector3(px + armDirX * 1.4, 4.55, pz + armDirZ * 1.4))
  }
  if (!waterChunk) {
    addLamp(x0 + 30, z0 + ROAD_HALF_WIDTH + 1, 0, -1)
    addLamp(x0 + 70, z0 + ROAD_HALF_WIDTH + 1, 0, -1)
    addLamp(x0 + ROAD_HALF_WIDTH + 1, z0 + 30, -1, 0)
    addLamp(x0 + ROAD_HALF_WIDTH + 1, z0 + 70, -1, 0)
  }

  // ==================================================================
  // PROCEDURAL BUILDINGS
  // ==================================================================
  const placed: PlacedRect[] = []
  // Reserve space around authored buildings (they always spawn), any
  // reserved rects (vehicle spawn spots, traffic markers...), and the
  // water portions of partially-wet chunks.
  for (const b of authored) {
    placed.push({
      minX: b.position.x - b.size.x / 2 - 4,
      maxX: b.position.x + b.size.x / 2 + 4,
      minZ: b.position.z - b.size.z / 2 - 4,
      maxZ: b.position.z + b.size.z / 2 + 4,
    })
  }
  for (const r of reserved) placed.push(r)
  if (waterFraction > 0) {
    for (const w of waterRects) {
      placed.push({
        minX: Math.max(w.minX, x0),
        maxX: Math.min(w.maxX, x1),
        minZ: Math.max(w.minZ, z0),
        maxZ: Math.min(w.maxZ, z1),
      })
    }
  }
  const overlaps = (r: PlacedRect, margin = 2): boolean =>
    placed.some(
      (p) =>
        r.minX - margin < p.maxX &&
        r.maxX + margin > p.minX &&
        r.minZ - margin < p.maxZ &&
        r.maxZ + margin > p.minZ,
    )

  const buildingCount = waterChunk ? 0 : randInt(rng, 2, 6)
  let procIndex = 0
  for (let i = 0; i < buildingCount; i++) {
    // Attempt a few placements per building.
    for (let attempt = 0; attempt < 8; attempt++) {
      const w = randRange(rng, 14, kind === 'industrial' ? 46 : 30)
      const d = randRange(rng, 14, kind === 'industrial' ? 36 : 30)
      const px = randRange(rng, x0 + PLOT_INSET, x1 - PLOT_INSET - w)
      const pz = randRange(rng, z0 + PLOT_INSET, z1 - PLOT_INSET - d)
      const rect: PlacedRect = { minX: px, maxX: px + w, minZ: pz, maxZ: pz + d }
      if (overlaps(rect)) continue
      placed.push(rect)
      const id = `proc${procIndex++}`
      switch (kind) {
        case 'urban':
          buildUrbanTower(assets, group, mergeList, colliders, colliderPrefix, id, px, pz, w, d, rng, () => {
            topY = Math.max(topY, 62)
          })
          break
        case 'residential':
          buildHouse(assets, group, mergeList, colliders, colliderPrefix, id, px, pz, w, d, rng, () => {
            topY = Math.max(topY, 14)
          })
          break
        case 'industrial':
          buildWarehouse(assets, group, mergeList, colliders, colliderPrefix, id, px, pz, w, d, rng, () => {
            topY = Math.max(topY, 28)
          })
          break
        case 'harbor': {
          const r = rng()
          if (r < 0.4) {
            buildContainerStack(assets, group, mergeList, colliders, colliderPrefix, id, px, pz, w, d, rng, () => {
              topY = Math.max(topY, 10)
            })
          } else if (r < 0.62) {
            buildCrane(assets, group, mergeList, colliders, colliderPrefix, id, px + w / 2, pz + d / 2, rng, () => {
              topY = Math.max(topY, 46)
            })
          } else {
            buildWarehouse(assets, group, mergeList, colliders, colliderPrefix, id, px, pz, Math.min(w, 30), Math.min(d, 24), rng, () => {
              topY = Math.max(topY, 14)
            })
          }
          break
        }
      }
      break
    }
  }

  // Trees for residential (and a couple in urban) — never in water chunks.
  if (!waterChunk && (kind === 'residential' || (kind === 'urban' && rng() < 0.5))) {
    const treeCount = kind === 'residential' ? randInt(rng, 3, 6) : randInt(rng, 1, 2)
    const trunkMat = assets.trunkMat()
    const foliage = assets.foliageMats()
    for (let t = 0; t < treeCount; t++) {
      const tx = randRange(rng, x0 + PLOT_INSET - 2, x1 - PLOT_INSET + 2)
      const tz = randRange(rng, z0 + PLOT_INSET - 2, z1 - PLOT_INSET + 2)
      const rect: PlacedRect = { minX: tx - 1.2, maxX: tx + 1.2, minZ: tz - 1.2, maxZ: tz + 1.2 }
      if (overlaps(rect, 0.5)) continue
      const h = randRange(rng, 2.4, 3.6)
      addCyl(trunkMat, tx, h * 0.35, tz, 0.26, h * 0.7, false)
      const f = new THREE.Mesh(assets.unitSphere, pick(rng, foliage))
      f.position.set(tx, h * 0.95, tz)
      f.scale.setScalar(randRange(rng, 1.8, 2.7))
      group.add(f)
      // No collision for trees (cheap) — documented limitation.
    }
  }

  // ==================================================================
  // AUTHORED BUILDINGS (always spawn)
  // ==================================================================
  authored.forEach((b, i) => {
    topY = Math.max(topY, b.size.y + 6)
    buildAuthoredBuilding(assets, group, mergeList, colliders, colliderPrefix, `auth${i}`, b, labels)
  })

  // LOD1 — merged low-poly geometry (base road plate skipped for water
  // chunks; a hidden submerged micro-box keeps the geometry non-empty).
  if (!waterChunk) {
    mergeList.push({
      x: x0 + CHUNK_SIZE / 2,
      y: 0.03,
      z: z0 + CHUNK_SIZE / 2,
      sx: CHUNK_SIZE,
      sy: 0.06,
      sz: CHUNK_SIZE,
      color: new THREE.Color(0x2a2a2f), // road/base tone
    })
  } else if (mergeList.length === 0) {
    mergeList.push({ x: x0 + 50, y: -6, z: z0 + 50, sx: 0.01, sy: 0.01, sz: 0.01, color: new THREE.Color(0) })
  }
  const lod1Geo = mergeBoxes(mergeList)
  const lod1 = new THREE.Mesh(lod1Geo, assets.lod1Mat())
  lod1.visible = false
  group.add(lod1)

  return {
    group,
    lod1,
    labels,
    lampHeads,
    colliders,
    colliderPrefix,
    bounds: new THREE.Box3(
      new THREE.Vector3(x0, 0, z0),
      new THREE.Vector3(x1, topY, z1),
    ),
  }
}

// ====================================================================
// Procedural building constructors (shared by chunk builder)
// ====================================================================

type TopYNotifier = () => void

function buildUrbanTower(
  assets: WorldAssets,
  group: THREE.Group,
  mergeList: MergeBox[],
  colliders: StaticBox[],
  prefix: string,
  id: string,
  px: number,
  pz: number,
  w: number,
  d: number,
  rng: () => number,
  notifyTop: TopYNotifier,
): void {
  const h = randRange(rng, 20, 60)
  const facade = assets.facadeMat(randInt(rng, 0, 2))
  const cx = px + w / 2
  const cz = pz + d / 2
  const body = new THREE.Mesh(assets.unitBox, facade)
  body.position.set(cx, h / 2, cz)
  body.scale.set(w, h, d)
  body.castShadow = true
  group.add(body)
  // rooftop unit + antenna
  const concrete = assets.concreteMat()
  const roof = new THREE.Mesh(assets.unitBox, concrete)
  roof.position.set(cx + randRange(rng, -w * 0.2, w * 0.2), h + 0.8, cz + randRange(rng, -d * 0.2, d * 0.2))
  roof.scale.set(w * 0.3, 1.6, d * 0.3)
  roof.castShadow = true
  group.add(roof)
  if (h > 40) {
    const ant = new THREE.Mesh(assets.unitCyl, assets.darkConcreteMat())
    ant.position.set(cx, h + 3, cz)
    ant.scale.set(0.14, 6, 0.14)
    group.add(ant)
  }
  colliders.push({
    id: prefix + id,
    minX: px,
    maxX: px + w,
    minY: 0,
    maxY: h,
    minZ: pz,
    maxZ: pz + d,
  })
  mergeList.push({ x: cx, y: h / 2, z: cz, sx: w, sy: h, sz: d, color: new THREE.Color(0x4c5158) })
  notifyTop()
}

function buildHouse(
  assets: WorldAssets,
  group: THREE.Group,
  mergeList: MergeBox[],
  colliders: StaticBox[],
  prefix: string,
  id: string,
  px: number,
  pz: number,
  w: number,
  d: number,
  rng: () => number,
  notifyTop: TopYNotifier,
): void {
  const h = randRange(rng, 4.5, 8)
  const cx = px + w / 2
  const cz = pz + d / 2
  const wallColors = [0xb3a08a, 0xa89a86, 0x9c8f7a, 0xb08e77, 0xc4b49c]
  const wallMat = assets.mat(`house${randInt(rng, 0, wallColors.length - 1)}`, () =>
    new THREE.MeshStandardMaterial({ color: wallColors[randInt(rng, 0, wallColors.length - 1)], roughness: 0.95 }),
  )
  const body = new THREE.Mesh(assets.unitBox, wallMat)
  body.position.set(cx, h / 2, cz)
  body.scale.set(w, h, d)
  body.castShadow = true
  group.add(body)
  // pitched-ish roof: 4-sided pyramid
  const roofColors = [0x6e4a38, 0x5d4436, 0x7a5240]
  const roofMat = assets.mat(`roof${randInt(rng, 0, 2)}`, () =>
    new THREE.MeshStandardMaterial({ color: roofColors[randInt(rng, 0, 2)], roughness: 1 }),
  )
  const roof = new THREE.Mesh(assets.pyramid, roofMat)
  const rw = w * 1.08
  const rd = d * 1.08
  // ConeGeometry(0.707,1,4) rotated 45°: base spans 1×1 after rotation? No —
  // radius SQRT1_2 with 4 segments gives a unit-square base footprint.
  roof.scale.set(rw, randRange(rng, 2.5, 4), rd)
  roof.position.set(cx, h + roof.scale.y / 2 - 0.05, cz)
  roof.castShadow = true
  group.add(roof)
  // door
  const door = new THREE.Mesh(assets.unitBox, assets.darkConcreteMat())
  door.position.set(cx, 1.05, pz - 0.06)
  door.scale.set(1.1, 2.1, 0.14)
  group.add(door)
  colliders.push({
    id: prefix + id,
    minX: px,
    maxX: px + w,
    minY: 0,
    maxY: h + 3,
    minZ: pz,
    maxZ: pz + d,
  })
  mergeList.push({ x: cx, y: h / 2, z: cz, sx: w, sy: h, sz: d, color: new THREE.Color(0xa89a86) })
  mergeList.push({ x: cx, y: h + 1.4, z: cz, sx: rw * 0.7, sy: 2.8, sz: rd * 0.7, color: new THREE.Color(0x6e4a38) })
  notifyTop()
}

function buildWarehouse(
  assets: WorldAssets,
  group: THREE.Group,
  mergeList: MergeBox[],
  colliders: StaticBox[],
  prefix: string,
  id: string,
  px: number,
  pz: number,
  w: number,
  d: number,
  rng: () => number,
  notifyTop: TopYNotifier,
): void {
  const h = randRange(rng, 9, 22)
  const cx = px + w / 2
  const cz = pz + d / 2
  const mats = [0x62666b, 0x6d6a62, 0x575d5f, 0x716c60]
  const bodyMat = assets.mat(`ware${randInt(rng, 0, 3)}`, () =>
    new THREE.MeshStandardMaterial({ color: mats[randInt(rng, 0, 3)], roughness: 0.9, metalness: 0.1 }),
  )
  const body = new THREE.Mesh(assets.unitBox, bodyMat)
  body.position.set(cx, h / 2, cz)
  body.scale.set(w, h, d)
  body.castShadow = true
  group.add(body)
  // roof ridges
  const ridge = new THREE.Mesh(assets.unitBox, assets.darkConcreteMat())
  ridge.position.set(cx, h + 0.5, cz)
  ridge.scale.set(w * 0.5, 1, d * 0.5)
  ridge.castShadow = true
  group.add(ridge)
  // loading door
  const door = new THREE.Mesh(assets.unitBox, assets.darkConcreteMat())
  door.position.set(px - 0.06, 2.2, cz)
  door.scale.set(0.14, 4.4, Math.min(d * 0.4, 8))
  group.add(door)
  // silo sometimes
  if (rng() < 0.35) {
    const siloH = randRange(rng, 9, 15)
    const silo = new THREE.Mesh(assets.unitCyl, assets.concreteMat())
    silo.position.set(px + w + 1.6, siloH / 2, pz + 1.6)
    silo.scale.set(3.4, siloH, 3.4)
    silo.castShadow = true
    group.add(silo)
  }
  colliders.push({
    id: prefix + id,
    minX: px,
    maxX: px + w,
    minY: 0,
    maxY: h,
    minZ: pz,
    maxZ: pz + d,
  })
  mergeList.push({ x: cx, y: h / 2, z: cz, sx: w, sy: h, sz: d, color: new THREE.Color(0x62666b) })
  notifyTop()
}

function buildContainerStack(
  assets: WorldAssets,
  group: THREE.Group,
  mergeList: MergeBox[],
  colliders: StaticBox[],
  prefix: string,
  id: string,
  px: number,
  pz: number,
  w: number,
  d: number,
  rng: () => number,
  notifyTop: TopYNotifier,
): void {
  const mats = assets.containerMats()
  const stacks = randInt(rng, 2, 4)
  let maxTop = 0
  for (let s = 0; s < stacks; s++) {
    const sx = px + randRange(rng, 0, Math.max(0.1, w - 6.4))
    const sz = pz + randRange(rng, 0, Math.max(0.1, d - 6.4))
    const count = randInt(rng, 1, 3)
    for (let c = 0; c < count; c++) {
      const yaw = randRange(rng, -0.07, 0.07)
      const m = new THREE.Mesh(assets.unitBox, pick(rng, mats))
      m.position.set(sx + 3.1, 1.3 + c * 2.6, sz + 3.1)
      m.scale.set(6.2, 2.6, 2.5)
      m.rotation.y = yaw
      m.castShadow = true
      group.add(m)
      maxTop = Math.max(maxTop, 1.3 + c * 2.6 + 1.3)
    }
  }
  colliders.push({
    id: prefix + id,
    minX: px,
    maxX: px + Math.min(w, 12),
    minY: 0,
    maxY: Math.max(maxTop, 2.6),
    minZ: pz,
    maxZ: pz + Math.min(d, 12),
  })
  mergeList.push({ x: px + Math.min(w, 12) / 2, y: 2.6, z: pz + Math.min(d, 12) / 2, sx: Math.min(w, 12), sy: 5.2, sz: Math.min(d, 12), color: new THREE.Color(0x8a3b2e) })
  notifyTop()
}

function buildCrane(
  assets: WorldAssets,
  group: THREE.Group,
  mergeList: MergeBox[],
  colliders: StaticBox[],
  prefix: string,
  id: string,
  cx: number,
  cz: number,
  rng: () => number,
  notifyTop: TopYNotifier,
): void {
  const steel = assets.mat('steel', () =>
    new THREE.MeshStandardMaterial({ color: 0xb08e2e, roughness: 0.7, metalness: 0.3 }),
  )
  const dark = assets.darkConcreteMat()
  const mastH = randRange(rng, 34, 44)
  // 4 legs
  for (const [lx, lz] of [
    [-2.4, -2.4],
    [2.4, -2.4],
    [-2.4, 2.4],
    [2.4, 2.4],
  ]) {
    const leg = new THREE.Mesh(assets.unitBox, steel)
    leg.position.set(cx + lx, 6, cz + lz)
    leg.scale.set(1.1, 12, 1.1)
    leg.castShadow = true
    group.add(leg)
  }
  // mast
  const mast = new THREE.Mesh(assets.unitBox, steel)
  mast.position.set(cx, 12 + mastH / 2, cz)
  mast.scale.set(2, mastH, 2)
  mast.castShadow = true
  group.add(mast)
  // horizontal arm
  const armLen = randRange(rng, 22, 30)
  const armDir = rng() < 0.5 ? 1 : -1
  const arm = new THREE.Mesh(assets.unitBox, steel)
  arm.position.set(cx + (armDir * armLen) / 2 + armDir * 1, 12 + mastH - 1, cz)
  arm.scale.set(armLen, 1.6, 1.6)
  arm.castShadow = true
  group.add(arm)
  // counterweight
  const cw = new THREE.Mesh(assets.unitBox, dark)
  cw.position.set(cx - armDir * 3.5, 12 + mastH - 2.2, cz)
  cw.scale.set(3.4, 2.4, 2.8)
  cw.castShadow = true
  group.add(cw)
  // cab
  const cab = new THREE.Mesh(assets.unitBox, dark)
  cab.position.set(cx + armDir * 2, 12 + mastH - 3.4, cz)
  cab.scale.set(2.2, 2.2, 2.2)
  group.add(cab)
  // hanging cable + hook
  const cable = new THREE.Mesh(assets.unitBox, dark)
  cable.position.set(cx + armDir * armLen * 0.7, 12 + mastH - 8, cz)
  cable.scale.set(0.14, 14, 0.14)
  group.add(cable)

  colliders.push({ id: prefix + id + 'base', minX: cx - 3.2, maxX: cx + 3.2, minY: 0, maxY: 12, minZ: cz - 3.2, maxZ: cz + 3.2 })
  colliders.push({ id: prefix + id + 'mast', minX: cx - 1.4, maxX: cx + 1.4, minY: 0, maxY: 12 + mastH, minZ: cz - 1.4, maxZ: cz + 1.4 })
  mergeList.push({ x: cx, y: 6, z: cz, sx: 5.6, sy: 12, sz: 5.6, color: new THREE.Color(0xb08e2e) })
  mergeList.push({ x: cx, y: 12 + mastH / 2, z: cz, sx: 2.2, sy: mastH, sz: 2.2, color: new THREE.Color(0xb08e2e) })
  mergeList.push({ x: arm.position.x, y: arm.position.y, z: cz, sx: armLen, sy: 1.6, sz: 1.6, color: new THREE.Color(0xb08e2e) })
  notifyTop()
}

// ====================================================================
// Authored building — distinctive mesh by type + floating name label
// ====================================================================

function buildAuthoredBuilding(
  assets: WorldAssets,
  group: THREE.Group,
  mergeList: MergeBox[],
  colliders: StaticBox[],
  prefix: string,
  id: string,
  b: BuildingData,
  labels: ChunkLabel[],
): void {
  const { position: p, size: s } = b
  const w = s.x
  const h = s.y
  const d = s.z
  const cx = p.x
  const cz = p.z
  const type = b.type.toLowerCase()
  const facade = assets.facadeMat(1)

  const addB = (mat: THREE.Material, ox: number, oy: number, oz: number, sx: number, sy: number, sz: number, cast = true) => {
    const m = new THREE.Mesh(assets.unitBox, mat)
    m.position.set(cx + ox, oy, cz + oz)
    m.scale.set(sx, sy, sz)
    m.castShadow = cast
    group.add(m)
    return m
  }

  let baseColor = 0x8d8477
  let bodyMat: THREE.Material = facade

  if (type.includes('police')) {
    bodyMat = assets.mat('auth_police', () => new THREE.MeshStandardMaterial({ color: 0x2e3338, roughness: 0.8 }))
    baseColor = 0x2e3338
    addB(bodyMat, 0, h / 2, 0, w, h, d)
    // gold badge band
    const band = assets.mat('auth_police_band', () => new THREE.MeshStandardMaterial({ color: 0xc9a23f, roughness: 0.5, metalness: 0.4 }))
    addB(band, 0, 3.6, 0, w + 0.5, 1.4, d + 0.5, false)
    // antenna
    const ant = new THREE.Mesh(assets.unitCyl, assets.darkConcreteMat())
    ant.position.set(cx, h + 3, cz)
    ant.scale.set(0.16, 6, 0.16)
    group.add(ant)
    // rooftop light (red emissive)
    const beacon = assets.mat('auth_beacon', () =>
      new THREE.MeshStandardMaterial({ color: 0x5a1616, emissive: new THREE.Color(0xd93a2f), emissiveIntensity: 1.4 }),
    )
    addB(beacon, 0, h + 0.5, 0, 1.2, 0.5, 1.2, false)
  } else if (type.includes('bank')) {
    bodyMat = assets.mat('auth_bank', () => new THREE.MeshStandardMaterial({ color: 0xb5a486, roughness: 0.85 }))
    baseColor = 0xb5a486
    addB(bodyMat, 0, h / 2, 0, w, h, d)
    // columns along the front (south) face
    const colMat = assets.mat('auth_bank_col', () => new THREE.MeshStandardMaterial({ color: 0xd8cbb2, roughness: 0.8 }))
    const nCols = 5
    for (let i = 0; i < nCols; i++) {
      const ox = -w / 2 + (w / (nCols - 1)) * i
      const col = new THREE.Mesh(assets.unitCyl, colMat)
      col.position.set(cx + ox, 5, cz - d / 2 - 1)
      col.scale.set(1.6, 10, 1.6)
      col.castShadow = true
      group.add(col)
    }
    // gold trim
    const trim = assets.mat('auth_bank_trim', () => new THREE.MeshStandardMaterial({ color: 0xc9a23f, roughness: 0.4, metalness: 0.5 }))
    addB(trim, 0, h - 1, 0, w + 0.6, 1.2, d + 0.6, false)
  } else if (type.includes('hospital')) {
    bodyMat = assets.mat('auth_hospital', () => new THREE.MeshStandardMaterial({ color: 0xe8e6e0, roughness: 0.9 }))
    baseColor = 0xe8e6e0
    addB(bodyMat, 0, h / 2, 0, w, h, d)
    // red cross (emissive) on the front
    const cross = assets.mat('auth_hospital_cross', () =>
      new THREE.MeshStandardMaterial({ color: 0xb02020, emissive: new THREE.Color(0xe03a2f), emissiveIntensity: 1.6 }),
    )
    addB(cross, 0, h * 0.68, -d / 2 - 0.1, Math.min(w * 0.5, 9), 2.2, 0.3, false)
    addB(cross, 0, h * 0.68, -d / 2 - 0.1, 2.2, Math.min(w * 0.5, 9), 0.3, false)
    // entrance canopy
    addB(assets.concreteMat(), 0, 3.4, -d / 2 - 2.2, Math.min(w * 0.6, 14), 0.5, 4, false)
  } else if (type.includes('shop') || type.includes('gun')) {
    const shopColors = [0xb0673d, 0x8f8542, 0xa5523f, 0x97743c]
    bodyMat = assets.mat(`auth_shop`, () => new THREE.MeshStandardMaterial({ color: 0xb0673d, roughness: 0.85 }))
    baseColor = 0xb0673d
    addB(bodyMat, 0, h / 2, 0, w, h, d)
    // colored awning strip (angled)
    const awnMat = assets.mat('auth_awning', () => new THREE.MeshStandardMaterial({ color: shopColors[1], roughness: 0.9 }))
    const awn = addB(awnMat, 0, 3.1, -d / 2 - 1.1, w * 0.8, 0.22, 2.6, false)
    awn.rotation.x = -0.42
    // emissive sign
    const sign = assets.mat('auth_shop_sign', () =>
      new THREE.MeshStandardMaterial({ color: 0x3a2e18, emissive: new THREE.Color(0xffc98a), emissiveIntensity: 0 }),
    )
    assets.registerNightMaterial(sign as THREE.MeshStandardMaterial, 0.15, 2.0)
    addB(sign, 0, h - 1.4, -d / 2 - 0.12, w * 0.85, 1.5, 0.24, false)
  } else if (type.includes('crane')) {
    // Authored crane — full gantry-style crane mesh (own precise colliders).
    buildCrane(assets, group, mergeList, colliders, prefix, id, cx, cz, mulberry32(hashName(b.name)), () => {})
    const label = makeLabelSprite(b.name)
    label.position.set(cx, h + 6, cz)
    group.add(label)
    labels.push({ sprite: label, position: label.position.clone() })
    return
  } else if (type.includes('terminal')) {
    bodyMat = assets.mat('auth_terminal', () => new THREE.MeshStandardMaterial({ color: 0x6a6f74, roughness: 0.85 }))
    baseColor = 0x6a6f74
    addB(bodyMat, 0, h / 2, 0, w, h, d)
    // amber loading stripe
    const stripe = assets.mat('auth_terminal_stripe', () =>
      new THREE.MeshStandardMaterial({ color: 0x4a3a14, emissive: new THREE.Color(0xffb45e), emissiveIntensity: 0 }),
    )
    assets.registerNightMaterial(stripe as THREE.MeshStandardMaterial, 0.1, 1.6)
    addB(stripe, 0, 1.6, -d / 2 - 0.12, w * 0.9, 0.9, 0.22, false)
    // container beside
    const cont = assets.containerMats()[0]
    addB(cont, w / 2 + 4, 1.3, 0, 6.2, 2.6, 2.5)
  } else if (type.includes('factory')) {
    bodyMat = assets.mat('auth_factory', () => new THREE.MeshStandardMaterial({ color: 0x6d6a62, roughness: 0.9 }))
    baseColor = 0x6d6a62
    addB(bodyMat, 0, h / 2, 0, w, h, d)
    const chimMat = assets.mat('auth_chimney', () => new THREE.MeshStandardMaterial({ color: 0x7a4a3a, roughness: 0.95 }))
    for (const ox of [-w * 0.25, w * 0.25]) {
      const c = new THREE.Mesh(assets.unitCyl, chimMat)
      c.position.set(cx + ox, h + 4, cz - d * 0.2)
      c.scale.set(2.4, h * 0.55, 2.4)
      c.castShadow = true
      group.add(c)
    }
  } else if (type.includes('gas')) {
    bodyMat = assets.mat('auth_gas', () => new THREE.MeshStandardMaterial({ color: 0xb09a3f, roughness: 0.85 }))
    baseColor = 0xb09a3f
    addB(bodyMat, 0, h / 2, 0, w * 0.5, h, d * 0.5)
    // canopy on poles
    const canopyMat = assets.mat('auth_gas_canopy', () => new THREE.MeshStandardMaterial({ color: 0xd8d2c4, roughness: 0.8 }))
    addB(canopyMat, 0, 5, -d / 2 - 5, w * 1.2, 0.6, 9, false)
    for (const [ox, oz] of [[-w * 0.55, -d / 2 - 9], [w * 0.55, -d / 2 - 9], [-w * 0.55, -d / 2 - 1.5], [w * 0.55, -d / 2 - 1.5]]) {
      const pole = new THREE.Mesh(assets.unitCyl, assets.darkConcreteMat())
      pole.position.set(cx + ox, 2.5, cz + oz)
      pole.scale.set(0.4, 5, 0.4)
      group.add(pole)
    }
    // pumps
    addB(assets.darkConcreteMat(), -w * 0.28, 1.1, -d / 2 - 5, 1, 2.2, 0.8, false)
    addB(assets.darkConcreteMat(), w * 0.28, 1.1, -d / 2 - 5, 1, 2.2, 0.8, false)
  } else {
    // apartment | mall | office | warehouse | parking | default → facade box
    bodyMat = facade
    baseColor = 0x5a5750
    addB(bodyMat, 0, h / 2, 0, w, h, d)
    const roofUnit = new THREE.Mesh(assets.unitBox, assets.concreteMat())
    roofUnit.position.set(cx, h + 0.9, cz)
    roofUnit.scale.set(w * 0.25, 1.8, d * 0.25)
    roofUnit.castShadow = true
    group.add(roofUnit)
  }

  // collider (full footprint) + LOD1 box + name label
  colliders.push({
    id: prefix + id,
    minX: cx - w / 2,
    maxX: cx + w / 2,
    minY: 0,
    maxY: h,
    minZ: cz - d / 2,
    maxZ: cz + d / 2,
  })
  mergeList.push({ x: cx, y: h / 2, z: cz, sx: w, sy: h, sz: d, color: new THREE.Color(baseColor) })

  const label = makeLabelSprite(b.name)
  label.position.set(cx, h + 2.5, cz)
  group.add(label)
  labels.push({ sprite: label, position: label.position.clone() })
}

function hashName(name: string): number {
  let h = 2166136261
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}
