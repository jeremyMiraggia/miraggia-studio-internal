'use client'
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { getCurrentProvider } from '@/lib/imageProviderClient'

export default function StudioLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  // L'accès est contrôlé côté serveur par proxy.ts (cookie de session signé).
  // Ici on intercepte seulement les 401 des API (session expirée, mot de passe
  // changé, page ouverte avant un déploiement…) pour renvoyer à la connexion.
  useEffect(() => {
    // On y ajoute aussi le moteur d'image choisi dans l'onglet (en-tête x-image-provider).
    const orig = window.fetch
    window.fetch = async (...args) => {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] as Request)?.url ?? ''
      if (typeof args[0] === 'string' && url.startsWith('/api/studio/')) {
        const headers = new Headers(args[1]?.headers)
        headers.set('x-image-provider', getCurrentProvider())
        args = [args[0], { ...args[1], headers }]
      }
      const res = await orig(...args)
      if (res.status === 401 && url.startsWith('/api/')) {
        router.push('/?expired=1')
      }
      return res
    }
    return () => { window.fetch = orig }
  }, [router])

  const logout = async () => {
    try { await fetch('/api/logout', { method: 'POST' }) } catch { /* ignore */ }
    router.push('/')
  }

  return (
    <div style={{ minHeight: '100vh', background: '#F5F5F7' }}>
      <nav style={{ background: '#0D4A5C', padding: '0 24px', height: 52, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ color: '#fff', fontWeight: 700, fontSize: 16 }}>✦ Miraggia Studio</span>
        <button
          onClick={logout}
          style={{ color: 'rgba(255,255,255,0.6)', background: 'none', border: 'none', fontSize: 12, cursor: 'pointer' }}
        >
          Déconnexion
        </button>
      </nav>
      <div>{children}</div>
    </div>
  )
}