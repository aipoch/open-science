import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { classifyChanges, parseNameStatus, toGitHubOutputPlan } from './classify-pr-changes.mjs'

const readManifest = (): ReturnType<JSON['parse']> =>
  JSON.parse(readFileSync(resolve('scripts/ci/change-impact.json'), 'utf8'))

const listSourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? listSourceFiles(path) : [path]
  })

const windowsRuntimeSignal =
  /['"]win32['"]|powershell|taskkill(?:\.exe)?|windowsHide|SystemRoot|WINDIR|USERPROFILE|ProgramFiles|LOCALAPPDATA|APPDATA/i

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
      expect(JSON.parse(outputs.lanes)).toContain('e2e_workspace_macos')
      expect(JSON.parse(outputs.plan)).toEqual({
        schemaVersion: 1,
        mode: 'selective',
        roots: expect.any(Array),
        lanes: expect.any(Array),
        bundles: expect.arrayContaining(['policy', 'static', 'unit', 'macos_e2e'])
      })
      expect(JSON.parse(outputs.plan)).not.toHaveProperty('reasonChains')
      expect(readFileSync(summary, 'utf8')).toContain(
        'src/shared/acp.ts -&gt; shared_contract -&gt; preload_adapter'
      )
      expect(readFileSync(summary, 'utf8')).toContain(
        'Execution bundles: policy, static, unit, macos_e2e'
      )
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it('keeps GitHub Actions plan output bounded without per-path reason chains', () => {
    const linuxMaxArgStrlen = 131_072
    const changes = Array.from({ length: 2_000 }, (_, index) => ({
      path: `src/renderer/src/pages/workspace/generated-${index}.tsx`,
      status: 'modified' as const
    }))
    const plan = classifyChanges(changes)
    const output = toGitHubOutputPlan(plan)
    const outputJson = JSON.stringify(output)

    expect(plan.reasonChains.length).toBeGreaterThan(1_000)
    expect(JSON.stringify(plan).length).toBeGreaterThan(linuxMaxArgStrlen)
    expect(output).not.toHaveProperty('reasonChains')
    expect(outputJson).not.toContain('reasonChains')
    expect(outputJson.length).toBeLessThan(8_192)
    expect(output).toMatchObject({
      schemaVersion: plan.schemaVersion,
      mode: plan.mode,
      roots: plan.roots,
      lanes: plan.lanes,
      bundles: plan.bundles
    })
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
        'unit_macos',
        'build',
        'e2e_functional_macos',
        'e2e_workspace_macos'
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
        'unit_macos',
        'windows_runtime',
        'e2e_functional_macos',
        'e2e_functional_windows',
        'e2e_workspace_macos',
        'e2e_workspace_windows',
        'e2e_accessibility_macos',
        'e2e_visual_macos'
      ])
    )
    expect(plan.bundles).toEqual([
      'policy',
      'static',
      'unit',
      'linux_runtime',
      'windows_core',
      'macos_e2e',
      'windows_e2e'
    ])
    expect(plan.reasonChains).toContain('src/new-runtime/capability.ts -> unknown -> full')
  })

  it('selects cross-platform build and runtime lanes for the Notebook network sandbox', () => {
    const path = 'packages/notebook-network-sandbox/src/config.ts'
    const plan = classifyChanges([{ path, status: 'modified' }])

    expect(plan.mode).toBe('selective')
    expect(plan.roots).toContain('notebook_network_sandbox')
    expect(plan.lanes).toEqual(
      expect.arrayContaining([
        'typecheck_node',
        'unit_macos',
        'linux_runtime',
        'windows_runtime',
        'windows_path',
        'build'
      ])
    )
    expect(plan.bundles).toContain('linux_runtime')
    expect(plan.reasonChains).toContain(`${path} -> notebook_network_sandbox`)
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

  it('uses one specific owner instead of a broad fallback owner', () => {
    const manifest = readManifest()
    manifest.rules.push({
      id: 'notebook_runtime',
      role: 'owner',
      paths: ['src/main/notebook/runtime-service.ts'],
      capabilities: ['notebook_runtime']
    })
    manifest.capabilities.notebook_runtime = {
      consumers: [],
      lanes: ['typecheck_node']
    }

    const plan = classifyChanges(
      [{ path: 'src/main/notebook/runtime-service.ts', status: 'modified' }],
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
        'unit_macos',
        'build',
        'e2e_functional_macos',
        'e2e_workspace_macos',
        'e2e_accessibility_macos',
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
        'unit_macos',
        'build',
        'e2e_functional_macos',
        'e2e_workspace_macos'
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
    ['notebook shell process', 'src/main/notebook/shell-process.ts'],
    ['file save', 'src/main/file-save.ts'],
    ['specialist repository', 'src/main/specialist/repository.ts'],
    ['notebook runtime settings', 'src/main/settings/notebook-runtime-settings.ts'],
    ['preferences', 'src/main/settings/preferences.ts'],
    ['restricted runtime profile', 'src/main/acp/restricted-runtime-profile.ts'],
    ['CodeBuddy framework', 'src/main/agent-framework/codebuddy.ts'],
    ['CodeBuddy detect', 'src/main/settings/codebuddy-detect.ts'],
    ['managed CodeBuddy', 'src/main/settings/managed-codebuddy.ts'],
    ['immutable notebook inputs', 'src/main/immutable-input-authority.ts'],
    ['notebook package process sandbox', 'src/main/notebook/package-process-sandbox.ts']
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

  it.each([
    ['renderer view', 'src/renderer/src/components/Button.tsx'],
    ['renderer locale catalog', 'src/shared/i18n/locales/ja.json'],
    ['Korean locale catalog', 'src/shared/i18n/locales/ko.json'],
    ['French locale catalog', 'src/shared/i18n/locales/fr.json'],
    ['Spanish locale catalog', 'src/shared/i18n/locales/es.json'],
    ['German locale catalog', 'src/shared/i18n/locales/de.json'],
    ['shared contract', 'src/shared/acp.ts'],
    ['main runtime', 'src/main/notebook/runtime-service.ts']
  ])('selects the i18n catalog lane for a scanned %s change', (_label, path) => {
    const plan = classifyChanges([{ path, status: 'modified' }])

    expect(plan.lanes).toContain('i18n')
    expect(plan.bundles).toContain('static')
  })

  it.each(
    readdirSync(resolve('src/shared/i18n/locales'))
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.replace(/\.json$/u, ''))
      .sort()
  )('runs the build and functional Electron journey for a shared %s catalog change', (locale) => {
    const plan = classifyChanges([
      { path: `src/shared/i18n/locales/${locale}.json`, status: 'modified' }
    ])

    expect(plan.lanes).toEqual(expect.arrayContaining(['i18n', 'build', 'e2e_functional_macos']))
    expect(plan.bundles).toEqual(expect.arrayContaining(['static', 'macos_e2e']))
  })

  it.each([
    ['documentation', 'README.md'],
    ['preload contract', 'src/preload/index.ts'],
    ['CLI package', 'packages/open-science/index.mjs'],
    ['ordinary workflow', '.github/workflows/release.yml']
  ])('keeps the i18n catalog lane off a %s change', (_label, path) => {
    const plan = classifyChanges([{ path, status: 'modified' }])

    expect(plan.lanes).not.toContain('i18n')
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
        'unit_macos',
        'build',
        'e2e_functional_macos',
        'e2e_accessibility_macos',
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

    expect(plan.lanes).toEqual(expect.arrayContaining(['e2e_workspace_macos']))
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
      'unit_macos',
      'build'
    ])
    expect(plan.bundles).toEqual(['policy', 'static', 'unit', 'macos_e2e'])
  })

  it('adds Windows core back when a Preload platform-risk overlay matches', () => {
    const plan = classifyChanges([{ path: 'src/preload/windows-path-adapter.ts', status: 'added' }])

    expect(plan.mode).toBe('selective')
    expect(plan.roots).toEqual(expect.arrayContaining(['preload_contract', 'windows_sensitive']))
    expect(plan.lanes).toEqual(expect.arrayContaining(['windows_runtime', 'windows_path']))
    expect(plan.bundles).toContain('windows_core')
    expect(plan.bundles).toContain('windows_e2e')
  })

  it('keeps CLI and SDK changes out of Electron E2E', () => {
    const plan = classifyChanges([{ path: 'packages/open-science/index.mjs', status: 'modified' }])

    expect(plan.mode).toBe('selective')
    expect(plan.lanes).toEqual(['policy', 'format', 'lint', 'cli_sdk'])
    expect(plan.lanes).not.toContain('e2e_functional_macos')
  })

  it('fails closed when a source rename cannot be related from the current import graph', () => {
    const plan = classifyChanges([
      {
        path: 'docs/acp-contract.md',
        previousPath: 'src/shared/acp.ts',
        status: 'renamed'
      }
    ])

    expect(plan.mode).toBe('full')
    expect(plan.roots).toContain('destructive_change')
    expect(plan.reasonChains).toContain('src/shared/acp.ts -> destructive change -> full')
  })

  it('keeps documentation-only renames on the minimal documentation boundary', () => {
    const plan = classifyChanges([
      {
        path: 'docs/current.md',
        previousPath: 'docs/legacy.md',
        status: 'renamed'
      }
    ])

    expect(plan.mode).toBe('selective')
    expect(plan.lanes).toEqual(['policy', 'docs'])
    expect(plan.bundles).toEqual(['policy', 'static'])
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

  it('keeps documentation-only changes outside every code and platform lane', () => {
    const plan = classifyChanges([
      { path: 'README.md', status: 'modified' },
      { path: 'docs/architecture.md', status: 'added' }
    ])

    expect(plan.mode).toBe('selective')
    expect(plan.lanes).toEqual(['policy', 'docs'])
    expect(plan.bundles).toEqual(['policy', 'static'])
    expect(plan.lanes).not.toContain('unit_macos')
    expect(plan.lanes.some((lane) => lane.startsWith('e2e_'))).toBe(false)
  })

  it('selects one macOS Module-test lane without duplicate coverage or Renderer lanes', () => {
    const plan = classifyChanges([
      { path: 'src/main/notebook/runtime-service.ts', status: 'modified' }
    ])

    expect(plan.mode).toBe('selective')
    expect(plan.lanes).toContain('unit_macos')
    expect(plan.lanes).not.toContain('unit_linux')
    expect(plan.lanes).not.toContain('unit_renderer')
    expect(plan.lanes).not.toContain('coverage_macos')
    expect(plan.lanes).not.toContain('e2e_functional_windows')
    expect(plan.lanes).not.toContain('e2e_workspace_windows')
  })

  it('adds Windows GUI consumers only for a Windows-sensitive source change', () => {
    const plan = classifyChanges([
      { path: 'src/main/notebook/windows-shell.ts', status: 'modified' }
    ])

    expect(plan.lanes).toEqual(
      expect.arrayContaining([
        'windows_runtime',
        'windows_path',
        'e2e_functional_windows',
        'e2e_workspace_windows'
      ])
    )
    expect(plan.lanes).not.toContain('e2e_accessibility_windows')
  })

  it('covers every production source file with an explicit Windows runtime signal', () => {
    const sourceFiles = ['src/main', 'src/preload', 'src/shared']
      .flatMap((directory) => listSourceFiles(resolve(directory)))
      .filter((path) => /\.(?:ts|tsx)$/.test(path) && !/\.(?:test|spec)\.(?:ts|tsx)$/.test(path))
      .filter((path) => windowsRuntimeSignal.test(readFileSync(path, 'utf8')))
      .map((path) => relative(process.cwd(), path).replaceAll('\\', '/'))

    const uncoveredFiles = sourceFiles.filter((path) => {
      const plan = classifyChanges([{ path, status: 'modified' }])
      return (
        !plan.roots.includes('windows_sensitive') ||
        !plan.lanes.includes('e2e_functional_windows') ||
        !plan.lanes.includes('e2e_workspace_windows')
      )
    })

    expect(uncoveredFiles).toEqual([])
  })
})
