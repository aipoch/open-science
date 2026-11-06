/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createRequire } from 'node:module'
import { setTimeout as pause } from 'node:timers/promises'

const defaultNative = createRequire(import.meta.url)('@aipoch/process-tree-native')

// Teardown itself is an ownership boundary: keep the code tree until the kernel proves every
// process launched from this unique fixture root is gone. A failed UI receipt must not orphan
// Electron helpers with deleted executable paths and poison later conservative process scans.
export async function cleanupOwnedFixture(root, native = defaultNative) {
  const owned = new Map()
  const started = Date.now()
  const deadline = started + 8000
  let emptyPasses = 0
  while (Date.now() < deadline) {
    const table = native.listDarwinProcesses()
    if (!table?.complete)
      throw new Error(`Fixture cleanup cannot prove process-table completeness; preserving ${root}`)
    for (const row of table.processes) {
      let executablePath
      try {
        executablePath = native.getDarwinProcessExecutable(row.pid, row.uniqueId)
      } catch {
        throw new Error(`Fixture cleanup cannot inspect PID ${row.pid}; preserving ${root}`)
      }
      if (executablePath?.startsWith(root + '/'))
        owned.set(row.uniqueId, { ...row, executablePath })
    }
    let live = 0
    for (const [generation, row] of owned) {
      const current = native.getDarwinProcess(row.pid)
      if (!current || current.uniqueId !== generation) {
        owned.delete(generation)
        continue
      }
      const executablePath = native.getDarwinProcessExecutable(row.pid, generation)
      if (!executablePath?.startsWith(root + '/'))
        throw new Error(
          `Owned fixture PID ${row.pid} is still alive but its executable cannot be confirmed; preserving ${root}`
        )
      native.signalDarwinProcess(
        row.pid,
        generation,
        Date.now() - started < 1000 ? 15 : 9,
        executablePath
      )
      live++
    }
    if (live === 0) {
      if (++emptyPasses >= 2) return
    } else emptyPasses = 0
    await pause(50)
  }
  throw new Error(`Fixture processes did not exit within the cleanup budget; preserving ${root}`)
}
