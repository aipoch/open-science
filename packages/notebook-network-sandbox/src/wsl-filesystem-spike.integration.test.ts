import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

import {
  defaultRunGuest,
  probeWslFilesystemSandboxReuse,
  wslGuestArguments
} from '../runtime/src/platform/wsl-filesystem-spike.js'

const distro = process.env.OPEN_SCIENCE_WSL_DISTRO
const user = process.env.OPEN_SCIENCE_WSL_USER
const configuredWindowsIt = it.runIf(process.platform === 'win32' && Boolean(distro && user))

configuredWindowsIt('reports repeatable Windows + WSL2 filesystem sandbox evidence', async () => {
  const result = await probeWslFilesystemSandboxReuse({
    workspace: resolve('.'),
    distro: distro!,
    user: user!
  })

  console.info(`WSL_FILESYSTEM_SPIKE_RESULT=${JSON.stringify(result)}`)
  expect(result.kind).toBe('ready')
  if (result.kind !== 'ready') throw new Error(`Configured WSL spike failed: ${result.code}`)
  expect(Object.values(result.evidence)).not.toContain(false)
})

configuredWindowsIt(
  'cleans an exactly receipted hung guest command without stopping the distro',
  async () => {
    const tokenCapture = `/tmp/open-science-filesystem-test-${randomUUID()}.token`
    try {
      const runError = await defaultRunGuest({
        distro: distro!,
        user: user!,
        args: [
          '/bin/sh',
          '-c',
          'printf %s "$OPEN_SCIENCE_FILESYSTEM_TOKEN" > "$1"; setsid /bin/sh -c \'trap "" TERM; while :; do sleep 1; done\' & trap "" TERM; while :; do sleep 1; done',
          'hung-probe',
          tokenCapture
        ],
        timeoutMs: 300
      }).then(
        () => undefined,
        (error: unknown) => error
      )
      expect(runError).toBeDefined()

      const token = execFileSync(
        'wsl.exe',
        wslGuestArguments({
          distro: distro!,
          user: user!,
          args: ['/bin/sh', '-c', 'cat "$1"', 'read-token', tokenCapture]
        }),
        { encoding: 'utf8', windowsHide: true }
      ).trim()
      expect(token).toMatch(/^open-science-filesystem-[0-9a-f-]{36}$/u)

      const cleanupEvidence = execFileSync(
        'wsl.exe',
        wslGuestArguments({
          distro: distro!,
          user: user!,
          args: [
            '/bin/sh',
            '-c',
            String.raw`token=$1; receipt=$2; alive=0
for environment in /proc/[0-9]*/environ; do
  [ -r "$environment" ] || continue
  tr '\0' '\n' < "$environment" 2>/dev/null | grep -Fqx "OPEN_SCIENCE_FILESYSTEM_TOKEN=$token" && alive=$((alive + 1))
done
if [ -e "$receipt" ]; then receipt_count=1; else receipt_count=0; fi
printf 'alive=%s;receipt=%s\n' "$alive" "$receipt_count"`,
            'verify-cleanup',
            token,
            `/tmp/.open-science-filesystem-${token}.receipt`
          ]
        }),
        { encoding: 'utf8', windowsHide: true }
      ).trim()
      expect(cleanupEvidence).toBe('alive=0;receipt=0')
      expect(() =>
        execFileSync(
          'wsl.exe',
          wslGuestArguments({ distro: distro!, user: user!, args: ['/bin/true'] }),
          { windowsHide: true }
        )
      ).not.toThrow()
    } finally {
      execFileSync(
        'wsl.exe',
        wslGuestArguments({
          distro: distro!,
          user: user!,
          args: ['/bin/rm', '-f', '--', tokenCapture]
        }),
        { windowsHide: true }
      )
    }
  },
  15_000
)
