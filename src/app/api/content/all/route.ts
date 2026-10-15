import { NextRequest, NextResponse } from 'next/server'
import { loadContentBundle } from '@/lib/content/loader'

export const dynamic = 'force-dynamic'

let cache: { data: import('@/game/types').ContentBundle; at: number } | null = null
const TTL_MS = 60_000

/**
 * GET /api/content/all
 * Returns the fully-parsed ContentBundle (levels, missions, campaign,
 * vehicles, npcs) — the web replacement for the stubbed C++ ContentLoader.
 */
export async function GET(_req: NextRequest) {
  if (cache && Date.now() - cache.at < TTL_MS) {
    return NextResponse.json(cache.data)
  }
  try {
    const data = await loadContentBundle()
    cache = { data, at: Date.now() }
    return NextResponse.json(data)
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to load content', detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
