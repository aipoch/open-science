import { build } from 'esbuild'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { closeMacInstallationProcesses } from './mac-installation-processes'

// Native boundary evidence using REAL service/executor/sandbox work. This intentionally lacks
// Electron, signing and replacement, so passing it never certifies a signed package update.
it.runIf(process.platform === 'darwin')(
  'closes a nonresponding installation host with real Python, REPL and sandboxed Shell work',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mac-real-work-close-')))
    const app = join(root, 'Science.app')
    const executable = join(app, 'Contents/MacOS/host')
    const ready = join(root, 'ready.json')
    const native = createRequire(__filename)(
      '@aipoch/process-tree-native'
    ) as typeof import('@aipoch/process-tree-native')
    let child: ChildProcess | undefined
    let captured: Array<{ pid: number; uniqueId: string; executable: string }> = []
    const errors: string[] = []
    try {
      await mkdir(join(app, 'Contents/MacOS'), { recursive: true })
      await cp(
        join(process.cwd(), 'resources/notebook'),
        join(app, 'Contents/Resources/resources/notebook'),
        { recursive: true }
      )
      const launcher = join(root, 'launcher.c')
      await writeFile(
        launcher,
        `#include <unistd.h>
#include <sys/wait.h>
int main(int argc,char **argv) {
  pid_t child=fork();
  if(child<0) return 2;
  if(child==0) { execv(argv[1],argv+1); return 3; }
  int status; waitpid(child,&status,0); return WIFEXITED(status)?WEXITSTATUS(status):4;
}`
      )
      execFileSync('/usr/bin/clang', [launcher, '-o', executable], { timeout: 10000 })
      const entry = join(root, 'worker.mjs')
      await symlink(join(process.cwd(), 'node_modules'), join(root, 'node_modules'))
      await build({
        entryPoints: [join(process.cwd(), 'src/main/update/fixtures/mac-real-work-host.ts')],
        bundle: true,
        platform: 'node',
        format: 'esm',
        packages: 'external',
        plugins: [
          {
            name: 'source-sandbox-owner',
            setup(build) {
              build.onResolve({ filter: /^@aipoch\/notebook-network-sandbox$/ }, () => ({
                path: join(process.cwd(), 'packages/notebook-network-sandbox/src/index.ts')
              }))
            }
          }
        ],
        banner: {
          js: 'import {createRequire as fixtureRequire} from "node:module"; import {fileURLToPath as fixturePath} from "node:url"; import {dirname as fixtureDirname} from "node:path"; const require=fixtureRequire(import.meta.url); const __filename=fixturePath(import.meta.url); const __dirname=fixtureDirname(__filename);'
        },
        outfile: entry,
        logLevel: 'silent'
      })
      child = spawn(executable, [process.execPath, entry, root, process.cwd(), app], {
        env: { ...process.env, NODE_PATH: join(process.cwd(), 'node_modules') },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      child.stderr!.on('data', (chunk) => errors.push(chunk.toString()))
      const evidence = await new Promise<{
        submissions: Array<{ runId: string }>
        witnesses: Array<{ pid: number }>
      }>((resolve, reject) => {
        const timer = setInterval(() => {
          void readFile(ready, 'utf8')
            .then((value) => {
              clearInterval(timer)
              resolve(JSON.parse(value))
            })
            .catch(() => {})
        }, 100)
        child!.once('exit', () => {
          clearInterval(timer)
          reject(new Error(errors.join('') || 'Real task host exited before ready'))
        })
        setTimeout(() => {
          clearInterval(timer)
          reject(new Error(errors.join('') || 'Real task startup deadline'))
        }, 65000).unref()
      })
      expect(evidence.submissions.every((entry) => Boolean(entry.runId))).toBe(true)
      // Capture the real service host as well as its task witnesses before shutdown. Its
      // inherited stdio can outlive the launcher if a conservative scan rejects cleanup.
      const childIdentity = native.getDarwinProcess(child.pid!)!
      const serviceHosts = native
        .listDarwinProcesses()!
        .processes.filter(
          (entry) => entry.ppid === child!.pid && entry.parentUniqueId === childIdentity.uniqueId
        )
      captured = [
        child.pid!,
        ...serviceHosts.map((entry) => entry.pid),
        ...evidence.witnesses.map((entry) => entry.pid)
      ].map((pid) => {
        const identity = native.getDarwinProcess(pid)!
        expect(identity).toBeTruthy()
        return {
          pid,
          uniqueId: identity.uniqueId,
          executable: native.getDarwinProcessExecutable(pid, identity.uniqueId)!
        }
      })
      await writeFile(join(root, 'persisted-data.json'), JSON.stringify({ scientificValue: 42 }))
      const start = Date.now()
      // Optional local red evidence uses an isolated compiled ancestor module. The normal suite
      // always exercises the current implementation; this cannot turn an update failure green.
      const baselineModule = process.env.OPEN_SCIENCE_MAC_UPDATE_BASELINE_CLOSE
      const exerciseClose: typeof closeMacInstallationProcesses = baselineModule
        ? createRequire(__filename)(baselineModule).closeMacInstallationProcesses
        : closeMacInstallationProcesses
      const result = await exerciseClose(app, {
        excludedProcessIds: [],
        timeoutMs: 1500,
        deadlineAt: start + 5000
      })
      console.log(
        '[MAC REAL WORK CLOSE observation]',
        JSON.stringify({
          captured,
          result,
          current: captured.map((entry) => native.getDarwinProcess(entry.pid)?.uniqueId)
        })
      )
      expect(Date.now() - start).toBeLessThan(5000)
      for (const entry of captured)
        expect(native.getDarwinProcess(entry.pid)?.uniqueId).not.toBe(entry.uniqueId)
      expect(JSON.parse(await readFile(join(root, 'persisted-data.json'), 'utf8'))).toEqual({
        scientificValue: 42
      })
      console.log(
        '[MAC REAL WORK CLOSE]',
        JSON.stringify({
          level: 'native-boundary',
          kinds: ['python', 'repl', 'bash'],
          captured,
          result,
          elapsedMs: Date.now() - start
        })
      )
    } finally {
      const cleanup = async (): Promise<void> => {
        // A startup failure can occur before task witnesses exist. Keep the verified bundle parent
        // alive until native cleanup has captured its actual external-runtime descendants.
        if (child && child.exitCode === null && child.signalCode === null) {
          // Even startup failures must capture descendants while the launcher still proves
          // their ancestry. Do not depend on a successful installation-wide scan for teardown.
          const launcherIdentity = native.getDarwinProcess(child.pid!)
          const table = native.listDarwinProcesses()
          if (!table?.complete)
            throw new Error(`Preserving fixture with unknown process table: ${root}`)
          const family = launcherIdentity ? [launcherIdentity] : []
          for (let cursor = 0; cursor < family.length; cursor++) {
            const parent = family[cursor]
            for (const row of table.processes)
              if (row.ppid === parent.pid && row.parentUniqueId === parent.uniqueId)
                family.push(row)
          }
          for (const row of family) {
            const path = native.getDarwinProcessExecutable(row.pid, row.uniqueId)
            if (path) captured.push({ pid: row.pid, uniqueId: row.uniqueId, executable: path })
            else if (native.getDarwinProcess(row.pid)?.uniqueId === row.uniqueId)
              throw new Error(`Preserving fixture with unknown executable: ${root}`)
          }
          await closeMacInstallationProcesses(app, {
            excludedProcessIds: [],
            timeoutMs: 0,
            deadlineAt: Date.now() + 5000
          }).catch(() => undefined)
        }
        for (const entry of captured)
          if (native.getDarwinProcess(entry.pid)?.uniqueId === entry.uniqueId) {
            try {
              native.signalDarwinProcess(entry.pid, entry.uniqueId, 9, entry.executable)
            } catch (error) {
              if (native.getDarwinProcess(entry.pid)?.uniqueId === entry.uniqueId) throw error
            }
          }
        const cleanupDeadline = Date.now() + 5000
        while (
          captured.some((entry) => native.getDarwinProcess(entry.pid)?.uniqueId === entry.uniqueId)
        ) {
          if (Date.now() >= cleanupDeadline)
            throw new Error(`Preserving fixture with a surviving process: ${root}`)
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
        await rm(root, { recursive: true, force: true })
      }
      try {
        await cleanup()
      } finally {
        child?.stdout?.destroy()
        child?.stderr?.destroy()
        child?.unref()
      }
    }
  },
  90000
)
