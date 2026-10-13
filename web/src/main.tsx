import { Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import Landing from './Landing'
import './design/core.css'

const rootElement = document.querySelector<HTMLDivElement>('#app')

if (!rootElement) {
  throw new Error('App root not found')
}

if (!(process.env.PRIVY_APP_ID || '').trim()) {
  throw new Error('PRIVY_APP_ID is required to initialize Privy.')
}

// The auth SDK and the app are the heavy part of the bundle: split them out so the
// landing shell is the first (and tiny) thing the browser has to parse and paint.
const AuthGate = lazy(() => import('./AuthGate'))

createRoot(rootElement).render(
  <Suspense fallback={<Landing loading />}>
    <AuthGate />
  </Suspense>,
)
