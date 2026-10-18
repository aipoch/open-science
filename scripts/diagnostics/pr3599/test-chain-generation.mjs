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
const inspectSource = source.match(/function inspectPersistedHandoff\([\s\S]*?\n}\n/)
assert.ok(inspectSource, 'Generated persistence verifier is missing')
const inspectPersistence = vm.runInNewContext('(' + inspectSource[0] + ')')
const operation = '0a5a6537-65ed-43a4-8d64-2523a52ea3b2'
const request = { operationId: operation, helperPid: 6548, parentPid: 2984, createdAt: 1000 }
const backend = { pid: 4412, parent: 2984 }
const row = (scope, msg, data) => ({ t: '2026-10-18T13:30:43.000Z', runId: 'retained-b', scope, msg, data })
const records = [
  row('update', 'operation started', { operation: 'update-apply', operationId: 'apply-b' }),
  row('update', 'Windows update progress window ready', { pid: 6548, visible: true, directory: 'C:\\fixture\\Open-Science\\UpdateHandoffs\\' + operation }),
  row('main', 'update renderer persistence', { phase: 'preflight', outcome: 'completed' }),
  row('main', 'update renderer persistence', { phase: 'final', outcome: 'completed' }),
  row('desktop-runtime-client', 'runtime-stop', { step: 'confirm', runtimePid: 4412 }),
  row('desktop-runtime-client', 'runtime-stop', { step: 'confirmed', result: 'clean', processExited: true })
]
const encode = rows => rows.map(record => JSON.stringify(record)).join('\r\n') + '\r\n'
assert.equal(inspectPersistence(encode(records), request, backend).status, 'PASS')
const wrong = mutate => { const copy = structuredClone(records); mutate(copy); return copy }
for (const [name, rows] of [
  ['missing final save', records.filter((_, index) => index !== 3)],
  ['stop before final save', [records[0], records[1], records[2], records[4], records[3], records[5]]],
  ['wrong operation', wrong(rows => { rows[1].data.directory += '-old' })],
  ['wrong helper', wrong(rows => { rows[1].data.pid = 999 })],
  ['wrong backend', wrong(rows => { rows[4].data.runtimePid = 999 })],
  ['other run final save', wrong(rows => { rows[3].runId = 'old-a' })],
  ['failed final save', wrong(rows => { rows[3].data.outcome = 'failed' })],
  ['ambiguous final save', [...records, records[3]]],
  ['stale previous attempt', [records[0], records[2], records[3], records[0], records[1], records[4], records[5]]],
  ['new attempt before stop', [...records.slice(0, 4), records[0], ...records.slice(4)]],
  ['failed apply', [...records.slice(0, 4), row('update', 'operation failed', { operation: 'update-apply', operationId: 'apply-b', outcome: 'failed' }), ...records.slice(4)]]
]) assert.throws(() => inspectPersistence(encode(rows), request, backend), /Persistence evidence:/, name)
assert.throws(() => inspectPersistence(encode(records), request, { ...backend, parent: 1 }), /not owned/)
assert.throws(() => inspectPersistence(encode(records), { ...request, createdAt: Date.now() + 1e12 }, backend), /stale/)
assert.throws(() => inspectPersistence(encode(records) + '{\n', request, backend), /JSON|Expected/)
assert.equal(inspectPersistence(encode(records) + '{"runId":"new-c",', request, backend).status, 'PASS')
assert.throws(() => inspectPersistence(encode(records.slice(0, 5)) + JSON.stringify(records[5]), request, backend), /missing or ambiguous backend exit/)
assert.ok(source.indexOf('const persistence = retained') < source.indexOf('const installerResult = await installerExit'))
console.log('PASS: generated contracts and persistence ordering (2 positive + 15 negative cases)')
