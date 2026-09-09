import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { expect, it } from 'vitest'

// Run the workflow's actual PowerShell selection boundary. The gh function is deliberately local:
// it supplies API pages and records downloads, never reaches GitHub or executes an installer.
it.skipIf(process.platform !== 'win32')(
  'selects an older stable installer when replaying a historical release',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'windows-upgrade-baseline-'))
    try {
      const workflow = load(
        readFileSync('.github/workflows/windows-upgrade-smoke.yml', 'utf8')
      ) as {
        jobs: Record<string, { steps: { name: string; run?: string }[] }>
      }
      const step = workflow.jobs['windows-upgrade-smoke'].steps.find(
        (item) => item.name === 'Download previous stable Windows installer'
      )!
      expect(step.run).toBeTruthy()
      const script = join(dir, 'selection.ps1')
      writeFileSync(
        script,
        `
function gh {
  $global:LASTEXITCODE = 0
  if ($args[0] -eq 'release' -and $args[1] -eq 'list') {
    return '[{"tagName":"v0.28.0"},{"tagName":"v0.27.0"},{"tagName":"v0.26.0"}]'
  }
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
          CURRENT_TAG: 'v0.27.0',
          GITHUB_OUTPUT: join(dir, 'output.txt'),
          TEST_SELECTED_TAG: join(dir, 'selected.txt')
        }
      })
      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(join(dir, 'selected.txt'), 'utf8').trim()).toBe('v0.26.0')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
)
