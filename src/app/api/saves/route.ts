import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import type { GarageVehicleSnapshot, SaveGamePayload, SaveGameRecord } from '@/game/types'

export const dynamic = 'force-dynamic'

function toRecord(row: {
  id: string
  slot: number
  playerName: string
  levelId: string
  money: number
  health: number
  armor: number
  xp: number
  wantedLevel: number
  positionX: number
  positionY: number
  positionZ: number
  stateJson: string
  missionsCompletedCount: number
  campaignProgress: number
  playTimeSec: number
  createdAt: Date
  updatedAt: Date
}): SaveGameRecord {
  const state = JSON.parse(row.stateJson || '{}') as Partial<SaveGamePayload>
  return {
    id: row.id,
    slot: row.slot,
    playerName: row.playerName,
    levelId: row.levelId,
    money: row.money,
    health: row.health,
    armor: row.armor,
    xp: row.xp,
    wantedLevel: row.wantedLevel,
    position: { x: row.positionX, y: row.positionY, z: row.positionZ },
    missionsCompleted: state.missionsCompleted ?? [],
    campaignProgress: row.campaignProgress,
    weaponsOwned: state.weaponsOwned ?? ['fists', 'pistol'],
    inventory: state.inventory ?? [],
    garageOwned: state.garageOwned === true,
    garageVehicle: state.garageVehicle ?? null,
    garageBays: typeof state.garageBays === 'number' ? state.garageBays : 1,
    garageSlotsData: Array.isArray(state.garageSlotsData)
      ? (state.garageSlotsData as (GarageVehicleSnapshot | null)[])
      : undefined,
    playTimeSec: row.playTimeSec,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** GET /api/saves — list all save slots (or ?slot=N for one) */
export async function GET(req: NextRequest) {
  const slotParam = req.nextUrl.searchParams.get('slot')
  try {
    if (slotParam !== null) {
      const slot = parseInt(slotParam, 10)
      const row = await db.saveGame.findUnique({ where: { slot } })
      if (!row) return NextResponse.json({ save: null })
      return NextResponse.json({ save: toRecord(row) })
    }
    const rows = await db.saveGame.findMany({ orderBy: { updatedAt: 'desc' } })
    return NextResponse.json({ saves: rows.map(toRecord) })
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to read saves', detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}

/** POST /api/saves — create or update a save slot */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as SaveGamePayload
    if (!body || typeof body.slot !== 'number' || body.slot < 1 || body.slot > 9) {
      return NextResponse.json({ error: 'Invalid save payload: slot 1-9 required' }, { status: 400 })
    }
    const stateJson = JSON.stringify({
      missionsCompleted: body.missionsCompleted ?? [],
      weaponsOwned: body.weaponsOwned ?? ['fists', 'pistol'],
      inventory: body.inventory ?? [],
      garageOwned: body.garageOwned === true,
      garageVehicle: body.garageVehicle ?? null,
      garageBays: body.garageBays,
      garageSlotsData: body.garageSlotsData ?? null,
    })
    const data = {
      slot: body.slot,
      playerName: body.playerName || 'Player',
      levelId: body.levelId || 'downtown',
      money: Math.max(0, Math.round(body.money ?? 500)),
      health: Math.max(0, Math.round(body.health ?? 100)),
      armor: Math.max(0, Math.round(body.armor ?? 0)),
      xp: Math.max(0, Math.round(body.xp ?? 0)),
      wantedLevel: Math.max(0, Math.min(5, Math.round(body.wantedLevel ?? 0))),
      positionX: body.position?.x ?? 500,
      positionY: body.position?.y ?? 0,
      positionZ: body.position?.z ?? 500,
      stateJson,
      missionsCompletedCount: (body.missionsCompleted ?? []).length,
      campaignProgress: body.campaignProgress ?? 0,
      playTimeSec: body.playTimeSec ?? 0,
    }
    const row = await db.saveGame.upsert({
      where: { slot: data.slot },
      create: data,
      update: data,
    })
    return NextResponse.json({ save: toRecord(row) })
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to save game', detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}

/** DELETE /api/saves?slot=N */
export async function DELETE(req: NextRequest) {
  const slot = parseInt(req.nextUrl.searchParams.get('slot') ?? '', 10)
  if (!Number.isFinite(slot)) return NextResponse.json({ error: 'slot required' }, { status: 400 })
  try {
    await db.saveGame.delete({ where: { slot } })
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ ok: true })
  }
}
