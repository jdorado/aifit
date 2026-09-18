declare module '*.css'

declare const process: {
  env: {
    PRIVY_APP_ID?: string
    PRIVY_CLIENT_ID?: string
    API_BASE_URL?: string
    DISABLE_DEV_WORKOUT?: string
    DEV_PREVIEW_WORKOUT?: string
    DEV_LOCAL_AUTH_TOKEN?: string
  }
}
