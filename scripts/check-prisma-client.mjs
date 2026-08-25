/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PRISMA_SOURCE_SCHEMA_RELATIVE_PATH = 'prisma/schema.prisma'
export const PRISMA_CLIENT_SCHEMA_RELATIVE_PATH = 'node_modules/.prisma/client/schema.prisma'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function prismaClientFingerprintMismatchMessage(schemaPath, clientSchemaPath) {
  return [
    'Generated Prisma Client is out of date with prisma/schema.prisma.',
    'Run `npx prisma generate` (or `npm install`) in this worktree before tests.',
    `Source: ${schemaPath}`,
    `Client: ${clientSchemaPath}`
  ].join('\n')
}

// Prisma generate copies the schema into the Client package after realigning field columns.
// Compare tokens, not bytes: comments and alignment spaces are not part of the datamodel.
export function prismaSchemaFingerprint(schema) {
  let out = ''
  let index = 0
  const source = String(schema).replaceAll('\r\n', '\n').replaceAll('\r', '\n')
  while (index < source.length) {
    const char = source[index]
    if (char === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') index += 1
      continue
    }
    if (char === '"' || char === "'") {
      const quote = char
      out += char
      index += 1
      while (index < source.length) {
        out += source[index]
        if (source[index] === '\\' && index + 1 < source.length) {
          out += source[index + 1]
          index += 2
          continue
        }
        if (source[index] === quote) {
          index += 1
          break
        }
        index += 1
      }
      continue
    }
    if (/\s/.test(char)) {
      if (out.length > 0 && out.at(-1) !== ' ') out += ' '
      index += 1
      continue
    }
    out += char
    index += 1
  }
  return out.trim()
}

export function checkPrismaClient({
  root = repositoryRoot,
  schemaPath = resolve(root, PRISMA_SOURCE_SCHEMA_RELATIVE_PATH),
  clientSchemaPath = resolve(root, PRISMA_CLIENT_SCHEMA_RELATIVE_PATH)
} = {}) {
  if (!existsSync(schemaPath)) {
    throw new Error(`Prisma schema not found: ${schemaPath}`)
  }
  if (!existsSync(clientSchemaPath)) {
    throw new Error(
      `Prisma Client is not generated. Run \`npx prisma generate\` (or \`npm install\`).\nMissing: ${clientSchemaPath}`
    )
  }
  const source = readFileSync(schemaPath, 'utf8')
  const generated = readFileSync(clientSchemaPath, 'utf8')
  if (prismaSchemaFingerprint(source) !== prismaSchemaFingerprint(generated)) {
    throw new Error(prismaClientFingerprintMismatchMessage(schemaPath, clientSchemaPath))
  }
}

const isDirectExecution =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isDirectExecution) {
  try {
    checkPrismaClient()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
