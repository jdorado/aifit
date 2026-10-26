declare module '*.css'
declare module '*.html' { const html: string; export default html }

declare const process: {
  env: {
    PRIVY_APP_ID?: string
    PRIVY_CLIENT_ID?: string
    API_BASE_URL?: string
  }
}
