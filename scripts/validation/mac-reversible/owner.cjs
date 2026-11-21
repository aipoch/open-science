// Disposable, memory-only owner. Never scan the machine or infer an abandoned directory.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { dirname, join } = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const api = require(process.env.DRIVER)
const d = process.argv[2]
const input = () => JSON.parse(fs.readFileSync(join(d, 'input.json')))
const p = JSON.parse(fs.readFileSync(join(d, 'prepared.json')))
const loc = api.location(d)
function id(path) {
  try {
    const s = fs.lstatSync(path)
    assert(!s.isSymbolicLink())
    return [s.dev, s.ino, s.uid].join('/')
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
}
async function run() {
  const target = id(loc.installationRoot)
  const dirs = [dirname(loc.installationRoot), dirname(p.stagedBundle), p.stagedBundle, p.directory]
  const identities = dirs.map(id)
  assert(target && identities.every(Boolean))
  fs.writeFileSync(join(d,'monitor-ready'),String(process.pid),{flag:'wx'})
  for (;;) {
    if (fs.existsSync(join(p.directory,'request.json'))) return
    const reason = id(loc.installationRoot)!==target ? 'target-moved' :
      fs.existsSync(join(d,'profile/disable-background-update-downloads')) ? 'opt-out' :
      input().sha512!==p.sha512 ? 'superseded' : null
    if (reason) {
      assert.deepEqual(dirs.map(id), identities)
      await api.discard(d)
      api.note(d, 'owner-discarded', {reason, pid:process.pid})
      return
    }
    await delay(100)
  }
}
run().catch(e=>{console.error(e);process.exitCode=1})
