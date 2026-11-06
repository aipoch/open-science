import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { closeMacInstallationProcesses } from './mac-installation-processes'

// Boundary fixtures only: these shell/sleep processes are not Notebook/REPL/sandbox tasks or
// signed app-update acceptance. Every termination target is created in this isolated directory.
it.runIf(process.platform === 'darwin')(
  'closes two isolated installation peers and their external workers while preserving another installation',
  async () => {
    const native = createRequire(__filename)(
      '@aipoch/process-tree-native'
    ) as typeof import('@aipoch/process-tree-native')
    const directory = await mkdtemp(join(tmpdir(), 'mac-installation-close-'))
    const children: ChildProcess[] = []
    const workers: Array<{ pid: number; uniqueId: string }> = []
    try {
      const root = join(directory, 'Science.app')
      const foreign = join(directory, 'Science-other.app')
      const source = join(directory, 'worker.c')
      const binary = join(directory, 'worker')
      await writeFile(
        source,
        `#include <signal.h>
#include <stdio.h>
#include <unistd.h>
int main(void) {
  signal(SIGTERM, SIG_IGN);
  pid_t pid = fork();
  if (pid < 0) return 2;
  if (pid == 0) { execl("/bin/sleep", "sleep", "30", (char *)0); return 3; }
  printf("%d\\n", pid); fflush(stdout);
  for (;;) pause();
}`
      )
      execFileSync('/usr/bin/clang', [source, '-o', binary], { timeout: 10_000 })
      for (const appRoot of [root, foreign]) {
        await mkdir(join(appRoot, 'Contents/MacOS'), { recursive: true })
        await copyFile(binary, join(appRoot, 'Contents/MacOS/worker'))
      }
      const start = async (appRoot: string): Promise<ChildProcess> => {
        const child = spawn(join(appRoot, 'Contents/MacOS/worker'), [], {
          stdio: ['ignore', 'pipe', 'pipe']
        })
        children.push(child)
        const data = await Promise.race([
          once(child.stdout!, 'data'),
          once(child, 'exit').then(() => {
            throw new Error('Fixture exited before ready')
          })
        ])
        const pid = Number(String(data[0]).trim())
        const identity = native.getDarwinProcess(pid)
        expect(identity).toBeTruthy()
        workers.push({ pid, uniqueId: identity!.uniqueId })
        return child
      }
      const first = await start(root)
      const second = await start(root)
      const other = await start(foreign)
      const foreignIdentity = native.getDarwinProcess(other.pid!)!
      const started = Date.now()
      const result = await closeMacInstallationProcesses(await realpath(root), {
        excludedProcessIds: [],
        timeoutMs: 1000,
        deadlineAt: started + 4000
      })
      expect(result.forced).toEqual(
        expect.arrayContaining([first.pid, second.pid, workers[0].pid, workers[1].pid])
      )
      expect(Date.now() - started).toBeLessThan(4000)
      expect(native.getDarwinProcess(first.pid!)).toBeNull()
      expect(native.getDarwinProcess(second.pid!)).toBeNull()
      expect(native.getDarwinProcess(other.pid!)?.uniqueId).toBe(foreignIdentity.uniqueId)
      expect(native.getDarwinProcess(workers[2].pid)?.uniqueId).toBe(workers[2].uniqueId)
    } finally {
      // Cleanup uses only generations captured from processes created above.
      for (const worker of workers)
        if (native.getDarwinProcess(worker.pid)?.uniqueId === worker.uniqueId)
          native.signalDarwinProcess(worker.pid, worker.uniqueId, 9, '/bin/sleep')
      for (const child of children) {
        if (child.exitCode !== null || child.signalCode !== null) continue
        const exited = once(child, 'exit')
        child.kill('SIGKILL')
        await exited
      }
      await rm(directory, { recursive: true, force: true })
    }
  },
  15_000
)
