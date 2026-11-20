/**
 * Catalogue des POSES de la plateforme Miraggia (table Supabase `poses`, gérée dans Admin → Poses, lecture publique).
 * Sortie : { poses: [{ label, description, view: 'front'|'back'|'profile', audience: 'adulte'|'enfant' }] } — cache 5 min.
 * Env : MIRAGGIA_SUPABASE_URL + MIRAGGIA_SUPABASE_ANON_KEY (clé anon, lecture seule).
 */
import { NextResponse } from 'next/server'

export const runtime = 'nodejs'

let cache: { at: number; data: unknown } | null = null

export async function GET() {
  const url = process.env.MIRAGGIA_SUPABASE_URL
  const key = process.env.MIRAGGIA_SUPABASE_ANON_KEY
  if (!url || !key) return NextResponse.json({ error: 'MIRAGGIA_SUPABASE_URL / MIRAGGIA_SUPABASE_ANON_KEY manquantes côté serveur.' }, { status: 500 })
  if (cache && Date.now() - cache.at < 5 * 60_000) return NextResponse.json(cache.data)
  try {
    const res = await fetch(`${url}/rest/v1/poses?select=label,description,view,audience,sort_order&order=sort_order`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: 'no-store',
    })
    const rows = await res.json().catch(() => null) as any[] | null
    if (!res.ok || !Array.isArray(rows)) return NextResponse.json({ error: `Poses inaccessibles (HTTP ${res.status}).` }, { status: 502 })
    const data = {
      poses: rows.map(r => ({
        label: String(r.label ?? '').trim(), description: String(r.description ?? '').trim(),
        view: r.view ?? '', audience: r.audience ?? 'adulte',
      })).filter(p => p.label),
    }
    cache = { at: Date.now(), data }
    return NextResponse.json(data)
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Erreur poses' }, { status: 500 })
  }
}
