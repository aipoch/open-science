/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile, access, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const work = await mkdtemp(join(tmpdir(), 'skills-package-acceptance-'))
console.log(`Acceptance artifacts: ${work}`)
const durableTarball = process.argv
  .find((arg) => arg.startsWith('--durable-files-tarball='))
  ?.split('=')
  .slice(1)
  .join('=')
if (!durableTarball)
  throw new Error(
    'Supply --durable-files-tarball=<npm pack archive>; the repository check:packages dispatcher supplies it.'
  )
const source = join(work, 'package')
await mkdir(source)
for (const entry of await readdir(root)) {
  if (['node_modules', 'dist', '.git', '.cache'].includes(entry) || entry.endsWith('.tgz')) continue
  await cp(join(root, entry), join(source, entry), { recursive: true })
}
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
if (process.argv.includes('--offline')) process.env.npm_config_offline = 'true'
const cacheArgs = process.env.npm_config_cache ? ['--cache', process.env.npm_config_cache] : []
const run = (command, args, cwd) => {
  const env = { ...process.env }
  for (const key of [
    'NODE_PATH',
    'NODE_OPTIONS',
    'INIT_CWD',
    'VITEST_PORTABLE_CI',
    'OPEN_SCIENCE_CI_SELECTED_PACKAGE_ROOTS',
    'OPEN_SCIENCE_CI_EXCLUDED_PACKAGE_ROOTS'
  ])
    delete env[key]
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env,
    shell: process.platform === 'win32' && command === npm
  })
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}
console.log(
  run(
    npm,
    [
      'install',
      '--no-save',
      '--ignore-scripts',
      '--prefer-offline',
      '--no-audit',
      '--no-fund',
      ...cacheArgs,
      durableTarball
    ],
    source
  )
)
const sourceTests = !process.argv.includes('--skip-tests')
for (const script of ['build', 'typecheck', ...(sourceTests ? ['test'] : [])])
  console.log(run(npm, ['run', script], source))
const [packed] = JSON.parse(
  run(npm, ['pack', '--json', '--pack-destination', work, ...cacheArgs], source)
)
for (const file of packed.files) {
  assert.match(file.path, /^(?:dist\/|README\.md$|LICENSE$|package\.json$)/)
  if (file.path.endsWith('.js') || file.path.endsWith('.d.ts')) {
    await access(
      join(source, 'src', file.path.slice('dist/'.length).replace(/(?:\.d)?\.ts$|\.js$/, '.ts'))
    )
    const content = await readFile(join(source, file.path), 'utf8')
    assert.ok(!content.includes(root), `Absolute checkout reference in ${file.path}`)
    assert.ok(
      !content.includes('src/main/') && !content.includes('src/shared/'),
      `Host reference in ${file.path}`
    )
  }
}
const consumer = join(work, 'consumer')
await mkdir(consumer)
const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
await writeFile(
  join(consumer, 'package.json'),
  JSON.stringify({
    name: 'skills-clean-consumer',
    private: true,
    type: 'module',
    dependencies: {
      '@aipoch/skills': `file:../${packed.filename}`,
      '@aipoch/durable-files': `file:${durableTarball}`
    },
    devDependencies: {
      typescript: manifest.devDependencies.typescript,
      '@types/node': manifest.devDependencies['@types/node']
    }
  })
)
console.log(
  run(
    npm,
    [
      'install',
      '--omit=dev',
      '--ignore-scripts',
      '--prefer-offline',
      '--no-audit',
      '--no-fund',
      ...cacheArgs
    ],
    consumer
  )
)
await cp(join(source, 'scripts/consumer-smoke.mjs'), join(consumer, 'smoke.mjs'))
console.log(run(process.execPath, ['smoke.mjs'], consumer))
console.log(
  run(
    npm,
    [
      'install',
      '--include=dev',
      '--ignore-scripts',
      '--prefer-offline',
      '--no-audit',
      '--no-fund',
      ...cacheArgs
    ],
    consumer
  )
)
await writeFile(
  join(consumer, 'usage.ts'),
  `
import { UserSkillRepository, SkillRegistry, SkillAuthoringService, type SkillHelperValidator } from '@aipoch/skills'
import { parseSkillDocument } from '@aipoch/skills/document'
import { buildSkillExportArchive } from '@aipoch/skills/sources'
import { ClaudeCodeSkillMaterializer } from '@aipoch/skills/projection'
const repository = new UserSkillRepository('/tmp/example')
const registry = new SkillRegistry('/tmp/bundled')
const validator: SkillHelperValidator = async () => {}
const catalog = await registry.list()
await new ClaudeCodeSkillMaterializer().sync('/tmp/projection', catalog)
if (catalog[0]) await buildSkillExportArchive(catalog[0], undefined, validator)
parseSkillDocument('---\\nname: example\\n---\\nExample')
const host: typeof SkillAuthoringService = SkillAuthoringService
void host; void repository
`
)
console.log(
  run(
    process.execPath,
    [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '--strict',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--target',
      'ES2022',
      'usage.ts'
    ],
    consumer
  )
)
console.log(
  `PASS: isolated source build${sourceTests ? '/tests' : ' (source tests not selected)'}, npm pack contents, clean runtime and TypeScript consumer (${packed.filename})`
)

await rm(source, { recursive: true, force: true })
console.log(
  run(
    npm,
    ['prune', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', ...cacheArgs],
    consumer
  )
)
console.log(run(process.execPath, ['smoke.mjs'], consumer))
console.log(
  run(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { DurableJsonRecoveryBarrierError } from '@aipoch/durable-files';
const require = createRequire(import.meta.url);
const sibling = createRequire(require.resolve('@aipoch/skills'));
assert.equal(realpathSync(sibling.resolve('@aipoch/durable-files')), realpathSync(require.resolve('@aipoch/durable-files')));
assert.equal(sibling('@aipoch/durable-files').DurableJsonRecoveryBarrierError, DurableJsonRecoveryBarrierError);
`
    ],
    consumer
  )
)
await rm(work, { recursive: true, force: true })
