/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { execFileSync } from 'node:child_process'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { format, resolveConfig } from 'prettier'

const scriptPath = fileURLToPath(import.meta.url)
const require = createRequire(import.meta.url)
const repositoryRoot = resolve(dirname(scriptPath), '..')
const prismaSchemaPath = resolve(repositoryRoot, 'prisma/schema.prisma')
const checkContractPath = resolve(repositoryRoot, 'prisma/sqlite-check-constraints.json')
const generatedModulePath = resolve(repositoryRoot, 'src/main/database/generated/runtime-schema.ts')

const runtimeDdlPattern =
  /(?:`|'|")\s*(?:CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|TRIGGER|VIEW)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX|TRIGGER|VIEW))/i
const frozenDdlPattern =
  /\/\/ schema-locality: begin frozen-0001-repairs[\s\S]*?\/\/ schema-locality: end frozen-0001-repairs/g
const unsafeRawSqlPattern = /\.\$(?:execute|query)RawUnsafe\b/

const assertRuntimeDdlLocality = (files) => {
  const rawSqlOwner = 'src/main/database/migration-sql-executor.ts'
  const fullyOwnedPaths = new Set([
    'src/main/database/generated/runtime-schema.ts',
    'src/main/database/sqlite-schema-migrations.ts'
  ])
  for (const file of files) {
    if (
      file.path.startsWith('src/main/database/') &&
      file.path !== rawSqlOwner &&
      unsafeRawSqlPattern.test(file.source)
    ) {
      throw new Error(
        `Unsafe migration SQL found in ${file.path}. Route trusted SQL through ${rawSqlOwner}.`
      )
    }
    if (
      fullyOwnedPaths.has(file.path) ||
      file.path.startsWith('src/main/database/migrations/') ||
      file.path.startsWith('src/main/literature/migrations/')
    ) {
      continue
    }
    const source = file.source.replaceAll(frozenDdlPattern, '')
    if (runtimeDdlPattern.test(source)) {
      throw new Error(
        `Unversioned runtime DDL found in ${file.path}. Generate the target schema or add a versioned migration.`
      )
    }
  }
}

const checkRuntimeDdlLocality = async () => {
  const sourceRoot = resolve(repositoryRoot, 'src/main')
  const names = await readdir(sourceRoot, { recursive: true })
  const sourceNames = names.filter(
    (name) => name.endsWith('.ts') && !/\.(?:test|spec)\.ts$/.test(name)
  )
  const files = await Promise.all(
    sourceNames.map(async (name) => ({
      path: `src/main/${name.replaceAll('\\', '/')}`,
      source: await readFile(resolve(sourceRoot, name), 'utf8')
    }))
  )
  assertRuntimeDdlLocality(files)
}

const parsePrismaStatements = (prismaSql) =>
  prismaSql
    .split(/(?=^-- Create(?:Table|Index)\s*$)/m)
    .map((block) => block.replace(/^-- Create(?:Table|Index)\s*$/m, '').trim())
    .filter(Boolean)

const tableNameFromDdl = (ddl) => ddl.match(/^CREATE TABLE "([^"]+)"/)?.[1]
const indexNameFromDdl = (ddl) => ddl.match(/^CREATE (?:UNIQUE )?INDEX "([^"]+)"/)?.[1]

const injectCheckConstraints = (ddl, constraints) => {
  if (constraints.length === 0) return ddl
  const suffix = constraints
    .map(({ name, expression }) => `    CONSTRAINT "${name}" CHECK (${expression})`)
    .join(',\n')
  if (!ddl.endsWith('\n);')) throw new Error('Prisma table DDL has an unsupported shape.')
  return `${ddl.slice(0, -3)},\n${suffix}\n);`
}

const validateSqliteContract = (checkContract, tableNames) => {
  if (!Array.isArray(checkContract.constraints)) {
    throw new Error('SQLite CHECK contract must declare a constraints array.')
  }
  const constraintNames = new Set()
  for (const constraint of checkContract.constraints) {
    if (!tableNames.has(constraint.tableName)) {
      throw new Error(`SQLite CHECK references unknown table ${constraint.tableName}.`)
    }
    if (!constraint.name || !constraint.expression || constraintNames.has(constraint.name)) {
      throw new Error(`SQLite CHECK has an invalid or duplicate name ${constraint.name}.`)
    }
    constraintNames.add(constraint.name)
  }
  if (!Array.isArray(checkContract.indexes)) {
    throw new Error('SQLite schema contract must declare an indexes array.')
  }
  const indexNames = new Set()
  for (const index of checkContract.indexes) {
    if (
      !tableNames.has(index.tableName) ||
      indexNameFromDdl(index.sql) !== index.name ||
      !index.sql.includes(` ON "${index.tableName}"`) ||
      indexNames.has(index.name)
    ) {
      throw new Error(`SQLite schema contract has an invalid or duplicate index ${index.name}.`)
    }
    indexNames.add(index.name)
  }
}

const renderTemplateArray = (name, values) => `const ${name} = [
${values.map((value) => `  \`${value.replaceAll('`', '\\`').replaceAll('${', '\\${')}\``).join(',\n')}
] as const
`

const buildRuntimeSchemaModule = async (prismaSql, checkContract) => {
  const statements = parsePrismaStatements(prismaSql)
  const rawTables = statements.filter((statement) => tableNameFromDdl(statement))
  const prismaIndexes = statements.filter((statement) => indexNameFromDdl(statement))
  if (rawTables.length === 0 || rawTables.length + prismaIndexes.length !== statements.length) {
    throw new Error('Prisma emitted an unsupported database schema statement.')
  }
  const rawIndexes = [...prismaIndexes, ...checkContract.indexes.map(({ sql }) => sql)]

  const tableNames = new Set(rawTables.map(tableNameFromDdl))
  validateSqliteContract(checkContract, tableNames)
  const tables = rawTables.map((ddl) => {
    const tableName = tableNameFromDdl(ddl)
    const constraints = checkContract.constraints.filter(
      (constraint) => constraint.tableName === tableName
    )
    return injectCheckConstraints(ddl, constraints).replace(
      /^CREATE TABLE /,
      'CREATE TABLE IF NOT EXISTS '
    )
  })
  const indexes = rawIndexes.map((ddl) =>
    ddl.replace(/^CREATE (UNIQUE )?INDEX /, 'CREATE $1INDEX IF NOT EXISTS ')
  )
  const source = `/* This file is generated by scripts/generate-database-schema.mjs. Do not edit. */

