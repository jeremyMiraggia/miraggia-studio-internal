/**
 * Catalogue des mannequins de la plateforme Miraggia (table Supabase `mannequins`, lecture publique).
 * Sortie : { mannequins: [{ id, name, gender, description, faceUrl, bodyUrl }] } — mis en cache 5 min.
 * Env : MIRAGGIA_SUPABASE_URL + MIRAGGIA_SUPABASE_ANON_KEY (clé anon, lecture seule).
 */
import { NextResponse } from 'next/server'

export const runtime = 'nodejs'

type Row = { id: string; name: string; gender?: string; description?: string; photo_url?: string; body_photo_url?: string; active?: boolean }

let cache: { at: number; data: unknown } | null = null

export async function GET() {
  const url = process.env.MIRAGGIA_SUPABASE_URL
  const key = process.env.MIRAGGIA_SUPABASE_ANON_KEY
  if (!url || !key) {
    return NextResponse.json({ error: 'MIRAGGIA_SUPABASE_URL / MIRAGGIA_SUPABASE_ANON_KEY manquantes côté serveur (Vercel → Settings → Environment Variables).' }, { status: 500 })
  }
  if (cache && Date.now() - cache.at < 5 * 60_000) return NextResponse.json(cache.data)
  try {
    const res = await fetch(`${url}/rest/v1/mannequins?select=id,name,gender,description,photo_url,body_photo_url,active&active=eq.true&order=sort_order`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: 'no-store',
    })
    const rows = await res.json().catch(() => null) as Row[] | null
    if (!res.ok || !Array.isArray(rows)) return NextResponse.json({ error: `Catalogue inaccessible (HTTP ${res.status}).` }, { status: 502 })
    const data = {
      mannequins: rows.map(r => ({
        id: r.id, name: (r.name ?? '').trim(), gender: r.gender ?? '', description: r.description ?? '',
        faceUrl: r.photo_url || r.body_photo_url || '', bodyUrl: r.body_photo_url || '',
      })),
    }
    cache = { at: Date.now(), data }
    return NextResponse.json(data)
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Erreur catalogue' }, { status: 500 })
  }
}
