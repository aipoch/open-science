import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { classifyChanges, parseNameStatus } from './classify-pr-changes.mjs'

describe('pull request change classification', () => {
  it('publishes a Git revision plan for GitHub Actions callers', () => {
    const root = mkdtempSync(join(tmpdir(), 'pr-change-classifier-'))
    const output = join(root, 'github-output')
    const summary = join(root, 'github-summary')

    try {
      execFileSync('git', ['init', '--quiet'], { cwd: root })
      execFileSync('git', ['config', 'user.email', 'ci@example.com'], { cwd: root })
      execFileSync('git', ['config', 'user.name', 'CI Test'], { cwd: root })
      writeFileSync(join(root, 'README.md'), '# fixture\n')
      execFileSync('git', ['add', 'README.md'], { cwd: root })
      execFileSync('git', ['commit', '--quiet', '-m', 'initial'], { cwd: root })
      const base = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8'
      }).trim()

      mkdirSync(join(root, 'src', 'shared'), { recursive: true })
      writeFileSync(join(root, 'src', 'shared', 'acp.ts'), 'export type Acp = unknown\n')
      execFileSync('git', ['add', 'src/shared/acp.ts'], { cwd: root })
      execFileSync('git', ['commit', '--quiet', '-m', 'add shared contract'], { cwd: root })
      const head = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8'
      }).trim()

      const result = spawnSync(
        process.execPath,
        [resolve('scripts/ci/classify-pr-changes.mjs'), '--base', base, '--head', head],
        {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            GITHUB_OUTPUT: output,
            GITHUB_STEP_SUMMARY: summary
          }
        }
      )

      expect(result.status, result.stderr).toBe(0)
      const outputs = Object.fromEntries(
        readFileSync(output, 'utf8')
          .trim()
          .split('\n')
          .map((line) => line.split('=', 2))
      )
      expect(JSON.parse(outputs.lanes)).toContain('e2e_workspace_windows')
      expect(JSON.parse(outputs.plan).mode).toBe('selective')
      expect(readFileSync(summary, 'utf8')).toContain(
        'src/shared/acp.ts -&gt; shared_contract -&gt; preload_adapter'
      )
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it('preserves both paths from NUL-delimited Git rename and deletion records', () => {
    const changes = parseNameStatus(
      'M\0src/main/index.ts\0R097\0src/shared/old.ts\0src/shared/new.ts\0D\0README.md\0'
    )

    expect(changes).toEqual([
      { path: 'src/main/index.ts', status: 'modified' },
      {
        path: 'src/shared/new.ts',
        previousPath: 'src/shared/old.ts',
        status: 'renamed'
      },
      { path: 'README.md', status: 'deleted' }
    ])
  })

  it('expands a Main IPC change through its Renderer consumers', () => {
    const plan = classifyChanges([{ path: 'src/main/settings/ipc.ts', status: 'modified' }])

    expect(plan.mode).toBe('selective')
    expect(plan.lanes).toEqual(
      expect.arrayContaining([
        'typecheck_node',
        'typecheck_web',
        'interface_contracts',
        'unit_renderer',
        'build',
        'e2e_functional_macos',
        'e2e_functional_windows',
        'e2e_workspace_macos',
        'e2e_workspace_windows'
      ])
    )
    expect(plan.reasonChains).toContain(
      'src/main/settings/ipc.ts -> settings_ipc -> preload_adapter -> renderer_settings -> e2e_workspace'
    )
  })

  it('fails closed to the full deterministic plan for an unknown path', () => {
    const plan = classifyChanges([{ path: 'src/new-runtime/capability.ts', status: 'added' }])

    expect(plan.mode).toBe('full')
    expect(plan.roots).toContain('unknown')
    expect(plan.lanes).toEqual(
      expect.arrayContaining([
        'lint',
        'typecheck_node',
        'typecheck_web',
        'coverage_macos',
        'windows_runtime',
        'e2e_functional_macos',
        'e2e_functional_windows',
        'e2e_workspace_macos',
        'e2e_workspace_windows',
        'e2e_accessibility_macos',
        'e2e_accessibility_windows',
        'e2e_visual_macos'
      ])
    )
    expect(plan.reasonChains).toContain('src/new-runtime/capability.ts -> unknown -> full')
  })

  it('keeps documentation-only changes on the stable minimal gate', () => {
    const plan = classifyChanges([
      { path: 'docs/internal/pr-gate.md', status: 'modified' },
      { path: 'README.md', status: 'modified' }
    ])

    expect(plan.mode).toBe('selective')
    expect(plan.lanes).toEqual(['policy', 'docs'])
    expect(plan.reasonChains).toEqual(
      expect.arrayContaining([
        'README.md -> documentation',
        'docs/internal/pr-gate.md -> documentation'
      ])
    )
  })

  it('treats Shared changes as cross-process consumer changes', () => {
    const plan = classifyChanges([{ path: 'src/shared/acp.ts', status: 'modified' }])

    expect(plan.mode).toBe('selective')
    expect(plan.lanes).toEqual(
      expect.arrayContaining([
        'format',
        'lint',
        'typecheck_node',
        'typecheck_web',
        'interface_contracts',
        'unit_linux',
        'coverage_macos',
        'windows_runtime',
        'windows_path',
        'unit_renderer',
        'build',
        'e2e_functional_macos',
        'e2e_functional_windows',
        'e2e_workspace_macos',
        'e2e_workspace_windows',
        'e2e_accessibility_macos',
        'e2e_accessibility_windows',
        'e2e_visual_macos'
      ])
    )
    expect(plan.reasonChains).toContain(
      'src/shared/acp.ts -> shared_contract -> preload_adapter -> renderer_settings -> e2e_workspace'
    )
  })

  it('expands Main runtime changes to desktop behavior consumers', () => {
    const plan = classifyChanges([
      { path: 'src/main/notebook/runtime-service.ts', status: 'modified' }
    ])

    expect(plan.mode).toBe('selective')
    expect(plan.lanes).toEqual(
      expect.arrayContaining([
        'format',
        'lint',
        'typecheck_node',
        'typecheck_web',
        'interface_contracts',
        'unit_linux',
        'coverage_macos',
        'unit_renderer',
        'build',
        'e2e_functional_macos',
        'e2e_functional_windows',
        'e2e_workspace_macos',
        'e2e_workspace_windows'
      ])
    )
    expect(plan.lanes).not.toContain('e2e_visual_macos')
    expect(plan.reasonChains).toContain(
      'src/main/notebook/runtime-service.ts -> main_runtime -> renderer_runtime -> e2e_workspace'
    )
  })

  it.each([
    ['Windows runtime', 'src/main/windows.ts'],
    ['PowerShell', 'src/main/notebook/micromamba-cache-powershell.test.ts'],
    ['path handling', 'src/main/acp/workspace-path.ts'],
    ['ACL behavior', 'src/main/notebook/micromamba-cache-acl.integration.test.ts'],
    ['storage', 'src/main/storage/ipc.ts'],
    ['session persistence', 'src/main/session-persistence/ipc.ts'],
    ['file save', 'src/main/file-save.ts'],
    ['specialist repository', 'src/main/specialist/repository.ts'],
    ['notebook runtime settings', 'src/main/settings/notebook-runtime-settings.ts'],
    ['preferences', 'src/main/settings/preferences.ts']
  ])('adds native Windows lanes for %s changes', (_category, path) => {
    const plan = classifyChanges([{ path, status: 'modified' }])

    expect(plan.roots).toContain('windows_sensitive')
    expect(plan.lanes).toEqual(expect.arrayContaining(['windows_runtime', 'windows_path']))
    expect(plan.reasonChains).toContain(`${path} -> windows_sensitive`)
  })

  it('does not add focused Windows lanes for platform-neutral Main changes', () => {
    const plan = classifyChanges([
      { path: 'src/main/notebook/runtime-service.ts', status: 'modified' }
    ])

    expect(plan.roots).not.toContain('windows_sensitive')
    expect(plan.lanes).not.toContain('windows_runtime')
    expect(plan.lanes).not.toContain('windows_path')
  })

  it('selects visual and accessibility consumers for a Renderer view change', () => {
    const plan = classifyChanges([
      { path: 'src/renderer/src/components/Button.tsx', status: 'modified' }
    ])

    expect(plan.mode).toBe('selective')
    expect(plan.lanes).toEqual(
      expect.arrayContaining([
        'format',
        'lint',
        'typecheck_web',
        'unit_linux',
        'coverage_macos',
        'unit_renderer',
        'build',
        'e2e_functional_macos',
        'e2e_functional_windows',
        'e2e_accessibility_macos',
        'e2e_accessibility_windows',
        'e2e_visual_macos'
      ])
    )
    expect(plan.lanes).not.toContain('typecheck_node')
    expect(plan.lanes).not.toContain('windows_path')
  })

  it('adds workspace journeys for Renderer state changes', () => {
    const plan = classifyChanges([
      { path: 'src/renderer/src/stores/session.ts', status: 'modified' }
    ])

    expect(plan.lanes).toEqual(
      expect.arrayContaining(['e2e_workspace_macos', 'e2e_workspace_windows'])
    )
    expect(plan.reasonChains).toContain(
      'src/renderer/src/stores/session.ts -> renderer_state -> e2e_workspace'
    )
  })

  it('treats Preload changes as a known cross-process Interface change', () => {
    const plan = classifyChanges([{ path: 'src/preload/index.ts', status: 'modified' }])

    expect(plan.mode).toBe('selective')
    expect(plan.roots).toContain('preload_contract')
    expect(plan.lanes).toEqual(
      expect.arrayContaining([
        'typecheck_node',
        'typecheck_web',
        'interface_contracts',
        'unit_linux',
        'coverage_macos',
        'windows_runtime',
        'windows_path',
        'unit_renderer',
        'build',
        'e2e_functional_macos',
        'e2e_functional_windows',
        'e2e_workspace_macos',
        'e2e_workspace_windows',
        'e2e_accessibility_macos',
        'e2e_accessibility_windows',
        'e2e_visual_macos'
      ])
    )
  })

  it('keeps CLI and SDK changes out of Electron E2E', () => {
    const plan = classifyChanges([{ path: 'packages/open-science/index.mjs', status: 'modified' }])

    expect(plan.mode).toBe('selective')
    expect(plan.lanes).toEqual(['policy', 'format', 'lint', 'cli_sdk'])
    expect(plan.lanes).not.toContain('e2e_functional_macos')
  })

  it('uses the broader impact of both paths for a rename', () => {
    const plan = classifyChanges([
      {
        path: 'docs/acp-contract.md',
        previousPath: 'src/shared/acp.ts',
        status: 'renamed'
      }
    ])

    expect(plan.mode).toBe('selective')
    expect(plan.roots).toEqual(expect.arrayContaining(['documentation', 'shared_contract']))
    expect(plan.lanes).toContain('e2e_workspace_windows')
    expect(plan.reasonChains).toContain(
      'src/shared/acp.ts -> shared_contract -> preload_adapter -> renderer_settings -> e2e_workspace'
    )
  })

  it.each([
    'package-lock.json',
    'vitest.config.ts',
    'scripts/ci/change-impact.json',
    '.github/workflows/pr-gate.yml'
  ])('selects the declared full plan for global gate input %s', (path) => {
    const plan = classifyChanges([{ path, status: 'modified' }])

    expect(plan.mode).toBe('full')
    expect(plan.roots).toContain('global_gate_input')
    expect(plan.roots).not.toContain('unknown')
    expect(plan.lanes).toContain('e2e_visual_macos')
    expect(plan.reasonChains).toContain(`${path} -> global_gate_input -> full`)
  })

  it('leaves ordinary workflow-only validation to the trusted integrity gate', () => {
    const plan = classifyChanges([{ path: '.github/workflows/release.yml', status: 'modified' }])

    expect(plan.mode).toBe('selective')
    expect(plan.roots).toContain('ci_integrity_surface')
    expect(plan.lanes).toEqual(['policy'])
  })
})
