import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  PRISMA_CLIENT_SCHEMA_RELATIVE_PATH,
  PRISMA_SOURCE_SCHEMA_RELATIVE_PATH,
  checkPrismaClient,
  prismaClientFingerprintMismatchMessage,
  prismaSchemaFingerprint
} from './check-prisma-client.mjs'

const writeTree = (
  schema: string,
  clientSchema?: string
): { root: string; schemaPath: string; clientSchemaPath: string } => {
  const root = mkdtempSync(join(tmpdir(), 'prisma-fingerprint-'))
  const schemaPath = join(root, 'prisma', 'schema.prisma')
  const clientSchemaPath = join(root, 'node_modules', '.prisma', 'client', 'schema.prisma')
  mkdirSync(join(root, 'prisma'), { recursive: true })
  writeFileSync(schemaPath, schema)
  if (clientSchema !== undefined) {
    mkdirSync(join(root, 'node_modules', '.prisma', 'client'), { recursive: true })
    writeFileSync(clientSchemaPath, clientSchema)
  }
  return { root, schemaPath, clientSchemaPath }
}

describe('Prisma Client fingerprint', () => {
  it('names the source schema and generated client copy', () => {
    expect(PRISMA_SOURCE_SCHEMA_RELATIVE_PATH).toBe('prisma/schema.prisma')
    expect(PRISMA_CLIENT_SCHEMA_RELATIVE_PATH).toBe('node_modules/.prisma/client/schema.prisma')
  })

  it('runs the fingerprint check before npm test', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts: { pretest?: string }
    }
    expect(pkg.scripts.pretest).toBe('node scripts/check-prisma-client.mjs')
  })

  it('accepts a generated client that matches the source schema', () => {
    const schema = 'model Probe { id String @id }\n'
    const { root, schemaPath, clientSchemaPath } = writeTree(schema, schema)
    try {
      expect(() => checkPrismaClient({ root, schemaPath, clientSchemaPath })).not.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // Captured from `prisma generate` 6.19.3: the client copy realigns field columns and does not
  // copy the source bytes. Byte equality would reject a fresh Client.
  const unformattedSource = `generator client {
  provider = "prisma-client-js"
  output   = "./generated"
}

datasource db {
  provider = "sqlite"
  url      = "file:./dev.db"
}

model Probe {
  id          String   @id @default(cuid())
  name String
  description String   @default("")
  archivedAt  DateTime?
}
`

  const generatedFormatted = `generator client {
  provider = "prisma-client-js"
  output   = "./generated"
}

datasource db {
  provider = "sqlite"
  url      = "file:./dev.db"
}

model Probe {
  id          String    @id @default(cuid())
  name        String
  description String    @default("")
  archivedAt  DateTime?
}
`

  it('accepts a fresh Prisma Client whose generated schema only reformats field alignment', () => {
    expect(unformattedSource).not.toBe(generatedFormatted)
    expect(prismaSchemaFingerprint(unformattedSource)).toBe(
      prismaSchemaFingerprint(generatedFormatted)
    )
    const { root, schemaPath, clientSchemaPath } = writeTree(unformattedSource, generatedFormatted)
    try {
      expect(() => checkPrismaClient({ root, schemaPath, clientSchemaPath })).not.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails with a fingerprint error when the generated client is missing', () => {
    const { root, schemaPath, clientSchemaPath } = writeTree('model Probe { id String @id }\n')
    try {
      expect(() => checkPrismaClient({ root, schemaPath, clientSchemaPath })).toThrow(
        /Prisma Client is not generated/i
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails with a fingerprint error when the generated client does not match the source schema', () => {
    const { root, schemaPath, clientSchemaPath } = writeTree(
      'model Probe { id String @id }\n',
      'model Probe { id String @id\n  extra String }\n'
    )
    try {
      expect(() => checkPrismaClient({ root, schemaPath, clientSchemaPath })).toThrow(
        prismaClientFingerprintMismatchMessage(schemaPath, clientSchemaPath)
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
