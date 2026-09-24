import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { seatbeltProfile } from '../../../packages/notebook-network-sandbox/runtime/src/platform/macos-isolation'

it.skipIf(process.platform !== 'darwin')(
  'enforces write denials even under an overlapping writable workspace for opaque analysis code',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'analysis-write-protection-'))
    try {
      const protectedRoot = join(root, 'runtime', 'envs', 'analysis')
      await mkdir(protectedRoot, { recursive: true })
      const protectedFile = join(protectedRoot, 'package.py')
      await writeFile(protectedFile, 'original')
      const profile = seatbeltProfile({
        command: '',
        gatewayPort: 3128,
        gatewayCredentials: { username: 'test', password: 'test' },
        shell: '/bin/sh',
        env: {},
        filesystem: {
          privateRoot: root,
          readOnlyRoots: [protectedRoot, process.execPath],
          readWriteRoots: [root],
          deniedReadRoots: [],
          deniedWriteRoots: [join(root, 'runtime', 'envs')]
        }
      })
      const result = await promisify(execFile)('/usr/bin/sandbox-exec', [
        '-p',
        profile,
        process.execPath,
        '-e',
        `
      const fs = require('node:fs');
      const path = require('node:path');
      fs.writeFileSync(path.join(process.argv[1], 'result.txt'), 'analysis result');
      try { fs.writeFileSync(path.join(process.argv[1], 'runtime', 'envs', 'analysis', 'package.py'), 'bypass'); process.exit(2) }
      catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; }
    `,
        root
      ])
      expect(result.stderr).toBe('')
      expect(await readFile(protectedFile, 'utf8')).toBe('original')
      expect(await readFile(join(root, 'result.txt'), 'utf8')).toBe('analysis result')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)
