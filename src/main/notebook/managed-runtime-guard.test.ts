import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

import { describe, expect, it } from 'vitest'

import { detectManagedRuntimeMutation, protectManagedRuntimeWrites } from './managed-runtime-guard'

describe('detectManagedRuntimeMutation', () => {
  it('uses the injected platform for managed-runtime path comparisons', () => {
    const platform: NodeJS.Platform = process.platform === 'win32' ? 'linux' : 'win32'
    const runtimeRoot = join(tmpdir(), 'OpenScience', 'runtime')
    const target = join(tmpdir(), 'openscience', 'runtime', 'pwn.txt')
    const mutation = detectManagedRuntimeMutation({
      source: `touch "${target}"`,
      surface: 'bash',
      runtimeRoot,
      platform
    })

    expect(mutation !== undefined).toBe(platform === 'win32')
  })

  const runtimeRoot = '/tmp/open-science/runtime'

  it.each([
    ['python', `print("pip install pandas")`],
    ['r', `cat("install.packages('dplyr')")`],
    ['bash', `echo "pip install pandas"`],
    ['bash', `echo "$OPEN_SCIENCE_RUNTIME_DIR/envs/default-python/bin/pip install pandas"`],
    ['bash', '# pip install pandas'],
    ['python', `print("pip install pandas"); subprocess.run(["echo", "ok"])`],
    ['python', `subprocess.run(["echo", 'python -c "pip install pandas"'])`],
    ['r', `cat("install.packages('dplyr')"); system("echo ok")`],
    ['r', `system2("echo", 'python -c "pip install pandas"')`],
    ['repl', `console.log("pip install pandas"); execFile("echo", ["ok"])`],
    ['repl', `execFile("echo", ['python -c "pip install pandas"'])`],
    ['repl', '// pip install pandas'],
    ['repl', '/* pip install pandas */'],
    ['repl', 'console.log(`pip install pandas`)'],
    ['python', `print('os.system("pip install pandas")')`],
    ['repl', '// exec("pip install pandas")'],
    ['repl', 'console.log(`exec("pip install pandas")`)'],
    ['python', 'import pip, venv, ensurepip; print(pip.__version__)'],
    ['bash', 'python -m pip list'],
    ['bash', `python -c 'import pip; print(pip.__version__)'`],
    ['python', 'subprocess.run([sys.executable, "-m", "pip", "show", "numpy"])'],
    ['python', `os.system('echo "$OPEN_SCIENCE_RUNTIME_DIR"')`],
    ['r', `system('echo "$OPEN_SCIENCE_RUNTIME_DIR"')`],
    ['repl', `exec('echo "$OPEN_SCIENCE_RUNTIME_DIR"')`],
    [
      'python',
      `subprocess.run(["cp", os.environ["OPEN_SCIENCE_RUNTIME_DIR"] + "/source.txt", "report.txt"])`
    ],
    ['python', `subprocess.run(["echo", "touch", os.environ["OPEN_SCIENCE_RUNTIME_DIR"] + "/x"])`],
    ['repl', 'execFile("python3", ["-m", "pip", "help"])'],
    ['powershell', `node -e 'require("child_process").execFileSync("pip", ["list"])'`],
    ['python', 'print(os.environ["OPEN_SCIENCE_RUNTIME_DIR"]); open("report.txt", "w")'],
    ['python', 'open("/tmp/open-science/runtime-backup.txt", "w")'],
    ['python', 'Path("/tmp/open-science/runtime-backup.txt").write_text("ok")'],
    ['r', 'pipe("cat /tmp/open-science/runtime/conda-meta/history")'],
    [
      'r',
      'file.copy(file.path(Sys.getenv("OPEN_SCIENCE_RUNTIME_DIR"), "source.txt"), "report.txt")'
    ],
    [
      'python',
      'shutil.copy(os.path.join(os.environ["OPEN_SCIENCE_RUNTIME_DIR"], "x"), "report.txt")'
    ],
    ['bash', 'echo "$OPEN_SCIENCE_RUNTIME_DIR"; touch report.txt'],
    ['bash', 'cp "$OPEN_SCIENCE_RUNTIME_DIR/x" ./copy.txt'],
    ['bash', 'printf x > report.txt'],
    ['bash', 'cd /tmp; touch report.txt'],
    ['powershell', 'Write-Output $env:OPEN_SCIENCE_RUNTIME_DIR; New-Item report.txt'],
    ['powershell', 'Set-Content report.txt $env:OPEN_SCIENCE_RUNTIME_DIR'],
    ['powershell', 'Copy-Item "$env:OPEN_SCIENCE_RUNTIME_DIR\\source.txt" ".\\copy.txt"'],
    ['powershell', 'cmd /c copy %OPEN_SCIENCE_RUNTIME_DIR%\\source.txt report.txt'],
    ['r', 'cat(Sys.getenv("OPEN_SCIENCE_RUNTIME_DIR")); writeLines("ok", "report.txt")'],
    ['r', 'writeLines(Sys.getenv("OPEN_SCIENCE_RUNTIME_DIR"), "report.txt")'],
    [
      'repl',
      'console.log(process.env.OPEN_SCIENCE_RUNTIME_DIR); writeFileSync("report.txt", "ok")'
    ],
    ['repl', 'copyFileSync(process.env.OPEN_SCIENCE_RUNTIME_DIR + "/x", "report.txt")']
  ] as const)('allows %s code that only mentions an installer', (surface, source) => {
    expect(detectManagedRuntimeMutation({ source, surface, runtimeRoot })).toBeUndefined()
  })

  it.each([
    ['bash', 'cd "$OPEN_SCIENCE_RUNTIME_DIR"; cd ..; touch report.txt'],
    ['bash', `cd "$OPEN_SCIENCE_RUNTIME_DIR"; sh -c 'cd ..; touch report.txt'`],
    ['bash', 'cd "$OPEN_SCIENCE_RUNTIME_DIR/subdir"; cd ../..; touch report.txt'],
    [
      'powershell',
      'Set-Location $env:OPEN_SCIENCE_RUNTIME_DIR; Set-Location ..; New-Item report.txt'
    ]
  ] as const)('allows %s after leaving the managed runtime: %s', (surface, source) => {
    expect(detectManagedRuntimeMutation({ source, surface, runtimeRoot })).toBeUndefined()
  })

  it.each([
    ['python', `os.system("pip install pandas")`],
    ['r', `f <- utils::install.packages`],
    ['bash', 'pip install pandas'],
    ['bash', '"$OPEN_SCIENCE_RUNTIME_DIR/envs/default-python/bin/pip" install pandas'],
    ['bash', 'result=$(pip install pandas)'],
    ['bash', 'prefix=$(printf analysis) PIP_DISABLE_PIP_VERSION_CHECK=1 pip install pandas'],
    ['bash', 'python -m pip install pandas'],
    ['bash', `Rscript -e 'install.packages("dplyr")'`],
    ['bash', `python -c 'import pip._internal; pip._internal.main(["install", "pandas"])'`],
    ['bash', `python -c 'import venv; venv.create("analysis-env")'`],
    ['powershell', `node -e 'require("child_process").execFileSync("pip", ["install", "pandas"])'`],
    ['python', `subprocess.run(["pip", "install", "pandas"])`],
    ['python', 'subprocess.run([sys.executable, "-m", "pip", "install", "pandas"])'],
    ['r', `system("R CMD INSTALL package.tar.gz")`],
    ['r', `file.link(Sys.getenv("OPEN_SCIENCE_RUNTIME_DIR"), "runtime-link")`],
    ['r', `file.symlink(Sys.getenv("OPEN_SCIENCE_RUNTIME_DIR"), "runtime-link")`],
    ['repl', `execFile("pip", ["install", "pandas"])`],
    ['repl', 'execFile("python3", ["-m", "pip", "install", "pandas"])'],
    ['bash', `tool=python3; mode=-m; action=venv; "$tool" "$mode" "$action" analysis-env`],
    ['bash', `tool=pip; verb=install; "$tool" "$verb" --user pandas`],
    ['python', 'open(os.path.join(os.environ["OPEN_SCIENCE_RUNTIME_DIR"], "x"), "w")'],
    ['python', 'Path(os.environ["OPEN_SCIENCE_RUNTIME_DIR"]).write_text("x")'],
    ['python', `os.system('touch "$OPEN_SCIENCE_RUNTIME_DIR"/x')`],
    ['r', `system('touch "$OPEN_SCIENCE_RUNTIME_DIR"/x')`],
    ['repl', `exec('touch "$OPEN_SCIENCE_RUNTIME_DIR"/x')`],
    [
      'python',
      `subprocess.run(["cp", "report.txt", os.environ["OPEN_SCIENCE_RUNTIME_DIR"] + "/x"])`
    ],
    [
      'python',
      `subprocess.run(["sudo", "-n", "touch", os.environ["OPEN_SCIENCE_RUNTIME_DIR"] + "/x"])`
    ],
    [
      'python',
      'shutil.copy("report.txt", os.path.join(os.environ["OPEN_SCIENCE_RUNTIME_DIR"], "x"))'
    ],
    ['bash', 'touch "$OPEN_SCIENCE_RUNTIME_DIR/x"'],
    ['bash', 'cp ./copy.txt "$OPEN_SCIENCE_RUNTIME_DIR/x"'],
    ['bash', 'cat > "$OPEN_SCIENCE_RUNTIME_DIR/x"'],
    ['bash', 'target="$OPEN_SCIENCE_RUNTIME_DIR/x"; printf x >> "$target"'],
    ['bash', 'target="$OPEN_SCIENCE_RUNTIME_DIR/x"; touch "$target"'],
    ['bash', 'root=$(printf %s /tmp/open-science/runtime); touch "$root/conda-meta/pwn.json"'],
    [
      'bash',
      'ln -s "$OPEN_SCIENCE_RUNTIME_DIR" runtime-link; touch runtime-link/conda-meta/pwn.json'
    ],
    ['bash', 'cd "$OPEN_SCIENCE_RUNTIME_DIR" && touch conda-meta/pwn.json'],
    ['bash', 'cd "$OPEN_SCIENCE_RUNTIME_DIR/subdir"; cd ..; touch conda-meta/pwn.json'],
    ['bash', `cd "$OPEN_SCIENCE_RUNTIME_DIR"; sh -c 'touch conda-meta/inherited-cwd.json'`],
    ['bash', `cd "$OPEN_SCIENCE_RUNTIME_DIR"; python -c 'open("python-relative", "w")'`],
    ['bash', `cd "$OPEN_SCIENCE_RUNTIME_DIR"; Rscript -e 'writeLines("x", "r-relative")'`],
    ['powershell', 'Set-Location $env:OPEN_SCIENCE_RUNTIME_DIR; New-Item conda-meta\\pwn.json'],
    [
      'powershell',
      `Set-Location $env:OPEN_SCIENCE_RUNTIME_DIR; powershell -Command 'New-Item conda-meta\\inherited-cwd.json'`
    ],
    [
      'powershell',
      `Set-Location $env:OPEN_SCIENCE_RUNTIME_DIR; node -e 'require("fs").writeFileSync("node-relative", "x")'`
    ],
    [
      'powershell',
      `powershell.exe -c 'Set-Content "$env:OPEN_SCIENCE_RUNTIME_DIR\\short-command.txt" x'`
    ],
    ['powershell', 'Remove-Item "$env:OPEN_SCIENCE_RUNTIME_DIR\\conda-meta\\history"'],
    ['powershell', "$target = Join-Path $env:OPEN_SCIENCE_RUNTIME_DIR 'pwn.txt'; New-Item $target"],
    [
      'powershell',
      '[IO.File]::WriteAllText((Join-Path $env:OPEN_SCIENCE_RUNTIME_DIR "pwn.txt"), "x")'
    ],
    ['powershell', '& "pip" install pandas'],
    ['r', 'writeLines("x", file.path(Sys.getenv("OPEN_SCIENCE_RUNTIME_DIR"), "x"))'],
    ['r', 'file.append(file.path(Sys.getenv("OPEN_SCIENCE_RUNTIME_DIR"), "x"), "report.txt")'],
    [
      'r',
      'download.file("https://example.invalid/report", file.path(Sys.getenv("OPEN_SCIENCE_RUNTIME_DIR"), "x"))'
    ],
    ['r', 'fifo(file.path(Sys.getenv("OPEN_SCIENCE_RUNTIME_DIR"), "x"), open="w")'],
    ['r', 'pipe("touch /tmp/open-science/runtime/x")'],
    [
      'python',
      'os.truncate(os.path.join(os.environ["OPEN_SCIENCE_RUNTIME_DIR"], "conda-meta", "history"), 0)'
    ],
    ['r', 'file.copy("report.txt", file.path(Sys.getenv("OPEN_SCIENCE_RUNTIME_DIR"), "x"))'],
    [
      'bash',
      `python -c 'import os; open(os.path.join(os.environ["OPEN_SCIENCE_RUNTIME_DIR"], "x"), "w")'`
    ],
    [
      'python',
      `subprocess.run([sys.executable, "-c", "import os; open(os.path.join(os.environ['OPEN_SCIENCE_RUNTIME_DIR'], 'x'), 'w')"] )`
    ],
    [
      'r',
      `system2("python3", c("-c", "import os; open(os.environ['OPEN_SCIENCE_RUNTIME_DIR'] + '/x', 'w')"))`
    ],
    [
      'repl',
      `execFile("python3", ["-c", "import os; open(os.environ['OPEN_SCIENCE_RUNTIME_DIR'] + '/x', 'w')"])`
    ],
    ['repl', 'writeFileSync(process.env.OPEN_SCIENCE_RUNTIME_DIR + "/x", "x")'],
    ['repl', 'fs.mkdtemp(process.env.OPEN_SCIENCE_RUNTIME_DIR + "/pwn-", callback)'],
    ['repl', 'mkdtempSync(process.env.OPEN_SCIENCE_RUNTIME_DIR + "/pwn-")'],
    ['repl', 'fs.promises.mkdtemp(process.env.OPEN_SCIENCE_RUNTIME_DIR + "/pwn-")'],
    ['repl', 'copyFileSync("report.txt", process.env.OPEN_SCIENCE_RUNTIME_DIR + "/x")']
  ] as const)('rejects %s code that executes or aliases an installer', (surface, source) => {
    expect(detectManagedRuntimeMutation({ source, surface, runtimeRoot })?.message).toMatch(
      /manage_packages/
    )
  })

  it.each([
    'cmd.exe /d /c copy report.txt C:\\OpenScience\\runtime\\conda-meta\\history',
    'cmd /c mkdir C:\\OpenScience\\runtime\\pwn',
    'cmd.exe /c rmdir C:\\OpenScience\\runtime\\envs\\default-r /s /q',
    'cmd /c mklink /d report-link C:\\OpenScience\\runtime\\envs\\default-r'
  ])('rejects a cmd.exe payload that writes into the Windows runtime', (source) => {
    expect(
      detectManagedRuntimeMutation({
        source,
        surface: 'powershell',
        runtimeRoot: 'C:\\OpenScience\\runtime'
      })?.message
    ).toMatch(/manage_packages/)
  })

  it.each(['-EncodedCommand', '-ec', '-e'])(
    'rejects a PowerShell %s payload that writes into the Windows runtime',
    (flag) => {
      const payload =
        '[IO.File]::WriteAllText("C:\\OpenScience\\runtime\\conda-meta\\encoded.txt", "x")'
      const encoded = Buffer.from(payload, 'utf16le').toString('base64')

      expect(
        detectManagedRuntimeMutation({
          source: `powershell.exe -NoProfile ${flag} ${encoded}`,
          surface: 'powershell',
          runtimeRoot: 'C:\\OpenScience\\runtime'
        })?.message
      ).toMatch(/manage_packages/)
    }
  )

  it('rejects a shell write through an existing runtime symlink or junction', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'os-runtime-alias-'))
    const runtimeRoot = join(cwd, 'managed-runtime')
    const alias = join(cwd, 'runtime-link')
    try {
      await mkdir(runtimeRoot, { recursive: true })
      await symlink(runtimeRoot, alias, process.platform === 'win32' ? 'junction' : 'dir')

      expect(
        detectManagedRuntimeMutation({
          source: 'touch runtime-link/conda-meta/pwn.json',
          surface: 'bash',
          runtimeRoot,
          cwd
        })?.message
      ).toMatch(/manage_packages/)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('handles an unterminated shell command substitution without exponential backtracking', () => {
    const source = `A=$( ${String.raw`\(`.repeat(256)} `
    const startedAt = performance.now()

    expect(detectManagedRuntimeMutation({ source, surface: 'bash', runtimeRoot })).toBeUndefined()
    expect(performance.now() - startedAt).toBeLessThan(500)
  })
})

describe('protectManagedRuntimeWrites', () => {
  const invocation = { executable: 'sh', args: ['-c', 'echo hi'] }
  const macOSOnly = it.skipIf(process.platform === 'win32')

  macOSOnly('wraps the complete child process tree in a macOS read-only runtime policy', () => {
    const protectedInvocation = protectManagedRuntimeWrites(
      invocation,
      '/tmp/open-science/runtime',
      'darwin'
    )

    expect(protectedInvocation.executable).toBe('/usr/bin/sandbox-exec')
    expect(protectedInvocation.args.slice(-3)).toEqual(['sh', '-c', 'echo hi'])
    expect(protectedInvocation.args[0]).toBe('-p')
    expect(protectedInvocation.args[1]).toContain(
      '(deny file-write* (literal "/tmp/open-science/runtime"))'
    )
    expect(protectedInvocation.args[1]).toContain('(subpath "/tmp/open-science/runtime")')
    expect(protectedInvocation.args[1]).toContain(
      '(require-not (literal "/tmp/open-science/runtime/cache/notebook"))'
    )
    expect(protectedInvocation.args[1]).toContain(
      '(require-not (subpath "/tmp/open-science/runtime/cache/notebook"))'
    )
  })

  it.skipIf(process.platform !== 'darwin')(
    'allows the workload cache while keeping the rest of runtime read-only on macOS',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'open-science-seatbelt-cache-'))
      const runtimeRoot = join(root, 'runtime')
      const cacheRoot = join(runtimeRoot, 'cache', 'notebook')
      const cacheFile = join(cacheRoot, 'allowed.txt')
      const blockedFile = join(runtimeRoot, 'blocked.txt')
      await mkdir(cacheRoot, { recursive: true })

      try {
        const invocation = protectManagedRuntimeWrites(
          {
            executable: '/bin/sh',
            args: [
              '-c',
              'printf cache > "$1"; printf blocked > "$2"',
              'open-science-seatbelt-test',
              cacheFile,
              blockedFile
            ]
          },
          runtimeRoot,
          'darwin'
        )
        const result = spawnSync(invocation.executable, invocation.args, { encoding: 'utf8' })

        expect(result.status).not.toBe(0)
        expect(result.stderr).toMatch(/Operation not permitted/)
        expect(await readFile(cacheFile, 'utf8')).toBe('cache')
        await expect(stat(blockedFile)).rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  it('leaves the invocation unchanged where no native sandbox adapter exists', () => {
    expect(protectManagedRuntimeWrites(invocation, '/tmp/open-science/runtime', 'linux')).toBe(
      invocation
    )
  })

  it('keeps an absolute executable with shell metacharacters in one sandbox argv element', () => {
    const executable = '/Applications/Open Science; touch injected.app/Contents/MacOS/Open Science'
    const protectedInvocation = protectManagedRuntimeWrites(
      { executable, args: ['--inspect'] },
      '/tmp/open-science/runtime',
      'darwin'
    )

    expect(protectedInvocation.executable).toBe('/usr/bin/sandbox-exec')
    expect(protectedInvocation.args.slice(-2)).toEqual([executable, '--inspect'])
  })
})
