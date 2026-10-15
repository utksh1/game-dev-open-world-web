/**
 * Tiny geometry merge utility — concatenates transformed box geometries
 * (with per-box vertex colors) into ONE BufferGeometry for chunk LOD1.
 * Hand-rolled instead of importing BufferGeometryUtils to keep the
 * dependency surface minimal; we only ever merge indexed primitives
 * with position + normal attributes.
 */
import * as THREE from 'three'

export interface MergeBox {
  /** Center position. */
  x: number
  y: number
  z: number
  /** Full sizes. */
  sx: number
  sy: number
  sz: number
  color: THREE.Color
  /** Optional yaw rotation (radians). */
  yaw?: number
}

const UNIT_BOX = /* @__PURE__ */ new THREE.BoxGeometry(1, 1, 1)

/**
 * Merge a list of boxes into one geometry with vertex colors.
 * The result owns its attributes (safe to dispose per chunk).
 */
export function mergeBoxes(boxes: MergeBox[]): THREE.BufferGeometry {
  const boxCount = boxes.length
  const vertCount = 24 * boxCount
  const indexCount = 36 * boxCount

  const positions = new Float32Array(vertCount * 3)
  const normals = new Float32Array(vertCount * 3)
  const colors = new Float32Array(vertCount * 3)
  const indices = vertCount > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount)

  const basePos = UNIT_BOX.attributes.position.array as ArrayLike<number>
  const baseNor = UNIT_BOX.attributes.normal.array as ArrayLike<number>
  const baseIdx = UNIT_BOX.index!.array as ArrayLike<number>

  const q = new THREE.Quaternion()
  const up = new THREE.Vector3(0, 1, 0)
  const pos = new THREE.Vector3()
  const nor = new THREE.Vector3()

  for (let b = 0; b < boxCount; b++) {
    const box = boxes[b]
    q.setFromAxisAngle(up, box.yaw ?? 0)
    const vBase = b * 24
    for (let v = 0; v < 24; v++) {
      const src = v * 3
      pos.set(
        basePos[src] * box.sx,
        basePos[src + 1] * box.sy,
        basePos[src + 2] * box.sz,
      )
      pos.applyQuaternion(q)
      positions[(vBase + v) * 3] = pos.x + box.x
      positions[(vBase + v) * 3 + 1] = pos.y + box.y
      positions[(vBase + v) * 3 + 2] = pos.z + box.z

      nor.set(baseNor[src], baseNor[src + 1], baseNor[src + 2])
      nor.applyQuaternion(q)
      normals[(vBase + v) * 3] = nor.x
      normals[(vBase + v) * 3 + 1] = nor.y
      normals[(vBase + v) * 3 + 2] = nor.z

      colors[(vBase + v) * 3] = box.color.r
      colors[(vBase + v) * 3 + 1] = box.color.g
      colors[(vBase + v) * 3 + 2] = box.color.b
    }
    const iBase = b * 36
    const indexOffset = b * 24
    for (let i = 0; i < 36; i++) {
      indices[iBase + i] = baseIdx[i] + indexOffset
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geo.setIndex(new THREE.BufferAttribute(indices, 1))
  geo.computeBoundingSphere()
  geo.computeBoundingBox()
  return geo
}
