// Type-only shims so `tsc -b` can follow src/test/supabaseStack's imports into
// supabase/functions/, which is Deno code written against the Edge Runtime's
// globals rather than the app's DOM/vite ones. Runtime equivalents live
// elsewhere: `Deno` is stubbed by ./edgeFunctions.ts, and the `jsr:` specifier
// is aliased onto the npm package by vite.config.ts's `test.alias`.
//
// Deliberately has no top-level import/export: that keeps it a global script
// rather than a module, which is what makes `declare var Deno` global and
// makes the `declare module` below a real ambient declaration instead of an
// augmentation of a module that does not exist.

declare module 'jsr:@supabase/supabase-js@2' {
  export * from '@supabase/supabase-js'
}

declare var Deno: {
  env: { get(key: string): string | undefined }
  serve(handler: (req: Request) => Response | Promise<Response>): void
}
