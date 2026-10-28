import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { DEFAULT_NOTEBOOK_NETWORK_SETTINGS } from '../../shared/notebook-network'
import { NotebookNetworkSandboxOwner } from './network-sandbox-owner'

it
  .skipIf(
    (process.platform !== 'darwin' && process.platform !== 'linux') ||
      (process.platform === 'linux' && process.env.VITEST_PORTABLE_CI === '1')
  )
  .each([
    { restrictFolders: true, broadGrant: false },
    { restrictFolders: true, broadGrant: true },
    { restrictFolders: false, broadGrant: false }
  ])(
  'reads Skill references without granting writes (%j)',
  async ({ restrictFolders, broadGrant }) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'notebook-skill-read-')))
    const configRoot = join(root, 'Application data 科研')
    const workspace = join(root, 'workspace')
    const skillRoots = [
      join(configRoot, 'codex', 'skills'),
      join(configRoot, 'codex-subscription', 'skills'),
      join(configRoot, 'opencode', 'config', 'opencode', 'skills'),
      join(
        configRoot,
        'runtime-support',
        'agent-skills',
        'claude',
        'v1',
        'revision',
        '.claude',
        'skills'
      ),
      join(configRoot, 'codebuddy', 'skill-runtime', '.claude', 'skills')
    ]
    const references = skillRoots.map((path) => join(path, 'research', 'references', 'guide.md'))
    await mkdir(workspace)
    for (const reference of references) {
      await mkdir(dirname(reference), { recursive: true })
      // Deliberately writable on disk: isolation, not chmod, must enforce read-only access.
      await writeFile(reference, 'Skill reference')
    }
    const privateFile = join(configRoot, 'codex', 'auth.json')
    await writeFile(privateFile, 'private')
    const escaped = join(dirname(references[0]!), 'outside.md')
    await symlink(privateFile, escaped)
    const owner = new NotebookNetworkSandboxOwner({
      configRoot,
      resourceRoot: resolve('packages/notebook-network-sandbox/vendor'),
      temporaryRoot: join(root, 'commands'),
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      getFolderRestrictionEnabled: async () => restrictFolders,
      getGrantedLocalRoots: async () =>
        broadGrant ? [{ id: 'config', name: 'config', path: configRoot, access: 'rw' }] : [],
      persistAlwaysAllow: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      requestDecision: async () => 'deny'
    })
    const script = `
    const fs = require('node:fs');
    const assert = require('node:assert/strict');
    for (const path of ${JSON.stringify(references)}) {
      assert.equal(fs.readFileSync(path, 'utf8'), 'Skill reference');
      assert.throws(() => fs.writeFileSync(path, 'changed'));
      assert.throws(() => fs.writeFileSync(path + '.new', 'new'));
      assert.throws(() => fs.unlinkSync(path));
    }
    ${
      restrictFolders && !broadGrant
        ? `
      assert.throws(() => fs.readFileSync(${JSON.stringify(privateFile)}));
      assert.throws(() => fs.readFileSync(${JSON.stringify(escaped)}));
    `
        : ''
    }
    console.log('READ_OK_WRITE_DENIED');
  `
    try {
      const wrapped = await owner.wrap({
        executable: process.execPath,
        args: ['-e', script],
        env: { PATH: process.env.PATH },
        cwd: workspace,
        commandText: 'read managed Skill references',
        sessionId: 'skill-session',
        projectId: 'skill-project',
        runtime: 'repl',
        filesystem: {
          readOnlyRoots: [dirname(await realpath(process.execPath))],
          readWriteRoots: [workspace],
          deniedReadRoots: [],
          deniedWriteRoots: []
        }
      })
      let started = false
      try {
        const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
          (resolve, reject) => {
            const child = spawn(wrapped.executable, [...wrapped.args], {
              cwd: workspace,
              env: wrapped.env
            })
            let stdout = ''
            let stderr = ''
            child.once('spawn', () => {
              started = true
            })
            child.once('error', reject)
            child.stdout.on('data', (chunk) => {
              stdout += chunk
            })
            child.stderr.on('data', (chunk) => {
              stderr += chunk
            })
            child.once('close', (code) => resolve({ code, stdout, stderr }))
          }
        )
        expect(result.code, result.stderr).toBe(0)
        expect(result.stdout).toContain('READ_OK_WRITE_DENIED')
      } finally {
        await wrapped.cleanup(started ? 'exit' : 'spawn-failed', { processesTerminated: true })
      }
      for (const reference of references)
        expect(await readFile(reference, 'utf8')).toBe('Skill reference')
    } finally {
      await owner.dispose()
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000
)
