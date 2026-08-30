import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import {
  assertRuntimeDdlLocality,
  buildRuntimeSchemaModule,
  generateRuntimeSchema
} from './generate-database-schema.mjs'

describe('database schema generator', () => {
  it('compiles Prisma SQL and SQLite CHECK overlays into deterministic runtime DDL', async () => {
    const prismaSql = `-- CreateTable
CREATE TABLE "Probe" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Probe_value_key" ON "Probe"("value");
`
    const checkContract = {
      constraints: [
        {
          tableName: 'Probe',
          name: 'Probe_value_check',
          expression: 'length(trim("value")) > 0'
        }
      ]
    }

    const first = await buildRuntimeSchemaModule(prismaSql, checkContract)
    const second = await buildRuntimeSchemaModule(prismaSql, checkContract)

    expect(first).toBe(second)
    expect(first).toContain('CREATE TABLE IF NOT EXISTS "Probe"')
    expect(first).toContain('CONSTRAINT "Probe_value_check" CHECK (length(trim("value")) > 0)')
    expect(first).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "Probe_value_key"')
  })

  it('keeps the committed runtime schema generated from the current Prisma target', async () => {
    const committed = await readFile(
      new URL('../src/main/database/generated/runtime-schema.ts', import.meta.url),
      'utf8'
    )

    await expect(generateRuntimeSchema()).resolves.toBe(committed)
  })

  it('rejects unversioned runtime DDL outside the frozen legacy and ledger exceptions', () => {
    expect(() =>
      assertRuntimeDdlLocality([
        { path: 'src/main/example.ts', source: 'const ddl = `CREATE TABLE "Drift" ("id" TEXT)`' }
      ])
    ).toThrow(/Unversioned runtime DDL/)

    expect(() =>
      assertRuntimeDdlLocality([
        {
          path: 'src/main/database/legacy-baseline-adapter.ts',
          source: `// schema-locality: begin frozen-0001-repairs
const ddl = \`ALTER TABLE "Legacy" ADD COLUMN "value" TEXT\`
// schema-locality: end frozen-0001-repairs`
        }
      ])
    ).not.toThrow()

    expect(() =>
      assertRuntimeDdlLocality([
        {
          path: 'src/main/literature/migrations/index-0001.ts',
          source: 'const ddl = `CREATE TABLE "LiteratureIndex" ("id" TEXT)`'
        }
      ])
    ).not.toThrow()
  })

  it('keeps unsafe migration SQL behind the private executor', () => {
    expect(() =>
      assertRuntimeDdlLocality([
        {
          path: 'src/main/database/legacy-baseline-adapter.ts',
          source: 'await client.$executeRawUnsafe(ddl)'
        }
      ])
    ).toThrow(/Unsafe migration SQL/)

    expect(() =>
      assertRuntimeDdlLocality([
        {
          path: 'src/main/database/migration-sql-executor.ts',
          source: 'await client.$executeRawUnsafe(statement)'
        }
      ])
    ).not.toThrow()
  })
})
