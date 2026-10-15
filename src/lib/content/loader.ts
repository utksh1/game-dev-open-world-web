/**
 * ContentLoader — full parser for the original repo's asset formats.
 * Fixes the #1 documented gap: the C++ ContentLoader::loadMission /
 * loadVehicle / loadNPC / loadCampaign were print-only stubs and
 * loadLevel parsed only 3 of ~10 keys. This implementation parses
 * EVERYTHING: buildings, roads, docks, water, traffic/npc spawns,
 * all 15 objective types, vehicle physics stats, NPC reactions.
 */
import { readFile, readdir } from 'fs/promises'
import path from 'path'
import type {
  BuildingData,
  CampaignData,
  CampaignMission,
  ContentBundle,
  DockData,
  LevelData,
  MissionData,
  MissionEnemy,
  MissionObjective,
  MissionOpponent,
  NpcData,
  NpcReaction,
  NpcSpawnData,
  RoadData,
  TrafficSpawnData,
  Vec3,
  WaterArea,
} from '@/game/types'

const CONTENT_DIR = path.join(process.cwd(), 'content')

// ------------------------------------------------------------------
// Low-level line parser for the repo's YAML-ish format
// ------------------------------------------------------------------
interface RawEntry {
  fields: Record<string, string>
  /**
   * Nested list items under a field of this entry — e.g. the `checkpoints:`
   * list inside a race objective or `positions:` inside an enemy. Indent-
   * aware: deeper list items attach HERE instead of becoming phantom
   * section entries (previously "- position: …" became bogus goto
   * objectives / bodyguard spawns).
   */
  sub?: RawEntry[]
}
type Section = { key: string; entries: RawEntry[]; fields: Record<string, string> }

