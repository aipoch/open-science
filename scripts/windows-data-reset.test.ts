import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { once } from 'node:events'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

const script = resolve('scripts/windows-reset/reset-open-science.ps1')
const launcher = resolve('scripts/windows-reset/reset-open-science.cmd')
const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`
const roots: string[] = []
const fixture = (): { root: string; profile: string; appData: string; data: string } => {
  const root = mkdtempSync(join(tmpdir(), 'open-science-reset-'))
  roots.push(root)
  const profile = join(root, 'user space')
  const appData = join(profile, 'AppData', 'Roaming')
  const data = join(profile, 'OpenScience')
  mkdirSync(join(profile, '.open-science'), { recursive: true })
  mkdirSync(appData, { recursive: true })
  mkdirSync(data)
  return { root, profile, appData, data }
}

const run = (body: string): SpawnSyncReturns<string> =>
  spawnSync(
    join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); . ${quote(script)}; ${body}`
    ],
    { encoding: 'utf8', timeout: 30_000, windowsHide: true }
  )
const success = (body: string): string => {
  const result = run(body)
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr || result.stdout).toBe(0)
  return result.stdout
}
const plan = (f: ReturnType<typeof fixture>, explicit = ''): string =>
  `$plan = @(Get-ResetPlan ${quote(f.profile)} ${quote(f.appData)} ${quote(explicit)} 'fixture-user' '' @());`
const stopped = `function Get-CimInstance { [pscustomobject]@{ Name='unrelated.exe'; ProcessId=987654; ExecutablePath='C:\\unrelated.exe'; CommandLine='unrelated' } };`
const confirmed = `function Read-Host { 'RESET OPEN SCIENCE' };`

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('keeps standalone cache ownership checks identical to the installer owner', () => {
  const source = readFileSync(
    resolve('build/windows-runtime-cache-uninstall.ps1'),
    'utf8'
  ).replaceAll('\r\n', '\n')
  const helpers = source
    .slice(
      source.indexOf('function Get-CanonicalPath'),
      source.indexOf('function Remove-EmptyManagedParent')
    )
    .trim()
  const reset = readFileSync(script, 'utf8').replaceAll('\r\n', '\n')
  expect(
    reset
      .split('# CACHE OWNERSHIP FUNCTIONS BEGIN')[1]
      .split('# CACHE OWNERSHIP FUNCTIONS END')[0]
      .trim()
  ).toBe(helpers)
})

