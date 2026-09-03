'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function LoginPage() {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const router = useRouter()

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      // Vérification côté serveur : le mot de passe n'est jamais dans le code client.
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      if (res.ok) {
        router.push('/studio')
      } else {
        const j = await res.json().catch(() => ({}))
        setError(j.error || 'Mot de passe incorrect')
      }
    } catch {
      setError('Connexion impossible')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0D4A5C' }}>
      <div style={{ background: '#fff', borderRadius: 16, padding: 40, width: 360, boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }}>
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>✦</div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0D4A5C', margin: 0 }}>Miraggia Studio</h1>
          <p style={{ fontSize: 13, color: '#6B7A8A', marginTop: 6 }}>Accès équipe</p>
        </div>
        <form onSubmit={handleLogin}>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="Mot de passe"
            style={{ width: '100%', padding: '11px 14px', border: '1px solid rgba(13,74,92,0.2)', borderRadius: 8, fontSize: 14, marginBottom: 12, boxSizing: 'border-box' as const, fontFamily: 'system-ui' }}
          />
          {error && <p style={{ color: '#c0392b', fontSize: 12, marginBottom: 10 }}>{error}</p>}
          <button type="submit" disabled={busy} style={{ width: '100%', padding: 12, background: busy ? '#6B7A8A' : '#0D4A5C', color: '#C8F07D', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: busy ? 'wait' : 'pointer' }}>
            {busy ? 'Vérification…' : 'Accéder au Studio →'}
          </button>
        </form>
      </div>
    </div>
  )
}
