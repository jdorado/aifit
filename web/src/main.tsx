import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { PrivyProvider, usePrivy } from '@privy-io/react-auth'
import App from './App'
import Landing from './Landing'
import './style.css'

const rootElement = document.querySelector<HTMLDivElement>('#app')

if (!rootElement) {
  throw new Error('App root not found')
}

const privyAppId = (process.env.PRIVY_APP_ID || '').trim()
const privyClientId = (process.env.PRIVY_CLIENT_ID || '').trim()

if (!privyAppId) {
  throw new Error('PRIVY_APP_ID is required to initialize Privy.')
}

const AuthenticatedApp = () => {
  const { ready, authenticated, login } = usePrivy()
  const [error, setError] = useState<string | null>(null)

  if (!ready) return <Landing loading />
  if (!authenticated) {
    return (
      <Landing
        error={error}
        onLogin={() => {
          setError(null)
          void (async () => {
            try {
              await login()
            } catch (reason) {
              setError(reason instanceof Error ? reason.message : 'Sign-in failed')
            }
          })()
        }}
      />
    )
  }
  return <App />
}

const app = (
  <PrivyProvider
    appId={privyAppId}
    clientId={privyClientId || undefined}
    config={{
      loginMethods: ['google'],
      // AIFit uses Privy for sign-in only, with no wallet creation or wallet UI.
      embeddedWallets: {
        ethereum: { createOnLogin: 'off' },
        solana: { createOnLogin: 'off' },
        showWalletUIs: false,
      },
    }}
  >
    <AuthenticatedApp />
  </PrivyProvider>
)

createRoot(rootElement).render(app)