describe.skipIf(process.platform !== 'win32')('Windows data reset', () => {
  it('previews default, legacy and custom data with config last and deletes nothing', () => {
    const f = fixture()
    const custom = join(f.root, '科研 [test]', 'OpenScience')
    mkdirSync(custom, { recursive: true })
    writeFileSync(
      join(f.profile, '.open-science/settings.json'),
      JSON.stringify({ dataRoot: custom })
    )
    const out = success(
      `${plan(f)} ${stopped} Invoke-Reset $plan ${quote(f.profile)} 'fixture-user' -PreviewOnly; $plan[-1].Path`
    )
    expect(out).toContain('Preview only. Nothing was removed.')
    expect(out).toContain(custom)
    expect(out.trim().endsWith(join(f.profile, '.open-science'))).toBe(true)
    expect(existsSync(custom)).toBe(true)
    expect(existsSync(join(f.profile, '.open-science/settings.json'))).toBe(true)
  })

  it('cancels without confirmation and never deletes data', () => {
    const f = fixture()
    const out = success(
      `${plan(f)} ${stopped} function Read-Host { 'no' }; Invoke-Reset $plan ${quote(f.profile)} 'fixture-user'`
    )
    expect(out).toContain('Cancelled. Nothing was removed.')
    expect(existsSync(f.data)).toBe(true)
  })

  it.each([
    'open-science.exe',
    'notebook-appcontainer-host.exe',
    'wsl.exe',
    'python.exe',
    'R.exe',
    'node.exe',
    'claude.exe',
    'codex.exe',
    'opencode.exe',
    'codebuddy.exe'
  ])('refuses active or uninspectable %s', (name) => {
    const f = fixture()
    const result = run(
      `${plan(f)} function Get-CimInstance { [pscustomobject]@{ Name=${quote(name)}; ProcessId=987654 } }; ${confirmed} Invoke-Reset $plan ${quote(f.profile)} 'fixture-user'`
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Detected:')
    expect(existsSync(f.data)).toBe(true)
  })

  it('refuses when process enumeration fails or is empty', () => {
    const f = fixture()
    for (const body of ["throw 'CIM unavailable'", 'return']) {
      const result = run(
        `${plan(f)} function Get-CimInstance { ${body} }; ${confirmed} Invoke-Reset $plan ${quote(f.profile)} 'fixture-user'`
      )
      expect(result.status).not.toBe(0)
      expect(existsSync(f.data)).toBe(true)
    }
  })

  it('rechecks processes after confirmation before deleting', () => {
    const f = fixture()
    const result = run(
      `${plan(f)} ${stopped} function Read-Host { function script:Get-CimInstance { [pscustomobject]@{ Name='open-science.exe'; ProcessId=987654 } }; 'RESET OPEN SCIENCE' }; Invoke-Reset $plan ${quote(f.profile)} 'fixture-user'`
    )
    expect(result.status).not.toBe(0)
    expect(existsSync(f.data)).toBe(true)
  })

  it('exempts its launcher ancestor with -DataRoot but refuses an unrelated shell using that path', () => {
    const f = fixture()
    const processes = `
      function Get-CimInstance {
        [pscustomobject]@{ Name='powershell.exe'; ProcessId=$PID; ParentProcessId=987650; ExecutablePath='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'; CommandLine='reset' };
        [pscustomobject]@{ Name='cmd.exe'; ProcessId=987650; ParentProcessId=0; ExecutablePath='C:\\Windows\\System32\\cmd.exe'; CommandLine=${quote(`cmd /c reset-open-science.cmd -DataRoot "${f.data}"`)} };
        if ($script:otherShell) { [pscustomobject]@{ Name='cmd.exe'; ProcessId=987651; ParentProcessId=0; ExecutablePath='C:\\Windows\\System32\\cmd.exe'; CommandLine=${quote(f.data)} } }
      };
    `
    success(`${plan(f)} ${processes} Assert-OpenScienceStopped $plan`)
    const result = run(
      `${plan(f)} ${processes} $script:otherShell=$true; Assert-OpenScienceStopped $plan`
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('PID 987651')
  })

  it('deletes a confirmed custom data root with spaces, Unicode and literal brackets', () => {
    const f = fixture()
    const custom = join(f.root, '科研 [data]', 'OpenScience')
    mkdirSync(join(custom, 'runtime'), { recursive: true })
    writeFileSync(join(custom, 'runtime/data.txt'), 'fixture')
    writeFileSync(
      join(f.profile, '.open-science/settings.json'),
      JSON.stringify({ dataRoot: custom })
    )
    success(
      `${plan(f)} ${stopped} ${confirmed} Invoke-Reset $plan ${quote(f.profile)} 'fixture-user'`
    )
    expect(existsSync(custom)).toBe(false)
    expect(existsSync(join(f.root, '科研 [data]'))).toBe(true)
  })

  it('removes data and legacy runtime after confirmation, preserving external files and development data', () => {
    const f = fixture()
    const external = join(f.root, 'external-project')
    mkdirSync(external)
    writeFileSync(join(external, 'keep.txt'), 'keep')
    mkdirSync(join(f.data, 'runtime'))
    writeFileSync(join(f.data, 'runtime/old.txt'), 'old')
    symlinkSync(external, join(f.data, 'linked-project'), 'junction')
    mkdirSync(join(f.profile, '.open-science/runtime'))
    writeFileSync(join(f.profile, '.open-science/settings.json'), '{}')
    mkdirSync(join(f.profile, '.open-science-project'))
    mkdirSync(join(f.appData, 'Open Science'))
    const out = success(
      `${plan(f)} ${stopped} ${confirmed} Invoke-Reset $plan ${quote(f.profile)} 'fixture-user'; Invoke-Reset $plan ${quote(f.profile)} 'fixture-user'`
    )
    expect(out.match(/Reset completed/g)).toHaveLength(2)
    expect(existsSync(f.data)).toBe(false)
    expect(existsSync(join(f.profile, '.open-science'))).toBe(false)
    expect(existsSync(join(f.appData, 'Open Science'))).toBe(false)
    expect(readFileSync(join(external, 'keep.txt'), 'utf8')).toBe('keep')
    expect(existsSync(join(f.profile, '.open-science-project'))).toBe(true)
  })

  it('rejects junction targets and protected or nonstandard custom roots', () => {
    const f = fixture()
    const alias = join(f.root, 'alias')
    symlinkSync(f.profile, alias, 'junction')
    for (const custom of [
      f.profile,
      'C:\\',
      join(alias, 'OpenScience'),
      join(f.root, 'arbitrary'),
      'C:OpenScience',
      '\\\\server\\share\\OpenScience'
    ]) {
      const result = run(plan(f, custom))
      expect(result.status, custom).not.toBe(0)
    }
    expect(existsSync(f.data)).toBe(true)
  })

  it('requires an explicit reviewed data path for corrupt settings or recovery residue', () => {
    const f = fixture()
    const settings = join(f.profile, '.open-science/settings.json')
    writeFileSync(settings, '{broken')
    expect(run(plan(f)).status).not.toBe(0)
    success(plan(f, f.data))
    writeFileSync(settings, '{}')
    writeFileSync(`${settings}.123.tmp`, '{}')
    expect(run(plan(f)).status).not.toBe(0)
    success(plan(f, f.data))
  })

  it('preserves settings when a locked data file prevents completion', () => {
    const f = fixture()
    const locked = join(f.data, 'locked.txt')
    writeFileSync(locked, 'locked')
    writeFileSync(join(f.profile, '.open-science/settings.json'), '{}')
    const result = run(
      `${plan(f)} ${stopped} ${confirmed} $handle = [IO.File]::Open(${quote(locked)}, 'Open', 'ReadWrite', 'None'); try { Invoke-Reset $plan ${quote(f.profile)} 'fixture-user' } finally { $handle.Dispose() }`
    )
    expect(result.status).not.toBe(0)
    expect(existsSync(join(f.profile, '.open-science/settings.json'))).toBe(true)
  })

  it('refuses mismatched external cache ownership before touching data', () => {
    const f = fixture()
    const out = success(
      `$cache = Join-Path ${quote(f.profile)} (Get-CacheLeaf ${quote(join(f.data, 'runtime'))} 'fixture-user'); New-Item -ItemType Directory -Path $cache | Out-Null; [IO.File]::WriteAllText((Join-Path $cache '.open-science-cache.json'), '{}'); $cache`
    )
    expect(existsSync(out.trim())).toBe(true)
    const result = run(plan(f))
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('ownership')
    expect(existsSync(f.data)).toBe(true)
  })

  it('recognizes a live runtime through native CIM without terminating it', async () => {
    const f = fixture()
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', f.data], {
      windowsHide: true,
      stdio: 'ignore'
    })
    try {
      await once(child, 'spawn')
      const result = run(
        `${plan(f)} function Get-CimInstance { CimCmdlets\\Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = ${child.pid}' -ErrorAction Stop }; Assert-OpenScienceStopped $plan`
      )
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(`PID ${child.pid}`)
      expect(child.exitCode).toBeNull()
    } finally {
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }
  })

  it('removes a legacy cache when its environment identity differs from the Windows ACL identity', () => {
    const f = fixture()
    const unrelated = join(f.profile, 'os-unrelated')
    mkdirSync(unrelated)
    writeFileSync(join(unrelated, 'keep.txt'), 'keep')
    const out = success(`
      $aclIdentity = [Security.Principal.WindowsIdentity]::GetCurrent().Name;
      $env:USERDOMAIN = 'RESET-FIXTURE';
      $env:USERNAME = 'cache-owner';
      $identity = 'RESET-FIXTURE\\cache-owner';
      if ($identity -eq $aclIdentity) { throw 'Fixture identities must differ' };
      $runtime = ${quote(join(f.profile, '.open-science/runtime'))};
      $cache = Join-Path ${quote(f.profile)} (Get-CompactCacheLeaf $runtime $identity);
      New-Item -ItemType Directory -Path $cache | Out-Null;
      @{ schema=1; canonicalRoot=$runtime.ToLowerInvariant(); userIdentity=$identity } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $cache '.open-science-cache.json') -Encoding UTF8;
      & "$env:SystemRoot\\System32\\icacls.exe" $cache /inheritance:r /grant:r ($aclIdentity + ':(OI)(CI)F') '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null;
      if ($LASTEXITCODE -ne 0) { throw 'Fixture ACL setup failed' };
      $resolvedIdentity = Get-ResetCacheIdentity;
      if ($resolvedIdentity -cne $identity) { throw 'Cache identity convention differs' };
      $plan = @(Get-ResetPlan ${quote(f.profile)} ${quote(f.appData)} '' $resolvedIdentity '' @());
      ${stopped} ${confirmed}
      Invoke-Reset $plan ${quote(f.profile)} $identity;
      if (Test-Path -LiteralPath $cache) { throw 'Owned cache remains' };
    `)
    expect(out).toContain('Managed cache')
    expect(out).toContain('Reset completed')
    expect(readFileSync(join(unrelated, 'keep.txt'), 'utf8')).toBe('keep')
  })

  it('removes a trusted working cache while preserving its parent marker and unowned sibling', () => {
    const f = fixture()
    const parent = join(f.profile, 'os-tmp')
    mkdirSync(join(parent, 'unowned'), { recursive: true })
    writeFileSync(join(parent, 'unowned/keep.txt'), 'keep')
    success(`
      $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name;
      $runtime = ${quote(join(f.data, 'runtime'))};
      $parent = ${quote(parent)};
      $cache = Join-Path $parent (Get-WorkingCacheLeaf $runtime $identity);
      New-Item -ItemType Directory -Path $cache | Out-Null;
      @{ schema=1; kind='micromamba-working-cache-parent'; userIdentity=$identity } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $parent '.open-science-temp.json') -Encoding UTF8;
      @{ schema=1; canonicalRoot=$runtime.ToLowerInvariant(); userIdentity=$identity } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $cache '.open-science-cache.json') -Encoding UTF8;
      foreach ($path in @($parent, $cache)) {
        & "$env:SystemRoot\\System32\\icacls.exe" $path /inheritance:r /grant:r ($identity + ':(OI)(CI)F') '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null;
        if ($LASTEXITCODE -ne 0) { throw 'Fixture ACL setup failed' };
      }
      $plan = @(Get-ResetPlan ${quote(f.profile)} ${quote(f.appData)} '' $identity '' @());
      ${stopped} ${confirmed}
      Invoke-Reset $plan ${quote(f.profile)} $identity;
      if (Test-Path -LiteralPath $cache) { throw 'Owned cache remains' };
    `)
    expect(existsSync(join(parent, '.open-science-temp.json'))).toBe(true)
    expect(readFileSync(join(parent, 'unowned/keep.txt'), 'utf8')).toBe('keep')
  })

  it('launches its sibling PowerShell script from a spaced directory and preserves the exit code', () => {
    const f = fixture()
    const folder = join(f.root, 'launcher space')
    mkdirSync(folder)
    copyFileSync(launcher, join(folder, 'reset-open-science.cmd'))
    writeFileSync(
      join(folder, 'reset-open-science.ps1'),
      "param([switch]$Preview); Write-Output ('preview=' + $Preview); exit 7"
    )
    const result = spawnSync(
      process.env.ComSpec!,
      ['/d', '/s', '/c', `""${join(folder, 'reset-open-science.cmd')}" -Preview"`],
      {
        encoding: 'utf8',
        input: '\r\n',
        timeout: 30_000,
        windowsHide: true,
        windowsVerbatimArguments: true
      }
    )
    expect(result.status, result.stderr).toBe(7)
    expect(result.stdout).toContain('preview=True')
  })

  it('discovers a canonical runtime cache through an 8.3 custom data path', ({ skip }) => {
    const f = fixture()
    const customParent = join(f.root, 'custom data parent')
    const custom = join(customParent, 'OpenScience')
    mkdirSync(join(custom, 'runtime'), { recursive: true })
    const shortParent = success(
      `(New-Object -ComObject Scripting.FileSystemObject).GetFolder(${quote(customParent)}).ShortPath`
    ).trim()
    if (shortParent.toLowerCase() === customParent.toLowerCase()) {
      skip('This Windows volume does not provide 8.3 directory aliases.')
    }
    const alias = join(shortParent, 'OpenScience')
    const runtime = realpathSync.native(join(custom, 'runtime'))
    const out = success(`
      $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name;
      $runtime = ${quote(runtime)};
      $cache = Join-Path ${quote(f.profile)} (Get-CacheLeaf $runtime $identity);
      New-Item -ItemType Directory -Path $cache | Out-Null;
      @{ schema=1; canonicalRoot=$runtime.ToLowerInvariant(); userIdentity=$identity } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $cache '.open-science-cache.json') -Encoding UTF8;
      & "$env:SystemRoot\\System32\\icacls.exe" $cache /inheritance:r /grant:r ($identity + ':(OI)(CI)F') '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null;
      if ($LASTEXITCODE -ne 0) { throw 'Fixture ACL setup failed' };
      $plan = @(Get-ResetPlan ${quote(f.profile)} ${quote(f.appData)} ${quote(alias)} $identity '' @());
      if (@($plan | Where-Object { $_.Path -eq $cache -and $_.Runtime -eq $runtime }).Count -ne 1) {
        throw 'Canonical cache was not discovered from its runtime alias';
      }
      ${stopped} ${confirmed}
      Invoke-Reset $plan ${quote(f.profile)} $identity;
      if (Test-Path -LiteralPath $cache) { throw 'Canonical cache remains' };
    `)
    expect(out).toContain('Reset completed')
    expect(existsSync(custom)).toBe(false)
  })
})