${renderTemplateArray('RUNTIME_SCHEMA_TABLE_DDLS', tables)}
${renderTemplateArray('RUNTIME_SCHEMA_INDEX_DDLS', indexes)}
const RUNTIME_SCHEMA_TARGET_SQL = [
  ...RUNTIME_SCHEMA_TABLE_DDLS,
  ...RUNTIME_SCHEMA_INDEX_DDLS
] as const

const RUNTIME_SCHEMA_TABLES = ${JSON.stringify([...tableNames])} as const

export {
  RUNTIME_SCHEMA_INDEX_DDLS,
  RUNTIME_SCHEMA_TABLES,
  RUNTIME_SCHEMA_TABLE_DDLS,
  RUNTIME_SCHEMA_TARGET_SQL
}
`
  const prettierConfig = (await resolveConfig(generatedModulePath)) ?? {}
  return format(source, { ...prettierConfig, parser: 'typescript' })
}

const generatePrismaSql = () => {
  const prismaCli = require.resolve('prisma/build/index.js')
  return execFileSync(
    process.execPath,
    [
      prismaCli,
      'migrate',
      'diff',
      '--from-empty',
      '--to-schema-datamodel',
      prismaSchemaPath,
      '--script'
    ],
    { cwd: repositoryRoot, encoding: 'utf8' }
  )
}

const generateRuntimeSchema = async () => {
  const checkContract = JSON.parse(await readFile(checkContractPath, 'utf8'))
  return buildRuntimeSchemaModule(generatePrismaSql(), checkContract)
}

const run = async (arguments_ = process.argv.slice(2)) => {
  const generated = await generateRuntimeSchema()
  if (arguments_.includes('--check')) {
    const current = await readFile(generatedModulePath, 'utf8').catch(() => '')
    if (current !== generated) {
      throw new Error('Generated database schema is stale. Run npm run db:schema:generate.')
    }
    await checkRuntimeDdlLocality()
    console.log('Generated database schema is current.')
    return
  }
  await writeFile(generatedModulePath, generated)
  console.log(`Generated ${generatedModulePath}`)
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}

export { assertRuntimeDdlLocality, buildRuntimeSchemaModule, generateRuntimeSchema, run }
