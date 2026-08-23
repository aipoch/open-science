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
  if (source !== generated) {
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
