import { createHash } from 'node:crypto'
import { execFile, spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { zipSync } from 'fflate'
import { describe, expect, it, vi } from 'vitest'

import { PIP_WHEEL_EVIDENCE_SCRIPT } from './pip-wheel-evidence'
import { EnvironmentLockCaptureOwner } from './environment-lock'

const python = process.env.OPEN_SCIENCE_TEST_PYTHON
const mockNetwork = String.raw`
import base64, io, json, sys, urllib.request
responses = json.loads(sys.argv[3])
class Response(io.BytesIO):
    def __init__(self, url):
        self.url = url
        super().__init__(base64.b64decode(responses[url]))
class Opener:
    def open(self, url, **kwargs):
        return Response(url)
urllib.request.build_opener = lambda *args: Opener()
`

describe('legacy pip wheel evidence', () => {
  it
    .skipIf(!process.env.RUN_KERNEL || !python || process.platform === 'win32')
    .each(['bundled', 'current'])(
    'recovers a real %s pip installation with generated entry points only when their bytes match',
    async (installer) => {
      const root = await mkdtemp(join(tmpdir(), 'wheel-entry-points-'))
      const prefix = join(root, 'env')
      const execute = promisify(execFile)
      try {
        await execute(python!, ['-I', '-m', 'venv', prefix], { timeout: 30_000 })
        const interpreter = join(
          prefix,
          process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
        )
        const { stdout: siteOutput } = await execute(interpreter, [
          '-I',
          '-c',
          'import sysconfig; print(sysconfig.get_path("purelib"))'
        ])
        const site = siteOutput.trim()
        if (installer === 'current') {
          const { stdout: pipPath } = await execute(python!, [
            '-I',
            '-c',
            'import pathlib, pip; print(pathlib.Path(pip.__file__).parent)'
          ])
          await rm(join(site, 'pip'), { recursive: true, force: true })
          await cp(pipPath.trim(), join(site, 'pip'), { recursive: true })
        }
        const dist = 'entry_probe-1.0.dist-info'
        const payload: Record<string, Uint8Array> = {
          'entry_probe.py': Buffer.from('def main():\n    return 0\n'),
          [dist + '/METADATA']: Buffer.from(
            'Metadata-Version: 2.1\nName: entry-probe\nVersion: 1.0\n'
          ),
          [dist + '/WHEEL']: Buffer.from(
            'Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n'
          ),
          [dist + '/entry_points.txt']: Buffer.from(
            '[console_scripts]\nentry-probe = entry_probe:main\n[gui_scripts]\nentry-probe-gui = entry_probe:main\n'
          )
        }
        payload[dist + '/RECORD'] = Buffer.from(
          [...Object.keys(payload), dist + '/RECORD'].map((path) => `${path},,`).join('\n')
        )
        const wheel = Buffer.from(zipSync(payload))
        const filename = 'entry_probe-1.0-py3-none-any.whl'
        const wheelPath = join(root, filename)
        await writeFile(wheelPath, wheel)
        await execute(
          interpreter,
          ['-I', '-m', 'pip', 'install', '--no-index', '--no-deps', wheelPath],
          {
            timeout: 30_000,
            env: {
              ...process.env,
              PIP_CONFIG_FILE: process.platform === 'win32' ? 'nul' : '/dev/null'
            }
          }
        )
        // The local wheel avoids network access; remove its local-install marker to model an
        // older registry installation that has no download report.
        await rm(join(site, dist, 'direct_url.json'))
        const recordPath = join(site, dist, 'RECORD')
        const record = (await readFile(recordPath, 'utf8'))
          .split('\n')
          .filter((line) => !line.startsWith(dist + '/direct_url.json,'))
          .join('\n')
        await writeFile(recordPath, record)
        const url = 'https://files.pythonhosted.org/' + filename
        const sha256 = createHash('sha256').update(wheel).digest('hex')
        const responses = {
          'https://pypi.org/pypi/entry-probe/1.0/json': Buffer.from(
            JSON.stringify({
              urls: [
                {
                  filename,
                  url,
                  packagetype: 'bdist_wheel',
                  size: wheel.length,
                  digests: { sha256 }
                }
              ]
            })
          ).toString('base64'),
          [url]: wheel.toString('base64')
        }
        const probe = async (): Promise<unknown[]> => {
          const result = await execute(
            interpreter,
            [
              '-I',
              '-c',
              mockNetwork + '\n' + PIP_WHEEL_EVIDENCE_SCRIPT,
              prefix,
              JSON.stringify(['python:entry-probe']),
              JSON.stringify(responses)
            ],
            { timeout: 15_000 }
          )
          return JSON.parse(result.stdout).install
        }
        expect(await probe()).toHaveLength(1)
        const script = join(
          prefix,
          process.platform === 'win32' ? 'Scripts/entry-probe.exe' : 'bin/entry-probe'
        )
        const original = await readFile(script)
        await writeFile(script, Buffer.concat([original, Buffer.from('\n# modified\n')]))
        expect(await probe()).toHaveLength(0)
        await writeFile(script, original)
        await writeFile(
          recordPath,
          record
            .split('\n')
            .filter((line) => !line.startsWith('../../../bin/entry-probe,'))
            .join('\n')
        )
        expect(await probe()).toHaveLength(0)
        await writeFile(recordPath, record + '\n../../../bin/unexpected,,\n')
        expect(await probe()).toHaveLength(0)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    60_000
  )
  it.each(['matched', 'unavailable', 'unused', 'changed-during-probe', 'retry'] as const)(
    'recovers only a required %s pip package through the environment capture owner',
    async (scenario) => {
      const root = await mkdtemp(join(tmpdir(), 'legacy-pip-lock-'))
      const dist = join(root, 'lib/python3.12/site-packages/example_lib-1.0.dist-info')
      const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
      try {
        await mkdir(dist, { recursive: true })
        await writeFile(join(dist, 'METADATA'), 'Name: example-lib\nVersion: 1.0\n')
        await writeFile(join(dist, 'RECORD'), 'example_lib/__init__.py,sha256=test,1\n')
        await writeFile(join(dist, 'INSTALLER'), 'pip\n')
        await mkdir(join(root, 'conda-meta'))
        await writeFile(join(root, 'conda-meta/history'), 'baseline')
        let probeCount = 0
        const execute = vi.fn(async (argv: string[]) => {
          if (argv.includes('-c')) {
            probeCount++
            if (scenario === 'changed-during-probe')
              await writeFile(join(dist, 'RECORD'), 'changed while downloading\n')
          }
          return argv.includes('-c')
            ? JSON.stringify({
                version: '1',
                install:
                  scenario === 'unavailable' || (scenario === 'retry' && probeCount === 1)
                    ? []
                    : [
                        {
                          metadata: { name: 'example-lib', version: '1.0' },
                          download_info: {
                            url: 'https://files.pythonhosted.org/example_lib-1.0-py3-none-any.whl',
                            archive_info: { hashes: { sha256: 'a'.repeat(64) } }
                          }
                        }
                      ]
              })
            : JSON.stringify([
                {
                  name: 'python',
                  version: '3.12',
                  url: 'https://conda.example/python.conda',
                  md5: '1'.repeat(32)
                },
                {
                  name: 'pip',
                  version: '25.0',
                  url: 'https://conda.example/pip.conda',
                  md5: '2'.repeat(32)
                },
                { name: 'example-lib', version: '1.0', channel: 'pypi' }
              ])
        })
        const owner = new EnvironmentLockCaptureOwner()
        const capture = (): ReturnType<EnvironmentLockCaptureOwner['capture']> =>
          owner.capture(
            {
              language: 'python',
              environmentName: 'default-python',
              runtimeSource: 'managed',
              condaPrefix: root
            },
            {
              schemaVersion: 1,
              captureKind: 'completed-run',
              capturedAt: '2026-09-05T00:00:00Z',
              installedInventory: {
                capturedAt: '2026-09-05T00:00:00Z',
                source: 'full-scan',
                validation: 'full-scan'
              },
              kernelKind: 'python',
              environmentName: 'default-python',
              runtimeSource: 'managed',
              inventorySources: ['kernel-native', 'interpreter-native'],
              complete: true,
              captureStatus: 'complete',
              packages: [
                {
                  name: 'example-lib',
                  version: '1.0',
                  versionStatus: 'known',
                  ecosystem: 'python',
                  evidenceSources: ['python-kernel-modules', 'python-importlib-metadata'],
                  loadedState: scenario === 'unused' ? 'installed-only' : 'loaded'
                }
              ]
            },
            { micromamba: 'micromamba', execute, environmentFingerprint: 'unchanged' }
          )
        const result = await capture()
        expect(result, JSON.stringify(result)).toMatchObject({
          state: 'captured',
          captureStatus: ['unavailable', 'changed-during-probe', 'retry'].includes(scenario)
            ? 'partial'
            : 'complete'
        })
        expect(execute.mock.calls.some(([args]) => args.includes('-c'))).toBe(scenario !== 'unused')
        if (scenario === 'matched') {
          expect(
            JSON.parse(await readFile(join(root, '.open-science-pip/example-lib.json'), 'utf8'))
          ).toMatchObject({ sha256: 'a'.repeat(64) })
        }
        if (scenario === 'retry') {
          expect(await capture()).toMatchObject({ captureStatus: 'partial' })
          expect(probeCount).toBe(1)
          now.mockReturnValue(61_001)
          expect(await capture()).toMatchObject({ captureStatus: 'complete' })
          expect(probeCount).toBe(2)
          expect(await capture()).toMatchObject({ captureStatus: 'complete' })
          expect(probeCount).toBe(2)
        }
      } finally {
        now.mockRestore()
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  it
    .skipIf(!process.env.RUN_KERNEL || !python)
    .each([
      'matched',
      'modified',
      'extra-file',
      'direct-url',
      'hash-mismatch',
      'offline',
      'foreign-origin',
      'data-relocation',
      'wrong-platform',
      'purelib',
      'platlib',
      'relocated-modified',
      'relocated-collision',
      'relocated-traversal'
    ])('checks real wheel bytes for %s installation evidence', async (scenario) => {
    const prefix = await mkdtemp(join(tmpdir(), 'wheel-byte-verification-'))
    const site = join(prefix, 'lib/python3.12/site-packages')
    const dist = 'example_lib-1.0.dist-info'
    try {
      const payload: Record<string, Uint8Array> = {
        'example_lib/__init__.py': Buffer.from('value = 42\n'),
        [dist + '/METADATA']: Buffer.from('Name: example-lib\nVersion: 1.0\n'),
        [dist + '/WHEEL']: Buffer.from('Wheel-Version: 1.0\nTag: py3-none-any\n')
      }
      if (scenario === 'data-relocation')
        payload['example_lib-1.0.data/scripts/tool'] = Buffer.from('tool')
      const record =
        Object.keys(payload)
          .map((path) => `${path},,`)
          .join('\n') + `\n${dist}/RECORD,,\n`
      for (const [path, bytes] of Object.entries({
        ...payload,
        [dist + '/RECORD']: Buffer.from(record)
      })) {
        await mkdir(join(site, path, '..'), { recursive: true })
        await writeFile(join(site, path), bytes)
      }
      await writeFile(join(site, dist, 'INSTALLER'), 'pip\n')
      if (scenario === 'modified')
        await writeFile(join(site, 'example_lib/__init__.py'), 'value = 99\n')
      if (scenario === 'extra-file')
        await writeFile(join(site, dist, 'RECORD'), record + 'extra.py,,\n')
      if (scenario === 'direct-url') await writeFile(join(site, dist, 'direct_url.json'), '{}')
      const wheelPayload: Record<string, Uint8Array> = {
        ...payload,
        [dist + '/RECORD']: Buffer.from(record)
      }
      if (scenario === 'purelib' || scenario === 'platlib' || scenario.startsWith('relocated-')) {
        const category = scenario === 'platlib' ? 'platlib' : 'purelib'
        const path =
          scenario === 'relocated-traversal'
            ? '../example_lib/__init__.py'
            : 'example_lib/__init__.py'
        wheelPayload[`example_lib-1.0.data/${category}/${path}`] =
          wheelPayload['example_lib/__init__.py']
        if (scenario !== 'relocated-collision') delete wheelPayload['example_lib/__init__.py']
        wheelPayload[dist + '/RECORD'] = Buffer.from(
          Object.keys(wheelPayload)
            .map((path) => `${path},,`)
            .join('\n') + '\n'
        )
      }
      if (scenario === 'relocated-modified')
        await writeFile(join(site, 'example_lib/__init__.py'), 'value = 99\n')
      const wheel = Buffer.from(zipSync(wheelPayload))
      const url =
        scenario === 'foreign-origin'
          ? 'https://private.example/example_lib-1.0-py3-none-any.whl'
          : 'https://files.pythonhosted.org/example_lib-1.0-py3-none-any.whl'
      const sha256 = createHash('sha256').update(wheel).digest('hex')
      const responses = {
        'https://pypi.org/pypi/example-lib/1.0/json': Buffer.from(
          JSON.stringify({
            urls: [
              {
                filename:
                  scenario === 'wrong-platform'
                    ? 'example_lib-1.0-cp312-cp312-win_amd64.whl'
                    : 'example_lib-1.0-py3-none-any.whl',
                url,
                packagetype: 'bdist_wheel',
                size: wheel.length,
                digests: { sha256: scenario === 'hash-mismatch' ? '0'.repeat(64) : sha256 }
              }
            ]
          })
        ).toString('base64'),
        [url]: wheel.toString('base64')
      }
      const result = spawnSync(
        python!,
        [
          '-c',
          mockNetwork + '\n' + PIP_WHEEL_EVIDENCE_SCRIPT,
          prefix,
          JSON.stringify(['python:example-lib']),
          JSON.stringify(scenario === 'offline' ? {} : responses)
        ],
        { encoding: 'utf8', timeout: 10_000 }
      )
      expect(result.status, result.stderr).toBe(0)
      const report = JSON.parse(result.stdout)
      const matched = ['matched', 'purelib', 'platlib'].includes(scenario)
      expect(report.install).toHaveLength(matched ? 1 : 0)
      if (matched) expect(report.install[0].download_info.archive_info.hashes.sha256).toBe(sha256)
    } finally {
      await rm(prefix, { recursive: true, force: true })
    }
  })
})
