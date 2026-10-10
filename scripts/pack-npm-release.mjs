import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { currentRuntimeTarget } from '../packages/open-science/runtime-package.mjs'

const root = resolve(import.meta.dirname, '..')
const target = currentRuntimeTarget()
const output = join(root, 'out/npm-artifacts')
await mkdir(output, { recursive: true })
const packages = []
for (const folder of ['main', target.id]) {
  const directory = join(root, 'out/npm-release', folder)
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  const packed = JSON.parse(
    execFileSync(
      process.execPath,
      [process.env.npm_execpath, 'pack', directory, '--json', '--pack-destination', output],
      { encoding: 'utf8' }
    )
  )[0]
  const bytes = await readFile(join(output, packed.filename))
  packages.push({
    manifest,
    filename: packed.filename,
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`
  })
}
await writeFile(
  join(output, `${target.id}.json`),
  JSON.stringify({ target: target.id, packages }, null, 2) + '\n'
)
