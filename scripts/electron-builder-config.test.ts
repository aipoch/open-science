import { existsSync, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import type { Stats } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { copyFiles, FileMatcher } from 'app-builder-lib/out/fileMatcher'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

import {
  WSL2_BASH_PREVIEW_MANIFEST,
  matchesWsl2BashPreviewManifest
} from '../src/shared/wsl2-preview-manifest'

import {
  WINDOWS_CACHE_DANGEROUS_RIGHT_NAMES,
  WINDOWS_CACHE_TRUSTED_OWNER_SIDS
} from '@aipoch/environment'

describe('macOS native privacy purpose descriptions', () => {
  it.each([
    'NSDesktopFolderUsageDescription',
    'NSDocumentsFolderUsageDescription',
    'NSDownloadsFolderUsageDescription',
    'NSNetworkVolumesUsageDescription',
    'NSRemovableVolumesUsageDescription',
    'NSLocalNetworkUsageDescription'
  ])('provides a purpose for %s in the app Info.plist configuration', (key) => {
    const config = load(readFileSync(join(process.cwd(), 'electron-builder.yml'), 'utf8')) as {
      mac?: { extendInfo?: Record<string, unknown> }
    }

    expect(config.mac?.extendInfo?.[key]).toEqual(expect.stringMatching(/\S/))
  })
})

describe('electron-builder local evidence exclusion', () => {
  it('runs desktop staging with an explicit target after building its current checkout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-hook-'))
    try {
      await mkdir(join(root, 'scripts'))
      for (const name of ['native-components', 'build-backend', 'stage-backend'])
        await writeFile(
          join(root, 'scripts', `${name}.mjs`),
          `import { appendFileSync } from 'node:fs'; appendFileSync('calls.jsonl', JSON.stringify({name:${JSON.stringify(name)},args:process.argv.slice(2)})+'\\n')`
        )
      await writeFile(
        join(root, 'scripts/stage-node-runtime.mjs'),
        `export async function stageNodeRuntime() {}`
      )
      const require = createRequire(import.meta.url)
      await require('../build/stage-desktop-runtime.cjs')({
        electronPlatformName: process.platform,
        arch: require('builder-util').Arch[process.arch],
        packager: { projectDir: root }
      })
      expect(
        (await readFile(join(root, 'calls.jsonl'), 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      ).toEqual([
        { name: 'native-components', args: [] },
        { name: 'build-backend', args: ['--desktop'] },
        { name: 'stage-backend', args: ['--desktop'] }
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps repository tooling and prior CLI artifacts out while retaining runtime resources', async () => {
    const config = load(readFileSync('electron-builder.yml', 'utf8')) as { files: string[] }
    const root = await mkdtemp(join(tmpdir(), 'desktop-cli-artifacts-'))
    const source = join(root, 'source')
    const destination = join(root, 'packaged')
    const applicationFiles = [
      'out/main/index.js',
      'out/renderer/index.html',
      'resources/notebook/python_loop.py',
      'resources/skills/skill-creator/scripts/utils.js',
      'resources/specialists/template/v1/README.txt',
      'resources/guides/wsl2.html'
    ]
    const cliArtifacts = [
      'out/cli-artifacts/open-science-0.37.0-win32-x64.zip',
      'out/cli-artifacts/win32-x64.json',
      'out/cli-artifacts/.archive-fixture/backend/index.cjs',
      'out/desktop-backend/out/backend/index.cjs',
      'out/desktop-backend-build/index.cjs'
    ]
    const developmentFiles = [
      'scripts/stage-backend.mjs',
      'test/fixtures/paper.pdf',
      'e2e/fixtures/data.csv',
      'docs/design.md',
      'release-notes/v0.37.0.md',
      'patches/dependency.patch',
      'prisma/schema.prisma'
    ]
    try {
      for (const file of [...applicationFiles, ...cliArtifacts, ...developmentFiles]) {
        const target = join(source, file)
        await mkdir(join(target, '..'), { recursive: true })
        await writeFile(target, file)
      }
      await copyFiles([
        new FileMatcher(source, destination, (value) => value, ['**/*', ...config.files])
      ])
      for (const file of applicationFiles)
        expect(await readFile(join(destination, file), 'utf8')).toBe(file)
      for (const file of [...cliArtifacts, ...developmentFiles])
        await expect(readFile(join(destination, file))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('copies the ordinary Node backend dependency tree through the real builder filter', async () => {
    const config = load(readFileSync('electron-builder.yml', 'utf8')) as {
      extraResources: Array<{ from: string; to: string; filter?: string[] }>
    }
    const root = await mkdtemp(join(tmpdir(), 'desktop-backend-package-'))
    const files = [
      'out/backend/index.cjs',
      'node_modules/zod/package.json',
      'node_modules/onnxruntime-node/bin/napi-v6/linux/arm64/onnxruntime_binding.node',
      'node_modules/pdfjs-dist/legacy/build/pdf.mjs',
      'node_modules/@aipoch/pdf-translation/resources/worker.mjs',
      'resources/prisma-client/index.js',
      'node_modules/.prisma/client/default.js',
      'node_modules/@aipoch/process-tree-native/build/Release/process_tree.node',
      'node_modules/parent/node_modules/child/package.json'
    ]
    try {
      for (const file of files) {
        const path = join(root, 'out/desktop-backend', file)
        await mkdir(join(path, '..'), { recursive: true })
        await writeFile(path, file)
      }
      // A prior npm release may coexist; desktop packaging must never pick its stale payload.
      await mkdir(join(root, 'out/standalone/out/backend'), { recursive: true })
      await writeFile(join(root, 'out/standalone/out/backend/index.cjs'), 'stale standalone')
      const matchers = config.extraResources
        .filter((entry) => entry.to === 'backend' || entry.to.startsWith('backend/'))
        .map(
          (entry) =>
            new FileMatcher(
              join(root, entry.from),
              join(root, 'resources', entry.to),
              (value) => value,
              entry.filter
            )
        )
      await copyFiles(matchers)
      for (const file of files)
        expect(await readFile(join(root, 'resources/backend', file), 'utf8')).toBe(file)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('loads the installed providers protocol through the desktop filter without host tokenizer dependencies', async () => {
    const config = load(readFileSync('electron-builder.yml', 'utf8')) as { files: string[] }
    const root = await mkdtemp(join(tmpdir(), 'desktop-providers-'))
    const source = join(root, 'source')
    const destination = join(root, 'packaged')
    const require = createRequire(import.meta.url)
    const collected = new Set<string>()
    // Mirror dependency collection from package manifests, without naming provider internals.
    const collect = async (name: string, resolveFrom: NodeJS.Require): Promise<void> => {
      if (collected.has(name)) return
      collected.add(name)
      let packageRoot = dirname(resolveFrom.resolve(name))
      while (
        !existsSync(join(packageRoot, 'package.json')) ||
        JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).name !== name
      ) {
        const parent = dirname(packageRoot)
        if (parent === packageRoot) throw new Error(`Missing package root: ${name}`)
        packageRoot = parent
      }
      await cp(packageRoot, join(source, 'node_modules', name), {
        recursive: true,
        filter: (path) =>
          path === packageRoot ||
          !path
            .slice(packageRoot.length + 1)
            .split(/[\\/]/)
            .includes('node_modules')
      })
      const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
      for (const dependency of Object.keys(manifest.dependencies ?? {}))
        await collect(dependency, createRequire(join(packageRoot, 'package.json')))
    }
    try {
      await collect('@aipoch/providers', require)
      const filter = new FileMatcher(source, destination, (value) => value, [
        '**/*',
        ...config.files
      ]).createFilter()
      await mkdir(join(destination, 'node_modules'), { recursive: true })
      for (const name of collected) {
        await cp(join(source, 'node_modules', name), join(destination, 'node_modules', name), {
          recursive: true,
          filter: (path) => filter(path, statSync(path))
        })
      }
      const result = execFileSync(
        process.execPath,
        [
          '-e',
          `
        const protocol = require('@aipoch/providers/protocol')
        if (!(protocol.countMessagesInputTokens({messages:[{role:'user',content:'hello'}]}) > 0))
          throw new Error('Installed provider token count failed')
        console.log('ok')
      `
        ],
        { cwd: destination, env: { ...process.env, NODE_PATH: '' }, encoding: 'utf8' }
      )
      expect(result.trim()).toBe('ok')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('declares the native PDF worker imports as production dependencies', () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
    for (const dependency of [
      'fontkit',
      '@embedpdf/pdfium',
      'pdf-lib',
      '@huggingface/transformers'
    ])
      expect(manifest.dependencies[dependency]).toEqual(expect.stringMatching(/\S/))
  })

  it('excludes local papers and traces while preserving application and translation resources', () => {
    const config = load(readFileSync(join(process.cwd(), 'electron-builder.yml'), 'utf8')) as {
      files: string[]
      asarUnpack: string[]
    }
    // Match the builder's default inclusion for an exclusion-only files list.
    const filter = new FileMatcher(process.cwd(), process.cwd(), (value) => value, [
      '**/*',
      ...config.files
    ]).createFilter()
    for (const directory of [
      'docs/internal',
      'docs/superpowers',
      'test-results',
      'playwright-report',
      'blob-report',
      'coverage',
      'local',
      '.dev-isolate',
      '.hallmark',
      '.scratch',
      '.superpowers',
      '.worktree/other-checkout'
    ]) {
      // Exclude the directory itself so the packager never traverses private evidence.
      expect(filter(join(process.cwd(), directory), { isDirectory: () => true } as Stats)).toBe(
        false
      )
      for (const file of ['paper.pdf', 'nested/model.onnx', 'trace.zip', 'screenshot.png'])
        expect(
          filter(join(process.cwd(), directory, file), { isDirectory: () => false } as Stats)
        ).toBe(false)
    }
    for (const file of [
      'out/main/index.js',
      'out/renderer/index.html',
      'resources/pdf-translation-local/worker.mjs',
      'resources/notebook/python_loop.py',
      'node_modules/@aipoch/credential-identity-probe-native/build/Release/credential_secret',
      'node_modules/@aipoch/diagnostics/dist/node.js',
      'node_modules/@aipoch/providers/dist/providers.js',
      'node_modules/@aipoch/providers/dist/protocol.js',
      'node_modules/@aipoch/providers/dist/client.js',
      'node_modules/i18next/index.js',
      'node_modules/electron-updater/out/main.js',
      'package.json',
      'LICENSE'
    ])
      expect(filter(join(process.cwd(), file), { isDirectory: () => false } as Stats)).toBe(true)
    for (const directory of [
      'out/web',
      'packages/pdf-structure',
      'packages/pdf-translation',
      'packages/skills',
      'node_modules/@prisma/client',
      'node_modules/.prisma',
      'node_modules/prisma',
      'node_modules/typescript',
      'node_modules/js-tiktoken',
      'node_modules/tiktoken',
      'node_modules/web-tree-sitter',
      'node_modules/openchemlib',
      'node_modules/citeme-engine-wasm',
      'node_modules/@aipoch/pdf-structure',
      'node_modules/@aipoch/pdf-translation',
      'node_modules/@huggingface/transformers',
      'node_modules/onnxruntime-node',
      'node_modules/onnxruntime-web',
      'node_modules/pdfjs-dist',
      'node_modules/sharp',
      'node_modules/@img/sharp-darwin-arm64',
      'node_modules/@napi-rs/canvas',
      'node_modules/fontkit',
      'node_modules/pdf-lib',
      'node_modules/@embedpdf/pdfium',
      'node_modules/@anthropic-ai/claude-agent-sdk',
      'node_modules/@agentclientprotocol/claude-agent-acp'
    ]) {
      expect(filter(join(process.cwd(), directory), { isDirectory: () => true } as Stats)).toBe(
        false
      )
      expect(
        filter(join(process.cwd(), directory, 'index.js'), { isDirectory: () => false } as Stats)
      ).toBe(false)
    }
  })
})

describe('electron-builder native image processing', () => {
  it.each(['tmp/fixture-build/node.exe', 'tmp/fixture-trace.log', 'docs/internal/fixture-plan.md'])(
    'keeps local-only %s out of the packaged application',
    (relativePath) => {
      const root = process.cwd()
      const config = load(readFileSync(join(root, 'electron-builder.yml'), 'utf8')) as {
        files?: string[]
      }
      const matcher = new FileMatcher(root, root, (pattern) => pattern, config.files)
      if (matcher.containsOnlyIgnore()) matcher.prependPattern('**/*')
      const filter = matcher.createFilter()
      const file = statSync(join(root, 'package.json'))

      expect(filter(join(root, relativePath), file)).toBe(false)
      expect(filter(join(root, 'out/main/index.js'), file)).toBe(true)
    }
  )

  it('keeps desktop native helpers while business dependencies live only in the backend', () => {
    const config = load(readFileSync(join(process.cwd(), 'electron-builder.yml'), 'utf8')) as {
      asarUnpack?: string[]
    }

    expect(config.asarUnpack).not.toContain('node_modules/sharp/**')
    expect(config.asarUnpack).toContain(
      'node_modules/@aipoch/credential-identity-probe-native/build/Release/credential_*'
    )
    expect(config.asarUnpack).toContain(
      'node_modules/@aipoch/process-tree-native/build/Release/*.node'
    )
  })

  it('ships the Notebook network sandbox helpers for every supported platform', () => {
    const config = load(readFileSync(join(process.cwd(), 'electron-builder.yml'), 'utf8')) as {
      files?: string[]
      win?: { extraResources?: Array<{ from: string; to: string }> }
      mac?: { extraResources?: Array<{ from: string; to: string }> }
      linux?: { extraResources?: Array<{ from: string; to: string }> }
    }

    expect(config.files).toContain('!node_modules/@aipoch/notebook-network-sandbox{,/**/*}')
    expect(config.files).toContain('!packages{,/**/*}')
    expect(config.win?.extraResources).toContainEqual({
      from: 'packages/notebook-network-sandbox/vendor/windows/${arch}/notebook-appcontainer-host.exe',
      to: 'notebook-network-sandbox/windows/${arch}/notebook-appcontainer-host.exe'
    })
    expect(config.win?.extraResources).toContainEqual({
      from: 'packages/notebook-network-sandbox/vendor/wsl2/manifest.json',
      to: 'notebook-network-sandbox/wsl2/manifest.json'
    })
    expect(config.mac?.extraResources).toHaveLength(1)
    expect(config.linux?.extraResources).toEqual([
      { from: 'resources/bin/linux/${arch}/micromamba', to: 'micromamba' },
      { from: 'build/deb-cli-launcher', to: 'open-science-cli' }
    ])
  })

  it('keeps Micromamba staging binaries out of the asar and unpacked duplicate tree', () => {
    const config = load(readFileSync(join(process.cwd(), 'electron-builder.yml'), 'utf8')) as {
      files?: string[]
      asarUnpack?: string[]
    }

    expect(config.files).toContain('!resources/bin{,/**/*}')
    expect(config.asarUnpack).toContain('resources/**')
    expect(config.asarUnpack).toContain('!resources/bin{,/**/*}')
  })
})

describe('WSL2 Bash Preview resource compatibility', () => {
  it('keeps the packaged manifest identical to the main-process certification contract', () => {
    const packagedManifest = JSON.parse(
      readFileSync(
        join(
          process.cwd(),
          'packages',
          'notebook-network-sandbox',
          'vendor',
          'wsl2',
          'manifest.json'
        ),
        'utf8'
      )
    )

    expect(packagedManifest).toEqual(WSL2_BASH_PREVIEW_MANIFEST)
  })

  it('uses a resource compatibility contract independent of application releases', () => {
    expect(WSL2_BASH_PREVIEW_MANIFEST).not.toHaveProperty('appVersion')
    expect(matchesWsl2BashPreviewManifest(WSL2_BASH_PREVIEW_MANIFEST)).toBe(true)
  })

  it.each([
    null,
    {},
    { ...WSL2_BASH_PREVIEW_MANIFEST, schemaVersion: -1 },
    { ...WSL2_BASH_PREVIEW_MANIFEST, assets: [] },
    { ...WSL2_BASH_PREVIEW_MANIFEST, assets: [...WSL2_BASH_PREVIEW_MANIFEST.assets, 'unknown'] },
    { ...WSL2_BASH_PREVIEW_MANIFEST, appVersion: 'old-release' }
  ])('rejects incompatible resource metadata: %j', (manifest) => {
    expect(matchesWsl2BashPreviewManifest(manifest)).toBe(false)
  })
})

describe('electron-builder Windows targets', () => {
  it('ships only the uninstallable NSIS package for durable AppContainer resources', () => {
    const rawConfig = readFileSync(join(process.cwd(), 'electron-builder.yml'), 'utf8')
    const config = load(rawConfig) as {
      nsis?: { oneClick?: boolean; perMachine?: boolean; allowElevation?: boolean }
    }
    const windowsConfig = rawConfig.match(/^win:\n([\s\S]*?)(?=^[^\s#])/m)?.[1]

    expect(windowsConfig).toBeDefined()
    expect(windowsConfig).toMatch(/^\s+- nsis\s*$/m)
    expect(windowsConfig).not.toMatch(/^\s+- zip\s*$/m)
    expect(config.nsis).toMatchObject({
      oneClick: false,
      perMachine: false,
      allowElevation: false
    })
    expect(readFileSync(join(process.cwd(), 'build', 'installer.nsh'), 'utf8')).toContain(
      'StrCpy $isForceCurrentInstall "1"'
    )
  })

  it('ships and invokes the owned managed-runtime cache cleanup on uninstall', () => {
    const config = readFileSync(join(process.cwd(), 'electron-builder.yml'), 'utf8')
    const include = readFileSync(join(process.cwd(), 'build', 'installer.nsh'), 'utf8')
    const cleanup = readFileSync(
      join(process.cwd(), 'build', 'windows-runtime-cache-uninstall.ps1'),
      'utf8'
    )

    expect(config).toContain('from: build/windows-runtime-cache-uninstall.ps1')
    expect(config).toContain('include: build/installer-license.nsh')
    expect(readFileSync(join(process.cwd(), 'build', 'installer-license.nsh'), 'utf8')).toContain(
      '!include "${BUILD_RESOURCES_DIR}\\installer.nsh"'
    )
    expect(include).toContain('windows-runtime-cache-uninstall.ps1')
    const customUninstall = include.match(/!macro customUnInstall\n([\s\S]*?)!macroend/)?.[1]
    expect(customUninstall).toContain('$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(customUninstall).not.toMatch(/ExecToLog 'powershell\.exe\b/)
    expect(cleanup).toContain('.open-science-cache.json')
    expect(cleanup).toContain('Get-CompactCacheLeaf')
    expect(cleanup).toContain('$compactLeaf = Get-CompactCacheLeaf $canonicalRoot $userIdentity')
    expect(cleanup).toContain('Get-WorkingCacheLeaf')
    expect(cleanup).toContain('$workingLeaf = Get-WorkingCacheLeaf $canonicalRoot $userIdentity')
    expect(cleanup).toContain('foreach ($configuredTemp in @($env:TEMP, $env:TMP))')
    expect(cleanup).toContain("(Join-Path $configuredTemp 'OpenScienceTmp')")
    expect(cleanup).toContain("(Join-Path $env:USERPROFILE 'os-tmp')")
    expect(cleanup).toContain('Test-TrustedManagedParent')
    expect(cleanup).toContain('Test-NoReparsePointInPath')
    expect(cleanup).toContain("'.open-science-temp.json'")
    expect(cleanup).toContain('$env:TMP')
    expect(cleanup).toContain('$trustedOwnerSids -notcontains $ownerSid')
    expect(cleanup).toContain('elseif ($candidate.ManagedParent')
    expect(cleanup).toContain('(Join-Path $env:PUBLIC $leaf)')
    expect(cleanup).toContain('(Join-Path $env:USERPROFILE $compactLeaf)')
    for (const sid of WINDOWS_CACHE_TRUSTED_OWNER_SIDS) {
      expect(cleanup).toContain("'" + sid + "'")
    }
    expect(cleanup).toContain('$trustedWriteSids -notcontains $sid')
    for (const right of WINDOWS_CACHE_DANGEROUS_RIGHT_NAMES) {
      expect(cleanup).toContain(`[System.Security.AccessControl.FileSystemRights]::${right}`)
    }
    expect(cleanup).toContain('Remove-Item -LiteralPath $candidate')
  })

  it('ships and enforces owned Notebook AppContainer cleanup on uninstall', () => {
    const config = readFileSync(join(process.cwd(), 'electron-builder.yml'), 'utf8')
    const include = readFileSync(join(process.cwd(), 'build', 'installer.nsh'), 'utf8')
    const cleanup = readFileSync(
      join(process.cwd(), 'build', 'windows-notebook-sandbox-uninstall.ps1'),
      'utf8'
    )

    expect(config).toContain('from: build/windows-notebook-sandbox-uninstall.ps1')
    expect(include).toContain('windows-notebook-sandbox-uninstall.ps1')
    expect(include).toContain('${ifNot} ${isUpdated}')
    expect(include).toContain('notebookSandboxCleanupComplete')
    expect(include).toContain('The uninstall was stopped so the cleanup can be retried.')
    expect(cleanup).toContain('-ArgumentList $quotedArguments')
    expect(cleanup).toContain(
      '@($Command, $installationId, $ownershipRoot) | ForEach-Object { ConvertTo-WindowsArgument $_ }'
    )
    expect(cleanup).toContain('OPEN_SCIENCE_E2E_STORAGE_ROOT')
    expect(cleanup).not.toContain('OPEN_SCIENCE_E2E_ROOT')
    expect(cleanup).toContain('& $HostPath $Command $installationId $ownershipRoot')
    expect(cleanup).toContain('& $HostPath prepare-remove $installationId $ownershipRoot')
    expect(cleanup).toContain('& $HostPath finish-remove $installationId $ownershipRoot')
    expect(cleanup).toContain('Test-CurrentUserIsAdministrator')
    expect(cleanup).toContain('Stop-SandboxHostProcesses')
    expect(cleanup).toContain('notebook-sandbox\\$installationId')
    expect(cleanup).toContain("$installationId = '0f3cd2a44c3d4e4e9f1e2a5b'")
    expect(cleanup.indexOf('$ownershipRoot =')).toBeLessThan(cleanup.indexOf('$HostPath ='))
    expect(cleanup).toContain('-Verb RunAs')
    expect(include).toContain('taskkill /F /IM "notebook-appcontainer-host.exe"')
  })

  it('does not claim a Windows publisher while packages remain unsigned', () => {
    const config = load(readFileSync(join(process.cwd(), 'electron-builder.yml'), 'utf8')) as {
      win?: { publisherName?: string; verifyUpdateCodeSignature?: boolean }
    }

    expect(config.win?.publisherName).toBeUndefined()
    expect(config.win?.verifyUpdateCodeSignature).toBeUndefined()
  })
})

describe('electron-builder Linux desktop identity', () => {
  it('keeps Electron and the installed launcher on the same desktop name', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      name: string
      desktopName: string
    }
    const config = load(readFileSync(join(process.cwd(), 'electron-builder.yml'), 'utf8')) as {
      linux?: { executableName?: string; syncDesktopName?: boolean }
    }
    const desktopBaseName = packageJson.desktopName.replace(/\.desktop$/, '')
    const executableName = config.linux?.executableName ?? packageJson.name

    expect(config.linux?.syncDesktopName).toBe(true)
    expect(desktopBaseName).toBe(executableName)
  })

  it('declares bubblewrap as a deb runtime dependency', () => {
    const config = load(readFileSync(join(process.cwd(), 'electron-builder.yml'), 'utf8')) as {
      deb?: { depends?: string[] }
    }

    expect(config.deb?.depends).toContain('bubblewrap')
  })
})

describe('electron-builder macOS icons', () => {
  it('uses Icon Composer for the app and signs the legacy-icon DMG container', () => {
    const config = load(readFileSync(join(process.cwd(), 'electron-builder.yml'), 'utf8')) as {
      mac?: { icon?: string; darkModeSupport?: boolean }
      dmg?: { icon?: string; sign?: boolean }
    }

    expect(config.mac?.icon).toBe('build/icon.icon')
    expect(config.mac?.darkModeSupport).toBe(true)
    expect(config.dmg?.icon).toBe('build/icon.icns')
    expect(config.dmg?.sign).toBe(true)

    const iconComposer = JSON.parse(
      readFileSync(join(process.cwd(), 'build', 'icon.icon', 'icon.json'), 'utf8')
    ) as {
      'fill-specializations'?: Array<{ appearance?: string }>
      groups?: Array<{
        layers?: Array<{ 'fill-specializations'?: Array<{ appearance?: string }> }>
      }>
    }
    expect(iconComposer['fill-specializations']?.some((item) => item.appearance === 'dark')).toBe(
      true
    )
    expect(
      iconComposer.groups?.some((group) =>
        group.layers?.some((layer) =>
          layer['fill-specializations']?.some((item) => item.appearance === 'dark')
        )
      )
    ).toBe(true)
  })
})

it('registers .science as a viewable document without changing the per-user installer', () => {
  const config = load(readFileSync(join(process.cwd(), 'electron-builder.yml'), 'utf8')) as {
    win: {
      fileAssociations: {
        ext: string
        role: string
        mimeType: string
        name: string
        description: string
      }[]
    }
    mac: { fileAssociations: { name: string }[] }
    linux: { fileAssociations: { name: string }[] }
    nsis: { perMachine: boolean; allowElevation: boolean }
  }
  expect(config.win.fileAssociations).toContainEqual(
    expect.objectContaining({
      ext: 'science',
      role: 'Viewer',
      mimeType: 'application/x-open-science-session'
    })
  )
  expect(config.win.fileAssociations[0]).toMatchObject({
    name: 'Open Science Session package',
    description: 'Open-Science Session package'
  })
  expect(config.mac.fileAssociations[0].name).toBe('Open-Science Session package')
  expect(config.linux.fileAssociations[0].name).toBe('Open-Science Session package')
  expect(config.nsis).toMatchObject({ perMachine: false, allowElevation: false })
})
