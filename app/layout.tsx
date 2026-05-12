import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Miraggia Studio',
  description: 'Studio de génération IA',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif', background: '#0D4A5C', minHeight: '100vh' }}>
        {children}
      </body>
    </html>
  )
}