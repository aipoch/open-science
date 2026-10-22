import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, relative, resolve } from 'node:path'

import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

import {
  classifyChanges,
  macosGroupsForPlan,
  parseNameStatus,
  platformExecutionPlan,
  playwrightReaderTests,
  toGitHubOutputPlan
} from './classify-pr-changes.mjs'
import { createAffectedTestPlan } from './module-test-impact.mjs'

const readManifest = (): ReturnType<JSON['parse']> =>
  JSON.parse(readFileSync(resolve('scripts/ci/change-impact.json'), 'utf8'))

it.each([
  'src/main/acp/specialist-switch-recovery.integration.test.ts',
  'src/main/acp/prompt-turn-workflow.ts',
  'src/main/agents/claude-code-handoff.ts',
  'src/main/specialist/session-reconfiguration.ts',
  'src/main/composition/agent-completion.ts',
  'src/main/session-persistence/claude-replay.ts'
])('runs the Windows Specialist recovery contract for %s', (path) => {
  expect(classifyChanges([{ path, status: 'modified' }]).lanes).toContain('windows_runtime')
})

const listSourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? listSourceFiles(path) : [path]
  })

const windowsRuntimeSignal =
  /['"]win32['"]|powershell|taskkill(?:\.exe)?|windowsHide|SystemRoot|WINDIR|USERPROFILE|ProgramFiles|LOCALAPPDATA|APPDATA/i

describe('declared test evidence without source ownership', () => {
  const path = 'scripts/unowned-consumer.test.ts'
  const moduleManifest = {
    modules: {
      host: {
        ownerPaths: [],
        testFiles: { owner: [], contract: [], consumer: [path] },
        fallbackCapability: 'settings_ipc',
        capabilityOverlays: []
      },
      runtime: {
        ownerPaths: [],
        testFiles: { owner: [], contract: [path], consumer: [] },
        fallbackCapability: 'notebook_network_sandbox',
        capabilityOverlays: []
      }
    }
  }

  it('unions capabilities of all evidence declarations and retains portable tests', () => {
    const plan = classifyChanges([{ path, status: 'modified' }], readManifest(), {
      moduleManifest
    })
    expect(plan.mode).toBe('selective')
    expect(plan.roots).toEqual(['module:host', 'module:runtime'])
    expect(plan.lanes).toEqual(
      expect.arrayContaining([
        'unit_macos',
        'interface_contracts',
        'linux_runtime',
        'windows_runtime'
      ])
    )
  })

  it.each(['scripts/unregistered.test.ts', 'scripts/unowned-consumer.mjs'])(
    'retains unknown fallback for %s',
    (path) => {
      const plan = classifyChanges([{ path, status: 'modified' }], readManifest(), {
        moduleManifest
      })
      expect(plan).toMatchObject({ mode: 'full', roots: ['unknown'] })
    }
  )

  it('does not let an evidence declaration override a global input rule', () => {
    const manifest = readManifest()
    manifest.rules.find((rule: { id: string }) => rule.id === 'global_gate_input').paths.push(path)
    expect(
      classifyChanges([{ path, status: 'modified' }], manifest, { moduleManifest })
    ).toMatchObject({ mode: 'full', roots: ['global_gate_input'] })
  })

  it('retains full validation for deletion of declared evidence', () => {
    expect(
      classifyChanges([{ path, status: 'deleted' }], readManifest(), { moduleManifest })
    ).toMatchObject({ mode: 'full', roots: ['destructive_change'] })
  })
})

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
        bundles: expect.arrayContaining(['policy', 'static', 'unit', 'macos_e2e']),
        macosGroups: ['journeys', 'presentation', 'regressions', 'delegation']
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

  it.each([
    ['packages/open-science/CLI.md', 'cli_sdk'],
    ['packages/open-science/README.md', 'cli_sdk'],
    ['packages/notebook-network-sandbox/README.md', 'notebook_network_sandbox']
  ])('keeps documentation and package checks without full fallback for %s', (path, owner) => {
    const changes = [{ path, status: 'modified' }]
    const plan = classifyChanges(changes)
    const manifest = readManifest()
    manifest.rules = manifest.rules.filter(({ id }: { id: string }) => id !== 'documentation')
    const packagePlan = classifyChanges(changes, manifest)

    expect(plan.mode).toBe('selective')
    expect(plan.roots).toEqual(expect.arrayContaining(['documentation', owner]))
    expect(plan.lanes).toEqual(expect.arrayContaining(['docs', ...packagePlan.lanes]))
    expect(plan.roots).not.toContain('owner_ambiguity')
    const tests = createAffectedTestPlan(changes, {
      status: 'unavailable-manifest-only',
      testFiles: []
    })
    expect(tests.mode).toBe('selective')
    if (owner === 'cli_sdk') {
      // CLI tests execute in their dedicated static lane, not the portable module bundle.
      expect(plan.lanes).toContain('cli_sdk')
      expect(tests.testFiles).toEqual([])
    } else {
      expect(tests.modules).toContain(owner)
      expect(tests.testFiles.length).toBeGreaterThan(0)
    }
  })

  it('retains real package-owner ambiguity when documentation also matches', () => {
    const manifest = readManifest()
    const path = 'packages/open-science/README.md'
    manifest.rules.push({
      id: 'another_package_owner',
      role: 'owner',
      paths: [path],
      capabilities: ['cli_sdk']
    })

    const plan = classifyChanges([{ path, status: 'modified' }], manifest)
    expect(plan.mode).toBe('full')
    expect(plan.roots).toContain('owner_ambiguity')
  })

  it.each(['yml', 'yaml'])('keeps issue-template .%s changes on static checks', (extension) => {
    const changes = [
      { path: `.github/ISSUE_TEMPLATE/reproducibility_case.${extension}`, status: 'added' },
      { path: '.github/ISSUE_TEMPLATE/config.yml', status: 'modified' },
      { path: 'CONTRIBUTING.md', status: 'modified' },
      { path: 'docs/reproducibility-cases/README.md', status: 'added' },
      { path: 'docs/reproducibility-cases/index.md', status: 'added' }
    ]
    const plan = classifyChanges(changes)
    expect(plan.mode).toBe('selective')
    expect(plan.lanes).toEqual(['policy', 'docs', 'format'])
    expect(plan.bundles).toEqual(['policy', 'static'])
    for (const event of ['pull_request', 'merge_group']) {
      expect(platformExecutionPlan(plan, changes, event).bundles).toEqual(['policy', 'static'])
    }
    const tests = createAffectedTestPlan(changes, {
      status: 'unavailable-manifest-only',
      testFiles: []
    })
    expect(tests.mode).toBe('selective')
    expect(tests.testFiles).toEqual([])
  })

  it.each([
    '.github/ISSUE_TEMPLATE/helper.js',
    '.github/ISSUE_TEMPLATE/nested/form.yml',
    '.github/unknown.yml',
    '.github/workflows/pr-gate.yml'
  ])('does not exempt unknown or executable inputs: %s', (path) => {
    expect(classifyChanges([{ path, status: 'added' }]).mode).toBe('full')
  })

  it('retains the full fallback when an issue form accompanies runtime changes', () => {
    const plan = classifyChanges([
      { path: '.github/ISSUE_TEMPLATE/bug_report.yml', status: 'modified' },
      { path: 'src/unknown-runtime.ts', status: 'added' }
    ])
    expect(plan.mode).toBe('full')
    expect(plan.bundles).toEqual(expect.arrayContaining(['unit', 'windows_core', 'windows_e2e']))
  })

  it('uses one specific owner instead of a broad fallback owner', () => {
    const manifest = readManifest()
    manifest.rules.push({
      id: 'notebook_runtime',
      role: 'owner',
      paths: ['packages/notebook-analysis/src/source-file-access-analysis.ts'],
      capabilities: ['notebook_runtime']
    })
    manifest.capabilities.notebook_runtime = {
      consumers: [],
      lanes: ['typecheck_node']
    }

    const plan = classifyChanges(
      [
        {
          path: 'packages/notebook-analysis/src/source-file-access-analysis.ts',
          status: 'modified'
        }
      ],
      manifest
    )

    expect(plan.mode).toBe('selective')
    expect(plan.roots).toContain('notebook_runtime')
    expect(plan.roots).not.toContain('main_runtime')
    expect(plan.lanes).toEqual([
      'policy',
      'typecheck_node',
      'e2e_regressions_macos',
      'e2e_delegation_macos'
    ])
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
    ['Shell search scope', 'src/main/notebook/shell-search-scope.ts'],
    ['PowerShell search parser', 'src/main/notebook/powershell-search-parser.ts'],
    ['PowerShell', 'packages/environment/src/micromamba-cache-powershell.test.ts'],
    ['path handling', 'src/main/acp/workspace-path.ts'],
    ['ACL behavior', 'packages/environment/src/micromamba-cache-acl.integration.test.ts'],
    ['Windows wheel recovery', 'packages/environment/src/pip-wheel-evidence.ts'],
    ['Windows wheel regression', 'packages/environment/src/pip-wheel-evidence.test.ts'],
    ['Windows install evidence', 'packages/environment/src/pip-install-evidence.test.ts'],
    ['storage', 'src/main/storage/ipc.ts'],
    ['session persistence', 'src/main/session-persistence/ipc.ts'],
    ['delegated process ownership', 'src/main/delegation/process-ownership.ts'],
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
    ['notebook package process sandbox', 'src/main/notebook/package-process-sandbox.ts'],
    ['WSL setup ownership', 'src/main/wsl/wsl-setup-owner.ts'],
    ['window shortcuts', 'src/main/window-shortcuts.ts']
  ])('adds native Windows lanes for %s changes', (_category, path) => {
    const plan = classifyChanges([{ path, status: 'modified' }])

    expect(plan.roots).toContain('windows_sensitive')
    expect(plan.lanes).toEqual(expect.arrayContaining(['windows_runtime', 'windows_path']))
    expect(plan.reasonChains).toContain(`${path} -> windows_sensitive`)
  })

  it('requires a live CDN bundle when the immutable runtime version changes', () => {
    const plan = classifyChanges([
      { path: 'packages/environment/src/runtime-paths.ts', status: 'modified' }
    ])

    expect(plan.roots).toEqual(expect.arrayContaining(['main_runtime', 'runtime_bundle']))
    expect(plan.lanes).toContain('runtime_bundle')
    expect(plan.reasonChains).toContain(
      'packages/environment/src/runtime-paths.ts -> runtime_bundle'
    )
  })

  it('does not add focused Windows lanes for platform-neutral Main changes', () => {
    const plan = classifyChanges([
      { path: 'packages/notebook-analysis/src/source-file-access-analysis.ts', status: 'modified' }
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
      'build',
      'e2e_regressions_macos',
      'e2e_delegation_macos'
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

  it('runs the PR workflow contract without selecting desktop or full suites', () => {
    const plan = classifyChanges([
      { path: 'scripts/ci/pr-gate-workflow.test.ts', status: 'modified' }
    ])
    expect(plan.mode).toBe('selective')
    expect(plan.bundles).toEqual(['policy', 'static', 'unit'])
    expect(plan.roots).toEqual(['ci_workflow_contract_test'])
  })

  it.each(['deleted', 'renamed', 'type-changed'] as const)(
    'retains the conservative fallback for a %s workflow contract',
    (status) => {
      const plan = classifyChanges([{ path: 'scripts/ci/pr-gate-workflow.test.ts', status }])
      expect(plan.mode).toBe('full')
    }
  )

  it.each([
    '.github/workflows/pr-gate.yml',
    'scripts/ci/classify-pr-changes.mjs',
    'scripts/ci/module-impact.json',
    'scripts/ci/module-impact/sample.json',
    'scripts/ci/load-module-impact.mjs'
  ])('does not let a workflow test hide the changed CI input %s', (path) => {
    const plan = classifyChanges([
      { path: 'scripts/ci/pr-gate-workflow.test.ts', status: 'modified' },
      { path, status: 'modified' }
    ])
    expect(plan.mode).toBe('full')
    expect(plan.roots).toContain('global_gate_input')
  })

  it.each([
    'package-lock.json',
    'vitest.config.ts',
    'test/config/vitest.config.test.ts',
    'test/config/electron.vite.config.test.ts',
    'test/config/playwright.config.test.ts',
    'test/config/vite.browser-test.config.test.ts',
    'e2e/playwright.browser.config.ts',
    'e2e/playwright.accessibility.config.ts',
    'e2e/vite.browser-test.config.ts',
    'scripts/ci/change-impact.json',
    'scripts/windows-signing-policy.mjs',
    'scripts/windows-signing-policy.test.ts',
    'scripts/linux-cli-packages.mjs',
    'scripts/linux-cli-packages.test.ts',
    'scripts/publish-linux-cli-packages.mjs',
    'scripts/publish-linux-cli-packages.test.ts',
    'scripts/test-linux-cli-package.mjs',
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
      { path: 'packages/notebook-analysis/src/source-file-access-analysis.ts', status: 'modified' }
    ])

    expect(plan.mode).toBe('selective')
    expect(plan.lanes).toContain('unit_macos')
    expect(plan.lanes).not.toContain('unit_linux')
    expect(plan.lanes).not.toContain('unit_renderer')
    expect(plan.lanes).not.toContain('coverage_macos')
    expect(plan.lanes).not.toContain('e2e_functional_windows')
    expect(plan.lanes).not.toContain('e2e_workspace_windows')
  })

  it.each([
    'src/main/notebook/windows-shell.ts',
    'src/main/settings/claude-cli-process.ts',
    'packages/notebook-code-risk/src/index.ts',
    'src/main/notebook/runtime-service.ts',
    'src/main/notebook/environment-resources.ts',
    'src/shared/tool-detail-sanitizer.ts',
    'src/shared/renderer-contract-catalog.ts',
    'src/shared/renderer-contracts/settings-preferences.ts'
  ])('adds Windows GUI consumers for Windows-sensitive source %s', (path) => {
    const plan = classifyChanges([{ path, status: 'modified' }])

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

describe('desktop E2E routing', () => {
  const desktopLanes = [
    'e2e_smoke_macos',
    'e2e_functional_macos',
    'e2e_functional_windows',
    'e2e_workspace_macos',
    'e2e_workspace_windows',
    'e2e_accessibility_macos',
    'e2e_visual_macos',
    'e2e_regressions_macos',
    'e2e_delegation_macos'
  ]
  const graph = { status: 'unavailable-manifest-only', testFiles: [] }
  const tracked = execFileSync('git', ['ls-files', 'e2e/**'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
  const classify = (path: string): ReturnType<typeof classifyChanges> =>
    classifyChanges([{ path, status: 'modified' }])
  const e2eLanes = (path: string): string[] =>
    classify(path).lanes.filter((lane: string) => desktopLanes.includes(lane))

  // Executors as configured: npm scripts named by pr-gate steps, the smoke step's explicit
  // files, the accessibility wrapper and @pr-mainline tags read by the Windows mainline job.
  const executors = (): Record<string, string[]> => {
    const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts as Record<
      string,
      string
    >
    const steps = (
      load(readFileSync('.github/workflows/pr-gate.yml', 'utf8')) as {
        jobs: Record<
          string,
          { steps: Array<{ id?: string; run?: string; uses?: string; with?: unknown }> }
        >
      }
    ).jobs.macos_e2e.steps
    const run = (id: string): string => steps.find((step) => step.id === id)?.run ?? ''
    const specs = (command: string): string[] => command.match(/e2e\/[\w./-]+\.spec\.ts/g) ?? []
    const script = (id: string): string[] => specs(scripts[/npm run (\S+)/.exec(run(id))![1]] ?? '')
    const tagged = tracked.filter(
      (path) => path.endsWith('.spec.ts') && readFileSync(path, 'utf8').includes('@pr-mainline-')
    )
    const accessibility = readFileSync('scripts/ci/run-accessibility-e2e.mjs', 'utf8')
    const supplemental = readFileSync('.github/actions/source-regression/action.yml', 'utf8')
    for (const group of ['regressions', 'delegation']) {
      expect(steps.find((step) => step.id === `e2e_${group}_macos`)).toMatchObject({
        uses: './.github/actions/source-regression',
        with: { group }
      })
      expect(supplemental).toContain(`npm run test:e2e:${group} --`)
    }
    const lanes = {
      e2e_smoke_macos: specs(run('e2e_smoke_macos')),
      e2e_functional_macos: script('e2e_functional_macos'),
      e2e_workspace_macos: script('e2e_workspace_macos'),
      e2e_accessibility_macos: specs(accessibility),
      e2e_visual_macos: script('e2e_visual_macos'),
      e2e_regressions_macos: specs(scripts['test:e2e:regressions']),
      e2e_delegation_macos: specs(scripts['test:e2e:delegation'])
    }
    expect(run('e2e_accessibility_macos')).toBe('npm run test:e2e:accessibility:signal')
    for (const files of Object.values(lanes)) expect(files.length).toBeGreaterThan(0)
    // Windows mainline journeys/workspace follow the macOS script that owns each tagged spec.
    const windowsFunctional = tagged.filter((path) => lanes.e2e_functional_macos.includes(path))
    const windowsWorkspace = tagged.filter((path) => lanes.e2e_workspace_macos.includes(path))
    expect([...windowsFunctional, ...windowsWorkspace].sort()).toEqual(tagged.sort())
    return {
      ...lanes,
      e2e_functional_windows: windowsFunctional,
      e2e_workspace_windows: windowsWorkspace
    }
  }

  it.each([
    ['e2e/accessibility.spec.ts', ['e2e_accessibility_macos']],
    ['e2e/desktop-runtime-recovery.spec.ts', ['e2e_regressions_macos']],
    ['e2e/delegation-resume.spec.ts', ['e2e_delegation_macos']],
    ['e2e/session-fork.spec.ts', ['e2e_functional_macos']],
    ['e2e/visual-regression.spec.ts', ['e2e_visual_macos']],
    ['e2e/window-presentation.spec.ts', ['e2e_smoke_macos', 'e2e_regressions_macos']],
    [
      'e2e/electron-foundation.spec.ts',
      ['e2e_smoke_macos', 'e2e_functional_macos', 'e2e_functional_windows']
    ],
    ['e2e/workspace-files.spec.ts', ['e2e_workspace_macos', 'e2e_workspace_windows']],
    ['e2e/certification/remote-pairing.spec.ts', []]
  ])('routes %s to its executing lanes', (path, lanes) => {
    const plan = classify(path)
    expect(plan.mode).toBe('selective')
    expect(e2eLanes(path)).toEqual(lanes)
    expect(plan.lanes).toEqual(
      expect.arrayContaining(['policy', 'format', 'lint', 'typecheck_node'])
    )
    expect(plan.lanes).not.toContain('unit_macos')
    expect(plan.lanes).not.toContain('e2e_browser_windows')
    expect(createAffectedTestPlan([{ path, status: 'modified' }], graph).testFiles).toEqual([])
  })

  it('matches every root spec to the lanes whose configured command executes it', () => {
    const lanes = executors()
    const specs = tracked.filter(
      (path) => path.endsWith('.spec.ts') && !path.startsWith('e2e/browser/')
    )
    const drift = specs.flatMap((path) => {
      const expected = desktopLanes.filter((lane) => lanes[lane]?.includes(path))
      const actual = e2eLanes(path)
      return expected.join() === actual.join() ? [] : [`${path}: ${actual} != ${expected}`]
    })
    expect(drift).toEqual([])
  })

  // Static references inside e2e/: relative imports, repo-relative strings and path segments.
  const importers = (): Map<string, Set<string>> => {
    const files = new Set(tracked)
    const reverse = new Map<string, Set<string>>()
    const resolveTarget = (base: string): string[] => {
      for (const extension of ['', '.ts', '.tsx', '.mjs', '.cjs', '.js', '.jsx'])
        if (files.has(base + extension)) return [base + extension]
      return tracked.filter((path) => path.startsWith(`${base}/`))
    }
    for (const file of tracked) {
      if (!/\.(?:[cm]?[jt]sx?|html)$/.test(file)) continue
      const text = readFileSync(file, 'utf8')
      const targets = [
        ...[...text.matchAll(/['"`](\.{1,2}\/[^'"`$]+)['"`]/g)].map((match) =>
          posix.join(posix.dirname(file), match[1])
        ),
        ...[...text.matchAll(/\/?(e2e\/[\w./-]+)/g)].map((match) => match[1].replace(/\/$/, '')),
        ...[...text.matchAll(/['"]e2e['"]\s*,\s*['"]fixtures['"]\s*,\s*['"]([\w.-]+)['"]/g)].map(
          (match) => `e2e/fixtures/${match[1]}`
        ),
        ...[...text.matchAll(/['"]([\w-]+\.(?:cjs|mjs|sh|png))['"]/g)].map((match) =>
          posix.join(posix.dirname(file), match[1])
        )
      ]
      for (const target of targets.flatMap(resolveTarget)) {
        if (target === file) continue
        if (!reverse.has(target)) reverse.set(target, new Set())
        reverse.get(target)!.add(file)
      }
    }
    return reverse
  }

  it('maps each shared fixture to at least the union of its importing specs', () => {
    const reverse = importers()
    const specsFor = (helper: string): string[] => {
      const seen = new Set<string>()
      const pending = [helper]
      while (pending.length) {
        for (const next of reverse.get(pending.pop()!) ?? []) {
          if (seen.has(next)) continue
          seen.add(next)
          pending.push(next)
        }
      }
      return [...seen].filter((path) => path.endsWith('.spec.ts'))
    }
    expect(specsFor('e2e/fixtures/electron-app.ts').length).toBeGreaterThan(80)
    const missing = tracked
      .filter((path) => !path.endsWith('.spec.ts') && !path.startsWith('e2e/browser/'))
      .filter((path) => classify(path).mode === 'selective')
      .flatMap((helper) => {
        const lanes = classify(helper).lanes
        const required = new Set(specsFor(helper).flatMap((spec) => classify(spec).lanes))
        const absent = [...required].filter((lane) => !lanes.includes(lane))
        return absent.length ? [`${helper}: ${absent.join(', ')}`] : []
      })
    expect(missing).toEqual([])
  })

  it.each([
    ['e2e/fixtures/electron-app.ts', desktopLanes],
    ['e2e/fixtures/viewport.ts', ['e2e_accessibility_macos', 'e2e_visual_macos']],
    ['e2e/fixtures/library.ts', ['e2e_regressions_macos']]
  ])('routes the shared fixture %s to its importers union', (path, lanes) => {
    expect(classify(path).mode).toBe('selective')
    expect(e2eLanes(path)).toEqual(lanes)
  })

  it.each([
    'e2e/playwright.accessibility.config.ts',
    'e2e/playwright.browser.config.ts',
    'e2e/vite.browser-test.config.ts',
    'e2e/accessibility-reporter.ts',
    'e2e/windows-shard-reporter.ts',
    'playwright.config.ts'
  ])('keeps the Playwright configuration input %s on the full plan', (path) => {
    const plan = classify(path)
    expect(plan.mode).toBe('full')
    expect(plan.roots).toContain('global_gate_input')
  })

  it.each([
    ['e2e/new-unregistered.spec.ts', 'modified', 'unknown'],
    ['e2e/fixtures/new-unattributed-helper.ts', 'added', 'unknown'],
    ['e2e/desktop-runtime-recovery.spec.ts', 'deleted', 'destructive_change'],
    ['e2e/fixtures/electron-app.ts', 'renamed', 'destructive_change']
  ])('keeps %s (%s) on the full plan', (path, status, root) => {
    const plan = classifyChanges([{ path, status }])
    expect(plan.mode).toBe('full')
    expect(plan.roots).toContain(root)
  })

  it('attributes every tracked E2E file so new specs cannot silently fall back to full', () => {
    expect(tracked.length).toBeGreaterThan(100)
    expect(tracked.filter((path) => classify(path).roots.includes('unknown'))).toEqual([])
  })

  it('declares every Vitest suite that loads a selective E2E input', () => {
    const files = new Set(tracked)
    const resolveFile = (base: string): string | undefined =>
      ['', '.ts', '.tsx', '.mjs', '.cjs', '.js'].map((ext) => base + ext).find((p) => files.has(p))
    // Vitest loads a test's own reads plus its transitive imports; factory mocks replace a module
    // for the whole graph. Path strings inside E2E files are Electron launch inputs, not loads.
    const imports = (file: string): string[] =>
      [
        ...readFileSync(file, 'utf8').matchAll(
          /(?:from\s+|import\(\s*|require\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g
        )
      ].map((match) => posix.join(posix.dirname(file), match[1]))
    const closure = (test: string): Set<string> => {
      const text = readFileSync(test, 'utf8')
      const mocked = new Set(
        [...text.matchAll(/vi\.mock\(\s*['"]([^'"]+)['"]\s*,/g)].map((match) =>
          resolveFile(posix.join(posix.dirname(test), match[1]))
        )
      )
      const reads = [
        ...text.matchAll(/(?:readFile(?:Sync)?|resolve)\([^)]*?['"](e2e\/[^'"]+)['"]/g)
      ].map((match) => match[1])
      const seen = new Set<string>()
      const pending = [...imports(test), ...reads]
      while (pending.length) {
        const next = resolveFile(pending.pop()!)
        if (!next?.startsWith('e2e/') || seen.has(next) || mocked.has(next)) continue
        seen.add(next)
        if (/\.[cm]?[jt]sx?$/.test(next)) pending.push(...imports(next))
      }
      return seen
    }
    const tests = execFileSync('git', ['ls-files', '*.test.ts', '*.test.tsx', '*.test.mjs'], {
      encoding: 'utf8'
    })
      .split('\n')
      .filter((path) => path && !path.startsWith('e2e/'))
      .filter((path) => /['"](?:\.\.\/)+e2e\/|['"]e2e\//.test(readFileSync(path, 'utf8')))
    const undeclared: string[] = []
    const reached = new Map(tests.map((test) => [test, closure(test)]))
    for (const [test, inputs] of reached) {
      for (const input of inputs) {
        if (classify(input).mode !== 'selective') continue
        if (!playwrightReaderTests(input)?.includes(test)) undeclared.push(`${input} -> ${test}`)
      }
    }
    expect(undeclared).toEqual([])
    const readers = readManifest().rules.filter((rule: { tests?: string[] }) => rule.tests)
    expect(readers.length).toBeGreaterThan(0)
    for (const rule of readers as Array<{ id: string; paths: string[]; tests: string[] }>) {
      for (const test of rule.tests) {
        expect(test, rule.id).toMatch(/^(?!e2e\/)[\w./-]+\.test\.ts$/)
        // A declaration may cover a runtime require the scan cannot see, but never nothing.
        const used = rule.paths.some(
          (path) => reached.get(test)?.has(path) || readFileSync(test, 'utf8').includes(path)
        )
        expect(used, `${rule.id} -> ${test}`).toBe(true)
      }
    }
    expect(playwrightReaderTests('e2e/fixtures/brand-storage-data.ts')).toEqual([
      'scripts/electron-app-fixture.test.ts',
      'scripts/electron-fixture-teardown.test.ts',
      'src/main/storage/brand-location.test.ts'
    ])
    expect(playwrightReaderTests('src/main/index.ts')).toBeUndefined()
  })

  it('keeps every selected desktop lane executable by its PR Gate job', () => {
    for (const lane of desktopLanes) {
      const path = tracked.find((file) => e2eLanes(file).includes(lane))!
      const plan = classify(path)
      const output = toGitHubOutputPlan(plan)
      const bundle = lane.endsWith('_windows') ? 'windows_e2e' : 'macos_e2e'
      expect(plan.bundles, `${path} -> ${lane}`).toContain(bundle)
      if (bundle === 'macos_e2e') {
        const group = Object.entries({
          journeys: ['e2e_smoke_macos', 'e2e_functional_macos', 'e2e_workspace_macos'],
          presentation: ['e2e_accessibility_macos', 'e2e_visual_macos'],
          regressions: ['e2e_regressions_macos'],
          delegation: ['e2e_delegation_macos']
        }).find(([, lanes]) => lanes.includes(lane))![0]
        expect(output.macosGroups, `${path} -> ${lane}`).toContain(group)
        expect(macosGroupsForPlan(plan)).toEqual(output.macosGroups)
      }
      // PRs substitute Windows journeys for Mac; the queue keeps one Mac core group.
      const changes = [{ path, status: 'modified' }]
      expect(platformExecutionPlan(plan, changes, 'pull_request').bundles).toContain('windows_e2e')
      expect(platformExecutionPlan(plan, changes, 'merge_group').lanes).toContain('e2e_smoke_macos')
    }
  })
})
