/* eslint-disable @typescript-eslint/explicit-function-return-type */
// The production Agent adapter/Job owner launches this fixture using the installed Node runtime.
// Its descendant intentionally survives ACP stdin closure and holds a real installation file.
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { openSync, writeFileSync } from 'node:fs'

const take = (flag) => {
  const index = process.argv.indexOf(flag)
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${flag}`)
  return process.argv.splice(index, 2)[1]
}
const target = take('--owned-lock-file')
if (process.argv.includes('--owned-descendant')) {
  openSync(target, 'r')
  process.send({ ready: true })
  process.disconnect()
  setInterval(() => {}, 1000)
} else {
  const evidence = take('--owned-evidence')
  const descendant = spawn(
    process.execPath,
    [process.argv[1], '--owned-descendant', '--owned-lock-file', target],
    { detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }
  )
  const [message] = await once(descendant, 'message', { signal: AbortSignal.timeout(10_000) })
  if (message.ready !== true) throw new Error('The owned descendant did not acquire its file.')
  writeFileSync(
    evidence,
    JSON.stringify({
      leaderPid: process.pid,
      descendantPid: descendant.pid,
      executable: process.execPath
    })
  )
  descendant.unref()
  await import('../../e2e/fixtures/fake-opencode.mjs')
}
