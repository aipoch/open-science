import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { expect, it } from 'vitest'

const release = (tag: string, blockmap = true, draft = false): object => ({
  tag_name: tag,
  draft,
  prerelease: false,
  assets: (blockmap ? ['.exe', '.exe.blockmap'] : ['.exe']).map((ext) => ({
    name: `aipoch-open-science-${tag.slice(1)}-win-x64-setup${ext}`
  }))
})

// Run the workflow's actual PowerShell selection boundary. The gh function supplies API pages and
// records downloads locally; no GitHub traffic or real installer execution is possible.
it.skipIf(process.platform !== 'win32').each([
  {
    name: 'historical release',
    current: 'v0.27.0',
    pages: [[release('v0.28.0'), release('v0.27.0'), release('v0.26.0')]],
    expected: 'v0.26.0'
  },
  {
    name: 'out-of-order publication',
    current: 'v0.27.0',
    pages: [[release('v0.9.0'), release('v0.26.0'), release('v0.25.0')]],
    expected: 'v0.26.0'
  },
  {
    name: 'older installer on a later API page',
    current: 'v0.27.0',
    pages: [Array.from({ length: 20 }, (_, i) => release(`v0.28.${i}`)), [release('v0.26.0')]],
    expected: 'v0.26.0'
  },
  {
    name: 'missing blockmap and draft release',
    current: 'v0.27.0',
    pages: [[release('v0.26.0', false), release('v0.25.0', true, true), release('v0.24.0')]],
    expected: 'v0.24.0'
  },
  {
    name: 'first stable release',
    current: 'v0.1.0',
    pages: [[release('v0.1.0')]],
    expected: undefined
  },
  {
    name: 'failed release lookup',
    current: 'v0.27.0',
    pages: [],
    expected: undefined,
    failed: true
  }
])('selects an eligible older Windows installer: $name', ({ current, pages, expected, failed }) => {
  const dir = mkdtempSync(join(tmpdir(), 'windows-upgrade-baseline-'))
  try {
    const workflow = load(readFileSync('.github/workflows/windows-upgrade-smoke.yml', 'utf8')) as {
      jobs: Record<string, { steps: { name: string; run?: string }[] }>
    }
    const step = workflow.jobs['windows-upgrade-smoke'].steps.find(
      (item) => item.name === 'Download previous stable Windows installer'
    )!
    expect(step.run).toBeTruthy()
    writeFileSync(join(dir, 'releases.json'), JSON.stringify(pages))
    const script = join(dir, 'selection.ps1')
    writeFileSync(
      script,
      `
function gh {
  $global:LASTEXITCODE = 0
  if ($env:TEST_API_FAIL -eq 'true') { $global:LASTEXITCODE = 7; return }
  if ($args[0] -eq 'release' -and $args[1] -eq 'list') {
    $releases = @(Get-Content -Raw $env:TEST_RELEASES | ConvertFrom-Json | ForEach-Object { $_ })
    return ConvertTo-Json -InputObject @($releases | ForEach-Object { @{tagName=$_.tag_name} })
  }
  if ($args[0] -eq 'api') { return Get-Content -Raw $env:TEST_RELEASES }
  if ($args[0] -eq 'release' -and $args[1] -eq 'download') {
    $args[2] | Out-File -FilePath $env:TEST_SELECTED_TAG -Encoding utf8
    return
  }
  throw "Unexpected gh operation: $args"
}
${step.run}
`
    )
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', script], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        CURRENT_TAG: current,
        TEST_RELEASES: join(dir, 'releases.json'),
        GITHUB_REPOSITORY: 'example/test',
        GITHUB_OUTPUT: join(dir, 'output.txt'),
        TEST_SELECTED_TAG: join(dir, 'selected.txt'),
        TEST_API_FAIL: failed ? 'true' : 'false'
      }
    })
    expect(result.status, result.stderr).toBe(failed ? 7 : 0)
    if (expected) expect(readFileSync(join(dir, 'selected.txt'), 'utf8').trim()).toBe(expected)
    else expect(existsSync(join(dir, 'selected.txt'))).toBe(false)
    if (!failed)
      expect(readFileSync(join(dir, 'output.txt'), 'utf8')).toContain(
        `available=${expected ? 'true' : 'false'}`
      )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
