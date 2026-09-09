import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  applyComputeEnvironment,
  computeEnvironmentPath,
  validateComputeEnvironmentName
} from './compute-environment'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Compute environment resolution', () => {
  it('leaves jobs without a named environment byte-for-byte unchanged', () => {
    const command = '#!/usr/bin/env bash\nprintf "hello\\n"\n'
    expect(applyComputeEnvironment(command, undefined)).toBe(command)
  })

  it('sources the host-scoped activation file before a direct workload', () => {
    const command = applyComputeEnvironment('python analysis.py', 'rna.gpu-1')

    expect(command).toContain(
      'OPEN_SCIENCE_ENV_FILE="$HOME/.open-science/environments/rna.gpu-1.sh"'
    )
    expect(command).toContain('. "$OPEN_SCIENCE_ENV_FILE"')
    expect(command.indexOf('. "$OPEN_SCIENCE_ENV_FILE"')).toBeLessThan(
      command.indexOf('python analysis.py')
    )
  })

  it('keeps scheduler directives ahead of the activation preamble', () => {
    const command = applyComputeEnvironment(
      [
        '#!/usr/bin/env bash',
        '#SBATCH --partition=debug',
        '#SBATCH --time=00:05:00',
        '',
        'python analysis.py'
      ].join('\n'),
      'cpu'
    )

    expect(command.indexOf('#SBATCH --time=00:05:00')).toBeLessThan(
      command.indexOf('OPEN_SCIENCE_ENV_FILE=')
    )
    expect(command.indexOf('OPEN_SCIENCE_ENV_FILE=')).toBeLessThan(
      command.indexOf('python analysis.py')
    )
  })

  it.skipIf(process.platform === 'win32')(
    'fails with the expected path and actionable Skill guidance when activation is absent',
    () => {
      const home = mkdtempSync(join(tmpdir(), 'compute-environment-home-'))
      roots.push(home)
      const command = applyComputeEnvironment('run-science', 'protein-gpu')
      const result = spawnSync('bash', ['-c', command], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home }
      })

      expect(command).toContain('~/.open-science/environments/protein-gpu.sh')
      expect(command).toContain('compute-env-setup Skill')
      expect(command).toContain('exit 78')
      expect(result.status).toBe(78)
      expect(result.stderr).toContain('~/.open-science/environments/protein-gpu.sh')
      expect(result.stderr).toContain('os-compute-env-setup')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'stops before the workload when the activation file returns non-zero',
    () => {
      const home = mkdtempSync(join(tmpdir(), 'compute-environment-home-'))
      roots.push(home)
      const directory = join(home, '.openscience', 'environments')
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'broken.sh'), 'false\nexport SHOULD_NOT_EXIST=yes\n')

      const result = spawnSync(
        'bash',
        ['-c', applyComputeEnvironment('printf workload-ran', 'broken')],
        { encoding: 'utf8', env: { ...process.env, HOME: home } }
      )

      expect(result.status).toBe(1)
      expect(result.stdout).toBe('')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'makes a direct named environment available to the workload',
    () => {
      const home = mkdtempSync(join(tmpdir(), 'compute-environment-home-'))
      roots.push(home)
      const directory = join(home, '.openscience', 'environments')
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'working.sh'), 'export COMPUTE_ENV_WITNESS=ready\n')

      const result = spawnSync(
        'bash',
        ['-c', applyComputeEnvironment('printf %s "$COMPUTE_ENV_WITNESS"', 'working')],
        { encoding: 'utf8', env: { ...process.env, HOME: home } }
      )

      expect(result.status).toBe(0)
      expect(result.stdout).toBe('ready')
      expect(result.stderr).toBe('')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'restores the caller shell semantics after successful activation',
    () => {
      const home = mkdtempSync(join(tmpdir(), 'compute-environment-home-'))
      roots.push(home)
      const directory = join(home, '.openscience', 'environments')
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'working.sh'), 'export COMPUTE_ENV_WITNESS=ready\n')

      const result = spawnSync(
        'bash',
        ['-c', applyComputeEnvironment('false\nprintf continued', 'working')],
        { encoding: 'utf8', env: { ...process.env, HOME: home } }
      )

      expect(result.status).toBe(0)
      expect(result.stdout).toBe('continued')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'preserves caller errexit when it was already enabled',
    () => {
      const home = mkdtempSync(join(tmpdir(), 'compute-environment-home-'))
      roots.push(home)
      const directory = join(home, '.openscience', 'environments')
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'working.sh'), 'export COMPUTE_ENV_WITNESS=ready\n')

      const result = spawnSync(
        'bash',
        ['-e', '-c', applyComputeEnvironment('false\nprintf must-not-run', 'working')],
        { encoding: 'utf8', env: { ...process.env, HOME: home } }
      )

      expect(result.status).toBe(1)
      expect(result.stdout).toBe('')
    }
  )

  it.each([
    '../escape',
    '/absolute',
    '.hidden',
    'name with spaces',
    'name;echo bad',
    '',
    'a'.repeat(65)
  ])('rejects unsafe environment name %j', (name) =>
    expect(() => validateComputeEnvironmentName(name)).toThrow(/Compute environment/u)
  )

  it.each(['python', 'cuda-12.4', 'rna_seq', 'R4'])('accepts environment name %j', (name) => {
    expect(() => validateComputeEnvironmentName(name)).not.toThrow()
    expect(computeEnvironmentPath(name)).toBe(`~/.open-science/environments/${name}.sh`)
  })
})
