import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import vm from 'node:vm'

const source = await readFile(resolve(process.argv[2], 'scripts/pr3599-upgrade-certification.mjs'), 'utf8')
const receipt = source.match(/if \(content !== (.*?)\) throw new Error\('Receipt correlation failed:/)
assert.ok(receipt)
assert.equal(vm.runInNewContext(receipt[1], { id: 'example', stage: 'ready' }), 'example\r\nready\r\n')
const split = source.match(/const events = \(await readFile\(seededData.marker, 'utf8'\)\)\.trim\(\)\.split\((.*?)\)\.map\(JSON.parse\)/g)
assert.ok(split?.length >= 2)
for (const line of split) {
  const regex = vm.runInNewContext(line.match(/\.split\((.*?)\)/)[1])
  assert.equal('{"a":1}\r\n{"a":2}\n'.trim().split(regex).map(JSON.parse).length, 2)
}
assert.match(source, /const legacyConfigRoots = \[\s*env.OPEN_SCIENCE_CONFIG_ROOT,/)
const uninstall = vm.runInNewContext(source.match(/singleFile\(directory, (.*?), 'installed uninstaller'\)/)[1])
assert.equal(uninstall.test('Uninstall Open-Science.exe'), true)
assert.equal(uninstall.test('Uninstall Open-ScienceXexe'), false)
assert.match(source, /'-HandoffAppData', handoffAppData/)
assert.match(source, /const handoffAppData = process\.env\.APPDATA/)
for (const [maintained, generated] of [
  ['observe-handoff.ps1', 'pr3599-observe-handoff.ps1'],
  ['HandoffObserver.cs', 'HandoffObserver.cs']
]) {
  assert.equal(
    await readFile(resolve(process.argv[2], 'scripts/windows-upgrade-diagnostics', maintained), 'utf8'),
    await readFile(resolve(process.argv[2], 'scripts', generated), 'utf8')
  )
}
console.log('PASS: generated receipt bytes, JSONL parsing, config discovery, uninstall filename and candidate observer binding')