function stripComment(line: string): string {
  const inQuote = line.includes('"') && (line.match(/"/g)?.length ?? 0) % 2 === 1
  if (inQuote) return line
  const idx = line.indexOf('#')
  return (idx >= 0 ? line.slice(0, idx) : line).trimEnd()
}

function parseSections(raw: string): Map<string, Section> {
  const sections = new Map<string, Section>()
  let current: Section | null = null
  /** Deepest entry seen (may be a nested sub-item). */
  let currentEntry: RawEntry | null = null
  /** Last entry at the section's own list indent (sub-lists hang off it). */
  let sectionEntry: RawEntry | null = null
  /** Indent of the section's list items; -1 until the first one. */
  let listIndent = -1
  /** True after a field like `checkpoints:` — deeper items become sub-entries. */
  let inSubList = false

  const reset = (): void => {
    currentEntry = null
    sectionEntry = null
    listIndent = -1
    inSubList = false
  }

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = stripComment(rawLine.replace(/\s+$/, ''))
    if (!line.trim()) continue

    // Top-level "key:" section header (no leading whitespace)
    if (/^[A-Za-z_]+:\s*$/.test(line)) {
      const key = line.slice(0, -1).trim()
      current = { key, entries: [], fields: {} }
      sections.set(key, current)
      reset()
      continue
    }
    // Top-level scalar "key: value" — always belongs to _root
    if (/^[A-Za-z_]+:\s*.+/.test(line)) {
      const idx = line.indexOf(':')
      const key = line.slice(0, idx).trim()
      const value = line.slice(idx + 1).trim()
      let rootSection = sections.get('_root')
      if (!rootSection) {
        rootSection = { key: '_root', entries: [], fields: {} }
        sections.set('_root', rootSection)
      }
      rootSection.fields[key] = value
      reset()
      continue
    }
    // List item "  - key: value" / "  - value" / "      - deeper"
    const listItem = line.match(/^(\s*)-\s*(.*)$/)
    if (listItem && current) {
      const indent = listItem[1].length
      if (listIndent < 0) listIndent = indent
      const rest = listItem[2]
      const entry: RawEntry = { fields: {} }
      const kv = rest.match(/^([A-Za-z_]+):\s*(.*)$/)
      if (kv) entry.fields[kv[1]] = kv[2].trim()
      else if (rest) entry.fields['value'] = rest.replace(/^"|"$/g, '')
      if (indent > listIndent && sectionEntry && inSubList) {
        // Nested item — belongs to the parent entry (checkpoints, positions…).
        ;(sectionEntry.sub ??= []).push(entry)
      } else {
        current.entries.push(entry)
        sectionEntry = entry
        inSubList = false
      }
      currentEntry = entry
      continue
    }
    // Continuation "    key: value" inside a list entry
    const kv = line.match(/^(\s*)([A-Za-z_]+):\s*(.*)$/)
    if (kv && current) {
      const indent = kv[1].length
      const key = kv[2]
      const value = kv[3].trim()
      if (listIndent < 0) {
        current.fields[key] = value
      } else if (sectionEntry && indent <= listIndent + 2) {
        // Field of the section-level entry. An EMPTY value ("checkpoints:")
        // opens a nested list; a valued one closes it.
        sectionEntry.fields[key] = value
        inSubList = value === ''
        currentEntry = sectionEntry
      } else if (currentEntry) {
        // Deeper indent — field of a nested item.
        currentEntry.fields[key] = value
      }
    }
  }
  return sections
}

// ------------------------------------------------------------------
// Value converters
// ------------------------------------------------------------------
function str(v: string | undefined, fallback = ''): string {
  if (v === undefined) return fallback
  return v.replace(/^"|"$/g, '').trim()
}

function num(v: string | undefined, fallback = 0): number {
  if (v === undefined) return fallback
  const n = parseFloat(v.replace(/["']/g, ''))
  return Number.isFinite(n) ? n : fallback
}

function bool(v: string | undefined, fallback = false): boolean {
  if (v === undefined) return fallback
  return /^(true|yes|1)$/i.test(v.trim())
}

function vec3(v: string | undefined, fallback: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  if (!v) return { ...fallback }
  const parts = v.split(',').map((p) => parseFloat(p.trim()))
  return {
    x: Number.isFinite(parts[0]) ? parts[0] : fallback.x,
    y: Number.isFinite(parts[1]) ? parts[1] : fallback.y,
    z: Number.isFinite(parts[2]) ? parts[2] : fallback.z,
  }
}

function vec3OrRandom(v: string | undefined): Vec3 | 'random' {
  if (v && /random/i.test(v)) return 'random'
  return vec3(v)
}

function rangeNum(v: string | undefined, pick: 'min' | 'max' = 'min', fallback = 0): number {
  if (v === undefined) return fallback
  const cleaned = v.replace(/["']/g, '')
  if (cleaned.includes('-')) {
    const parts = cleaned.split('-').map((p) => parseFloat(p.trim()))
    const a = Number.isFinite(parts[0]) ? parts[0] : fallback
    const b = Number.isFinite(parts[1]) ? parts[1] : a
    return pick === 'min' ? Math.min(a, b) : Math.max(a, b)
  }
  return num(cleaned, fallback)
}

// ------------------------------------------------------------------
// Level parser (.level)
// ------------------------------------------------------------------
export function parseLevel(id: string, raw: string): LevelData {
  const s = parseSections(raw)
  const root = s.get('_root')?.fields ?? {}
  const sizeMatch = root.size?.match(/(\d+)\s*x\s*(\d+)/)

  const buildings: BuildingData[] = (s.get('building')?.entries ?? []).map((e) => ({
    name: str(e.fields.name, 'Building'),
    position: vec3(e.fields.position),
    size: vec3(e.fields.size, { x: 20, y: 10, z: 20 }),
    type: str(e.fields.type, 'office'),
  }))

  const docks: DockData[] = (s.get('dock')?.entries ?? []).map((e) => ({
    position: vec3(e.fields.position),
    size: vec3(e.fields.size, { x: 50, y: 5, z: 20 }),
    type: str(e.fields.type, 'cargo_dock'),
  }))

  const waterAreas: WaterArea[] = (s.get('water')?.entries ?? []).map((e) => ({
    min: vec3(e.fields.area),
    max: vec3(e.fields.area ? e.fields.area.split(',').slice(3).join(',') : undefined, { x: 100, y: 0, z: 100 }),
    type: str(e.fields.type, 'ocean'),
  }))

  const roads: RoadData[] = (s.get('road')?.entries ?? []).map((e) => ({
    start: vec3(e.fields.start),
    end: vec3(e.fields.end),
    width: num(e.fields.width, 10),
    lanes: num(e.fields.lanes, 2),
  }))

  const trafficSpawns: TrafficSpawnData[] = (s.get('traffic_spawn')?.entries ?? []).map((e) => ({
    position: vec3(e.fields.position),
    direction: vec3(e.fields.direction, { x: 1, y: 0, z: 0 }),
    vehicleType: e.fields.vehicle_type ? str(e.fields.vehicle_type) : undefined,
  }))

  const npcSpawns: NpcSpawnData[] = (s.get('npc_spawn')?.entries ?? []).map((e) => ({
    position: vec3(e.fields.position),
    count: num(e.fields.count, 3),
    behavior: str(e.fields.behavior, 'wander'),
  }))

  const firstLine = raw.split('\n').find((l) => l.startsWith('#'))
  return {
    id,
    name: firstLine ? firstLine.replace(/^#\s*/, '').trim() : id,
    type: str(root.type, 'urban'),
    sizeX: sizeMatch ? parseInt(sizeMatch[1]) : 1000,
    sizeZ: sizeMatch ? parseInt(sizeMatch[2]) : 1000,
    spawnPoint: vec3(root.spawn_point, { x: 500, y: 0, z: 500 }),
    buildings,
    docks,
    waterAreas,
    roads,
    trafficSpawns,
    npcSpawns,
    timeOfDay: str(root.time_of_day, 'day'),
    weather: str(root.weather, 'clear'),
    trafficDensity: str(root.traffic_density, 'medium'),
    pedestrianDensity: str(root.pedestrian_density, 'medium'),
  }
}

// ------------------------------------------------------------------
// Mission parser (.mission)
// ------------------------------------------------------------------
const OBJECTIVE_TYPES = new Set([
  'goto', 'interact', 'timer', 'survive', 'eliminate', 'defend', 'collect',
  'chase', 'race', 'steal', 'observe', 'locate', 'escort', 'escape', 'destroy',
])

export function parseMission(raw: string, isSide: boolean): MissionData {
  const s = parseSections(raw)
  const root = s.get('_root')?.fields ?? {}

  const objectives: MissionObjective[] = (s.get('objectives')?.entries ?? [])
    .map((e) => {
      const type = str(e.fields.type, 'goto').toLowerCase()
      // Authored checkpoint positions live as a nested list under the
      // objective (mission_02's race documents five fixed gates).
      const checkpoints = (e.sub ?? [])
        .map((c) => (c.fields.position ? vec3(c.fields.position) : null))
        .filter((p): p is Vec3 => !!p)
      return {
        id: str(e.fields.id, `obj_${Math.random().toString(36).slice(2, 7)}`),
        type: (OBJECTIVE_TYPES.has(type) ? type : 'goto') as MissionObjective['type'],
        description: str(e.fields.description, 'Complete the objective'),
        targetPosition: e.fields.target_position ? vec3OrRandom(e.fields.target_position) : undefined,
        radius: num(e.fields.radius, 10),
        target: e.fields.target ? str(e.fields.target) : undefined,
        duration: e.fields.duration ? num(e.fields.duration, 60) : undefined,
        timeLimit: e.fields.time_limit ? num(e.fields.time_limit, 120) : undefined,
        wantedLevel: e.fields.wanted_level ? num(e.fields.wanted_level, 1) : undefined,
        targetCount: e.fields.target_count ? num(e.fields.target_count, 1) : undefined,
        enemyType: e.fields.enemy_type ? str(e.fields.enemy_type) : undefined,
        maxDistance: e.fields.max_distance ? num(e.fields.max_distance, 100) : undefined,
        method: e.fields.method ? str(e.fields.method) : undefined,
        opponents: e.fields.opponents ? num(e.fields.opponents, 3) : undefined,
        checkpoints: checkpoints.length > 0 ? checkpoints : undefined,
      }
    })

  // The authored street-race side hustle documents a `races:` catalog
  // (Downtown Circuit, Highway Sprint…) instead of an explicit objectives
  // list — without synthesis it would complete the instant it starts.
  // Play the first catalog race, honoring its authored checkpoint count.
  if (isSide && objectives.length === 0) {
    const races = s.get('races')?.entries ?? []
    const race = races[0]
    if (race) {
      objectives.push({
        id: 'obj_race_01',
        type: 'race',
        description: `Win the ${str(race.fields.name, 'street race')}`,
        targetCount: num(race.fields.checkpoints, 6),
        opponents: num(race.fields.opponents, 3),
        timeLimit: 30, // per checkpoint, resets on each pass
      })
    }
  }

  const enemies: MissionEnemy[] = (s.get('enemies')?.entries ?? []).map((e) => {
    // Authored per-enemy positions (mission_06 documents four bodyguard
    // spots as a nested `positions:` list).
    const spawnPositions = (e.sub ?? [])
      .map((p) => (p.fields.value || p.fields.position ? vec3(p.fields.value ?? p.fields.position) : null))
      .filter((p): p is Vec3 => !!p)
    return {
      type: str(e.fields.type, 'gang_member'),
      count: num(e.fields.count, spawnPositions.length > 0 ? spawnPositions.length : 1),
      spawnTrigger: str(e.fields.spawn_trigger, 'obj_01'),
      spawnPosition: e.fields.spawn_position ? vec3(e.fields.spawn_position) : undefined,
      spawnPositions: spawnPositions.length > 0 ? spawnPositions : undefined,
    }
  })

  // Authored race opponents (mission_02's "Racer 1/2/3" with skill levels).
  const opponents: MissionOpponent[] | undefined = (() => {
    const entries = s.get('opponents')?.entries ?? []
    if (entries.length === 0) return undefined
    return entries.map((e) => ({
      name: str(e.fields.name, 'Racer'),
      vehicle: e.fields.vehicle ? str(e.fields.vehicle) : undefined,
      skill: e.fields.skill ? str(e.fields.skill) : undefined,
    }))
  })()

  return {
    id: str(root.id, 'unknown_mission'),
    name: str(root.name, 'Unnamed Mission'),
    description: str(root.description, ''),
    difficulty: str(root.difficulty, 'medium'),
    rewardMoney: rangeNum(root.reward_money, 'min', 1000),
    rewardMoneyMin: root.reward_money?.includes('-') ? rangeNum(root.reward_money, 'min', 0) : undefined,
    rewardMoneyMax: root.reward_money?.includes('-') ? rangeNum(root.reward_money, 'max', 0) : undefined,
    rewardXp: num(root.reward_xp, 100),
    isSide,
    repeatable: bool(root.repeatable) || str(root.type) === 'repeatable' || isSide,
    objectives,
    opponents,
    startPosition: e_or(root, s, 'start_position'),
    enemies,
    requiredItems: (s.get('required_items')?.entries ?? []).map((e) => str(e.fields.value ?? e.fields.id)),
    timeLimit: root.time_limit ? num(root.time_limit, 0) : undefined,
    maxRepeats: root.max_repeats ? str(root.max_repeats) : undefined,
  }
}

function e_or(root: Record<string, string>, s: Map<string, Section>, key: string): Vec3 | undefined {
  if (root[key]) return vec3(root[key])
  const flow = s.get('Mission flow')?.fields
  if (flow && flow[key]) return vec3(flow[key])
  return undefined
}

// ------------------------------------------------------------------
// Campaign parser (.campaign)
// ------------------------------------------------------------------
export function parseCampaign(raw: string): CampaignData {
  const s = parseSections(raw)
  const root = s.get('_root')?.fields ?? {}
  const missions: CampaignMission[] = (s.get('missions')?.entries ?? []).map((e) => ({
    id: str(e.fields.id),
    name: str(e.fields.name),
    unlock: str(e.fields.unlock, 'start'),
    required: bool(e.fields.required, true),
  }))
  return {
    id: str(root.id, 'campaign_main'),
    name: str(root.name, 'Main Story'),
    description: str(root.description, ''),
    missions,
    totalMissions: num(root.total_missions, missions.length),
    requiredMissions: num(root.required_missions, missions.length),
    completionReward: num(root.completion_reward, 0),
    completionXp: num(root.completion_xp, 0),
  }
}

// ------------------------------------------------------------------
// Vehicle parser (.vehicle)
// ------------------------------------------------------------------
export function parseVehicle(raw: string): import('@/game/types').VehicleData {
  const s = parseSections(raw)
  const root = s.get('_root')?.fields ?? {}
  return {
    id: str(root.id, 'vehicle'),
    name: str(root.name, 'Vehicle'),
    type: str(root.type, 'car'),
    vehicleClass: str(root.class, str(root.type, 'sedan')),
    mass: num(root.mass, 1200),
    maxSpeed: num(root.max_speed, 100),
    acceleration: num(root.acceleration, 6),
    braking: num(root.braking, 10),
    handling: num(root.handling, 6),
    traction: num(root.traction, 0.7),
    length: num(root.length, 4.4),
    width: num(root.width, 1.8),
    height: num(root.height, 1.4),
    durability: num(root.durability, 100),
    fuelCapacity: num(root.fuel_capacity, 50),
    seats: num(root.seats, 2),
    trunkSpace: num(root.trunk_space, 100),
    price: num(root.price, 10000),
    spawnLocations: (s.get('spawn_locations')?.entries ?? []).map((e) => vec3(e.fields.value)),
  }
}

// ------------------------------------------------------------------
// NPC parser (.npc)
// ------------------------------------------------------------------
export function parseNpc(raw: string): NpcData {
  const s = parseSections(raw)
  const root = s.get('_root')?.fields ?? {}
  const reactions: NpcReaction[] = (s.get('reactions')?.entries ?? []).map((e) => ({
    trigger: str(e.fields.trigger, 'gunshot'),
    action: str(e.fields.action, 'flee'),
    radius: num(e.fields.radius, 25),
  }))
  return {
    id: str(root.id, 'npc'),
    name: str(root.name, 'NPC'),
    type: str(root.type, 'pedestrian'),
    behavior: str(root.behavior, 'wander'),
    health: num(root.health, 100),
    speedWalk: num(root.speed_walk, 1.5),
    speedRun: num(root.speed_run, 4),
    wanderRadius: num(root.wander_radius, 40),
    fleeOnDanger: bool(root.flee_on_danger, true),
    callPoliceOnCrime: bool(root.call_police_on_crime, false),
    spawnWeight: num(root.spawn_weight, 50),
    spawnLocations: (s.get('spawn_locations')?.entries ?? []).map((e) => str(e.fields.value)),
    reactions,
  }
}

// ------------------------------------------------------------------
// Bundle loader — reads content/ dir and parses everything
// ------------------------------------------------------------------
export async function loadContentBundle(): Promise<ContentBundle> {
  const levelsDir = path.join(CONTENT_DIR, 'levels')
  const missionsDir = path.join(CONTENT_DIR, 'missions')
  const modelsDir = path.join(CONTENT_DIR, 'models')

  const levelFiles = (await readdir(levelsDir)).filter((f) => f.endsWith('.level')).sort()
  const levels = await Promise.all(
    levelFiles.map(async (f) => parseLevel(f.replace('.level', ''), await readFile(path.join(levelsDir, f), 'utf8'))),
  )

  const missionFiles = (await readdir(missionsDir)).filter((f) => f.endsWith('.mission')).sort()
  const missions = await Promise.all(
    missionFiles.map(async (f) => parseMission(await readFile(path.join(missionsDir, f), 'utf8'), f.startsWith('side_'))),
  )

  let campaign: CampaignData | null = null
  const campaignFile = path.join(missionsDir, 'campaign_main.campaign')
  try {
    campaign = parseCampaign(await readFile(campaignFile, 'utf8'))
  } catch {
    campaign = null
  }

  const vehicleFiles = (await readdir(modelsDir)).filter((f) => f.endsWith('.vehicle')).sort()
  const vehicles = await Promise.all(
    vehicleFiles.map(async (f) => parseVehicle(await readFile(path.join(modelsDir, f), 'utf8'))),
  )

  const npcFiles = (await readdir(modelsDir)).filter((f) => f.endsWith('.npc')).sort()
  const npcs = await Promise.all(
    npcFiles.map(async (f) => parseNpc(await readFile(path.join(modelsDir, f), 'utf8'))),
  )

  return { levels, missions, campaign, vehicles, npcs }
}
