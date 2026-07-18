// Minimal ambient declaration for js-yaml (a runtime dependency via electron-updater, declared
// directly in package.json). js-yaml v4 ships no bundled types and @types/js-yaml is not installed,
// so this covers just the two functions used here. Replace with @types/js-yaml if that package is
// ever added.
declare module 'js-yaml' {
  // Opaque schema handle; only used to pass FAILSAFE_SCHEMA to load().
  export type Schema = unknown
  // Resolves every plain scalar to a string (no bool/number/Date coercion); supports only str/seq/map.
  export const FAILSAFE_SCHEMA: Schema

  export interface DumpOptions {
    // Max line width before folding; -1 disables folding so values stay byte-lossless.
    lineWidth?: number
    indent?: number
  }
  export interface LoadOptions {
    schema?: Schema
  }
  export function dump(obj: unknown, options?: DumpOptions): string
  export function load(input: string, options?: LoadOptions): unknown
}
