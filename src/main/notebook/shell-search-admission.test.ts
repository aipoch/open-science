import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { access, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NotebookShellProcessAdapter, runShellCommand } from './shell-process'

// Stop syntax probes at the sandbox boundary; never perform a real host-root traversal.
describe.skipIf(process.platform === 'win32')('POSIX Shell search admission', () => {
  let root: string
  let cwd: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'shell-search-admission-'))
    cwd = join(root, 'workspace')
    await mkdir(cwd)
    await mkdir(join(root, 'runtime'))
    await mkdir(join(root, 'outside'))
    await mkdir(join(cwd, 'data'))
    await symlink(join(root, 'outside'), join(cwd, 'escape'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const prepare = (
    command: string
  ): {
    result: Promise<void>
    wrap: ReturnType<typeof vi.fn>
    reachedSandbox: Error
  } => {
    const reachedSandbox = new Error('test stopped before launching a process')
    const wrap = vi.fn().mockRejectedValue(reachedSandbox)
    const adapter = new NotebookShellProcessAdapter('linux', { wrap })
    const result = adapter
      .prepare({
        command,
        cwd,
        handoffDir: cwd,
        runtimeRoot: join(root, 'runtime'),
        environment: {},
        sessionId: 'search-admission-session',
        projectId: 'search-admission-project'
      })
      .then(async (prepared) => {
        const result = await prepared.execute()
        if (result.exitCode !== 0) throw new Error(result.stderr)
      })
      .finally(() => adapter.shutdown())
    return { result, wrap, reachedSandbox }
  }

  it('executes ordinary searches without an additional cwd restriction', async () => {
    // Keep the host-root probe inert: only the temporary fixture executable may run.
    const probeBin = join(root, 'probe-bin')
    await mkdir(probeBin)
    await writeFile(join(probeBin, 'find'), '#!/bin/sh\nexit 99\n', { mode: 0o700 })
    const request = {
      cwd,
      handoffDir: cwd,
      runtimeRoot: join(root, 'runtime'),
      environment: {},
      sessionId: 's',
      projectId: 'p'
    }
    const denied = await runShellCommand({
      ...request,
      environment: { PATH: probeBin },
      command: 'printf launched > started; find / -name chart.png'
    })
    expect(denied).toMatchObject({ exitCode: 99, stderr: '' })
    await expect(access(join(cwd, 'started'))).resolves.toBeUndefined()
    await writeFile(join(cwd, 'chart.png'), 'fixture')
    const allowed = await runShellCommand({
      ...request,
      command: '/usr/bin/find . -name chart.png'
    })
    expect(allowed).toMatchObject({ stdout: './chart.png\n', stderr: '', exitCode: 0 })
  })

  it('leaves pipeline directory semantics to the shell', async () => {
    const { result, wrap, reachedSandbox } = prepare(`cd /; cd '${cwd}' | cat; find .`)
    await expect(result).rejects.toThrow(reachedSandbox.message)
    expect(wrap).toHaveBeenCalledOnce()
  })

  it.each([
    'command -v diagnostic-tool',
    'command -V diagnostic-tool',
    'command -pv diagnostic-tool',
    'command -p -v diagnostic-tool',
    'builtin command -v diagnostic-tool',
    'echo "$PATH"; command -v diagnostic-tool; ls .'
  ])('allows executable lookup without treating it as execution: %s', async (command) => {
    const { result, wrap, reachedSandbox } = prepare(command)
    await expect(result).rejects.toThrow(reachedSandbox.message)
    expect(wrap).toHaveBeenCalledOnce()
  })

  it.each(['echo "$PATH"; ls ~/.diagnostic-tools | head', 'ls ../outside'])(
    'delegates diagnostic directory access to the sandbox: %s',
    async (command) => {
      const { result, wrap, reachedSandbox } = prepare(command)
      await expect(result).rejects.toThrow(reachedSandbox.message)
      expect(wrap).toHaveBeenCalledOnce()
    }
  )

  it('distinguishes a missing npm on PATH from a search-scope denial', async () => {
    const bin = join(root, 'diagnostic-bin')
    await mkdir(bin)
    const request = {
      command: 'npm --version; printf done',
      cwd,
      handoffDir: cwd,
      runtimeRoot: join(root, 'runtime'),
      environment: { PATH: bin },
      sessionId: 'diagnostic-session',
      projectId: 'diagnostic-project'
    }
    const missing = await runShellCommand(request)
    expect(missing).toMatchObject({ exitCode: 0, stdout: 'done' })
    expect(missing.stderr).toMatch(/npm:.*(?:not found|No such file)/)
    expect(missing.stderr).not.toMatch(/search scope denied/i)
    await writeFile(join(bin, 'npm'), '#!/bin/sh\nprintf "fixture-version\\n"\n', { mode: 0o700 })
    expect(await runShellCommand(request)).toMatchObject({
      exitCode: 0,
      stdout: 'fixture-version\ndone',
      stderr: ''
    })
  })

  it.each([
    'find / -name "chord_diagram.png" 2>/dev/null | head -5',
    'find .. -name "chord_diagram.png"',
    'find ./data/../.. -name "chord_diagram.png"',
    'cd / && find . -name "chord_diagram.png"',
    '(cd /; find . -name "chord_diagram.png")',
    'root=/; find "$root" -name "chord_diagram.png"',
    'find "$UNRESOLVED_SEARCH_ROOT" -name "chord_diagram.png"',
    'sh -c \'find / -name "chord_diagram.png"\'',
    'printf "%s" "$(find / -name chord_diagram.png)"',
    'find -L ./escape -name "chord_diagram.png"',
    'rg --files /',
    'ln -s / fresh-escape; cd fresh-escape; find .',
    'env ln -s / fresh-escape; find fresh-escape',
    "sh -c 'ln -s / fresh-escape'; find fresh-escape",
    'link ../outside/file ./linked-file',
    'cp -s ../outside/file ./linked-file; rg needle .',
    'cp --symbolic-link ../outside/file ./linked-file',
    'rg --ignore-file ../outside/ignore needle .',
    'rg --ignore-file=../outside/ignore needle .',
    'rg -f ../outside/patterns .',
    'rg --file=../outside/patterns .',
    'rg --ignore-file ./escape/ignore needle .',
    'grep --exclude-from ../outside/ignore needle .',
    'du --exclude-from=../outside/ignore .',
    'du -X ../outside/ignore .',
    'fd --ignore-file ../outside/ignore needle .',
    'rg -f - .',
    'rg -f=./data/patterns .',
    'rg -L needle .',
    'rg -nL needle .',
    "bash <<< 'find /'",
    'ROOT=.; printf -v ROOT /; find "$ROOT"',
    'PWD=/; find "$PWD"',
    'tree --metafirst /',
    'find -f / -name x',
    'find -s / -name x',
    'rtk proxy find /',
    'nice -n 10 find /',
    'f(){ cd /; }; f; find .',
    'cd /; cd "$PWD" | cat; find .',
    'rg -P needle /',
    'grep -I needle /',
    'du -P /',
    'env command find /',
    'env --chdir=/ find .',
    'env -C / find .',
    'command env find /',
    'time find /',
    'busybox find /',
    'grep -R needle .',
    "bash <<'EOF'\nfind /\nEOF",
    'if true; then ROOT=/; else ROOT=.; fi; find "$ROOT"',
    'find -O3 / -name x',
    'find -regextype posix-extended / -name chart.png',
    'find -unknown-startup-option / -name chart.png',
    'hash -p /usr/bin/find f; f /',
    'builtin hash -p /usr/bin/find f; f /',
    'command builtin hash -p /usr/bin/find f; f /',
    "builtin eval 'find /'",
    "trap 'cd /' DEBUG; find .",
    "builtin trap 'cd /' DEBUG; find .",
    "command builtin trap 'find /' EXIT",
    'bash ./scan.sh',
    'source ./scan.sh',
    '. ./scan.sh',
    'builtin source ./scan.sh',
    'env bash ./scan.sh',
    'bash ./scan.sh -c "printf safe"',
    'sh -c "$UNRESOLVED_SCRIPT"',
    'sh -c "$(cat ./scan.sh)"',
    'bash < ./scan.sh',
    'cat ./scan.sh | bash',
    "bash ./scan.sh <<'EOF'\nprintf safe\nEOF",
    "bash <<< 'printf safe' < ./scan.sh",
    "bash <<'EOF' < ./scan.sh\nprintf safe\nEOF",
    "bash < ./scan.sh <<'EOF'\nprintf safe\nEOF",
    "bash 3<<'EOF'\nprintf safe\nEOF",
    "bash 3<<< 'printf safe'",
    "bash 0<<< 'find . -name chart.png'",
    'BASH_ENV=./scan.sh bash -c "printf safe"',
    'env BASH_ENV=./scan.sh bash -c "printf safe"',
    'ENV=./scan.sh sh -c "printf safe"',
    'rg -n "needle" /',
    'grep -R "needle" /',
    'fd "chord_diagram" /',
    'ls -R /',
    'tree /',
    'du /',
    'locate chord_diagram.png',
    'mdfind -name chord_diagram.png'
  ])('delegates search syntax to the sandbox without a separate preflight: %s', async (command) => {
    const { result, wrap, reachedSandbox } = prepare(command)
    await expect(result).rejects.toThrow(reachedSandbox.message)
    expect(wrap).toHaveBeenCalledOnce()
  })

  it.each([
    'find',
    'env LANG=C find .',
    'cp ./data/input ./data/output',
    'rg --ignore-file ./data/ignore needle .',
    'rg --ignore-file=./data/ignore needle .',
    'rg -f ./data/patterns .',
    'grep --exclude-from ./data/ignore needle .',
    'du -X ./data/ignore .',
    'fd --ignore-file ./data/ignore needle .',
    'rg -e "../outside is a pattern" .',
    'find -P',
    'find . -regextype posix-extended -name chart.png',
    "builtin printf '%s' 'find / is documentation'",
    "sh -c 'find . -name chart.png'",
    "bash -e -c 'find . -name chart.png'",
    "bash <<< 'find . -name chart.png'",
    "bash -s <<'EOF'\nfind . -name chart.png\nEOF",
    'find . -name "chord_diagram.png"',
    '/usr/bin/find ./data -name "chord_diagram.png"',
    'cd data && find . -name "chord_diagram.png"',
    'root=./data; find "$root" -name "chord_diagram.png"',
    'rg --files .',
    'find . -name foo & wait',
    'fd -H needle .',
    'rg -P needle .',
    'grep -I needle .',
    'du -P .',
    'rg "needle" ./data',
    'printf "%s" "find / is an example, not a command"',
    'cat /etc/hosts',
    'python analysis.py',
    'Rscript analysis.R'
  ])('retains scoped search and ordinary scientific commands: %s', async (command) => {
    const { result, wrap, reachedSandbox } = prepare(command)
    await expect(result).rejects.toThrow(reachedSandbox.message)
    expect(wrap).toHaveBeenCalledOnce()
  })
})

configureTestRuntimeMetadata()
