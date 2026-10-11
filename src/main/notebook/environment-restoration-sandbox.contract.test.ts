import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { zipSync } from 'fflate'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type {
  NotebookEnvironmentLock,
  NotebookEnvironmentLockComponent,
  NotebookEnvironmentLockFile
} from '@aipoch/environment/contracts'

import { restoreNativeEnvironmentLock } from '@aipoch/environment'
import { sandboxedPackageSpawn } from './package-process-sandbox'

type NativeComponent = Extract<NotebookEnvironmentLockComponent, { ecosystem: 'python' | 'r' }>

const lockWith = (
  component: NativeComponent,
  tool: string,
  packageName: string
): NotebookEnvironmentLock => ({
  schemaVersion: 1,
  format: 'environment-lock-bundle',
  kernelKind: component.ecosystem,
  environmentName: `default-${component.ecosystem}`,
  components: [
    {
      ecosystem: 'conda',
      format: 'conda-explicit-md5',
      resolution: 'locked',
      explicitLock:
        '@EXPLICIT\nhttps://example.test/package.conda#0123456789abcdef0123456789abcdef\n',
      packages: [component.ecosystem === 'python' ? 'python' : 'r-base', tool]
    },
    component
  ],
  untrackedPackages: [`${component.ecosystem}:${packageName}`]
})

const file = (path: string, content: string): NotebookEnvironmentLockFile => ({
  path,
  content,
  checksum: '0'.repeat(64)
})

describe('native Environment lock restoration', () => {
  it.skipIf(!process.env.RUN_KERNEL || !process.env.OPEN_SCIENCE_TEST_PYTHON)(
    'installs a hashed wheel into the isolated interpreter despite ambient pip configuration',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'native-lock-isolation-'))
      const prefix = join(root, 'env')
      const execute = promisify(execFile)
      try {
        await execute(process.env.OPEN_SCIENCE_TEST_PYTHON!, ['-I', '-m', 'venv', prefix], {
          timeout: 30_000
        })
        const wheels = join(root, 'wheels')
        const outside = join(root, 'outside')
        await mkdir(wheels)
        await mkdir(outside)
        await writeFile(join(outside, 'marker'), 'untouched')
        const config = join(root, 'pip.conf')
        await writeFile(config, `[install]\ntarget = ${outside}\ndry-run = true\n`)
        const payload: Record<string, Uint8Array> = {
          'lock_probe.py': Buffer.from('VALUE = 42\n'),
          'lock_probe-1.0.dist-info/METADATA': Buffer.from(
            'Metadata-Version: 2.1\nName: lock-probe\nVersion: 1.0\n'
          ),
          'lock_probe-1.0.dist-info/WHEEL': Buffer.from(
            'Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n'
          )
        }
        payload['lock_probe-1.0.dist-info/RECORD'] = Buffer.from(
          [...Object.keys(payload), 'lock_probe-1.0.dist-info/RECORD']
            .map((path) => `${path},,`)
            .join('\n') + '\n'
        )
        const wheel = Buffer.from(zipSync(payload))
        await writeFile(join(wheels, 'lock_probe-1.0-py3-none-any.whl'), wheel)
        const hash = createHash('sha256').update(wheel).digest('hex')
        await restoreNativeEnvironmentLock({
          prefix,
          locksRoot: join(root, 'locks'),
          lock: lockWith(
            {
              ecosystem: 'python',
              format: 'pip-requirements',
              resolution: 'locked',
              files: [file('requirements.lock', `lock-probe==1.0 --hash=sha256:${hash}\n`)]
            },
            'pip',
            'lock-probe'
          ),
          inheritedEnv: {
            PIP_TARGET: outside,
            PIP_DRY_RUN: '1',
            PIP_CONFIG_FILE: config,
            PIP_NO_INDEX: '1',
            PIP_FIND_LINKS: wheels,
            PYTHONHOME: outside,
            PYTHONPATH: outside
          },
          spawn: sandboxedPackageSpawn({
            request: { language: 'python', packages: ['lock-probe'], workspaceCwd: root },
            storageRoot: root,
            runtimeRoot: root,
            processSandbox: {
              wrap: async (invocation) => {
                expect(invocation.env.PIP_CONFIG_FILE).toBe(
                  process.platform === 'win32' ? 'nul' : '/dev/null'
                )
                expect(invocation.env.PIP_REPORT).toBeDefined()
                expect(invocation.filesystem.readWriteRoots).toContain(
                  dirname(invocation.env.PIP_REPORT!)
                )
                return {
                  executable: invocation.executable,
                  args: invocation.args,
                  env: invocation.env,
                  annotateStderr: (stderr) => stderr,
                  cleanup: vi.fn()
                }
              }
            }
          })
        })
        const python = join(
          prefix,
          process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
        )
        const result = await execute(python, [
          '-I',
          '-c',
          'import lock_probe; print(lock_probe.VALUE); print(lock_probe.__file__)'
        ])
        expect(result.stdout).toContain('42\n')
        expect(result.stdout).toContain(prefix)
        expect(await readdir(outside)).toEqual(['marker'])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    60_000
  )
})
