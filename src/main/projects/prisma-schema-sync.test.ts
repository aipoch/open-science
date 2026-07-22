import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { PrismaClient } from '@prisma/client'
import { describe, expect, it } from 'vitest'

// Guards against a stale generated Prisma client — the root cause of the "Cannot read properties of
// undefined (reading 'findMany')" crash that occurs when prisma/schema.prisma gains a model but the
// client is not regenerated. The postinstall hook runs `prisma generate`, but `npm run dev` and
// `npm run build` no longer implicitly trigger it after a bare `git pull`, so a developer who pulls
// a schema change without reinstalling gets a client that silently omits the new delegates.
//
// This test fails fast and with a clear message instead of letting the app crash at runtime with a
// confusing TypeError from deep inside the repository/poller stack.

const SCHEMA_PATH = join(process.cwd(), 'prisma', 'schema.prisma')

/** Extracts model names (lowercased first letter = Prisma delegate key) from the schema source. */
const readSchemaModelNames = (): string[] => {
  const source = readFileSync(SCHEMA_PATH, 'utf-8')
  const matches = source.matchAll(/^model\s+(\w+)\s*{/gm)
  const names = [...matches].map((m) => m[1]!)
  if (names.length === 0) {
    throw new Error('No models found in prisma/schema.prisma — the test regex may be stale.')
  }
  return names
}

describe('prisma schema ↔ generated client sync', () => {
  it('every model in prisma/schema.prisma has a delegate on the generated PrismaClient', () => {
    const models = readSchemaModelNames()
    const client = new PrismaClient()

    const missing: string[] = []
    for (const model of models) {
      const delegate = model[0]!.toLowerCase() + model.slice(1)
      if (!(delegate in client)) {
        missing.push(model)
      }
    }

    expect(
      missing,
      [
        'Generated Prisma client is stale — run `npx prisma generate`.',
        'Missing delegates for models: ' + missing.join(', '),
        'This usually means prisma/schema.prisma changed but the client was not regenerated.'
      ].join('\n')
    ).toEqual([])
  })
})
