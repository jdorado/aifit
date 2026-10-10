// Design-preview stand-in for @privy-io/react-auth: an always-signed-in demo user.
import type { ReactNode } from 'react'

const b64 = (value: object) => btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
const token = ['e30', b64({ sub: 'demo-user', exp: 4_000_000_000 }), 'preview'].join('.')
const user = { id: 'demo-user', email: { address: 'maya@example.com' } }
const auth = {
  ready: new URLSearchParams(window.location.search).get('landing') !== 'loading',
  authenticated: !new URLSearchParams(window.location.search).has('landing'),
  user,
  login: () => {},
  logout: () => {},
  getAccessToken: async () => token,
}

export const usePrivy = () => auth
export const PrivyProvider = ({ children }: { children: ReactNode }) => <>{children}</>
