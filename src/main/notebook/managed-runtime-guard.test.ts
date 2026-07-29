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
    ['python', 'print(os.environ["OPEN_SCIENCE_RUNTIME_DIR"]); open("report.txt", "w")'],
    ['bash', 'echo "$OPEN_SCIENCE_RUNTIME_DIR"; touch report.txt'],
    ['r', 'cat(Sys.getenv("OPEN_SCIENCE_RUNTIME_DIR")); writeLines("ok", "report.txt")'],
    ['repl', 'console.log(process.env.OPEN_SCIENCE_RUNTIME_DIR); writeFileSync("report.txt", "ok")']
  ] as const)('allows %s code that only mentions an installer', (surface, source) => {
    expect(detectManagedRuntimeMutation({ source, surface, runtimeRoot })).toBeUndefined()
  })

  it.each([
    ['python', `os.system("pip install pandas")`],
    ['r', `f <- utils::install.packages`],
    ['bash', 'pip install pandas'],
    ['bash', `Rscript -e 'install.packages("dplyr")'`],
    ['python', `subprocess.run(["pip", "install", "pandas"])`],
    ['r', `system("R CMD INSTALL package.tar.gz")`],
    ['repl', `execFile("pip", ["install", "pandas"])`],
    ['bash', `tool=python3; mode=-m; action=venv; "$tool" "$mode" "$action" analysis-env`],
    ['bash', `tool=pip; verb=install; "$tool" "$verb" --user pandas`],
    ['python', 'open(os.path.join(os.environ["OPEN_SCIENCE_RUNTIME_DIR"], "x"), "w")'],
    ['bash', 'touch "$OPEN_SCIENCE_RUNTIME_DIR/x"'],
    ['r', 'writeLines("x", file.path(Sys.getenv("OPEN_SCIENCE_RUNTIME_DIR"), "x"))'],
    ['repl', 'writeFileSync(process.env.OPEN_SCIENCE_RUNTIME_DIR + "/x", "x")']
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
