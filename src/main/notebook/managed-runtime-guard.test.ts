import { describe, expect, it } from 'vitest'

import { detectManagedRuntimeMutation, protectManagedRuntimeWrites } from './managed-runtime-guard'

describe('detectManagedRuntimeMutation', () => {
  const runtimeRoot = '/tmp/open-science/runtime'

  it.each([
    ['python', `print("pip install pandas")`],
    ['r', `cat("install.packages('dplyr')")`],
    ['bash', `echo "pip install pandas"`],
    ['bash', '# pip install pandas'],
    ['python', `print("pip install pandas"); subprocess.run(["echo", "ok"])`],
    ['r', `cat("install.packages('dplyr')"); system("echo ok")`],
    ['repl', `console.log("pip install pandas"); execFile("echo", ["ok"])`],
    ['repl', '// pip install pandas'],
    ['repl', '/* pip install pandas */'],
    ['repl', 'console.log(`pip install pandas`)'],
    ['python', `print('os.system("pip install pandas")')`],
    ['repl', '// exec("pip install pandas")'],
    ['repl', 'console.log(`exec("pip install pandas")`)'],
    ['python', 'import pip, venv, ensurepip; print(pip.__version__)'],
    ['bash', 'python -m pip list'],
    ['python', 'subprocess.run([sys.executable, "-m", "pip", "show", "numpy"])'],
    ['repl', 'execFile("python3", ["-m", "pip", "help"])'],
    ['python', 'print(os.environ["OPEN_SCIENCE_RUNTIME_DIR"]); open("report.txt", "w")'],
    ['python', 'open("/tmp/open-science/runtime-backup.txt", "w")'],
    ['python', 'Path("/tmp/open-science/runtime-backup.txt").write_text("ok")'],
    [
      'python',
      'shutil.copy(os.path.join(os.environ["OPEN_SCIENCE_RUNTIME_DIR"], "x"), "report.txt")'
    ],
    ['bash', 'echo "$OPEN_SCIENCE_RUNTIME_DIR"; touch report.txt'],
    ['bash', 'cp "$OPEN_SCIENCE_RUNTIME_DIR/x" ./copy.txt'],
    ['bash', 'printf x > report.txt'],
    ['bash', 'cd /tmp; touch report.txt'],
    ['powershell', 'Write-Output $env:OPEN_SCIENCE_RUNTIME_DIR; New-Item report.txt'],
    ['powershell', 'Copy-Item "$env:OPEN_SCIENCE_RUNTIME_DIR\\source.txt" ".\\copy.txt"'],
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
    ['python', `os.system("pip install pandas")`],
    ['r', `f <- utils::install.packages`],
    ['bash', 'pip install pandas'],
    ['bash', 'python -m pip install pandas'],
    ['bash', `Rscript -e 'install.packages("dplyr")'`],
    ['python', `subprocess.run(["pip", "install", "pandas"])`],
    ['python', 'subprocess.run([sys.executable, "-m", "pip", "install", "pandas"])'],
    ['r', `system("R CMD INSTALL package.tar.gz")`],
    ['repl', `execFile("pip", ["install", "pandas"])`],
    ['repl', 'execFile("python3", ["-m", "pip", "install", "pandas"])'],
    ['bash', `tool=python3; mode=-m; action=venv; "$tool" "$mode" "$action" analysis-env`],
    ['bash', `tool=pip; verb=install; "$tool" "$verb" --user pandas`],
    ['python', 'open(os.path.join(os.environ["OPEN_SCIENCE_RUNTIME_DIR"], "x"), "w")'],
    ['python', 'Path(os.environ["OPEN_SCIENCE_RUNTIME_DIR"]).write_text("x")'],
    [
      'python',
      'shutil.copy("report.txt", os.path.join(os.environ["OPEN_SCIENCE_RUNTIME_DIR"], "x"))'
    ],
    ['bash', 'touch "$OPEN_SCIENCE_RUNTIME_DIR/x"'],
    ['bash', 'cp ./copy.txt "$OPEN_SCIENCE_RUNTIME_DIR/x"'],
    ['bash', 'cat > "$OPEN_SCIENCE_RUNTIME_DIR/x"'],
    ['bash', 'target="$OPEN_SCIENCE_RUNTIME_DIR/x"; printf x >> "$target"'],
    ['bash', 'target="$OPEN_SCIENCE_RUNTIME_DIR/x"; touch "$target"'],
    [
      'bash',
      'root=$(printf %s /tmp/open-science/runtime); touch "$root/conda-meta/pwn.json"'
    ],
    ['bash', 'cd "$OPEN_SCIENCE_RUNTIME_DIR" && touch conda-meta/pwn.json'],
    ['powershell', 'Set-Location $env:OPEN_SCIENCE_RUNTIME_DIR; New-Item conda-meta\\pwn.json'],
    ['powershell', 'Remove-Item "$env:OPEN_SCIENCE_RUNTIME_DIR\\conda-meta\\history"'],
    ['powershell', "$target = Join-Path $env:OPEN_SCIENCE_RUNTIME_DIR 'pwn.txt'; New-Item $target"],
    ['r', 'writeLines("x", file.path(Sys.getenv("OPEN_SCIENCE_RUNTIME_DIR"), "x"))'],
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
})

describe('protectManagedRuntimeWrites', () => {
  const invocation = { executable: 'sh', args: ['-c', 'echo hi'] }

  it('wraps the complete child process tree in a macOS read-only runtime policy', () => {
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
    expect(protectedInvocation.args[1]).toContain(
      '(deny file-write* (subpath "/tmp/open-science/runtime"))'
    )
  })

  it('leaves the invocation unchanged where no native sandbox adapter exists', () => {
    expect(protectManagedRuntimeWrites(invocation, '/tmp/open-science/runtime', 'linux')).toBe(
      invocation
    )
  })
})
