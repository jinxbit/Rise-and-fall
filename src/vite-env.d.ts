/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string
  readonly VITE_SUPABASE_ANON_KEY: string
  /** Testing-only escape hatch — shows a "Continue as guest" option instead of requiring Discord sign-in. Unset/false in production. */
  readonly VITE_ALLOW_GUEST_AUTH?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/** Injected by vite.config.ts at build time; unique per deploy. */
declare const __BUILD_ID__: string
