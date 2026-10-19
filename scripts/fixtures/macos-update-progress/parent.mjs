/* eslint-disable @typescript-eslint/explicit-function-return-type -- native process fixture. */
import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const [helper, root] = process.argv.slice(2)
const operationId = randomUUID()
const directory = join(root, operationId)
mkdirSync(directory, { mode: 0o700 })
copyFileSync(helper, join(directory, 'progress'))
const state = (phase) => {
  writeFileSync(join(directory, 'state.tmp'), JSON.stringify({ operationId, phase }), {
    mode: 0o600
  })
  renameSync(join(directory, 'state.tmp'), join(directory, 'state.json'))
}
state('prepared')
writeFileSync(
  join(directory, 'config.json'),
  JSON.stringify({
    operationId,
    parentPid: process.pid,
    installing: 'Installing the Open-Science update…',
    unconfirmed:
      'The update status could not be confirmed. Closing this window does not stop installation.',
    close: 'Close update window'
  }),
  { mode: 0o600 }
)
const child = spawn(join(directory, 'progress'), [join(directory, 'config.json')], {
  detached: true,
  stdio: ['ignore', 'pipe', 'inherit']
})
let output = ''
child.stdout.on('data', (chunk) => {
  output += chunk
  if (!output.includes('\n')) return
  const ready = JSON.parse(output.trim())
  if (ready.operationId !== operationId || ready.pid !== child.pid || !ready.visible)
    throw new Error('No visible helper')
  child.stdout.destroy()
  child.unref()
  process.send({ ...ready, directory })
})
process.on('message', (message) => {
  if (message === 'handoff') {
    state('handoff')
    process.disconnect()
  }
  if (message === 'exit') process.disconnect()
  if (message === 'cancel') state('cancelled')
})
