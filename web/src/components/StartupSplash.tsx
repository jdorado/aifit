import startup from './startup.html'

// This trusted, account-free markup also paints before JavaScript loads.
export default function StartupSplash() {
  return <div dangerouslySetInnerHTML={{ __html: startup }} />
}
