/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile, readFile, rm, cp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const root = await mkdtemp(join(tmpdir(), 'pdf-structure-packed-'))
const npmCli = process.env.npm_execpath
assert(npmCli, 'Run this check with npm run test:pack')
const run = (args, cwd) =>
  execFileSync(process.execPath, [npmCli, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
try {
  const packed = JSON.parse(run(['pack', '--json', '--pack-destination', root], packageRoot))[0]
  const consumer = join(root, 'consumer')
  await mkdir(consumer)
  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      devDependencies: { '@types/node': '^22.19.1', typescript: '^5.9.3' }
    })
  )
  run(['install', '--no-audit', '--no-fund', join(root, packed.filename)], consumer)
  const metadata = JSON.parse(
    await readFile(join(consumer, 'node_modules/@aipoch/pdf-structure/package.json'), 'utf8')
  )
  assert.deepEqual(Object.keys(metadata.exports), ['.', './result'])
  await cp(new URL('./packed-runtime.mjs', import.meta.url), join(consumer, 'check.mjs'))
  const result = execFileSync(
    process.execPath,
    [join(consumer, 'check.mjs'), ...process.argv.slice(2)],
    { cwd: consumer, encoding: 'utf8', timeout: 180_000 }
  )
  console.log(result.trim())
  await writeFile(
    join(consumer, 'check.ts'),
    `import { createPdfStructureEngine, type PdfStructureProcessRuntime } from '@aipoch/pdf-structure';\nimport { decodePdfStructureResult, type PdfStructureResult } from '@aipoch/pdf-structure/result';\nconst engine = createPdfStructureEngine({ modelRecipe: { revision: 'test' } });\nconst decode: (value: unknown) => PdfStructureResult = decodePdfStructureResult;\nvoid engine; void decode; type Runtime = PdfStructureProcessRuntime;\n`
  )
  // The compiler is a declared package devDependency; module resolution starts at the clean consumer.
  const tsc = join(consumer, 'node_modules/typescript/bin/tsc')
  execFileSync(
    process.execPath,
    [
      tsc,
      '--noEmit',
      '--strict',
      '--module',
      'NodeNext',
      '--target',
      'ES2022',
      join(consumer, 'check.ts')
    ],
    { cwd: consumer, stdio: 'pipe' }
  )
  console.log('Packed consumer: exports, declarations, worker lifecycle passed.')
} finally {
  await rm(root, { recursive: true, force: true })
}
