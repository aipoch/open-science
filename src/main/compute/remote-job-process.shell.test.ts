import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { remoteJobPidTerminationFunctionLines } from './remote-job-process'

const shell = (): string | undefined => {
  if (process.platform !== 'win32') return '/bin/sh'
  try {
    // Git for Windows supplies a POSIX shell; do not accidentally invoke the WSL launcher.
    let directory = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim()
    while (dirname(directory) !== directory) {
      const candidate = join(directory, 'usr', 'bin', 'bash.exe')
      if (existsSync(candidate)) return candidate
      directory = dirname(directory)
    }
  } catch {
    /* The shell tests remain available on POSIX CI. */
  }
  return undefined
}
const executable = shell()

it.skipIf(!executable).each([true, false])(
  'checks a completion receipt published during the liveness probe (receipt=%s)',
  (completed) => {
    const directory = mkdtempSync(join(tmpdir(), 'scope-receipt-race-'))
    try {
      writeFileSync(join(directory, 'execution.scope'), 'supervisor-v1 test-boot 4321 10\n')
      const script = [
        ...remoteJobPidTerminationFunctionLines(),
        'workdir=$PWD',
        'scope_required=1',
        `cat() { if [ "$1" = /proc/sys/kernel/random/boot_id ]; then echo test-boot; else IFS= read -r content < "$1"; printf "%s\\n" "$content"; fi; }`,
        `job_pid_is_owned() { ${completed ? 'printf "%s\\n" "$scope_marker" > "$workdir/execution.stopped";' : ''} return 3; }`,
        'job_scope_state 4321',
        'printf "result:%s\\n" "$?"'
      ].join('\n')
      const output = execFileSync(executable!, ['-c', script], {
        cwd: directory,
        encoding: 'utf8',
        timeout: 5000
      })
      expect(output.trim()).toBe(`result:${completed ? 3 : 2}`)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
)
