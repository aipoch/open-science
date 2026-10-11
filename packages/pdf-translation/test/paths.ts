import { resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

export const resolve = (...paths: string[]): string =>
  resolvePath(fileURLToPath(new URL('..', import.meta.url)), ...paths)
