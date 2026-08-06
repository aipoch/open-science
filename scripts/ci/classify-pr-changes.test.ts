import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { classifyChanges, parseNameStatus } from './classify-pr-changes.mjs'

const readManifest = (): ReturnType<JSON['parse']> =>
  JSON.parse(readFileSync(resolve('scripts/ci/change-impact.json'), 'utf8'))

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
      expect(readFileSync(summary, 'utf8')).toContain(
        'Execution bundles: policy, static, unit, coverage_macos, windows_core, macos_e2e, windows_e2e, linux_e2e'
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
    expect(plan.bundles).toEqual([
      'policy',
      'static',
      'unit',
      'coverage_macos',
      'windows_core',
      'macos_e2e',
      'windows_e2e',
      'linux_e2e'
    ])
    expect(plan.reasonChains).toContain('src/new-runtime/capability.ts -> unknown -> full')
  })

  it('fails closed when a selected lane has no execution bundle', () => {
    const manifest = readManifest()
    delete manifest.laneBundles.policy

    expect(() => classifyChanges([], manifest)).toThrow(
      'Missing execution bundle for selected lane: policy'
    )
  })

  it('fails closed when a selected lane references an undeclared execution bundle', () => {
    const manifest = readManifest()
    manifest.laneBundles.policy = 'undeclared'

    expect(() => classifyChanges([], manifest)).toThrow(
      'Unknown execution bundle for selected lane policy: undeclared'
    )
  })

  it('keeps documentation-only changes on the stable minimal gate', () => {
    const plan = classifyChanges([
      { path: 'docs/internal/pr-gate.md', status: 'modified' },
      { path: 'README.md', status: 'modified' }
    ])

    expect(plan.mode).toBe('selective')
    expect(plan.lanes).toEqual(['policy', 'docs'])
    expect(plan.bundles).toEqual(['policy', 'static'])
    expect(plan.reasonChains).toEqual(
      expect.arrayContaining([
        'README.md -> documentation',
        'docs/internal/pr-gate.md -> documentation'
      ])
    )
  })

  it('selects one release journey without activating unrelated P0 journeys', () => {
    const plan = classifyChanges([
      { path: 'src/main/settings/openai-provider-bridge.ts', status: 'modified' }
    ])

    expect(plan.mode).toBe('selective')
    expect(plan.lanes).toEqual(
      expect.arrayContaining([
        'e2e_provider_bridge_macos',
        'e2e_provider_bridge_windows',
        'e2e_provider_bridge_linux'
      ])
    )
    expect(plan.lanes.filter((lane) => lane.includes('storage_migration'))).toEqual([])
    expect(plan.lanes.filter((lane) => lane.includes('notebook_lifecycle'))).toEqual([])
    expect(plan.lanes.filter((lane) => lane.includes('remote_pairing'))).toEqual([])
    expect(plan.lanes.filter((lane) => lane.includes('artifact_provenance'))).toEqual([])
    expect(plan.bundles).toEqual(expect.arrayContaining(['macos_e2e', 'windows_e2e', 'linux_e2e']))
  })

  it('maps a focused release spec only to its three platform bundles', () => {
    const plan = classifyChanges([
      { path: 'e2e/certification/remote-pairing.spec.ts', status: 'modified' }
    ])

    expect(plan.mode).toBe('selective')
    expect(plan.lanes).toEqual([
      'policy',
      'e2e_remote_pairing_macos',
      'e2e_remote_pairing_windows',
      'e2e_remote_pairing_linux'
    ])
    expect(plan.bundles).toEqual(['policy', 'macos_e2e', 'windows_e2e', 'linux_e2e'])
  })

  it('does not select a P0 journey for an unrelated Main runtime change', () => {
    const plan = classifyChanges([{ path: 'src/main/menu.ts', status: 'modified' }])

    for (const journey of [
      'storage_migration',
      'provider_bridge',
      'notebook_lifecycle',
      'remote_pairing',
      'artifact_provenance'
    ]) {
      expect(plan.lanes.some((lane) => lane.includes(journey))).toBe(false)
    }
  })

  it('uses one specific owner instead of a broad fallback owner', () => {
    const manifest = readManifest()
    manifest.rules.push({
      id: 'notebook_runtime',
      role: 'owner',
      paths: ['src/main/custom-runtime/service.ts'],
      capabilities: ['notebook_runtime']
    })
    manifest.capabilities.notebook_runtime = {
      consumers: [],
      lanes: ['typecheck_node']
    }

    const plan = classifyChanges(
      [{ path: 'src/main/custom-runtime/service.ts', status: 'modified' }],
      manifest
    )

    expect(plan.mode).toBe('selective')
    expect(plan.roots).toContain('notebook_runtime')
    expect(plan.roots).not.toContain('main_runtime')
    expect(plan.lanes).toEqual(['policy', 'typecheck_node'])
  })

  it('keeps risk overlays additive after a specific owner replaces a fallback', () => {
    const manifest = readManifest()
    manifest.rules.push({
      id: 'notebook_windows_runtime',
      role: 'owner',
      paths: ['src/main/notebook/windows-runtime.ts'],
      capabilities: ['notebook_runtime']
    })
    manifest.capabilities.notebook_runtime = {
      consumers: [],
      lanes: ['typecheck_node']
    }

    const path = 'src/main/notebook/windows-runtime.ts'
    const plan = classifyChanges([{ path, status: 'modified' }], manifest)

    expect(plan.mode).toBe('selective')
    expect(plan.roots).toEqual(
      expect.arrayContaining(['notebook_windows_runtime', 'windows_sensitive'])
    )
    expect(plan.roots).not.toContain('main_runtime')
    expect(plan.lanes).toEqual(
      expect.arrayContaining(['typecheck_node', 'windows_runtime', 'windows_path'])
    )
  })

  it('fails closed when multiple specific owners match one path', () => {
    const manifest = readManifest()
    for (const id of ['notebook_runtime_a', 'notebook_runtime_b']) {
      manifest.rules.push({
        id,
        role: 'owner',
        paths: ['src/main/notebook/runtime-service.ts'],
        capabilities: ['main_runtime']
      })
    }

    const path = 'src/main/notebook/runtime-service.ts'
    const plan = classifyChanges([{ path, status: 'modified' }], manifest)

    expect(plan.mode).toBe('full')
    expect(plan.roots).toContain('owner_ambiguity')
    expect(plan.reasonChains).toContain(
      `${path} -> owner ambiguity: notebook_runtime_a, notebook_runtime_b -> full`
    )
  })

  it('fails closed when a matched path has no owner', () => {
    const manifest = readManifest()
    manifest.rules.push({
      id: 'unowned_overlay',
      role: 'overlay',
      paths: ['src/new-runtime/overlay.ts'],
      capabilities: ['ci_integrity_surface']
    })

    const path = 'src/new-runtime/overlay.ts'
    const plan = classifyChanges([{ path, status: 'added' }], manifest)

    expect(plan.mode).toBe('full')
    expect(plan.roots).toContain('missing_owner')
    expect(plan.reasonChains).toContain(`${path} -> missing owner -> full`)
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
        'e2e_functional_linux',
        'e2e_accessibility_macos',
        'e2e_accessibility_windows',
        'e2e_accessibility_linux',
        'e2e_visual_macos',
        'e2e_visual_windows',
        'e2e_visual_linux'
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

  it('keeps a PR 684-shaped Preload change on the shadow contract plan', () => {
    const plan = classifyChanges([
      { path: 'src/preload/electron-renderer-contract-adapter.test.ts', status: 'modified' },
      { path: 'src/preload/electron-renderer-contract-adapter.ts', status: 'modified' },
      { path: 'src/preload/index.test.ts', status: 'modified' },
      { path: 'src/preload/index.ts', status: 'modified' }
    ])

    expect(plan.mode).toBe('selective')
    expect(plan.roots).toEqual(['preload_contract'])
    expect(plan.lanes).toEqual([
      'policy',
      'format',
      'lint',
      'typecheck_node',
      'typecheck_web',
      'interface_contracts',
      'coverage_macos',
      'build'
    ])
    expect(plan.bundles).toEqual(['policy', 'static', 'coverage_macos', 'macos_e2e'])
  })

  it('adds Windows core back when a Preload platform-risk overlay matches', () => {
    const plan = classifyChanges([{ path: 'src/preload/windows-path-adapter.ts', status: 'added' }])

    expect(plan.mode).toBe('selective')
    expect(plan.roots).toEqual(expect.arrayContaining(['preload_contract', 'windows_sensitive']))
    expect(plan.lanes).toEqual(expect.arrayContaining(['windows_runtime', 'windows_path']))
    expect(plan.bundles).toContain('windows_core')
    expect(plan.bundles).not.toContain('windows_e2e')
  })

  it('keeps CLI and SDK changes out of Electron E2E', () => {
    const plan = classifyChanges([{ path: 'packages/open-science/index.mjs', status: 'modified' }])

    expect(plan.mode).toBe('selective')
    expect(plan.lanes).toEqual(['policy', 'format', 'lint', 'cli_sdk'])
    expect(plan.lanes).not.toContain('e2e_functional_macos')
  })

  it('selects provider bridge P0 when an Agent framework route changes', () => {
    const plan = classifyChanges([
      { path: 'src/main/agent-framework/opencode.ts', status: 'modified' }
    ])

    expect(plan.lanes).toEqual(
      expect.arrayContaining([
        'e2e_provider_bridge_macos',
        'e2e_provider_bridge_windows',
        'e2e_provider_bridge_linux'
      ])
    )
  })

  it('selects Notebook and Artifact P0 when Session capability routing changes', () => {
    const plan = classifyChanges([
      { path: 'src/main/acp/session-capability-owner.ts', status: 'modified' }
    ])

    expect(plan.lanes).toEqual(
      expect.arrayContaining([
        'e2e_notebook_lifecycle_macos',
        'e2e_notebook_lifecycle_windows',
        'e2e_notebook_lifecycle_linux',
        'e2e_artifact_provenance_macos',
        'e2e_artifact_provenance_windows',
        'e2e_artifact_provenance_linux'
      ])
    )
  })

  it('selects remote pairing P0 when the Web authorization boundary changes', () => {
    const plan = classifyChanges([
      { path: 'src/main/web-service/http-server.ts', status: 'modified' }
    ])

    expect(plan.lanes).toEqual(
      expect.arrayContaining([
        'e2e_remote_pairing_macos',
        'e2e_remote_pairing_windows',
        'e2e_remote_pairing_linux'
      ])
    )
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

  it('limits macOS package smoke tooling changes to static and unit validation', () => {
    const plan = classifyChanges([{ path: 'scripts/macos-package-smoke.mjs', status: 'modified' }])

    expect(plan.mode).toBe('selective')
    expect(plan.roots).toEqual(['macos_package_smoke'])
    expect(plan.lanes).toEqual(['policy', 'format', 'lint', 'unit_linux'])
    expect(plan.bundles).toEqual(['policy', 'static', 'unit'])
  })
})
