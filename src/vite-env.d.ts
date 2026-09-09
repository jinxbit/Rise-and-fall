/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string
  readonly VITE_SUPABASE_ANON_KEY: string
  /** Testing-only escape hatch — shows a "Continue as guest" option instead of requiring Discord sign-in. Unset/false in production. */
  readonly VITE_ALLOW_GUEST_AUTH?: string
  /** Public half of the VAPID keypair used for Web Push (see README's "Push notifications" section). Unset hides the notification opt-in entirely. */
  readonly VITE_VAPID_PUBLIC_KEY?: string
  /** Names a NON-production environment ("Preview", "Local", …) so the build says on screen which backend it talks to. Deliberately unset in production — see src/components/environmentBadge.ts. */
  readonly VITE_ENVIRONMENT?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/** Injected by vite.config.ts at build time; unique per deploy. */
declare const __BUILD_ID__: string
