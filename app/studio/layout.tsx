'use client'
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function StudioLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()

  useEffect(() => {
    if (typeof window !== 'undefined' && localStorage.getItem('studio_auth') !== 'true') {
      router.push('/')
    }
  }, [router])

  return (
    <div style={{ minHeight: '100vh', background: '#F5F5F7' }}>
      <nav style={{ background: '#0D4A5C', padding: '0 24px', height: 52, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ color: '#fff', fontWeight: 700, fontSize: 16 }}>✦ Miraggia Studio</span>
        <button
          onClick={() => { localStorage.removeItem('studio_auth'); router.push('/') }}
          style={{ color: 'rgba(255,255,255,0.6)', background: 'none', border: 'none', fontSize: 12, cursor: 'pointer' }}
        >
          Déconnexion
        </button>
      </nav>
      <div>{children}</div>
    </div>
  )
}