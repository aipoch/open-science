import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NotebookRuntimeService, type NotebookExecutionRequest } from './runtime-service'
import { analyzeNotebookCodeRisk } from './code-risk-analysis'
import * as riskAnalysis from './code-risk-analysis'
import type { ShellRuntimeBinding, NotebookRunSummary } from '../../shared/notebook'
import type { DiscoveredInterpreter } from '../../shared/notebook-runtime'

const roots: string[] = []
const services: NotebookRuntimeService[] = []
const pythonNativeFlagPrelude =
  'import subprocess,builtins,operator\nfrom builtins import bool as B,int as I,len as L\nselector=True\nconvert=bool if selector else len\n'
const pythonNativeFalseFlags = [
  'bool()',
  'bool(False)',
  'bool(0)',
  'bool(None)',
  'bool("")',
  'bool([])',
  'bool(())',
  'bool({})',
  'builtins.bool(False)',
  'B(False)',
  'bool.__call__(False)',
  'getattr(bool,"__call__")(False)',
  'operator.call(bool,False)',
  'bool(*[False])',
  'bool(*())',
  'not bool(True)',
  'not not bool(False)',
  'int()',
  'int(False)',
  'int(-0)',
  'int(+0x0)',
  'int("0")',
  'int("-0_0")',
  'int(" +00 ")',
  'int(b"0")',
  'I(False)',
  'builtins.int(False)',
  'operator.call(int,False)',
  'int(bool(False))',
  'int(len([]))',
  'len(())',
  'len([])',
  'len({})',
  'len("")',
  'L(())',
  'builtins.len(())',
  'operator.call(len,())',
  'len(tuple())',
  'len(list([]))',
  'len("".split())',
  'len([*list([])])',
  'bool(len(tuple()))',
  'not len([0])',
  'list()',
  'tuple([])',
  '"".split()',
  'bool(list())',
  'bool(tuple([]))',
  'convert(())',
  'dict()',
  'bool(dict())',
  'len(dict())',
  'operator.call(dict)',
  'bool(dict(**dict()))'
]
const pythonNativeTrueFlags = [
  'bool(True)',
  'bool("False")',
  'bool([False])',
  'bool((None,))',
  'bool({"key":False})',
  'not bool(False)',
  'int(True)',
  'int(-1)',
  'int("-00_1")',
  'I("12")',
  'len([0])',
  'len((None,))',
  'len("False")',
  'len({"key":0})',
  'len([*tuple([0])])',
  'bool(len([0]))',
  'convert([0])',
  'int(not False)',
  'dict(key=0)',
  'bool(dict(key=0))',
  'len(dict(key=0))'
]
const pythonNativeKeywordForms = [
  'dict()',
  'dict(shell=False)',
  'dict(text=True,shell=False)',
  'dict({"shell":False})',
  'dict({"shell":True},shell=False)',
  'dict({"shell":False},text=True)',
  'dict({"shell":False}|{"text":True})',
  'dict(**{"shell":False})',
  'dict(**dict(shell=False))',
  'dict(dict(shell=False),text=True)',
  'dict([("shell",False),("text",True)])',
  'dict((("shell",True),("shell",False)))',
  'dict([*[("shell",False)]])',
  'dict(*({"shell":False},))',
  'dict(shell=bool(False))',
  'dict(shell=int("0"))',
  'dict(shell=len([*list([])]))',
  'dict(shell=False if selector else 0)',
  'dict(executable=None,preexec_fn=None,env=None,shell=False)',
  'builtins.dict(shell=False)',
  'D(shell=False)',
  'dict.__call__(shell=False)',
  'getattr(dict,"__call__")(shell=False)',
  'operator.call(dict,shell=False)',
  'operator.call(operator.call,dict,shell=False)',
  '(dict if selector else builtins.dict)(shell=False)',
  '{**dict(shell=False),"text":True}',
  '{"text":True,**dict(shell=False)}',
  '{**dict(shell=True),**dict(shell=False)}'
]
afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdownAll()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function harness(
  environmentCount = 0,
  shellRuntimeBinding?: ShellRuntimeBinding
): Promise<{
  service: NotebookRuntimeService
  execute: ReturnType<typeof vi.fn>
  shell: ReturnType<typeof vi.fn>
  runtimes: DiscoveredInterpreter[]
  request: { projectId: string; sessionId: string; workspaceCwd: string }
}> {
  const root = await mkdtemp(join(tmpdir(), 'notebook-risk-'))
  roots.push(root)
  const execute = vi.fn(async (request: NotebookExecutionRequest) => ({
    status: 'completed' as const,
    stdout: '',
    stderr: '',
    traceback: '',
    cwdAfter: request.cwd,
    outputs: [],
    kernelDispatched: true
  }))
  const shell = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }))
  const runtimes: DiscoveredInterpreter[] = Array.from(
    { length: environmentCount },
    (_, index) => ({
      language: 'python' as const,
      provenance: 'user-own' as const,
      envId: join(root, `python-${index}`),
      interpreterPath: join(root, `python-${index}`),
      label: `Python ${index}`,
      runnable: true
    })
  )
  const service = new NotebookRuntimeService({
    notebookRuntimeSettings: {
      getSnapshot: async (language) => ({
        language,
        manualInterpreters: [],
        packageMirror: {},
        runtimeEnablement: {
          enabled: Object.fromEntries(runtimes.map((r) => [r.envId, true])),
          installAuthorized: {}
        }
      })
    },
    configRoot: root,
    dataRoot: root,
    projectId: 'project',
    discoverRuntimes: async (language) =>
      runtimes.filter((runtime) => runtime.language === language),
    executorFactory: () => ({ execute, shutdown: async () => ({ reaped: true }) }),
    shellRuntimeBinding,
    shellProcess: { execute: shell }
  })
  services.push(service)
  return {
    service,
    execute,
    shell,
    runtimes,
    request: { projectId: 'project', sessionId: 'session', workspaceCwd: root }
  }
}

describe('host-owned one-shot execution admission', () => {
  it.each(['python', 'r'] as const)(
    'keeps %s default binding admission separate from every later destructive Cell',
    async (language) => {
      const { service, execute, request, runtimes } = await harness()
      const environment = language === 'r' ? 'default-r' : 'default-python'
      const interpreter = join(
        request.workspaceCwd,
        'runtime',
        'envs',
        environment,
        'bin',
        language === 'r' ? 'R' : 'python'
      )
      runtimes.push({
        language,
        provenance: 'app-managed',
        envId: interpreter,
        interpreterPath: interpreter,
        label: environment,
        condaEnv: environment,
        runnable: true
      })
      const environmentApproval = vi.fn(async (decision) => decision.defaultManagedFirstBinding)
      const codeApproval = vi.fn(async () => false)
      service.setRuntimeBindingApproval(environmentApproval)
      service.setExecutionApproval(codeApproval)
      const run = async (code: string): Promise<NotebookRunSummary> => {
        const cell = await service.beginCodeCell({ ...request, language })
        await service.appendCodeCell({ ...request, ...cell, delta: code })
        await service.finishCodeCell({ ...request, ...cell })
        return service.runCell({ ...request, cellId: cell.cellId })
      }
      await run('print(1)')
      expect(environmentApproval).toHaveBeenCalledTimes(1)
      expect(codeApproval).not.toHaveBeenCalled()
      const dangerous =
        language === 'r' ? 'unlink("sentinel.txt")' : 'import os\nos.unlink("sentinel.txt")'
      await expect(run(dangerous)).rejects.toThrow('one-time approval')
      await expect(run(dangerous)).rejects.toThrow('one-time approval')
      expect(environmentApproval).toHaveBeenCalledTimes(1)
      expect(codeApproval).toHaveBeenCalledTimes(2)
      expect(execute).toHaveBeenCalledTimes(1)
      expect(codeApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          rawInput: expect.objectContaining({
            notebookCodeRisk: expect.objectContaining({ language, environment })
          })
        })
      )
    }
  )

  it('carries PowerShell dialect from the actual runtime into approval evidence', async () => {
    const analyze = vi
      .spyOn(riskAnalysis, 'analyzePowerShellCodeRisk')
      .mockResolvedValue([
        { operation: 'Remove-Item', source: 'Remove-Item ./temporary.txt', line: 1 }
      ])
    try {
      const { service, shell, request } = await harness(0, { kind: 'powershell', version: '5.1' })
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      await expect(
        service.executeShell({ ...request, command: 'Remove-Item ./temporary.txt' })
      ).rejects.toThrow('one-time approval')
      expect(approve).toHaveBeenCalledWith(
        expect.objectContaining({
          rawInput: expect.objectContaining({
            notebookCodeRisk: expect.objectContaining({
              language: 'bash',
              shellRuntime: { kind: 'powershell' }
            })
          })
        })
      )
      expect(shell).not.toHaveBeenCalled()
    } finally {
      analyze.mockRestore()
    }
  })

  it.skipIf(process.platform === 'win32').each(['cp', 'mv'])(
    'gates real %s overwrite and source removal per execution',
    async (command) => {
      const { service, shell, request } = await harness()
      const source = join(request.workspaceCwd, 'source.txt')
      const target = join(request.workspaceCwd, 'target.txt')
      await writeFile(source, 'new content')
      await writeFile(target, 'keep content')
      shell.mockImplementation(
        (execution) =>
          new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
            execFile(
              '/bin/sh',
              ['-c', execution.command],
              {
                cwd: request.workspaceCwd,
                timeout: 5000
              },
              (error, stdout, stderr) => {
                if (error && typeof error.code !== 'number') reject(error)
                else
                  resolve({
                    stdout,
                    stderr,
                    exitCode: typeof error?.code === 'number' ? error.code : 0
                  })
              }
            )
          })
      )
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      await service.executeShell({ ...request, command: 'cp -n source.txt target.txt' })
      await service.executeShell({ ...request, command: 'cp -n source.txt fresh.txt' })
      expect(approve).not.toHaveBeenCalled()
      expect(await readFile(target, 'utf8')).toBe('keep content')
      expect(await readFile(join(request.workspaceCwd, 'fresh.txt'), 'utf8')).toBe('new content')
      const input = { ...request, command: `${command} -f source.txt target.txt` }
      await expect(service.executeShell(input)).rejects.toThrow('one-time approval')
      expect(shell).toHaveBeenCalledTimes(2)
      expect(await readFile(source, 'utf8')).toBe('new content')
      expect(await readFile(target, 'utf8')).toBe('keep content')
      approve.mockResolvedValueOnce(true)
      await service.executeShell(input)
      expect(shell).toHaveBeenCalledTimes(3)
      expect(await readFile(target, 'utf8')).toBe('new content')
      if (command === 'mv') await expect(readFile(source)).rejects.toMatchObject({ code: 'ENOENT' })
      else expect(await readFile(source, 'utf8')).toBe('new content')
      await writeFile(source, 'second run')
      await expect(service.executeShell(input)).rejects.toThrow('one-time approval')
      expect(approve).toHaveBeenCalledTimes(3)
      expect(shell).toHaveBeenCalledTimes(3)
      expect(await readFile(source, 'utf8')).toBe('second run')
      expect(await readFile(target, 'utf8')).toBe('new content')
    }
  )

  it.skipIf(!process.env.OPEN_SCIENCE_RISK_PYTHON)(
    'gates real Python overwrite while allowing new files and append',
    async () => {
      const { service, execute, request } = await harness()
      execute.mockImplementation(async (execution) => {
        const { stdout, stderr } = await promisify(execFile)(
          process.env.OPEN_SCIENCE_RISK_PYTHON!,
          ['-c', execution.code],
          { cwd: execution.cwd, timeout: 5000 }
        )
        return {
          status: 'completed',
          stdout,
          stderr,
          traceback: '',
          cwdAfter: execution.cwd,
          outputs: [],
          kernelDispatched: true
        }
      })
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      const code = 'open("write-target.txt", "w").write("new")'
      await service.execute({ ...request, code })
      const target = join(execute.mock.calls[0][0].cwd, 'write-target.txt')
      await service.execute({
        ...request,
        code: 'open("write-target.txt", "a").write(" appended")'
      })
      await service.execute({ ...request, code: 'print(open("write-target.txt").read())' })
      expect(approve).not.toHaveBeenCalled()
      expect(await readFile(target, 'utf8')).toBe('new appended')
      await expect(service.execute({ ...request, code })).rejects.toThrow('one-time approval')
      expect(await readFile(target, 'utf8')).toBe('new appended')
      approve.mockResolvedValueOnce(true)
      await service.execute({ ...request, code })
      expect(await readFile(target, 'utf8')).toBe('new')
      await expect(service.execute({ ...request, code })).rejects.toThrow('one-time approval')
      expect(approve).toHaveBeenCalledTimes(3)
      expect(execute).toHaveBeenCalledTimes(4)
    }
  )

  it
    .skipIf(!process.env.OPEN_SCIENCE_RISK_PYTHON)
    .each([
      'chdir',
      'copy-file',
      'copy-directory',
      'copy2-file',
      'copy2-directory',
      'handle-write',
      'handle-truncate'
    ])('gates real Python bounded overwrite form=%s once', async (form) => {
    const { service, execute, request } = await harness()
    execute.mockImplementation(async (execution) => {
      const { stdout, stderr } = await promisify(execFile)(
        process.env.OPEN_SCIENCE_RISK_PYTHON!,
        ['-c', execution.code],
        { cwd: execution.cwd, timeout: 5000 }
      )
      return {
        status: 'completed',
        stdout,
        stderr,
        traceback: '',
        cwdAfter: execution.cwd,
        outputs: [],
        kernelDispatched: true
      }
    })
    const approve = vi.fn(async () => false)
    service.setExecutionApproval(approve)
    const executeCode = (code: string): ReturnType<typeof service.execute> =>
      service.execute({ ...request, code })
    await executeCode('pass')
    const cwd = execute.mock.calls[0][0].cwd
    let target = join(cwd, 'target.txt')
    let code: string
    let expected = 'new'
    let before = 'keep'
    let promptFreeExecutions = 1
    if (form === 'chdir') {
      await mkdir(join(cwd, 'data'))
      target = join(cwd, 'data', 'target.txt')
      // Restore cwd after writing so every attempt starts outside the target directory.
      code = 'import os\nos.chdir("data")\nopen("target.txt","w").write("new")\nos.chdir("..")'
      await writeFile(target, before)
      await expect(readFile(join(cwd, 'target.txt'))).rejects.toMatchObject({
        code: 'ENOENT'
      })
    } else if (form.startsWith('copy')) {
      const method = form.startsWith('copy2') ? 'copy2' : 'copy'
      const directory = form.endsWith('directory')
      await writeFile(join(cwd, 'source.txt'), 'new')
      if (directory) {
        await mkdir(join(cwd, 'data'))
        target = join(cwd, 'data', 'source.txt')
      }
      code = `import shutil\nshutil.${method}("source.txt",${JSON.stringify(directory ? 'data' : 'target.txt')})`
      // An existing destination directory does not make its missing child an overwrite.
      await executeCode(code)
      promptFreeExecutions++
      expect(approve).not.toHaveBeenCalled()
      expect(await readFile(target, 'utf8')).toBe('new')
      await writeFile(target, before)
    } else {
      await writeFile(target, before)
      await executeCode('with open("target.txt","r+") as handle:\n    print(handle.read())')
      await executeCode('with open("target.txt","a") as handle:\n    handle.write(" appended")')
      await executeCode('with open("exclusive.txt","x") as handle:\n    handle.write("new")')
      promptFreeExecutions += 3
      before = 'keep appended'
      expect(approve).not.toHaveBeenCalled()
      expect(await readFile(target, 'utf8')).toBe(before)
      expect(await readFile(join(cwd, 'exclusive.txt'), 'utf8')).toBe('new')
      code =
        form === 'handle-write'
          ? 'open("target.txt","r+").write("new")'
          : 'with open("target.txt","r+") as handle:\n    handle.truncate(0)'
      expected = form === 'handle-write' ? 'newp appended' : ''
    }
    await expect(executeCode(code)).rejects.toThrow('one-time approval')
    expect(execute).toHaveBeenCalledTimes(promptFreeExecutions)
    expect(await readFile(target, 'utf8')).toBe(before)
    approve.mockResolvedValueOnce(true)
    await executeCode(code)
    expect(await readFile(target, 'utf8')).toBe(expected)
    await writeFile(target, 'next run')
    await expect(executeCode(code)).rejects.toThrow('one-time approval')
    expect(await readFile(target, 'utf8')).toBe('next run')
    expect(approve).toHaveBeenCalledTimes(3)
    expect(execute).toHaveBeenCalledTimes(promptFreeExecutions + 1)
  })

  it('keeps long kernel history prompt-free and reviews every deletion separately', async () => {
    const { service, execute, request } = await harness()
    const approve = vi.fn(async () => false)
    service.setExecutionApproval(approve)
    for (let index = 0; index < 8; index++)
      await service.execute({
        ...request,
        code: '#' + 'x'.repeat(35_000) + `\nimport os\nprint(${index})`
      })
    await service.execute({ ...request, code: 'print("hello")' })
    expect(approve).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(9)
    const code = 'os.unlink("target.txt")'
    await expect(service.execute({ ...request, code })).rejects.toThrow('one-time approval')
    expect(execute).toHaveBeenCalledTimes(9)
    approve.mockResolvedValueOnce(true)
    await service.execute({ ...request, code })
    await expect(service.execute({ ...request, code })).rejects.toThrow('one-time approval')
    expect(approve).toHaveBeenCalledTimes(3)
    expect(execute).toHaveBeenCalledTimes(10)
  })
  it.skipIf(!process.env.OPEN_SCIENCE_RISK_PYTHON)(
    'executes real Python after long history without reusing deletion consent',
    async () => {
      const { service, execute, request } = await harness()
      const target = join(request.workspaceCwd, 'history-target.txt')
      const keep = join(request.workspaceCwd, 'keep.txt')
      await writeFile(target, 'test')
      await writeFile(keep, 'keep')
      execute.mockImplementation(async (execution) => {
        const { stdout, stderr } = await promisify(execFile)(
          process.env.OPEN_SCIENCE_RISK_PYTHON!,
          ['-c', execution.code],
          { cwd: execution.cwd, timeout: 5000 }
        )
        return {
          status: 'completed',
          stdout,
          stderr,
          traceback: '',
          cwdAfter: execution.cwd,
          outputs: [],
          kernelDispatched: true
        }
      })
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      for (let index = 0; index < 8; index++)
        await service.execute({ ...request, code: '#' + 'x'.repeat(35_000) + `\nprint(${index})` })
      await service.execute({ ...request, code: `print(open(${JSON.stringify(target)}).read())` })
      expect((await execute.mock.results[8].value).stdout).toContain('test')
      expect(approve).not.toHaveBeenCalled()
      const code = `import os\nos.unlink(${JSON.stringify(target)})`
      await expect(service.execute({ ...request, code })).rejects.toThrow('one-time approval')
      expect(await readFile(target, 'utf8')).toBe('test')
      approve.mockResolvedValueOnce(true)
      await service.execute({ ...request, code })
      await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
      await writeFile(target, 'next run')
      await expect(service.execute({ ...request, code })).rejects.toThrow('one-time approval')
      expect(execute).toHaveBeenCalledTimes(10)
      expect(approve).toHaveBeenCalledTimes(3)
      expect(await readFile(target, 'utf8')).toBe('next run')
      expect(await readFile(keep, 'utf8')).toBe('keep')
    }
  )
  it.skipIf(!process.env.OPEN_SCIENCE_RISK_PYTHON)(
    'matches native Python split keyword mappings and container truth',
    async () => {
      const options = [
        'dict()',
        'dict(maxsplit=1)',
        'dict(sep=None)',
        'dict(sep=" ",maxsplit=1)',
        'dict({"maxsplit":-1})',
        'dict(dict(sep=None),maxsplit=1)',
        'D(maxsplit=1)',
        '{**dict(maxsplit=1)}',
        '{"maxsplit":0,"maxsplit":1}',
        'dict([("maxsplit",1)])',
        '{"sep":" ","maxsplit":1}'
      ]
      const expressions = options.flatMap((form) =>
        ['split', 'rsplit'].flatMap((method) => [
          `"echo target.txt".${method}(**${form})`,
          `str.${method}("echo target.txt",**${form})`
        ])
      )
      const { stdout } = await promisify(execFile)(
        process.env.OPEN_SCIENCE_RISK_PYTHON!,
        [
          '-c',
          'import operator,json\nfrom builtins import dict as D\n' +
            `print(json.dumps([${expressions.join(',')}]))`
        ],
        { timeout: 5000 }
      )
      const singleExpressions = [
        '"echo target.txt".split(**dict(maxsplit=0))',
        '"echo target.txt".rsplit(**dict(sep=","))'
      ]
      const single = await promisify(execFile)(
        process.env.OPEN_SCIENCE_RISK_PYTHON!,
        ['-c', 'import json;print(json.dumps([' + singleExpressions.join(',') + ']))'],
        { timeout: 5000 }
      )
      expect(JSON.parse(single.stdout)).toEqual([['echo target.txt'], ['echo target.txt']])
      for (const expr of singleExpressions) {
        expect(
          await analyzeNotebookCodeRisk('python', 'import subprocess;subprocess.run(' + expr + ')')
        ).toEqual([])
        expect(
          await analyzeNotebookCodeRisk(
            'python',
            'import subprocess;subprocess.run(' + expr.replaceAll('echo', 'rm') + ')'
          )
        ).toEqual([])
      }
      const vectors = JSON.parse(stdout) as string[][]
      expect(vectors).toHaveLength(expressions.length)
      for (const [index, expr] of expressions.entries()) {
        expect(vectors[index]).toEqual(['echo', 'target.txt'])
        expect(
          await analyzeNotebookCodeRisk(
            'python',
            `import subprocess,operator\nfrom builtins import dict as D\nsubprocess.run(${expr})`
          )
        ).toEqual([])
        expect(
          (
            await analyzeNotebookCodeRisk(
              'python',
              `import subprocess,operator\nfrom builtins import dict as D\nsubprocess.run(${expr.replaceAll('echo', 'rm')})`
            )
          ).length
        ).toBeGreaterThan(0)
      }
    }
  )
  it.skipIf(!process.env.OPEN_SCIENCE_RISK_PYTHON)(
    'matches native Python constructed keyword precedence and process classification',
    async () => {
      const forms = [
        ...pythonNativeKeywordForms,
        'dict(check=True)',
        'dict(stdout=subprocess.PIPE,check=True)',
        'dict({"shell":False},shell=True)',
        'dict([("shell",False),("shell",True)])',
        'dict(dict(shell=False),shell=True)',
        'operator.call(dict,{"shell":False},shell=True)'
      ]
      const { stdout } = await promisify(execFile)(
        process.env.OPEN_SCIENCE_RISK_PYTHON!,
        [
          '-c',
          pythonNativeFlagPrelude +
            'from builtins import dict as D\nimport json\n' +
            `print(json.dumps([{"literal":repr(options),"shell":bool(options.get("shell",False))} for options in [${forms.join(',')}]]))`
        ],
        { timeout: 5000 }
      )
      const mappings = JSON.parse(stdout) as { literal: string; shell: boolean }[]
      expect(mappings).toHaveLength(forms.length)
      expect(
        mappings.slice(0, pythonNativeKeywordForms.length).every((value) => !value.shell)
      ).toBe(true)
      for (const [index, form] of forms.entries())
        for (const danger of [false, true]) {
          const argv = JSON.stringify(
            mappings[index].shell
              ? danger
                ? 'rm target.txt'
                : 'echo hello'
              : [danger ? 'rm' : 'echo', 'target.txt']
          )
          const code =
            pythonNativeFlagPrelude +
            'from builtins import dict as D\n' +
            `subprocess.run(${argv},**${form})`
          const literal = `import subprocess\nsubprocess.run(${argv},**${mappings[index].literal})`
          expect(
            (await analyzeNotebookCodeRisk('python', code)).map((value) => value.operation),
            form
          ).toEqual(
            (await analyzeNotebookCodeRisk('python', literal)).map((value) => value.operation)
          )
        }
    }
  )
  it.skipIf(!process.env.OPEN_SCIENCE_RISK_PYTHON)(
    'matches native Python constructed flag truth and process classification',
    async () => {
      const flags = [...pythonNativeFalseFlags, ...pythonNativeTrueFlags]
      const { stdout } = await promisify(execFile)(
        process.env.OPEN_SCIENCE_RISK_PYTHON!,
        [
          '-c',
          pythonNativeFlagPrelude +
            `import json\nprint(json.dumps([bool(value) for value in [${flags.join(',')}]]))`
        ],
        { timeout: 5000 }
      )
      const values = JSON.parse(stdout) as boolean[]
      expect(values).toEqual([
        ...pythonNativeFalseFlags.map(() => false),
        ...pythonNativeTrueFlags.map(() => true)
      ])
      for (const [index, flag] of flags.entries())
        for (const danger of [false, true]) {
          const argv = JSON.stringify(
            values[index]
              ? danger
                ? 'rm target.txt'
                : 'echo hello'
              : [danger ? 'rm' : 'echo', 'hello']
          )
          const risks = await analyzeNotebookCodeRisk(
            'python',
            pythonNativeFlagPrelude + `subprocess.run(${argv},shell=(${flag}))`
          )
          const literal = await analyzeNotebookCodeRisk(
            'python',
            `import subprocess\nsubprocess.run(${argv},shell=${values[index] ? 'True' : 'False'})`
          )
          expect(
            risks.map((risk) => risk.operation),
            flag
          ).toEqual(literal.map((risk) => risk.operation))
        }
    }
  )
  it.skipIf(!process.env.OPEN_SCIENCE_RISK_PYTHON || process.platform === 'win32')(
    'matches native Python literal truth and selected process argument choices',
    async () => {
      const conditions = [
        'True',
        'False',
        '1',
        '0',
        '-1',
        '0.0',
        'None',
        '""',
        '"text"',
        '[]',
        '[1]',
        '()',
        '(1,)',
        '{}',
        '{"key":1}',
        '{1}',
        'not 0'
      ]
      const selections = conditions.flatMap((condition) => [
        `["echo","hello"] if ${condition} else ["rm","target.txt"]`,
        `["rm","target.txt"] if ${condition} else ("echo","hello")`
      ])
      const expressions = selections.flatMap((source) => [
        source,
        `list(${source})`,
        `tuple(${source})`,
        `(${source})[:]`,
        `[*(${source})]`
      ])
      const { stdout } = await promisify(execFile)(
        process.env.OPEN_SCIENCE_RISK_PYTHON!,
        ['-c', `import json\nprint(json.dumps([${expressions.join(',')}]))`],
        { timeout: 5000 }
      )
      const vectors = JSON.parse(stdout) as string[][]
      expect(vectors).toHaveLength(expressions.length)
      for (const [index, expression] of expressions.entries()) {
        const literalRisks = await analyzeNotebookCodeRisk(
          'python',
          `import subprocess\nsubprocess.run(${JSON.stringify(vectors[index])})`
        )
        const risks = await analyzeNotebookCodeRisk(
          'python',
          `import subprocess\nsubprocess.run(${expression})`
        )
        expect(
          risks.map((risk) => risk.operation),
          expression
        ).toEqual(literalRisks.map((risk) => risk.operation))
      }
    }
  )
  it.skipIf(!process.env.OPEN_SCIENCE_RISK_PYTHON || process.platform === 'win32')(
    'matches native Python slice bounds, clipping and reversed stops',
    async () => {
      const bounds = ['None', '-5', '-2', '-1', '0', '1', '2', '5', 'True', 'False']
      const steps = ['None', '-3', '-1', '1', '2', '5', 'True']
      const expressions = bounds.flatMap((start) =>
        bounds.flatMap((stop) =>
          steps.map((step) => `["rm","echo","target.txt","--help"][${start}:${stop}:${step}]`)
        )
      )
      const { stdout } = await promisify(execFile)(
        process.env.OPEN_SCIENCE_RISK_PYTHON!,
        ['-c', `import json\nprint(json.dumps([${expressions.join(',')}]))`],
        { timeout: 5000 }
      )
      const vectors = JSON.parse(stdout) as string[][]
      expect(vectors).toHaveLength(700)
      for (const [index, expression] of expressions.entries()) {
        const literalRisks = await analyzeNotebookCodeRisk(
          'python',
          `import subprocess\nsubprocess.run(${JSON.stringify(vectors[index])})`
        )
        for (const source of [expression, `tuple(${expression})`, `[*${expression}]`]) {
          const risks = await analyzeNotebookCodeRisk(
            'python',
            `import subprocess\nsubprocess.run(${source})`
          )
          expect(
            risks.map((risk) => risk.operation),
            source
          ).toEqual(literalRisks.map((risk) => risk.operation))
        }
      }
    }
  )
  it.skipIf(!process.env.OPEN_SCIENCE_RISK_PYTHON || process.platform === 'win32').each(
    (
      [
        ['"echo:::hello".split("::",1)', ['echo', ':hello'], false],
        ['"echo:::hello".rsplit("::",1)', ['echo:', 'hello'], false],
        ['"echo:::hello".rsplit("::")', ['echo:', 'hello'], false],
        ['"echo::::hello".rsplit("::")', ['echo', '', 'hello'], false],
        ['"echo|||hello".rsplit("||",1)', ['echo|', 'hello'], false],
        ['"echo::hello::world".rsplit("::",1)', ['echo::hello', 'world'], false],
        ['"echo::hello::world".split("::",1)', ['echo', 'hello::world'], false],
        ['"echo::hello".rsplit("::",0)', ['echo::hello'], false],
        ['"echo::hello".rsplit("::",-2)', ['echo', 'hello'], false],
        ['"echo ".split(None,0)', ['echo '], false],
        ['" echo".rsplit(None,0)', [' echo'], false],
        ['"  echo  ".split(None,0)', ['echo  '], false],
        ['"  echo  ".rsplit(None,0)', ['  echo'], false],
        ['"echo hello ".split(None,1)', ['echo', 'hello '], false],
        ['" echo hello".rsplit(None,1)', [' echo', 'hello'], false],
        ['" echo hello ".split(None,2)', ['echo', 'hello'], false],
        ['" echo hello ".rsplit(None,2)', ['echo', 'hello'], false],
        ['"echo hello world".rsplit(None,1)', ['echo hello', 'world'], false],
        ['"echo hello world".split(None,1)', ['echo', 'hello world'], false],
        ['" \t".split(None,0)', [], true],
        ['"".rsplit(None,0)', [], true],
        ['"echo\x1chello\x1fworld".split()', ['echo', 'hello', 'world'], false],
        ['"echo\x1dhello\x1eworld".rsplit()', ['echo', 'hello', 'world'], false],
        ['"rm\ttarget.txt".split()', ['rm', 'target.txt'], true],
        ['"rm:::target.txt".rsplit("::",1)', ['rm:', 'target.txt'], false],
        ['"rm:::target.txt".split("::",1)', ['rm', ':target.txt'], true],
        ['"rm ".split(None,0)', ['rm '], false],
        ['" rm".rsplit(None,0)', [' rm'], false],
        ['"rm ".split()', ['rm'], true],
        ['" rm".rsplit()', ['rm'], true]
      ] as Array<[string, string[], boolean]>
    ).flatMap(([expression, expected, review]): Array<[string, string[], boolean]> =>
      [expression, `list(${expression})`, `[*( ${expression} )]`].map((source) => [
        source,
        expected,
        review
      ])
    )
  )('matches native Python split boundaries: %s', async (expression, expected, review) => {
    const { stdout } = await promisify(execFile)(
      process.env.OPEN_SCIENCE_RISK_PYTHON!,
      ['-c', `import json\nprint(json.dumps(${expression}))`],
      { timeout: 5000 }
    )
    expect(JSON.parse(stdout)).toEqual(expected)
    const risks = await analyzeNotebookCodeRisk(
      'python',
      `import subprocess\nsubprocess.run(${expression})`
    )
    const literalRisks = await analyzeNotebookCodeRisk(
      'python',
      `import subprocess\nsubprocess.run(${JSON.stringify(expected)})`
    )
    expect(risks.map((risk) => risk.operation)).toEqual(literalRisks.map((risk) => risk.operation))
    expect(risks.length > 0).toBe(review)
  })
  it
    .skipIf(!process.env.OPEN_SCIENCE_RISK_PYTHON || process.platform === 'win32')
    .each(
      ['run', 'call', 'check_call', 'check_output', 'Popen'].flatMap(
        (method): Array<[string, string]> =>
          [
            'list(SOURCE)',
            'tuple(SOURCE)',
            'builtins.list(SOURCE)',
            'convert(SOURCE)',
            'tuple(list(SOURCE))',
            'str.split(TEXT)',
            'TEXT.split()',
            'TEXT.rsplit()',
            'operator.call(str.split,TEXT)',
            '[*TEXT.split()]',
            '(*TEXT.rsplit(),)',
            'TEXT.split(None,1)',
            'TEXT.rsplit(None,2)',
            'TEXT.split(sep=None,maxsplit=0x2)',
            'DELIMITED.split("|",maxsplit=1)',
            'DELIMITED.rsplit(sep="|",maxsplit=1)',
            'SOURCE[:]',
            'tuple(SOURCE)[0:2]',
            'list(SOURCE)[::1]',
            'SOURCE[-2:]',
            'SOURCE[-99:99]',
            'SOURCE[::-1][::-1]',
            'TEXT.split()[:]',
            'tuple(DELIMITED.rsplit("|"))[0:2]',
            '[*SOURCE[:]]',
            '(*tuple(SOURCE)[:],)',
            'list(SOURCE)[False:2:True]',
            'convert(SOURCE)[None:None:None]',
            '(["unused"] + list(SOURCE))[1:]',
            '(tuple(["unused"]) + tuple(SOURCE))[1:]',
            '(list(SOURCE) + ["unused"])[:-1]',
            'list(SOURCE[:1]) + list(SOURCE[1:])',
            'tuple(SOURCE[:1]) + tuple(SOURCE[1:])',
            '(TEXT.split() + ["unused"])[:-1]',
            'list(tuple(SOURCE)[:])',
            'SOURCE[:1] + list(SOURCE)[1:]',
            'SOURCE if flag else tuple(SOURCE)',
            'SOURCE if other_flag else tuple(SOURCE)',
            'list(SOURCE if flag else tuple(SOURCE))',
            'tuple(SOURCE if other_flag else tuple(SOURCE))',
            '(list if flag else tuple)(SOURCE)',
            '(list if other_flag else tuple)(SOURCE)',
            'operator.call((list if flag else tuple),SOURCE)',
            'getattr((list if other_flag else tuple),"__call__")(SOURCE)',
            'TEXT.split(None,1) if flag else tuple(SOURCE)',
            'SOURCE if other_flag else DELIMITED.split("|",maxsplit=1)',
            '(SOURCE if flag else tuple(SOURCE))[:]',
            '[*(SOURCE if other_flag else tuple(SOURCE))]',
            '(*(SOURCE if flag else tuple(SOURCE)),)',
            'list((list if flag else tuple)(SOURCE)) + []',
            'tuple((list if other_flag else tuple)(SOURCE)) + ()',
            '[] or SOURCE',
            '["unused"] and SOURCE',
            'SOURCE or ["rm","unused.txt"]',
            'SOURCE if True else ["rm","unused.txt"]',
            '["rm","unused.txt"] if False else SOURCE'
          ].map((factory): [string, string] => [method, factory])
      )
    )(
    'admits real Python process vector=%s factory=%s and gates deletion once',
    async (method, factory) => {
      const { service, execute, request } = await harness()
      const target = join(request.workspaceCwd, 'vector-target.txt')
      const keep = join(request.workspaceCwd, 'keep.txt')
      await writeFile(target, 'test')
      await writeFile(keep, 'keep')
      execute.mockImplementation(async (execution) => {
        const { stdout, stderr } = await promisify(execFile)(
          process.env.OPEN_SCIENCE_RISK_PYTHON!,
          ['-c', execution.code],
          { cwd: execution.cwd, timeout: 5000 }
        )
        return {
          status: 'completed',
          stdout,
          stderr,
          traceback: '',
          cwdAfter: execution.cwd,
          outputs: [],
          kernelDispatched: true
        }
      })
      const code = (command: string, args: string[]): string => {
        const argv = [command, ...args]
        const vector = factory
          .replaceAll('SOURCE', JSON.stringify(argv))
          .replaceAll('TEXT', JSON.stringify(argv.join(' ')))
          .replaceAll('DELIMITED', JSON.stringify(argv.join('|')))
        const invoke =
          method === 'check_output'
            ? `print(subprocess.check_output(${vector}).decode(),end="")`
            : method === 'Popen'
              ? `subprocess.Popen(${vector}).wait()`
              : `subprocess.${method}(${vector})`
        return (
          'import subprocess,builtins,operator\nconvert=list\nflag=True\nother_flag=False\n' +
          invoke
        )
      }
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      await service.execute({ ...request, code: code('echo', ['hello world']) })
      expect((await execute.mock.results[0].value).stdout).toContain('hello world')
      expect(approve).not.toHaveBeenCalled()
      expect(execute).toHaveBeenCalledTimes(1)
      expect(await readFile(target, 'utf8')).toBe('test')
      await service.execute({ ...request, code: code('cat', [target]) })
      expect((await execute.mock.results[1].value).stdout).toBe('test')
      expect(approve).not.toHaveBeenCalled()
      const erase = code('rm', [target])
      await expect(service.execute({ ...request, code: erase })).rejects.toThrow(
        'one-time approval'
      )
      expect(execute).toHaveBeenCalledTimes(2)
      expect(await readFile(target, 'utf8')).toBe('test')
      approve.mockResolvedValueOnce(true)
      await service.execute({ ...request, code: erase })
      expect(execute).toHaveBeenCalledTimes(3)
      await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
      await writeFile(target, 'next run')
      await expect(service.execute({ ...request, code: erase })).rejects.toThrow(
        'one-time approval'
      )
      expect(approve).toHaveBeenCalledTimes(3)
      expect(execute).toHaveBeenCalledTimes(3)
      expect(await readFile(target, 'utf8')).toBe('next run')
      expect(await readFile(keep, 'utf8')).toBe('keep')
    }
  )
  it.skipIf(!process.env.OPEN_SCIENCE_RISK_PYTHON || process.platform === 'win32').each([
    [
      'captured constructor',
      'subprocess.run(convert(("echo","hello")),text=(convert:=str))',
      'def convert(argv):\n    return ["rm",target]\nsubprocess.run(convert(("echo","hello")),text=(convert:=list))'
    ],
    [
      'starred captured constructor',
      'subprocess.run([*convert(("echo","hello"))],text=(convert:=str))',
      'def convert(argv):\n    return ["rm",target]\nsubprocess.run([*convert(("echo","hello"))],text=(convert:=list))'
    ],
    [
      'eager constructor argument deletion',
      'subprocess.run(list(("echo","hello")))',
      'subprocess.run(list(("echo",os.unlink(target))))'
    ],
    [
      'helper overrides builtin constructor',
      'subprocess.run(list(("echo","hello")))',
      'def poison():\n    builtins.list=lambda argv:["rm",target]\npoison()\nsubprocess.run(list(("echo","hello")))'
    ],
    [
      'sliced captured constructor',
      'subprocess.run(convert(("echo","hello"))[:],text=(convert:=str))',
      'def convert(argv):\n    return ["rm",target]\nsubprocess.run(convert(("echo","hello"))[:],text=(convert:=list))'
    ],
    [
      'eager deletion in omitted slice prefix',
      'subprocess.run(["unused","echo","hello"][1:])',
      'subprocess.run([os.unlink(target),"echo","hello"][1:])'
    ],
    [
      'eager deletion in omitted concatenated suffix',
      'subprocess.run((["echo"] + ["hello","unused"])[:2])',
      'subprocess.run((["echo"] + [os.unlink(target)])[:1])'
    ],
    [
      'captured conditional constructor',
      'convert=list if flag else tuple\nsubprocess.run(convert(("echo","hello")),text=(convert:=str))',
      'def custom(argv):\n    return ["rm",target]\nconvert=custom if flag else tuple\nsubprocess.run(convert(("echo","hello")),text=(convert:=list))'
    ],
    [
      'reachable conditional command',
      'subprocess.run(["echo","hello"] if flag else ["echo","world"])',
      'subprocess.run(["rm",target] if flag else ["echo","world"])'
    ],
    [
      'reachable alternative command',
      'subprocess.run(["echo","world"] if other_flag else ("echo","hello"))',
      'subprocess.run(["echo","world"] if other_flag else ("rm",target))'
    ],
    [
      'literal unreachable deletion',
      'subprocess.run(["echo","hello"] if True else (os.unlink(target) or ["echo","hello"]))',
      'subprocess.run(["echo","hello"] if False else (os.unlink(target) or ["echo","hello"]))'
    ],
    [
      'short-circuit unreachable deletion',
      'subprocess.run("echo hello".split() or (os.unlink(target) or ["echo","hello"]))',
      'subprocess.run("".split() or (os.unlink(target) or ["echo","hello"]))'
    ],
    [
      'custom truth hook',
      'subprocess.run(["echo","hello"] if flag else ["echo","world"])',
      'class Choice:\n    def __bool__(self):\n        os.unlink(target)\n        return True\nsubprocess.run(["echo","hello"] if Choice() else ["echo","world"])'
    ],
    [
      'custom sequence choice',
      'subprocess.run((list if flag else tuple)(("echo","hello")))',
      'def custom(argv):\n    os.unlink(target)\n    return list(argv)\nsubprocess.run((custom if flag else tuple)(("echo","hello")))'
    ],
    [
      'eager selected slot before slice',
      'subprocess.run((["unused","echo","hello"] if flag else ["unused","echo","world"])[1:])',
      'subprocess.run(([os.unlink(target),"echo","hello"] if flag else ["unused","echo","world"])[1:])'
    ],
    [
      'eager condition deletion',
      'subprocess.run(["echo","hello"] if flag else ["echo","world"])',
      'subprocess.run(["echo","hello"] if os.unlink(target) else ["echo","world"])'
    ],
    ...['["echo","hello"] if flag else ["echo","world"]', '"echo" if flag else "echo"'].map(
      (vector): [string, string, string] => [
        `captured truth before keyword rebinding ${vector}`,
        `subprocess.run(${vector},text=(flag:=os.unlink))\nprint("hello")`,
        `class Choice:\n    def __bool__(self):\n        os.unlink(target)\n        return True\nflag=Choice()\nsubprocess.run(${vector},text=(flag:=True))`
      ]
    ),
    ...[
      '"echo hello".split() if flag else ("echo","world")',
      '[*( ["echo","hello"] if flag else ["echo","world"] )]'
    ].map((vector): [string, string, string] => [
      `captured truth through vector construction ${vector}`,
      `subprocess.run(${vector},text=(flag:=os.unlink))`,
      `class Choice:\n    def __bool__(self):\n        os.unlink(target)\n        return True\nflag=Choice()\nsubprocess.run(${vector},text=(flag:=False))`
    ]),
    ...['B(False)', 'operator.call(B,False)', 'bool(B(False))', 'int(B(False))'].map(
      (flag): [string, string, string] => [
        `captured native flag before keyword rebinding ${flag}`,
        `B=bool\nsubprocess.run(["echo","hello"],shell=${flag},text=(B:=os.unlink))`,
        `def B(value):\n    os.unlink(target)\n    return False\nsubprocess.run(["echo","hello"],shell=${flag},text=(B:=bool))`
      ]
    ),
    ...[
      'dict()',
      'dict(NO_COLOR="1")',
      'dict({"NO_COLOR":"1"})',
      'dict([("NO_COLOR","1")])',
      'dict({"NO_COLOR":"old"},NO_COLOR="1")',
      'dict(dict(NO_COLOR="1"),PYTHONUTF8="1")',
      'dict(**dict(NO_COLOR="1"))',
      '{**dict(NO_COLOR="1")}',
      '{**dict(NO_COLOR="1"),"PYTHONUTF8":"1"}',
      'dict({"PYTHONUTF8":"invalid"},PYTHONUTF8="1")',
      '{**dict(PYTHONUTF8="invalid"),**dict(PYTHONUTF8="1")}',
      'operator.call(dict,NO_COLOR="1")',
      'builtins.dict(NO_COLOR="1")'
    ].map((form): [string, string, string] => [
      `passive native environment ${form}`,
      `subprocess.run(["echo","hello"],env=${form},check=True)`,
      `subprocess.run(["rm",target],env=${form},check=True)`
    ]),
    ...[
      'dict(maxsplit=1)',
      'dict(sep=None)',
      'dict(sep=" ",maxsplit=1)',
      'dict(dict(sep=None),maxsplit=1)',
      'dict([("maxsplit",1)])',
      '{**dict(maxsplit=1)}',
      '{"maxsplit":0,"maxsplit":1}'
    ].map((form, index): [string, string, string] => [
      `native split mapping ${form}`,
      `subprocess.run("echo hello".${index % 2 ? 'rsplit' : 'split'}(**${form}),check=True)`,
      `subprocess.run(("rm "+target).${index % 2 ? 'rsplit' : 'split'}(**${form}),check=True)`
    ]),
    ...[
      ['open', 'dict(mode="r")'],
      ['builtins.open', 'dict(encoding="utf-8")'],
      ['io.open', 'dict(dict(mode="r"),encoding="utf-8")'],
      ['open', '{**dict(mode="r",opener=None)}']
    ].map(([fn, form]): [string, string, string] => [
      `native file mapping ${fn} ${form}`,
      `import io\npath=os.path.join(os.path.dirname(target),"keep.txt")\nassert ${fn}(path,**${form}).read()=="keep"\nprint("hello")`,
      `import io\npath=os.path.join(os.path.dirname(target),"keep.txt")\n${fn}(path,**dict(${form},opener=lambda p,f:(os.unlink(target),os.open(p,f))[1])).read()`
    ]),
    ...[
      'sorted([1],**OPTIONS)',
      '[1].sort(**OPTIONS)',
      'operator.methodcaller("sort",**OPTIONS)([1])'
    ].map((route): [string, string, string] => [
      `native sort mapping ${route}`,
      route.replace('OPTIONS', 'dict(reverse=True)') + '\nprint("hello")',
      route.replace('OPTIONS', 'dict(reverse=True,key=lambda value:os.unlink(target))')
    ]),
    [
      'packed passive native environment',
      'subprocess.run(["echo","hello"],**dict(env=dict(NO_COLOR="1"),check=True))',
      'subprocess.run(["rm",target],**dict(env=dict(NO_COLOR="1"),check=True))'
    ],
    [
      'passive native shell environment',
      'subprocess.run("echo hello",shell=True,env=dict(NO_COLOR="1"),check=True)',
      'subprocess.run("rm "+target,shell=True,env=dict(NO_COLOR="1"),check=True)'
    ],
    [
      'eager passive environment value',
      'subprocess.run(["echo","hello"],env=dict(NO_COLOR="1"),check=True)',
      'subprocess.run(["echo","hello"],env=dict(NO_COLOR=os.unlink(target) or "1"),check=True)'
    ],
    [
      'overwritten environment constructor',
      'subprocess.run(["echo","hello"],env=dict(NO_COLOR="1"),check=True)',
      'class Flag:\n    def __init__(self):\n        os.unlink(target)\nsubprocess.run(["echo","hello"],env=dict({"NO_COLOR":Flag(),"NO_COLOR":"1"}),check=True)'
    ],
    ...['D(shell=False)', 'operator.call(D,shell=False)', 'getattr(D,"__call__")(shell=False)'].map(
      (form): [string, string, string] => [
        `captured keyword constructor before rebinding ${form}`,
        `D=dict\nsubprocess.run(["echo","hello"],**${form},text=(D:=os.unlink))`,
        `def D(**kwargs):\n    os.unlink(target)\n    return kwargs\nsubprocess.run(["echo","hello"],**${form},text=(D:=dict))`
      ]
    ),
    ...[
      [
        'constructor value',
        'dict(text=Flag())',
        '    def __init__(self):\n        os.unlink(target)'
      ],
      [
        'overwritten constructor value',
        'dict({"check":Flag(),"check":True})',
        '    def __init__(self):\n        os.unlink(target)'
      ],
      [
        'overwritten pair value',
        'dict([("check",Flag()),("check",True)])',
        '    def __init__(self):\n        os.unlink(target)'
      ],
      [
        'mapping keys',
        'dict(Flag())',
        '    def keys(self):\n        os.unlink(target)\n        return ["shell"]\n    def __getitem__(self,key):\n        return False'
      ],
      [
        'mapping item',
        'dict(Flag())',
        '    def keys(self):\n        return ["shell"]\n    def __getitem__(self,key):\n        os.unlink(target)\n        return False'
      ],
      [
        'pair iterator',
        'dict(Flag())',
        '    def __iter__(self):\n        os.unlink(target)\n        return iter((("shell",False),))'
      ],
      [
        'key hash',
        'dict({Flag():False})',
        '    def __new__(cls):\n        return super().__new__(cls,"shell")\n    def __hash__(self):\n        if os.path.isfile(target):\n            os.unlink(target)\n        return hash("shell")'
      ]
    ].map(([name, form, body]): [string, string, string] => [
      `constructed keyword hook ${name}`,
      'subprocess.run(["echo","hello"],**dict(shell=False))',
      `class Flag${name === 'key hash' ? '(str)' : ''}:\n${body}\nsubprocess.run(["echo","hello"],**${form})`
    ]),
    ...[
      [
        'same-name dict class',
        'class dict:\n    def __init__(self,**kwargs):\n        os.unlink(target)\n    def keys(self):\n        return ["shell"]\n    def __getitem__(self,key):\n        return False\nsubprocess.run(["echo","hello"],**dict(shell=False))'
      ],
      [
        'same-name bool class',
        'class bool:\n    def __init__(self,value):\n        os.unlink(target)\n    def __bool__(self):\n        return False\nsubprocess.run(["echo","hello"],shell=bool(False))'
      ],
      [
        'global dict class',
        'def prepare():\n    global dict\n    class dict:\n        def __init__(self,**kwargs):\n            os.unlink(target)\n        def keys(self):\n            return ["shell"]\n        def __getitem__(self,key):\n            return False\nprepare()\nsubprocess.run(["echo","hello"],**dict(shell=False))'
      ]
    ].map(([name, code]): [string, string, string] => [
      `constructed keyword hook ${name}`,
      'subprocess.run(["echo","hello"],**dict(shell=False))',
      code
    ])
  ])(
    'admits real Python vector mutation=%s and preserves one-shot consent',
    async (_, reader, erase) => {
      const { service, execute, request } = await harness()
      const target = join(request.workspaceCwd, 'mutated-vector.txt')
      const keep = join(request.workspaceCwd, 'keep.txt')
      await writeFile(target, 'test')
      await writeFile(keep, 'keep')
      execute.mockImplementation(async (execution) => {
        try {
          const { stdout, stderr } = await promisify(execFile)(
            process.env.OPEN_SCIENCE_RISK_PYTHON!,
            ['-c', execution.code],
            { cwd: execution.cwd, timeout: 5000 }
          )
          return {
            status: 'completed',
            stdout,
            stderr,
            traceback: '',
            cwdAfter: execution.cwd,
            outputs: [],
            kernelDispatched: true
          }
        } catch (error) {
          // An eager deletion can succeed before Popen rejects the None argument it returns.
          if (_ !== 'eager constructor argument deletion') throw error
          return {
            status: 'failed',
            stdout: '',
            stderr: String(error),
            traceback: '',
            cwdAfter: execution.cwd,
            outputs: [],
            kernelDispatched: true
          }
        }
      })
      const prelude = `import subprocess,builtins,operator,os\nconvert=list\nflag=True\nother_flag=False\ntarget=${JSON.stringify(target)}\n`
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      await service.execute({ ...request, code: prelude + reader })
      expect((await execute.mock.results[0].value).stdout).toContain('hello')
      expect(approve).not.toHaveBeenCalled()
      await expect(service.execute({ ...request, code: prelude + erase })).rejects.toThrow(
        'one-time approval'
      )
      expect(execute).toHaveBeenCalledTimes(1)
      expect(await readFile(target, 'utf8')).toBe('test')
      approve.mockResolvedValueOnce(true)
      await service.execute({ ...request, code: prelude + erase })
      expect(execute).toHaveBeenCalledTimes(2)
      await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
      await writeFile(target, 'next run')
      await expect(service.execute({ ...request, code: prelude + erase })).rejects.toThrow(
        'one-time approval'
      )
      expect(approve).toHaveBeenCalledTimes(3)
      expect(execute).toHaveBeenCalledTimes(2)
      expect(await readFile(target, 'utf8')).toBe('next run')
      expect(await readFile(keep, 'utf8')).toBe('keep')
    }
  )
  it
    .skipIf(!process.env.OPEN_SCIENCE_RISK_PYTHON)
    .each([
      ...[
        'open(target)',
        'builtins.open(target)',
        'io.open(target)',
        'opener(target)',
        'open(target,**dict(mode="r"))',
        'builtins.open(target,**dict([("mode","r")]))',
        'io.open(target,**dict(dict(mode="r"),encoding="utf-8"))',
        'opener(target,**{**dict(mode="r",opener=None)})'
      ].flatMap((receiver): Array<[string, string, string, string]> =>
        ['read', 'readline', 'readlines'].flatMap((method) =>
          [
            `getattr(${receiver},"${method}",os.unlink)`,
            `operator.call(getattr,${receiver},"${method}",os.unlink)`,
            `getattr(*(${receiver},"${method}",lambda:os.unlink(target)))`
          ].map((returned, route): [string, string, string, string] => [
            `file receiver=${receiver} method=${method} route=${route}`,
            `saved=${returned};opener=str;print(saved())`,
            `getattr(${receiver},"missing",os.unlink)(target)`,
            'test'
          ])
        )
      ),
      ...['"test"', 'str', 'builtins.str'].map((receiver): [string, string, string, string] => [
        `string receiver=${receiver}`,
        `print(getattr(${receiver},"upper",os.unlink)(${receiver === '"test"' ? '' : '"test"'}))`,
        `getattr(${receiver},"missing",os.unlink)(target)`,
        'TEST'
      ]),
      ...[
        'os.reader=VALUE',
        'alias=os;alias.reader=VALUE',
        'setattr(os,"reader",VALUE)',
        'builtins.setattr(os,"reader",VALUE)',
        'operator.call(setattr,os,"reader",VALUE)',
        'setattr(*(os,"reader",VALUE))',
        'os.reader,unused=(VALUE,42)'
      ].flatMap((write, writeIndex): Array<[string, string, string, string]> =>
        [
          'print(getattr(os,"reader",None)(ARGS))',
          'saved=getattr(os,"reader");os.reader=str;print(saved(ARGS))',
          'from os import reader;print(reader(ARGS))'
        ].map((call, callIndex): [string, string, string, string] => [
          `module write=${writeIndex} call=${callIndex}`,
          `${write.replaceAll('VALUE', 'open(target).read')}\n${call.replaceAll('ARGS', '')}`,
          `${write.replaceAll('VALUE', 'os.unlink')}\n${call.replaceAll('ARGS', 'target')}`,
          'test'
        ])
      ),
      [
        'captured callable before mutation',
        'os.reader=str;print(getattr(os,"reader")((setattr(os,"reader",os.unlink),"test")[1]))',
        'os.reader=os.unlink;getattr(os,"reader")((setattr(os,"reader",str),target)[1])',
        'test'
      ],
      [
        'captured receiver before rebinding',
        'os.reader=str;print(getattr(os,"reader",(os:=None))("test"))',
        'os.reader=os.unlink;getattr(os,"reader",(os:=None))(target)',
        'test'
      ],
      [
        'eager unused fallback',
        'print(getattr("test","upper",lambda:os.unlink(target))())',
        'print(getattr("test","upper",os.unlink(target))())',
        'TEST'
      ],
      [
        'lambda module replacement',
        'os.reader=lambda:print("test");getattr(os,"reader")()',
        'os.reader=lambda path:os.unlink(path);getattr(os,"reader")(target)',
        'test'
      ],
      [
        'deleted member with fallback',
        'os.reader=print;del os.reader;print(getattr(str,"__call__",os.unlink)("test"))',
        'os.reader=print;del os.reader;getattr(os,"reader",os.unlink)(target)',
        'test'
      ],
      [
        'operator forwarding member',
        'print(getattr(operator,"__call__")(open(target).read))',
        'getattr(operator,"__call__")(os.unlink,target)',
        'test'
      ],
      [
        'methodcaller rewritten member',
        'os.reader=open(target).read;print(operator.methodcaller("reader")(os))',
        'os.reader=os.unlink;operator.methodcaller("reader",target)(os)',
        'test'
      ],
      ...['os.reader=VALUE', 'setattr(os,"reader",VALUE)', 'alias=os;alias.reader=VALUE'].flatMap(
        (write, route): Array<[string, string, string, string]> =>
          [
            'install()',
            'alias_install=install;alias_install()',
            'operator.call(install)',
            'list(map(install,[None]))'
          ].map((call, invoke): [string, string, string, string] => [
            `helper route=${route} invoke=${invoke}`,
            `def install(unused=None):\n    ${write.replaceAll('VALUE', 'open(target).read')}\n${call}\nprint(os.reader())`,
            `def install(unused=None):\n    ${write.replaceAll('VALUE', 'os.unlink')}\n${call}\ngetattr(os,"reader",None)(target)`,
            'test'
          ])
      ),
      [
        'helper replaces builtin file constructor',
        'print(getattr(open(target),"read",os.unlink)())',
        'def install():\n    builtins.open=lambda path:object()\ninstall()\ngetattr(open(target),"read",os.unlink)(target)',
        'test'
      ],
      [
        'nested helper member rewrite',
        'def outer():\n    def inner():\n        os.reader=open(target).read\n    inner()\nouter()\nprint(os.reader())',
        'def outer():\n    def inner():\n        os.reader=os.unlink\n    inner()\nouter()\nos.reader(target)',
        'test'
      ]
    ])(
    'admits real Python attribute evidence=%s and gates deletion once',
    async (_, reader, erase, output) => {
      const { service, execute, request } = await harness()
      const target = join(request.workspaceCwd, 'attribute-target.txt')
      const keep = join(request.workspaceCwd, 'keep.txt')
      await writeFile(target, 'test')
      await writeFile(keep, 'keep')
      execute.mockImplementation(async (execution) => {
        const { stdout, stderr } = await promisify(execFile)(
          process.env.OPEN_SCIENCE_RISK_PYTHON!,
          ['-c', execution.code],
          { cwd: execution.cwd, timeout: 5000 }
        )
        return {
          status: 'completed',
          stdout,
          stderr,
          traceback: '',
          cwdAfter: execution.cwd,
          outputs: [],
          kernelDispatched: true
        }
      })
      const prelude = `import os,io,builtins,operator,subprocess\nopener=io.open\ntarget=${JSON.stringify(target)}\n`
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      await service.execute({ ...request, code: prelude + reader })
      expect((await execute.mock.results[0].value).stdout).toContain(output)
      expect(approve).not.toHaveBeenCalled()
      expect(execute).toHaveBeenCalledTimes(1)
      expect(await readFile(target, 'utf8')).toBe('test')
      await expect(service.execute({ ...request, code: prelude + erase })).rejects.toThrow(
        'one-time approval'
      )
      expect(execute).toHaveBeenCalledTimes(1)
      expect(await readFile(target, 'utf8')).toBe('test')
      approve.mockResolvedValueOnce(true)
      await service.execute({ ...request, code: prelude + erase })
      expect(execute).toHaveBeenCalledTimes(2)
      await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
      await writeFile(target, 'next run')
      await expect(service.execute({ ...request, code: prelude + erase })).rejects.toThrow(
        'one-time approval'
      )
      expect(approve).toHaveBeenCalledTimes(3)
      expect(execute).toHaveBeenCalledTimes(2)
      expect(await readFile(target, 'utf8')).toBe('next run')
      expect(await readFile(keep, 'utf8')).toBe('keep')
    }
  )
  it.skipIf(!process.env.OPEN_SCIENCE_RISK_PYTHON).each(
    ['get', 'pop', 'setdefault'].flatMap((method): Array<[string, string, string, string]> => [
      ...[
        '{"fn":VALUE}.METHOD("fn")',
        'dict.METHOD({"fn":VALUE},"fn")',
        'builtins.dict.METHOD({"fn":VALUE},"fn")',
        'lookup({"fn":VALUE},"fn")',
        'operator.call(dict.METHOD,{"fn":VALUE},"fn")',
        'operator.call({"fn":VALUE}.METHOD,"fn")',
        'operator.call(operator.call,{"fn":VALUE}.METHOD,"fn")',
        '{"fn":VALUE}.METHOD.__call__("fn")',
        '{"fn":VALUE}.METHOD(*("fn",))',
        'getattr(dict,"METHOD")({"fn":VALUE},"fn")',
        '{}.METHOD("fn",VALUE)',
        '{"other":str}.METHOD("fn",VALUE)',
        '{"fn":VALUE}.METHOD("fn",str)',
        '{"fn":str,"fn":VALUE}.METHOD("fn")',
        '{"fn":str,**{"fn":VALUE}}.METHOD("fn")',
        '({"fn":str}|{"fn":VALUE}).METHOD("fn")',
        '{0:str,False:VALUE}.METHOD(0)',
        'functools.partial(dict.METHOD).func({"fn":VALUE},"fn")'
      ].map((lookup, index): [string, string, string, string] => {
        const returned = lookup.replaceAll('METHOD', method)
        return [
          `method=${method} route=${index}`,
          `saved=${returned.replaceAll('VALUE', 'open(target).read')};lookup=str;print(saved())`,
          `saved=${returned.replaceAll('VALUE', 'os.unlink')};lookup=str;saved(target)`,
          'test'
        ]
      }),
      [
        `method=${method} unused dangerous default`,
        `print({"fn":str}.${method}("fn",os.unlink)("test"))`,
        `{"fn":os.unlink}.${method}("fn",str)(target)`,
        'test'
      ],
      [
        `method=${method} eager unused default deletion`,
        `print({"fn":str}.${method}("fn","unused")("test"))`,
        `{"fn":str}.${method}("fn",os.unlink(target))("test")`,
        'test'
      ],
      [
        `method=${method} key override avoids deletion`,
        `print({"fn":os.unlink,**{"fn":str}}.${method}("fn")("test"))`,
        `{"fn":str,**{"fn":os.unlink}}.${method}("fn")(target)`,
        'test'
      ],
      [
        `method=${method} inline callback invokes returned callable`,
        `print(list(map({"fn":str}.${method}("fn"),["test"])))`,
        `list(map({"fn":os.unlink}.${method}("fn"),[target]))`,
        'test'
      ],
      [
        `method=${method} caller arguments rebind selected source`,
        `fn=str;print({"fn":fn}.${method}("fn")((fn:=os.unlink)))`,
        `fn=os.unlink;{"fn":fn}.${method}("fn")((fn:=str) and target)`,
        'unlink'
      ],
      [
        `method=${method} default rebinds captured callable`,
        `print({"fn":str}.${method}("fn",None)("test"))`,
        `fn=os.unlink;{"fn":fn}.${method}("fn",(fn:=str))(target)`,
        'test'
      ],
      ...[
        [
          'format',
          'class Swap:\n    def __format__(self,spec):\n        global fn\n        fn=str\n        return "tag"',
          'f"{obj}"'
        ],
        [
          'descriptor',
          'class Swap:\n    @property\n    def value(self):\n        global fn\n        fn=str\n        return "tag"',
          'obj.value'
        ],
        [
          'default factory',
          'def change():\n    global fn\n    fn=str\n    return "tag"',
          'change()'
        ]
      ].map(([name, setup, fallback]): [string, string, string, string] => [
        `method=${method} default hook=${name}`,
        `print({"fn":str}.${method}("fn","tag")("test"))`,
        `${setup}\nfn=os.unlink\n${name === 'default factory' ? '' : 'obj=Swap()\n'}{"fn":fn}.${method}("fn",${fallback})(target)`,
        'test'
      ]),
      ...[
        '{"fn":str}.METHOD("fn",lambda:os.unlink(target))',
        'dict.METHOD({"fn":str},"fn",lambda tag="unused":os.unlink(target))',
        'operator.call({"fn":str}.METHOD,"fn",lambda:os.unlink(target))',
        '{"fn":str}.METHOD(*("fn",lambda:os.unlink(target)))'
      ].map((lookup, index): [string, string, string, string] => [
        `method=${method} unused lambda route=${index}`,
        `print(${lookup.replaceAll('METHOD', method)}("test"))`,
        `{"fn":str}.${method}("fn",lambda tag=os.unlink(target):"unused")("test")`,
        'test'
      ]),
      [
        `method=${method} partial lookup only`,
        `functools.partial(dict.${method},{"fn":os.unlink},"fn")();print("test")`,
        `functools.partial(dict.${method},{"fn":os.unlink},"fn")()(target)`,
        'test'
      ],
      [
        `method=${method} partial forwarded lookup only`,
        `operator.call(functools.partial(dict.${method}),{"fn":os.unlink},"fn");print("test")`,
        `operator.call(functools.partial(dict.${method}),{"fn":os.unlink},"fn")(target)`,
        'test'
      ],
      ...['run', 'call', 'check_call', 'check_output', 'Popen'].map(
        (processMethod): [string, string, string, string] => {
          const invoke = `result={"fn":subprocess.${processMethod}}.${method}("fn")(ARGS)${processMethod === 'Popen' ? ';result.wait()' : ''};print("test")`
          const python = JSON.stringify(process.env.OPEN_SCIENCE_RISK_PYTHON)
          return [
            `method=${method} process=${processMethod}`,
            invoke.replace('ARGS', `[${python},"--version"]`),
            invoke.replace('ARGS', `[${python},"-c","import os;os.unlink("+repr(target)+")"]`),
            'test'
          ]
        }
      )
    ])
  )(
    'admits real Python dictionary method=%s and gates deletion once',
    async (_, reader, erase, output) => {
      const { service, execute, request } = await harness()
      const target = join(request.workspaceCwd, 'dictionary-target.txt')
      const keep = join(request.workspaceCwd, 'keep.txt')
      await writeFile(target, 'test')
      await writeFile(keep, 'keep')
      execute.mockImplementation(async (execution) => {
        const { stdout, stderr } = await promisify(execFile)(
          process.env.OPEN_SCIENCE_RISK_PYTHON!,
          ['-c', execution.code],
          { cwd: execution.cwd, timeout: 5000 }
        )
        return {
          status: 'completed',
          stdout,
          stderr,
          traceback: '',
          cwdAfter: execution.cwd,
          outputs: [],
          kernelDispatched: true
        }
      })
      const method = /method=(get|pop|setdefault)/.exec(_)?.[1]
      const prelude = `import builtins,operator,os,pathlib,functools,subprocess\nlookup=dict.${method}\ntarget=${JSON.stringify(target)}\n`
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      await service.execute({ ...request, code: prelude + reader })
      expect((await execute.mock.results[0].value).stdout).toContain(output)
      expect(approve).not.toHaveBeenCalled()
      expect(execute).toHaveBeenCalledTimes(1)
      expect(await readFile(target, 'utf8')).toBe('test')
      await expect(service.execute({ ...request, code: prelude + erase })).rejects.toThrow(
        'one-time approval'
      )
      expect(execute).toHaveBeenCalledTimes(1)
      expect(await readFile(target, 'utf8')).toBe('test')
      approve.mockResolvedValueOnce(true)
      await service.execute({ ...request, code: prelude + erase })
      expect(execute).toHaveBeenCalledTimes(2)
      await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
      await writeFile(target, 'next run')
      await expect(service.execute({ ...request, code: prelude + erase })).rejects.toThrow(
        'one-time approval'
      )
      expect(approve).toHaveBeenCalledTimes(3)
      expect(execute).toHaveBeenCalledTimes(2)
      expect(await readFile(target, 'utf8')).toBe('next run')
      expect(await readFile(keep, 'utf8')).toBe('keep')
    }
  )

  it.skipIf(!process.env.OPEN_SCIENCE_RISK_PYTHON).each([
    ...[
      '(CONTAINER)[KEY]',
      'operator.getitem(CONTAINER,KEY)',
      'operator.__getitem__(CONTAINER,KEY)',
      'operator.itemgetter(KEY)(CONTAINER)',
      'operator.call(operator.itemgetter,KEY)(CONTAINER)'
    ].flatMap((lookup, lookupIndex) =>
      [
        ['(VALUE,)', 'False'],
        ['[str,VALUE]', 'True'],
        ['([str]+[VALUE])', '-0x1'],
        ['{"fn":VALUE}', '"fn"'],
        ['{"fn":str,**{"fn":VALUE}}', '"fn"'],
        ['({"fn":str}|{"fn":VALUE})', '"fn"']
      ].map(([container, key], containerIndex) => {
        const returned = (value: string): string =>
          lookup.replace('CONTAINER', container.replace('VALUE', value)).replace('KEY', key)
        return [
          `lookup=${lookupIndex} container=${containerIndex}`,
          `saved=${returned('open(target).read')};print(saved())`,
          `saved=${returned('os.unlink')};saved(target)`,
          'test'
        ]
      })
    ),
    [
      'last explicit key wins',
      'print(operator.itemgetter("fn")({"fn":os.unlink,"fn":str})("test"))',
      'operator.itemgetter("fn")({"fn":str,"fn":os.unlink})(target)',
      'test'
    ],
    [
      'last spread key wins',
      'print(operator.itemgetter("fn")({"fn":os.unlink,**{"fn":str}})("test"))',
      'operator.itemgetter("fn")({"fn":str,**{"fn":os.unlink}})(target)',
      'test'
    ],
    [
      'last explicit key after spread wins',
      'print(operator.itemgetter("fn")({**{"fn":os.unlink},"fn":str})("test"))',
      'operator.itemgetter("fn")({**{"fn":str},"fn":os.unlink})(target)',
      'test'
    ],
    [
      'saved getter rebound',
      'get=operator.itemgetter(0);saved=get((open(target).read,));get=str;print(saved())',
      'get=operator.itemgetter(0);saved=get((os.unlink,));get=str;saved(target)',
      'test'
    ],
    [
      'partial function member',
      'print(operator.itemgetter(0)((functools.partial(str).func,))("test"))',
      'operator.itemgetter(0)((functools.partial(os.unlink).func,))(target)',
      'test'
    ],
    [
      'eager non-selected deletion',
      'print(operator.itemgetter(0)((str,"data"))("test"))',
      'operator.itemgetter(0)((str,os.unlink(target)))("test")',
      'test'
    ],
    [
      'callable captured before walrus rebinding',
      'print(operator.getitem((str,),0)("test"))',
      'fn=os.unlink\nsaved=operator.itemgetter(0)((fn,(fn:=str)))\nsaved(target)',
      'test'
    ],
    [
      'construction function changes a later callable',
      'print(operator.getitem((str,),0)("test"))',
      'def change():\n    global fn\n    fn=os.unlink\nfn=str\nsaved=operator.itemgetter(1)((change(),fn))\nsaved(target)',
      'test'
    ],
    [
      'custom lookup returns deletion',
      'print(operator.getitem((str,),0)("test"))',
      'class Lookup:\n    def __getitem__(self,key):\n        return os.unlink\noperator.itemgetter(0)(Lookup())(target)',
      'test'
    ],
    ...[
      'open(target,**dict(mode="r")).read',
      'pathlib.Path(target,**dict()).read_text',
      'open(target,**dict({"encoding":None},encoding="utf-8")).read',
      'open(target,**dict(dict(mode="r"),opener=None)).read'
    ].flatMap((reader): Array<[string, string, string, string]> =>
      [
        'operator.itemgetter(0)((READER,dict()))',
        'operator.getitem([READER,dict(tag="data")],0)',
        'dict.get({"read":READER,"metadata":dict()},"read")',
        'operator.itemgetter("read")({"read":READER,"metadata":dict(tag="data")})',
        '(READER,dict())[0]',
        '{"read":READER,"metadata":dict()}["read"]'
      ].map((route): [string, string, string, string] => [
        `closed native construction ${reader} ${route}`,
        `print(${route.replaceAll('READER', reader)}())`,
        `${route.replaceAll('READER', 'os.unlink')}(target)`,
        'test'
      ])
    ),
    ...[
      'fn=os.unlink\noperator.itemgetter(0)((fn,operator.call((fn:=dict))))(target)',
      'fn=os.unlink\noperator.getitem([fn,dict(tag=(fn:=str))],0)(target)',
      'fn=os.unlink\ndict.get({"fn":fn,"meta":dict(tag=(fn:=str))},"fn")(target)',
      'fn=os.unlink\noperator.itemgetter(0)((fn,dict(**{"tag":(fn:=str)})))(target)',
      'fn=os.unlink\noperator.itemgetter(0)((fn,dict(tag=lambda default=(fn:=str):None)))(target)',
      'try:\n    open(target,**dict({"mode":os.unlink(target)},mode="r")).read()\nexcept FileNotFoundError:\n    print("deleted")',
      'getattr(open(target,**dict(mode="r")),"read",lambda p=os.unlink(target):None)()',
      'operator.itemgetter(0)((open(target,**dict(mode="r")).read,dict(tag=os.unlink(target))))()'
    ].map((erase): [string, string, string, string] => [
      `native construction retains eager or frozen deletion ${erase}`,
      'print(operator.itemgetter(0)((open(target,**dict(mode="r")).read,dict()))())',
      erase,
      'test'
    ]),
    ...[
      ['map', 'CALLBACK,VALUES', 'list'],
      ['builtins.map', 'CALLBACK,[1],VALUES', 'list'],
      ['filter', 'CALLBACK,VALUES', 'list'],
      ...['starmap', 'dropwhile', 'takewhile', 'filterfalse'].map((method) => [
        `itertools.${method}`,
        'CALLBACK,VALUES',
        'list'
      ]),
      ['functools.reduce', 'CALLBACK,VALUES,0', ''],
      ['itertools.accumulate', 'VALUES,CALLBACK,initial=0', 'list'],
      ['itertools.accumulate', 'VALUES,**{"func":CALLBACK,"initial":0}', 'list'],
      ['itertools.groupby', 'VALUES,CALLBACK', 'list'],
      ['itertools.groupby', 'VALUES,key=CALLBACK', 'list'],
      ['sorted', 'VALUES,key=CALLBACK', ''],
      ['builtins.sorted', 'VALUES,**{"key":CALLBACK,"reverse":False}', ''],
      ['min', 'VALUES,key=CALLBACK,default=0', ''],
      ['builtins.max', 'VALUES,key=CALLBACK,default=0', ''],
      ['list.sort', 'VALUES,key=CALLBACK', ''],
      ['heapq.nlargest', '1,VALUES,key=CALLBACK', ''],
      ['heapq.nsmallest', '1,VALUES,**{"key":CALLBACK}', ''],
      ['bisect.bisect', 'VALUES,1,key=CALLBACK', ''],
      ['bisect.bisect_left', 'VALUES,1,key=CALLBACK', ''],
      ['bisect.bisect_right', 'VALUES,1,key=CALLBACK', '']
    ].flatMap(([consumer, args, wrapper]): Array<[string, string, string, string]> =>
      ['lambda *args:(os.unlink(target),0)[1]', 'erase'].flatMap((callback) =>
        ['direct', 'forwarded'].map((route): [string, string, string, string] => {
          const script = (active: boolean): string => {
            const input = active ? (consumer.endsWith('starmap') ? '[(1,)]' : '[1]') : '[*[]]+[]'
            const argumentsText = args.replaceAll('VALUES', input).replaceAll('CALLBACK', callback)
            const call =
              route === 'direct'
                ? `${consumer}(${argumentsText})`
                : `operator.call(${consumer},${argumentsText})`
            return (
              'import builtins,itertools,heapq,bisect\ndef erase(*args):\n    os.unlink(target)\n    return 0\n' +
              (wrapper ? `${wrapper}(${call})` : call) +
              ';print("test")'
            )
          }
          return [
            `empty callback ${consumer} ${callback} ${route}`,
            script(false),
            script(true),
            'test'
          ]
        })
      )
    ),
    ...[
      ['itertools.starmap', 'lambda *args:0,[]', 'list'],
      ['heapq.nlargest', '0,[1],key=lambda *args:0', ''],
      ['bisect.bisect', '[],1,key=lambda *args:0', '']
    ].map(([consumer, args, wrapper]): [string, string, string, string] => {
      const setup =
        'import itertools,heapq,bisect\ndef custom(*args,**kwargs):\n    os.unlink(target)\n    return []\n' +
        `saved=${consumer}\n${consumer}=custom\n`
      const call = (fn: string): string =>
        (wrapper ? `${wrapper}(${fn}(${args}))` : `${fn}(${args})`) + ';print("test")'
      return [
        `empty callback mutated consumer ${consumer}`,
        setup + call('saved'),
        setup + call(consumer),
        'test'
      ]
    }),
    ...['heapq.nlargest', 'heapq.nsmallest', '[].sort', '[*[]].sort', '([]+[]).sort'].map(
      (consumer): [string, string, string, string] => {
        const callback = 'lambda *args:(os.unlink(target),0)[1]'
        const code = consumer.startsWith('heapq')
          ? `import heapq\n${consumer}(0,[1],key=${callback})`
          : `${consumer}(key=${callback})`
        return [
          `empty callback zero or literal ${consumer}`,
          code + ';print("test")',
          code.replace('(0,', '(1,').replaceAll('[]', '[1]') + ';print("test")',
          'test'
        ]
      }
    ),
    ...['open', 'builtins.open', 'io.open'].flatMap((consumer) =>
      ['lambda p,f:(os.unlink(target),os.open(p,f))[1]', 'acquire'].map(
        (callback): [string, string, string, string] => {
          const setup =
            'import builtins,io\ndef acquire(p,f):\n    os.unlink(target)\n    return os.open(p,f)\n'
          const safe =
            setup +
            'fd=os.open(target,os.O_RDONLY)\nif fd!=9:\n    os.dup2(fd,9)\n    os.close(fd)\n' +
            `print(${consumer}(file=9,opener=${callback}).read())`
          const danger =
            setup +
            'path=os.path.join(os.path.dirname(target),"keep.txt")\n' +
            `${consumer}(path,opener=${callback}).read();print("test")`
          return [`empty callback descriptor ${consumer} ${callback}`, safe, danger, 'test']
        }
      )
    ),
    [
      'empty callback module member effects',
      'os.remove=str\ndef change(*args):\n    os.remove=os.unlink\n    return 0\nlist(map(change,[]));assert os.remove("test")=="test";print("test")',
      'os.remove=str\ndef change(*args):\n    os.remove=os.unlink\n    return 0\nlist(map(change,[1]));os.remove(target);print("test")',
      'test'
    ],
    ...[
      'list(map(lambda x,tag=os.unlink(target):x,[]))',
      'sorted([],key=lambda x,tag=os.unlink(target):x)',
      'min([],key=lambda *args:0,default=os.unlink(target))',
      'list(itertools.accumulate([],func=lambda *args:0,initial=os.unlink(target)))',
      'list(map(lambda *args:0,[os.unlink(target)],[]))',
      'heapq.nlargest(0,[os.unlink(target)],key=lambda *args:0)',
      'list(map((saved:=lambda *args:os.unlink(target)),[]));saved()',
      'values=[];other=values;other.append(1);list(map(lambda *args:os.unlink(target),values))',
      'bisect.insort([],1,key=lambda *args:(os.unlink(target),0)[1])',
      'bisect.insort_left([],1,key=lambda *args:(os.unlink(target),0)[1])',
      'bisect.insort_right([],1,key=lambda *args:(os.unlink(target),0)[1])',
      'def custom(callback,items):\n    return [callback()]\nconsume=map\nfor flag in (False,True):\n    list(consume(lambda *args:os.unlink(target),[]))\n    consume=custom',
      'def custom(callback,items):\n    return [callback()]\nbuiltins.map=custom\nlist(map(lambda *args:os.unlink(target),[]))',
      'class Values:\n    def __iter__(self):\n        os.unlink(target)\n        return iter(())\nlist(map(lambda *args:0,Values(),[]))',
      'class Values:\n    def __iter__(self):\n        os.unlink(target)\n        return iter(())\nlist(map(lambda *args:0,[],Values()))',
      'class Values:\n    def __iter__(self):\n        os.unlink(target)\n        return iter(())\nlist(map(lambda *args:0,[*Values()],[]))'
    ].map((danger): [string, string, string, string] => [
      `empty callback eager or unknown ${danger}`,
      'print(list(map(lambda *args:os.unlink(target),[])));print("test")',
      'import builtins,itertools,heapq,bisect\n' + danger + ';print("test")',
      'test'
    ]),
    ...[
      '{"cleanup":EARLY,"cleanup":FINAL}',
      '{**{"cleanup":EARLY},"cleanup":FINAL}',
      '{"cleanup":EARLY,**{"cleanup":FINAL}}',
      '({"cleanup":EARLY}|{"cleanup":FINAL})',
      '{**({"cleanup":EARLY}|{"cleanup":FINAL})}',
      'dict({"cleanup":EARLY},cleanup=FINAL)',
      'builtins.dict({"cleanup":EARLY},cleanup=FINAL)',
      'D([("cleanup",EARLY)],cleanup=FINAL)',
      'dict((("cleanup",EARLY),),cleanup=FINAL)',
      'dict(dict({"cleanup":EARLY}),cleanup=FINAL)',
      'operator.call(dict,{"cleanup":EARLY},cleanup=FINAL)',
      'dict(**{"cleanup":EARLY,"cleanup":FINAL})',
      '{"cleanup":EARLY,**dict(cleanup=FINAL)}',
      '{"cleanup":EARLY,**dict(dict(cleanup=FINAL))}',
      '{"cleanup":EARLY,**operator.call(D,cleanup=FINAL)}',
      '({**{"cleanup":EARLY}}|dict(cleanup=FINAL))'
    ].flatMap((form): Array<[string, string, string, string]> => {
      const imports = 'import builtins\nfrom builtins import dict as D\n'
      const options = (key: string, body: string, active: boolean): string =>
        form
          .replaceAll('cleanup', key)
          .replaceAll('EARLY', active ? 'None' : body)
          .replaceAll('FINAL', active ? body : 'None')
      const metadata = (active: boolean): string =>
        imports +
        `metadata=${options('cleanup', 'lambda:os.unlink(target)', active)}\n` +
        (active
          ? 'metadata["cleanup"]()'
          : 'assert metadata["cleanup"] is None;print(open(target).read())')
      const opener = (active: boolean): string => {
        const supplied = options('opener', 'lambda p,f:(os.unlink(target),os.open(p,f))[1]', active)
        return (
          imports +
          `path=os.path.join(os.path.dirname(target),"keep.txt")\nprint(open(path,**${supplied}).read());print("test")`
        )
      }
      const sorting = (active: boolean): string =>
        imports +
        `sorted([1],**${options('key', 'lambda v:os.unlink(target)', active)});print("test")`
      return [
        [`discarded callback mapping ${form}`, metadata(false), metadata(true), 'test'],
        [`discarded callback opener ${form}`, opener(false), opener(true), 'test'],
        [`discarded callback sort ${form}`, sorting(false), sorting(true), 'test']
      ]
    }),
    ...[
      ['operator.itemgetter(0)((str,LAMBDA))', 'operator.itemgetter(1)((str,LAMBDA))'],
      ['pick((str,LAMBDA))', 'operator.itemgetter(1)((str,LAMBDA))'],
      ['operator.getitem([str,LAMBDA],0)', 'operator.getitem([str,LAMBDA],1)'],
      ['operator.__getitem__((str,LAMBDA),0)', 'operator.__getitem__((str,LAMBDA),1)'],
      [
        'operator.call(operator.getitem,[str,LAMBDA],0)',
        'operator.call(operator.getitem,[str,LAMBDA],1)'
      ],
      ['(str,LAMBDA)[0]', '(str,LAMBDA)[1]'],
      [
        'operator.itemgetter("read")({"read":str,"cleanup":LAMBDA})',
        'operator.itemgetter("cleanup")({"read":str,"cleanup":LAMBDA})'
      ],
      ['{"read":str,"cleanup":LAMBDA}["read"]', '{"read":str,"cleanup":LAMBDA}["cleanup"]'],
      ...['get', 'pop', 'setdefault'].flatMap((method) => [
        [
          `dict.${method}({"read":str,"cleanup":LAMBDA},"read")`,
          `dict.${method}({"read":str,"cleanup":LAMBDA},"cleanup")`
        ],
        [
          `{"read":str,"cleanup":LAMBDA}.${method}("read")`,
          `{"read":str,"cleanup":LAMBDA}.${method}("cleanup")`
        ],
        [
          `operator.call(dict.${method},{"read":str,"cleanup":LAMBDA},"read")`,
          `operator.call(dict.${method},{"read":str,"cleanup":LAMBDA},"cleanup")`
        ]
      ]),
      [
        'operator.itemgetter(1)((LAMBDA,open(target,**dict(mode="r")).read))',
        'operator.itemgetter(0)((LAMBDA,open(target,**dict(mode="r")).read))'
      ],
      [
        'operator.itemgetter(0)((str,LAMBDA,dict(tag="data")))',
        'operator.itemgetter(1)((str,LAMBDA,dict(tag="data")))'
      ]
    ].map(([reader, erase]): [string, string, string, string] => [
      `discarded callback literal selector ${reader}`,
      `pick=operator.itemgetter(0)\nprint(${reader.replaceAll('LAMBDA', 'lambda:os.unlink(target)')}(${reader.includes('.read') ? '' : '"test"'}))`,
      `${erase.replaceAll('LAMBDA', 'lambda:os.unlink(target)')}()`,
      'test'
    ]),
    ...[
      'metadata={"cleanup":lambda tag=os.unlink(target):None,"cleanup":None}',
      'metadata={"cleanup":(saved:=lambda:os.unlink(target)),"cleanup":None};saved()',
      'operator.itemgetter(0)((str,lambda tag=os.unlink(target):None))("test")',
      'operator.itemgetter(0)((str,lambda:None,os.unlink(target)))("test")',
      'operator.itemgetter(0,1)((str,lambda:os.unlink(target)))[1]()',
      'operator.itemgetter(0)(((lambda:os.unlink(target),),str))[0]()',
      'dict.get({"nested":[lambda:os.unlink(target)]},"nested")[0]()',
      'def choose(items):\n    return items[1]\npick=choose\npick((str,lambda:os.unlink(target)))()',
      'def options(**kwargs):\n    return {}\nD=options\nmetadata={"cleanup":lambda:os.unlink(target),**D(cleanup=None)}\nmetadata["cleanup"]()',
      'from builtins import dict as D\ndef options(**kwargs):\n    return {}\ncreate=D\nfor flag in (False,True):\n    metadata={"cleanup":lambda:os.unlink(target),**create(cleanup=None)}\n    create=options\nmetadata["cleanup"]()'
    ].map((erase): [string, string, string, string] => [
      `discarded callback retains eager or escaped effects ${erase}`,
      'print(operator.itemgetter(0)((open(target).read,lambda:os.unlink(target)))())',
      erase,
      'test'
    ]),
    [
      'native constructor reader union',
      'print(open(target,**({"opener":None}|dict(mode="r"))).read())',
      'path=os.path.join(os.path.dirname(target),"keep.txt")\nopen(path,**({"opener":lambda p,f:(os.unlink(target),os.open(p,f))[1]}|dict(mode="r"))).read()',
      'test'
    ],
    [
      'explicit absent opener',
      'print(operator.itemgetter(0)((open(target,opener=None).read,))())',
      'operator.itemgetter(0)((os.unlink,))(target)',
      'test'
    ],
    ...[
      ['__format__', ',spec', '"tag"', 'f"{obj}"'],
      ['__add__', ',other', '0', 'obj+0'],
      ['__neg__', '', '0', '-obj'],
      ['__eq__', ',other', 'False', 'obj==0'],
      ['__bool__', '', 'True', 'obj and "tag"'],
      ['__iter__', '', 'iter(())', '(*obj,)'],
      ['keys', '', '[]', '{**obj}'],
      ['__hash__', '', '0', '{obj}'],
      ['__hash__', '', '0', '{obj:"data"}']
    ].map(([hook, args, result, value]) => [
      `construction hook=${hook}`,
      'print(operator.getitem((str,),0)("test"))',
      `class Swap:\n    def ${hook}(self${args}):\n        global fn\n        fn=os.unlink\n        return ${result}\nfn=str\nobj=Swap()\nsaved=operator.itemgetter(1)((${value},fn))\nsaved(target)`,
      'test'
    ]),
    ...[
      ['__fspath__', 'target', 'open(obj).read'],
      ['__fspath__', 'target', 'pathlib.Path(obj).read_text'],
      ['__index__', '-1', 'open(target,buffering=obj).read']
    ].map(([hook, result, value]) => [
      `constructor input hook=${hook} value=${value}`,
      'print(operator.getitem((str,),0)("test"))',
      `class Swap:\n    def ${hook}(self):\n        global fn\n        fn=os.unlink\n        return ${result}\nfn=str\nobj=Swap()\nsaved=operator.itemgetter(1)((${value},fn))\nsaved(target)`,
      'test'
    ]),
    [
      'attribute descriptor changes a later callable',
      'print(operator.getitem((str,),0)("test"))',
      'class Swap:\n    @property\n    def value(self):\n        global fn\n        fn=os.unlink\n        return "tag"\nfn=str\nobj=Swap()\nsaved=operator.itemgetter(1)((obj.value,fn))\nsaved(target)',
      'test'
    ],
    ...['run', 'call', 'check_call', 'check_output', 'Popen'].map((method) => {
      const invoke = `result=operator.itemgetter("fn")({"fn":subprocess.${method}})(ARGS)${method === 'Popen' ? ';result.wait()' : ''};print(result)`
      const python = JSON.stringify(process.env.OPEN_SCIENCE_RISK_PYTHON)
      return [
        `process method=${method}`,
        invoke.replace('ARGS', `[${python},"--version"]`),
        invoke.replace('ARGS', `[${python},"-c","import os;os.unlink("+repr(target)+")"]`),
        'Python'
      ]
    }),
    ...[
      'list((FUNC,))[0]',
      'tuple([FUNC])[0]',
      'list(tuple([FUNC]))[0]',
      'tuple(list((FUNC,)))[0]',
      'builtins.list([FUNC])[False]',
      'builtins.tuple((str,FUNC))[-1]',
      'make_seq([FUNC])[0]',
      'list([*(FUNC,)])[0]',
      'tuple(([FUNC]+[]))[0]',
      'operator.call(list,(FUNC,))[0]',
      'operator.__call__(tuple,[FUNC])[0]',
      'operator.getitem(list((FUNC,)),0)',
      'operator.itemgetter(0)(tuple([FUNC]))',
      'operator.call(operator.getitem,tuple([FUNC]),0)',
      'dict(read=FUNC)["read"]',
      'dict({"read":FUNC})["read"]',
      'dict([("read",FUNC)])["read"]',
      'dict((("read",FUNC),))["read"]',
      'dict(dict(read=FUNC))["read"]',
      'builtins.dict(read=FUNC)["read"]',
      'make_map(read=FUNC)["read"]',
      'dict(**{"read":FUNC})["read"]',
      'dict({"read":str},read=FUNC)["read"]',
      'dict({"read":str}|{"read":FUNC})["read"]',
      'dict(read=FUNC).get("read")',
      'dict(read=FUNC).pop("read")',
      'dict(read=FUNC).setdefault("read",str)',
      'dict.get(dict(read=FUNC),"read")',
      'operator.getitem(dict(read=FUNC),"read")',
      'operator.itemgetter("read")(dict(read=FUNC))',
      'operator.call(dict,read=FUNC)["read"]',
      'dict().get("read",FUNC)'
    ].flatMap((form, index) =>
      ['print(SELECTED())', 'reader=SELECTED;print(operator.call(reader))'].map(
        (route, routeIndex) => {
          const setup = 'import builtins\nmake_seq=list\nmake_map=dict\n'
          return [
            `native constructor form=${index} route=${routeIndex}`,
            setup + route.replace('SELECTED', form.replaceAll('FUNC', 'open(target).read')),
            setup +
              route.replace('SELECTED', form.replaceAll('FUNC', 'pathlib.Path(target).unlink')),
            'test'
          ]
        }
      )
    ),
    ...[
      [
        'discarded sequence lambda',
        'print(list([open(target).read,lambda:os.unlink(target)])[0]())',
        'list([open(target).read,lambda:os.unlink(target)])[1]()'
      ],
      [
        'discarded mapping lambda',
        'print(dict(read=open(target).read,erase=lambda:os.unlink(target))["read"]())',
        'dict(read=open(target).read,erase=lambda:os.unlink(target))["erase"]()'
      ],
      [
        'overwritten pair',
        'print(dict([("read",lambda:os.unlink(target)),("read",open(target).read)])["read"]())',
        'dict([("read",open(target).read),("read",lambda:os.unlink(target))])["read"]()'
      ],
      [
        'existing lookup default',
        'print(dict(read=open(target).read).get("read",lambda:os.unlink(target))())',
        'dict(read=open(target).read).get("missing",lambda:os.unlink(target))()'
      ],
      [
        'eager lambda default',
        'print(list([open(target).read,lambda:os.unlink(target)])[0]())',
        'list([open(target).read,lambda default=os.unlink(target):0])[0]()'
      ],
      [
        'custom sequence iteration',
        'print(list((open(target).read,))[0]())',
        'class Values:\n def __iter__(self):\n  os.unlink(target)\n  return iter((str,))\nlist(Values())[0](target)'
      ],
      [
        'custom mapping protocol',
        'print(dict(read=open(target).read)["read"]())',
        'class Values:\n def keys(self):\n  os.unlink(target)\n  return ("read",)\n def __getitem__(self,key):return str\ndict(Values())["read"](target)'
      ],
      [
        'replaced sequence factory',
        'make=list\nprint(make((open(target).read,))[0]())',
        'def make(values): return [pathlib.Path(target).unlink]\nmake((str,))[0]()'
      ],
      [
        'replaced mapping factory',
        'make=dict\nprint(make(read=open(target).read)["read"]())',
        'def make(**kwargs): return {"read":pathlib.Path(target).unlink}\nmake(read=str)["read"]()'
      ],
      [
        'saved sequence native before replacement',
        'import builtins\nsaved=list\nbuiltins.list=lambda values:[pathlib.Path(target).unlink]\nprint(saved((open(target).read,))[0]())',
        'import builtins\nsaved=list\nbuiltins.list=lambda values:[pathlib.Path(target).unlink]\nbuiltins.list((str,))[0]()'
      ],
      [
        'saved mapping native before replacement',
        'import builtins\nsaved=dict\nbuiltins.dict=lambda **kwargs:{"read":pathlib.Path(target).unlink}\nprint(saved(read=open(target).read)["read"]())',
        'import builtins\nsaved=dict\nbuiltins.dict=lambda **kwargs:{"read":pathlib.Path(target).unlink}\nbuiltins.dict(read=str)["read"]()'
      ],
      [
        'named function returned by copy',
        'def read(): return open(target).read()\nprint(list((read,))[0]())',
        'def erase():os.unlink(target)\nlist((erase,))[0]()'
      ],
      [
        'dictionary callback in sort',
        'sorted([],**dict(key=os.unlink));print(open(target).read())',
        'sorted([target],**dict(key=os.unlink))'
      ],
      [
        'dictionary callback in groupby',
        'import itertools\nlist(itertools.groupby([],**dict(key=os.unlink)));print(open(target).read())',
        'import itertools\nlist(itertools.groupby([target],**dict(key=os.unlink)))'
      ],
      [
        'dictionary callback in heap',
        'import heapq\nheapq.nlargest(1,[],**dict(key=os.unlink));print(open(target).read())',
        'import heapq\nheapq.nlargest(1,[target],**dict(key=os.unlink))'
      ],
      [
        'dictionary function in map',
        'list(map(dict(fn=str)["fn"],[target]));print(open(target).read())',
        'list(map(dict(fn=os.unlink)["fn"],[target]))'
      ],
      [
        'inactive named callback member writes',
        'def callback(value):\n os.path.exists=os.unlink\n return value\nlist(map(dict(fn=callback)["fn"],[]));print(open(target).read());os.path.exists(target)',
        'def callback(value):\n os.path.exists=os.unlink\n return value\nlist(map(dict(fn=callback)["fn"],[target]));os.path.exists(target)'
      ]
    ].map(([name, reader, erase]) => [`native constructor ${name}`, reader, erase, 'test']),
    ...[
      '[ARGV][0]',
      '("unused",ARGV)[-1]',
      'tuple(list((ARGV,)))[0]',
      '{"args":ARGV}["args"]',
      'dict(args=ARGV)["args"]',
      'dict({"args":ARGV})["args"]',
      '({"args":["rm","target.txt"]}|{"args":ARGV})["args"]',
      '{**{"args":["rm","target.txt"]},**dict(args=ARGV)}["args"]',
      '{"args":["rm","target.txt"],"args":ARGV}["args"]',
      '{"args":ARGV}.get("args",["rm","target.txt"])',
      '{"args":ARGV}.pop("args",["rm","target.txt"])',
      '{"args":ARGV}.setdefault("args",["rm","target.txt"])',
      '{}.get("args",ARGV)',
      '{}.pop("args",ARGV)',
      '{}.setdefault("args",ARGV)',
      'dict.get(dict(args=ARGV),"args")',
      'builtins.dict.get({"args":ARGV},"args")',
      'operator.getitem([ARGV],0)',
      'operator.__getitem__(dict(args=ARGV),"args")',
      'operator.itemgetter("args")(dict(args=ARGV))',
      'operator.itemgetter(0)([ARGV])',
      'pick([ARGV],0)',
      'getter({"args":ARGV})',
      'operator.call(operator.getitem,[ARGV],0)',
      'operator.call(operator.itemgetter(0),[ARGV])',
      '{"args":tuple(list(ARGV))}["args"]',
      '{"args":operator.itemgetter(KEYS)(ARGV)}["args"]',
      'operator.itemgetter(KEYS)(ARGV)',
      'operator.itemgetter(KEYS)(tuple(list(ARGV)))',
      'operator.call(operator.itemgetter(KEYS),ARGV)',
      'multi(ARGV)',
      'operator.itemgetter(REV_KEYS)(ARGV[::-1])',
      'operator.itemgetter(KEYS,KEYS)(ARGV)',
      'operator.itemgetter(MAP_KEYS)(MAP)'
    ].flatMap((form, index) =>
      ['run', 'call', 'check_call', 'check_output', 'Popen'].flatMap((method) =>
        [
          'subprocess.METHOD(VECTOR)',
          'subprocess.METHOD(**dict(args=VECTOR))',
          'subprocess.METHOD([*VECTOR])'
        ].map((route, routeIndex) => {
          const python = process.env.OPEN_SCIENCE_RISK_PYTHON?.replaceAll('\\', '/')
          const invoke = (erase: boolean): string => {
            const args = [
              python,
              ...(erase ? ['-c', "import os;os.unlink('item-target.txt')"] : ['--version'])
            ]
            const keys = args.map((_, i) => i).join(',')
            const mapping = Object.fromEntries(
              args.map((value, i) => [i ? `arg${i - 1}` : 'command', value])
            )
            const vector = form
              .replaceAll('ARGV', JSON.stringify(args))
              .replaceAll('REV_KEYS', args.map((_, i) => args.length - i - 1).join(','))
              .replaceAll(
                'MAP_KEYS',
                Object.keys(mapping)
                  .map((key) => JSON.stringify(key))
                  .join(',')
              )
              .replaceAll('KEYS', keys)
              .replaceAll('MAP', JSON.stringify(mapping))
            return (
              'import builtins\npick=operator.getitem\ngetter=operator.itemgetter("args")\n' +
              `multi=operator.itemgetter(${keys})\nresult=${route.replace('METHOD', method).replace('VECTOR', vector)}` +
              (method === 'Popen' ? ';result.wait()' : '') +
              (method === 'check_output' ? ';print(result)' : '')
            )
          }
          return [
            `process returned vector form=${index} method=${method} route=${routeIndex}`,
            invoke(false),
            invoke(true),
            'Python'
          ]
        })
      )
    ),
    ...[
      '[ARGV][0]',
      'dict(args=ARGV)["args"]',
      'dict(args=ARGV).get("args")',
      '{}.get("args",ARGV)',
      'operator.getitem([ARGV],0)',
      'operator.itemgetter(0)([ARGV])',
      'operator.itemgetter(0,1)(ARGV)'
    ].flatMap((form, index) => {
      const python = JSON.stringify(process.env.OPEN_SCIENCE_RISK_PYTHON?.replaceAll('\\', '/'))
      const hook =
        'original=pathlib.PurePath.__fspath__\ndef hook(self):\n if os.path.exists(target):os.unlink(target)\n return original(self)\ndef change():\n pathlib.PurePath.__fspath__=hook\n return True\n'
      const invoke = (value: string): string =>
        `subprocess.run(${form.replaceAll('ARGV', `[${value},"--version"]`)},text=change(),check=True)`
      return ['str(VALUE)', 'os.fspath(VALUE)'].map((conversion) => [
        `process returned vector late path form=${index} conversion=${conversion}`,
        hook + invoke(conversion.replace('VALUE', `pathlib.Path(${python})`)),
        hook + invoke(`pathlib.Path(${python})`),
        'Python'
      ])
    }),
    ...[
      [
        'eager default',
        '{"args":ARGV}.get("args",None)',
        '{"args":ARGV}.get("args",os.unlink(target))'
      ],
      ['unused element', '[ARGV,None][0]', '[ARGV,os.unlink(target)][0]'],
      [
        'unused dictionary key',
        '{"args":ARGV}["args"]',
        '{"args":ARGV,os.unlink(target):None}["args"]'
      ],
      [
        'custom item lookup',
        '[ARGV][0]',
        'class Commands:\n def __getitem__(self,key):\n  os.unlink(target)\n  return ARGV\n\nCommands()[0]'
      ],
      [
        'custom integer index',
        '[ARGV][0]',
        'class Index:\n def __index__(self):\n  os.unlink(target)\n  return 0\n\n[ARGV][Index()]'
      ],
      [
        'custom hash lookup',
        '{"args":ARGV}["args"]',
        'class Key:\n def __hash__(self):\n  os.unlink(target)\n  return hash("args")\n def __eq__(self,other):return other=="args"\n\n{"args":ARGV}[Key()]'
      ],
      [
        'unknown expanded iterator',
        '[*operator.itemgetter(0,1)(ARGV)]',
        'class Commands:\n def __iter__(self):\n  os.unlink(target)\n  yield from ARGV\n\n[*Commands()]'
      ],
      [
        'embedded expanded iterator index',
        '[*(("unused",),ARGV)][1]',
        'import types\nclass Commands:\n def __iter__(self):\n  os.unlink(target)\n  yield ("unused",)\ncommands=types.SimpleNamespace(values=Commands())\n\n[*commands.values,ARGV][1]'
      ]
    ].map(([name, reader, erase]) => {
      const args = JSON.stringify([
        process.env.OPEN_SCIENCE_RISK_PYTHON?.replaceAll('\\', '/'),
        '--version'
      ])
      const invoke = (code: string): string => {
        const [setup, vector] = code.includes('\n\n') ? code.split('\n\n') : ['', code]
        return (
          setup.replaceAll('ARGV', args) +
          '\n' +
          `subprocess.run(${vector.replaceAll('ARGV', args)},check=True)`
        )
      }
      return [`process returned vector ${name}`, invoke(reader), invoke(erase), 'Python']
    }),
    ...[
      ['make=list\n', '[make(ARGV)][0]', 'text=(make:=os.unlink)'],
      ['multi=operator.itemgetter(0,1)\n', 'multi(ARGV)', 'text=(multi:=os.unlink)']
    ]
      .map(([setup, form, late]) => {
        const args = JSON.stringify([
          process.env.OPEN_SCIENCE_RISK_PYTHON?.replaceAll('\\', '/'),
          '--version'
        ])
        const reader = setup + `subprocess.run(${form.replaceAll('ARGV', args)},${late},check=True)`
        const erase =
          setup +
          `subprocess.run(${form.replaceAll('ARGV', args)},${late},preexec_fn=lambda:os.unlink(target),check=True)`
        return [`process returned vector frozen before ${late}`, reader, erase, 'Python']
      })
      .filter(() => process.platform !== 'win32'),
    ...[
      '[VALUE,"rm"][0]',
      '("rm",VALUE)[-1]',
      '[VALUE][False]',
      '("rm",VALUE)[True]',
      '([VALUE]+["rm"])[0]',
      '[*("rm",),VALUE][-1]',
      'tuple(list((VALUE,"rm")))[0]',
      'list((VALUE,"rm"))[0]',
      '["rm",VALUE][::-1][0]',
      'VALUE.split("|")[0]',
      'VALUE.rsplit("|")[0]',
      'str.split(VALUE,"|")[-1]',
      'VALUE.strip().split("|")[0]',
      '{"command":VALUE}["command"]',
      'dict(command=VALUE)["command"]',
      'dict({"command":VALUE})["command"]',
      '{"command":"rm","command":VALUE}["command"]',
      '({"command":"rm"}|{"command":VALUE})["command"]',
      '{**{"command":"rm"},**dict(command=VALUE)}["command"]',
      '{False:VALUE,True:"rm"}[0]',
      '{"command":VALUE}.get("command","rm")',
      '{"command":VALUE}.pop("command","rm")',
      '{"command":VALUE}.setdefault("command","rm")',
      '{}.get("command",VALUE)',
      '{}.pop("command",VALUE)',
      '{}.setdefault("command",VALUE)',
      'dict.get(dict(command=VALUE),"command")',
      'builtins.dict.get({"command":VALUE},"command")',
      'operator.getitem((VALUE,"rm"),0)',
      'operator.__getitem__(dict(command=VALUE),"command")',
      'operator.itemgetter(0)((VALUE,"rm"))',
      'operator.itemgetter("command")(dict(command=VALUE))',
      'operator.call(operator.getitem,[VALUE],0)',
      'operator.call(operator.itemgetter(0),VALUE.split("|"))',
      'pick([VALUE],0)',
      'getter(dict(command=VALUE))',
      '[VALUE][0].strip()',
      'dict(command=[VALUE][0])["command"]',
      'str([pathlib.Path(VALUE)][0])',
      'os.fspath(dict(command=pathlib.Path(VALUE))["command"])',
      'dict(command=VALUE)["command"].split("|")[0]',
      'operator.getitem(VALUE.split("|"),0)'
    ].flatMap((selector, index) =>
      ['run', 'call', 'check_call', 'check_output', 'Popen'].flatMap((method) =>
        ['subprocess.METHOD([VALUE,ARGS])', 'subprocess.METHOD(**dict(args=[VALUE,ARGS]))'].map(
          (route, routeIndex) => {
            const python = JSON.stringify(
              process.env.OPEN_SCIENCE_RISK_PYTHON?.replaceAll('\\', '/')
            )
            const value = selector.replaceAll('VALUE', python)
            const setup =
              'import builtins\npick=operator.getitem\ngetter=operator.itemgetter("command")\n'
            const invoke = (args: string): string =>
              `result=${route.replace('METHOD', method).replace('VALUE', value).replace('ARGS', args)}` +
              (method === 'Popen' ? ';result.wait()' : '') +
              (method === 'check_output' ? ';print(result)' : '')
            return [
              `process selected selector=${index} method=${method} route=${routeIndex}`,
              setup + invoke('"--version"'),
              setup + invoke('"-c","import os;os.unlink("+repr(target)+")"'),
              'Python'
            ]
          }
        )
      )
    ),
    ...[
      '[VALUE][0]',
      'dict(command=VALUE)["command"]',
      'dict(command=VALUE).get("command")',
      'operator.getitem([VALUE],0)',
      'operator.itemgetter("command")(dict(command=VALUE))'
    ].flatMap((selector, index) => {
      const python = JSON.stringify(process.env.OPEN_SCIENCE_RISK_PYTHON?.replaceAll('\\', '/'))
      const hook =
        'original=pathlib.PurePath.__fspath__\ndef hook(self):\n if os.path.exists(target):os.unlink(target)\n return original(self)\ndef change():\n pathlib.PurePath.__fspath__=hook\n return True\n'
      const invoke = (value: string): string =>
        `subprocess.run([${selector.replaceAll('VALUE', value)},"--version"],text=change(),check=True)`
      return ['str(VALUE)', 'os.fspath(VALUE)'].map((conversion) => [
        `process selected late path hook selector=${index} conversion=${conversion}`,
        hook + invoke(conversion.replace('VALUE', `pathlib.Path(${python})`)),
        hook + invoke(`pathlib.Path(${python})`),
        'Python'
      ])
    }),
    ...[
      ['unused list element', '[VALUE,None][0]', '[VALUE,os.unlink(target)][0]'],
      [
        'eager mapping default',
        '{"command":VALUE}.get("command",None)',
        '{"command":VALUE}.get("command",os.unlink(target))'
      ],
      [
        'custom index',
        '[VALUE][0]',
        'class Index:\n def __index__(self):\n  os.unlink(target)\n  return 0\n\n[VALUE][Index()]'
      ],
      [
        'custom mapping key',
        '{"command":VALUE}["command"]',
        'class Key:\n def __hash__(self):\n  os.unlink(target)\n  return hash("command")\n def __eq__(self,other):return other=="command"\n\n{"command":VALUE}[Key()]'
      ],
      [
        'custom container',
        '[VALUE][0]',
        'class Commands:\n def __getitem__(self,index):\n  os.unlink(target)\n  return VALUE\n\nCommands()[0]'
      ],
      [
        'replaced item accessor',
        'saved=operator.getitem\ndef changed(values,key):\n os.unlink(target)\n return values[key]\noperator.getitem=changed\n\nsaved([VALUE],0)',
        'def changed(values,key):\n os.unlink(target)\n return values[key]\noperator.getitem=changed\n\noperator.getitem([VALUE],0)'
      ]
    ].map(([name, reader, erase]) => {
      const python = JSON.stringify(process.env.OPEN_SCIENCE_RISK_PYTHON?.replaceAll('\\', '/'))
      const invoke = (value: string): string => {
        const [setup, selection] = value.includes('\n\n') ? value.split('\n\n') : ['', value]
        return (
          setup.replaceAll('VALUE', python) +
          '\n' +
          `subprocess.run([${selection.replaceAll('VALUE', python)},"--version"],check=True)`
        )
      }
      return [`process selected ${name}`, invoke(reader), invoke(erase), 'Python']
    }),
    ...[
      'Path',
      'PurePath',
      process.platform === 'win32' ? 'WindowsPath' : 'PosixPath',
      process.platform === 'win32' ? 'PureWindowsPath' : 'PurePosixPath'
    ].flatMap((kind) =>
      ['VALUE', 'str(VALUE)', 'os.fspath(VALUE)'].flatMap((conversion) =>
        ['run', 'call', 'check_call', 'check_output', 'Popen'].flatMap((method) =>
          [
            'subprocess.METHOD([VALUE,ARGS])',
            'subprocess.METHOD(tuple(list((VALUE,ARGS))))',
            'subprocess.METHOD(**dict(args=[VALUE,ARGS]))'
          ].map((route, index) => {
            const python = JSON.stringify(
              process.env.OPEN_SCIENCE_RISK_PYTHON?.replaceAll('\\', '/')
            )
            const value = conversion.replace('VALUE', `pathlib.${kind}(${python})`)
            const invoke = 'result=' + route.replaceAll('METHOD', method).replaceAll('VALUE', value)
            const finish = (method === 'Popen' ? ';result.wait()' : '') + ';print(result)'
            return [
              `process path ${kind} ${conversion} ${method} route=${index}`,
              invoke.replace('ARGS', '"--version"') + finish,
              invoke.replace('ARGS', '"-c","import os;os.unlink("+repr(target)+")"') + finish,
              'Python'
            ]
          })
        )
      )
    ),
    ...['run', 'call', 'check_call', 'check_output', 'Popen'].flatMap((method) => {
      const path = process.env.OPEN_SCIENCE_RISK_PYTHON?.replaceAll('\\', '/') ?? ''
      const python = JSON.stringify(path)
      const expressions = [
        `${JSON.stringify(' ' + path + ' ')}.strip()`,
        `${JSON.stringify(' ' + path)}.lstrip()`,
        `${JSON.stringify(path + ' ')}.rstrip()`,
        `${JSON.stringify('prefix-' + path)}.removeprefix("prefix-")`,
        `${JSON.stringify(path + '-suffix')}.removesuffix("-suffix")`,
        `${JSON.stringify(path + '-suffix')}.replace("-suffix","")`,
        `"".join([${python},""])`,
        `"".join(tuple(list((${python},""))))`,
        `str.strip(${JSON.stringify(' ' + path + ' ')})`,
        `transform(${JSON.stringify(' ' + path + ' ')})`,
        `operator.call(${JSON.stringify(' ' + path + ' ')}.strip)`,
        `operator.call(str.strip,${JSON.stringify(' ' + path + ' ')})`,
        `str(pathlib.Path(${python})).strip()`,
        `os.fspath(pathlib.Path(${python})).replace("__missing__","")`,
        `${python}.replace("__missing__","ignored",0)`,
        `${JSON.stringify('#' + path)}.replace("#","",True)`,
        `${JSON.stringify(path + '#')}.replace("#","",-1)`,
        `${python}.replace("","",2)`,
        `${python}.strip("")`,
        `${python}.removesuffix("")`
      ]
      return expressions.flatMap((value, index) =>
        ['subprocess.METHOD([VALUE,ARGS])', 'subprocess.METHOD(**dict(args=[VALUE,ARGS]))'].map(
          (route, routeIndex) => {
            const invoke =
              'transform=str.strip\nresult=' +
              route.replace('METHOD', method).replace('VALUE', value)
            const finish = (method === 'Popen' ? ';result.wait()' : '') + ';print(result)'
            return [
              `process text method=${method} form=${index} route=${routeIndex}`,
              invoke.replace('ARGS', '"--version"') + finish,
              invoke.replace('ARGS', '"-c","import os;os.unlink("+repr(target)+")"') + finish,
              'Python'
            ]
          }
        )
      )
    }),
    ...[
      ['"--VERSION".lower()', '"-C".lower()'],
      ['"--VERSION".casefold()', '"-C".casefold()'],
      ['"--version".upper().lower()', '"-c".upper().lower()'],
      ['" --version ".strip()', '" -c ".strip()'],
      ['"".join(("--","version"))', '"".join(("-","c"))'],
      ['*" --version ".strip().split()', '*" -c ".strip().split()'],
      ['*str.rsplit(" --version ".strip())', '*str.rsplit(" -c ".strip())']
    ].map(([query, script], index) => {
      const python = JSON.stringify(process.env.OPEN_SCIENCE_RISK_PYTHON?.replaceAll('\\', '/'))
      return [
        `process text option form=${index}`,
        `subprocess.run([${python},${query}],check=True)`,
        `subprocess.run([${python},${script},"import os;os.unlink("+repr(target)+")"],check=True)`,
        'Python'
      ]
    }),
    [
      'process text saved native versus replaced transform',
      `transform=str.strip\nsaved=transform\ndef transform(value):\n os.unlink(target)\n return value\nsubprocess.run([saved(${JSON.stringify(' ' + (process.env.OPEN_SCIENCE_RISK_PYTHON?.replaceAll('\\', '/') ?? '') + ' ')}),"--version"],check=True)`,
      `transform=str.strip\nsaved=transform\ndef transform(value):\n os.unlink(target)\n return value\nsubprocess.run([transform(${JSON.stringify(process.env.OPEN_SCIENCE_RISK_PYTHON?.replaceAll('\\', '/'))}),"--version"],check=True)`,
      'Python'
    ],
    ...[
      [
        'custom join iterator',
        'class Parts:\n def __iter__(self):\n  os.unlink(target)\n  yield PYTHON\nsubprocess.run(["".join(Parts()),"--version"],check=True)'
      ],
      [
        'custom replace index',
        'class Count:\n def __index__(self):\n  os.unlink(target)\n  return 1\nsubprocess.run([PYTHON.replace("__missing__","",Count()),"--version"],check=True)'
      ],
      [
        'eager replace argument',
        'subprocess.run([PYTHON.replace("__missing__",(os.unlink(target),"")[1]),"--version"],check=True)'
      ],
      [
        'eager strip argument',
        'subprocess.run([PYTHON.strip((os.unlink(target),None)[1]),"--version"],check=True)'
      ]
    ].map(([name, erase]) => {
      const python = JSON.stringify(process.env.OPEN_SCIENCE_RISK_PYTHON?.replaceAll('\\', '/'))
      return [
        `process text ${name}`,
        `subprocess.run(["".join([${python},""]),"--version"],check=True)`,
        erase.replaceAll('PYTHON', python),
        'Python'
      ]
    }),
    ...['__fspath__', '__str__'].flatMap((protocol) =>
      ['str', 'os.fspath'].flatMap((conversion) =>
        ['[VALUE,"--version"]', 'list((VALUE,"--version"))', 'tuple((VALUE,"--version"))[0:]'].map(
          (wrapper, index) => {
            const python = JSON.stringify(
              process.env.OPEN_SCIENCE_RISK_PYTHON?.replaceAll('\\', '/')
            )
            const value = `pathlib.Path(${python})`
            const setup = `original=pathlib.PurePath.${protocol}\ndef hook(self):\n if os.path.exists(target):os.unlink(target)\n return original(self)\n`
            const invoke = (source: string): string =>
              'subprocess.run(' +
              wrapper.replace('VALUE', source) +
              `,cwd=(setattr(pathlib.PurePath,"${protocol}",hook),None)[1],check=True)`
            return [
              `process path frozen ${conversion} ${protocol} route=${index}`,
              setup + invoke(`${conversion}(${value})`),
              setup + invoke(value),
              'Python'
            ]
          }
        )
      )
    ),
    ...[
      [
        'subprocess.run([VALUE,"--version"],check=True)',
        'subprocess.run(["argv0","--version"],executable=VALUE,check=True)'
      ],
      [
        'operator.call(subprocess.run,[VALUE,"--version"],check=True)',
        'subprocess.run([*(VALUE,"--version")],check=True)'
      ],
      [
        'subprocess.run(["ignored",VALUE,"--version"][1:],check=True)',
        'subprocess.run(tuple((VALUE,"--version"))[0:],check=True)'
      ]
    ].map(([reader, erase], index) => {
      const python = JSON.stringify(process.env.OPEN_SCIENCE_RISK_PYTHON?.replaceAll('\\', '/'))
      const value = `pathlib.Path(${python})`
      const hook =
        'original=pathlib.PurePath.__fspath__\ndef hook(self):\n if os.path.exists(target):os.unlink(target)\n return original(self)\npathlib.PurePath.__fspath__=hook\n'
      return [
        `process path protocol write route=${index}`,
        reader.replaceAll('VALUE', value),
        hook + erase.replaceAll('VALUE', value),
        'Python'
      ]
    })
  ])(
    'admits real Python literal item=%s and gates deletion once',
    async (_, reader, erase, output) => {
      const { service, execute, request } = await harness()
      const target = join(request.workspaceCwd, 'item-target.txt')
      const keep = join(request.workspaceCwd, 'keep.txt')
      erase = erase.replaceAll(
        JSON.stringify("import os;os.unlink('item-target.txt')"),
        JSON.stringify(`import os;os.unlink(${JSON.stringify(target)})`)
      )
      await writeFile(target, 'test')
      await writeFile(keep, 'keep')
      execute.mockImplementation(async (execution) => {
        const { stdout, stderr } = await promisify(execFile)(
          process.env.OPEN_SCIENCE_RISK_PYTHON!,
          ['-c', execution.code],
          { cwd: execution.cwd, timeout: 5000 }
        )
        return {
          status: 'completed',
          stdout,
          stderr,
          traceback: '',
          cwdAfter: execution.cwd,
          outputs: [],
          kernelDispatched: true
        }
      })
      const prelude = `import operator,os,pathlib,functools,subprocess\ntarget=${JSON.stringify(target)}\n`
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      await service.execute({ ...request, code: prelude + reader })
      expect((await execute.mock.results[0].value).stdout).toContain(output)
      expect(approve).not.toHaveBeenCalled()
      expect(execute).toHaveBeenCalledTimes(1)
      expect(await readFile(target, 'utf8')).toBe('test')
      await expect(service.execute({ ...request, code: prelude + erase })).rejects.toThrow(
        'one-time approval'
      )
      expect(execute).toHaveBeenCalledTimes(1)
      expect(await readFile(target, 'utf8')).toBe('test')
      approve.mockResolvedValueOnce(true)
      await service.execute({ ...request, code: prelude + erase })
      expect(execute).toHaveBeenCalledTimes(2)
      await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
      await writeFile(target, 'next run')
      await expect(service.execute({ ...request, code: prelude + erase })).rejects.toThrow(
        'one-time approval'
      )
      expect(approve).toHaveBeenCalledTimes(3)
      expect(execute).toHaveBeenCalledTimes(2)
      expect(await readFile(target, 'utf8')).toBe('next run')
      expect(await readFile(keep, 'utf8')).toBe('keep')
    }
  )

  it.skipIf(!process.env.OPEN_SCIENCE_RISK_PYTHON).each([
    ...[
      'operator.attrgetter(NAME)',
      'pick(NAME)',
      'operator.call(operator.attrgetter,NAME)',
      'operator.__call__(operator.attrgetter,NAME)',
      'operator.attrgetter(*(NAME,))',
      'getattr(operator,"attrgetter")(NAME)'
    ].flatMap((factory, factoryIndex) =>
      [
        'GETTER(path)()',
        'get=GETTER;method=get(path);get=str;method()',
        'operator.call(operator.call,GETTER,path)()',
        'GETTER(*(path,))()'
      ].map((route, routeIndex) => [
        `factory=${factoryIndex} route=${routeIndex}`,
        route.replace('GETTER', factory.replace('NAME', '"read_text"')),
        route.replace('GETTER', factory.replace('NAME', '"unlink"'))
      ])
    ),
    ...['read', 'readline', 'readlines'].map((name) => [
      `file reader=${name}`,
      `print(operator.attrgetter(${JSON.stringify(name)})(open(target))())`,
      'operator.attrgetter("unlink")(path)()'
    ]),
    [
      'byte reader',
      'print(operator.attrgetter("read_bytes")(path)())',
      'operator.attrgetter("unlink")(path)()'
    ],
    [
      'dotted method',
      'print(operator.attrgetter("nested.read_text")(record)())',
      'operator.attrgetter("nested.unlink")(record)()'
    ],
    [
      'partial function',
      'print(operator.attrgetter("func")(functools.partial(str))("test"))',
      'operator.attrgetter("func")(functools.partial(os.unlink))(target)'
    ],
    [
      'callable attribute',
      'print(operator.attrgetter("__call__")(str)("test"))',
      'operator.attrgetter("__call__")(os.unlink)(target)'
    ],
    [
      'mapped returned callable',
      'print(list(map(lambda _:operator.attrgetter("read_text")(path)(),[0])))',
      'list(map(lambda _:operator.attrgetter("unlink")(path)(),[0]))'
    ],
    [
      'non-executed method lookup',
      'operator.attrgetter("read_text","unlink")(path);print("test")',
      'operator.attrgetter("read_text","unlink")(path)[1]()'
    ],
    ...['run', 'call', 'check_call', 'check_output', 'Popen'].map((method) => {
      const invoke = `result=operator.attrgetter(${JSON.stringify(method)})(subprocess)(ARGS)${method === 'Popen' ? ';result.wait()' : ''}`
      const python = JSON.stringify(process.env.OPEN_SCIENCE_RISK_PYTHON)
      return [
        `process method=${method}`,
        invoke.replace('ARGS', `[${python},"--version"]`),
        invoke.replace('ARGS', `[${python},"-c","import os;os.unlink("+repr(target)+")"]`)
      ]
    })
  ])('admits real Python returned getter=%s and gates deletion once', async (_, reader, erase) => {
    const { service, execute, request } = await harness()
    const target = join(request.workspaceCwd, 'attrgetter-target.txt')
    const keep = join(request.workspaceCwd, 'keep.txt')
    await writeFile(target, 'test')
    await writeFile(keep, 'keep')
    execute.mockImplementation(async (execution) => {
      const { stdout, stderr } = await promisify(execFile)(
        process.env.OPEN_SCIENCE_RISK_PYTHON!,
        ['-c', execution.code],
        { cwd: execution.cwd, timeout: 5000 }
      )
      return {
        status: 'completed',
        stdout,
        stderr,
        traceback: '',
        cwdAfter: execution.cwd,
        outputs: [],
        kernelDispatched: true
      }
    })
    const prelude = `import operator,pathlib,os,functools,types,subprocess
from operator import attrgetter as pick
target=${JSON.stringify(target)}
path=pathlib.Path(target)
record=types.SimpleNamespace(nested=path)
`
    const approve = vi.fn(async () => false)
    service.setExecutionApproval(approve)
    await service.execute({ ...request, code: prelude + reader })
    expect(approve).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(await readFile(target, 'utf8')).toBe('test')
    await expect(service.execute({ ...request, code: prelude + erase })).rejects.toThrow(
      'one-time approval'
    )
    expect(execute).toHaveBeenCalledTimes(1)
    expect(await readFile(target, 'utf8')).toBe('test')
    approve.mockResolvedValueOnce(true)
    await service.execute({ ...request, code: prelude + erase })
    expect(execute).toHaveBeenCalledTimes(2)
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(target, 'next run')
    await expect(service.execute({ ...request, code: prelude + erase })).rejects.toThrow(
      'one-time approval'
    )
    expect(approve).toHaveBeenCalledTimes(3)
    expect(execute).toHaveBeenCalledTimes(2)
    expect(await readFile(target, 'utf8')).toBe('next run')
    expect(await readFile(keep, 'utf8')).toBe('keep')
  })

  it
    .skipIf(!process.env.OPEN_SCIENCE_RISK_PYTHON || process.platform === 'win32')
    .each([
      '"False"',
      'b"0"',
      '[False]',
      '(None,)',
      '{0}',
      '{"flag":False}',
      '[*(),1]',
      '{**{},"x":0}',
      'not []',
      '"" or "x"',
      '[0] and [False]',
      '"x" if [1] else ""',
      ...pythonNativeTrueFlags
    ])('gates real Python closed true shell flag=%s once', async (flag) => {
    const { service, execute, request } = await harness()
    const target = join(request.workspaceCwd, 'true-flag-target.txt')
    const keep = join(request.workspaceCwd, 'keep.txt')
    await writeFile(target, 'test')
    await writeFile(keep, 'keep')
    execute.mockImplementation(async (execution) => {
      const { stdout, stderr } = await promisify(execFile)(
        process.env.OPEN_SCIENCE_RISK_PYTHON!,
        ['-c', execution.code],
        { cwd: execution.cwd, timeout: 5000 }
      )
      return {
        status: 'completed',
        stdout,
        stderr,
        traceback: '',
        cwdAfter: execution.cwd,
        outputs: [],
        kernelDispatched: true
      }
    })
    const program = JSON.stringify(process.env.OPEN_SCIENCE_RISK_PYTHON)
    const code = (danger: boolean): string => {
      const command = danger
        ? `${program} -c ${JSON.stringify(`import os;os.unlink(${JSON.stringify(target)})`)}`
        : 'printf test'
      return (
        pythonNativeFlagPrelude +
        `subprocess.run(${JSON.stringify(command)},shell=(${flag}),check=True)`
      )
    }
    const approve = vi.fn(async () => false)
    service.setExecutionApproval(approve)
    await service.execute({ ...request, code: code(false) })
    expect((await execute.mock.results[0].value).stdout).toContain('test')
    expect(approve).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(1)
    await expect(service.execute({ ...request, code: code(true) })).rejects.toThrow(
      'one-time approval'
    )
    expect(execute).toHaveBeenCalledTimes(1)
    expect(await readFile(target, 'utf8')).toBe('test')
    approve.mockResolvedValueOnce(true)
    await service.execute({ ...request, code: code(true) })
    expect(execute).toHaveBeenCalledTimes(2)
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(target, 'next run')
    await expect(service.execute({ ...request, code: code(true) })).rejects.toThrow(
      'one-time approval'
    )
    expect(approve).toHaveBeenCalledTimes(3)
    expect(execute).toHaveBeenCalledTimes(2)
    expect(await readFile(target, 'utf8')).toBe('next run')
    expect(await readFile(keep, 'utf8')).toBe('keep')
  })
  it.skipIf(!process.env.OPEN_SCIENCE_RISK_PYTHON).each([
    ['Flag()', '__bool__', 'False'],
    ['Flag()', '__len__', '0'],
    ['[*Flag()]', '__iter__', 'iter(())'],
    ['{**Flag()}', 'keys', '[]'],
    ['not {Flag()}', '__hash__', '0'],
    ['not {Flag():False}', '__hash__', '0'],
    ['f"{Flag()}"', '__format__', '""'],
    ['[] if Flag() else []', '__bool__', 'False'],
    ['bool(Flag())', '__bool__', 'False'],
    ['int(Flag())', '__int__', '0'],
    ['len(Flag())', '__len__', '0'],
    ['bool(len(Flag()))', '__len__', '0'],
    ['not bool(Flag())', '__bool__', 'True'],
    ['int(bool(Flag()))', '__bool__', 'False'],
    ['not len({Flag():0})', '__hash__', '0'],
    ['bool(f"{Flag()}")', '__format__', '""'],
    ['not bool([Flag()])', '__init__', 'None'],
    ['not len([Flag()])', '__init__', 'None'],
    ['not bool(tuple([Flag()]))', '__init__', 'None'],
    ['not len(list([Flag()]))', '__init__', 'None'],
    ['not bool([*tuple([Flag()])])', '__init__', 'None'],
    ['bool([Flag()][:0])', '__init__', 'None'],
    ['len(list([Flag()])[:0])', '__init__', 'None'],
    ['bool([Flag()]) and False', '__init__', 'None']
  ])('gates real Python option construction hook=%s once', async (flag, hook, result) => {
    const { service, execute, request } = await harness()
    const target = join(request.workspaceCwd, 'hook-target.txt')
    const keep = join(request.workspaceCwd, 'keep.txt')
    await writeFile(target, 'test')
    await writeFile(keep, 'keep')
    execute.mockImplementation(async (execution) => {
      const { stdout, stderr } = await promisify(execFile)(
        process.env.OPEN_SCIENCE_RISK_PYTHON!,
        ['-c', execution.code],
        { cwd: execution.cwd, timeout: 5000 }
      )
      return {
        status: 'completed',
        stdout,
        stderr,
        traceback: '',
        cwdAfter: execution.cwd,
        outputs: [],
        kernelDispatched: true
      }
    })
    const argv = `[${JSON.stringify(process.env.OPEN_SCIENCE_RISK_PYTHON)},"--version"]`
    const code = (danger: boolean): string =>
      danger
        ? `import os,subprocess
class Flag:
    def ${hook}(self${hook === '__format__' ? ',spec' : ''}):
        if os.path.isfile(${JSON.stringify(target)}):
            os.unlink(${JSON.stringify(target)})
        return ${result}
    def __getitem__(self,key):
        return 0
subprocess.run(${argv},shell=(${flag}),check=True)`
        : `import subprocess;subprocess.run(${argv},shell=[],check=True)`
    const approve = vi.fn(async () => false)
    service.setExecutionApproval(approve)
    await service.execute({ ...request, code: code(false) })
    expect((await execute.mock.results[0].value).stdout).toContain('Python')
    expect(approve).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(1)
    await expect(service.execute({ ...request, code: code(true) })).rejects.toThrow(
      'one-time approval'
    )
    expect(execute).toHaveBeenCalledTimes(1)
    expect(await readFile(target, 'utf8')).toBe('test')
    approve.mockResolvedValueOnce(true)
    await service.execute({ ...request, code: code(true) })
    expect(execute).toHaveBeenCalledTimes(2)
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(target, 'next run')
    await expect(service.execute({ ...request, code: code(true) })).rejects.toThrow(
      'one-time approval'
    )
    expect(approve).toHaveBeenCalledTimes(3)
    expect(execute).toHaveBeenCalledTimes(2)
    expect(await readFile(target, 'utf8')).toBe('next run')
    expect(await readFile(keep, 'utf8')).toBe('keep')
  })

  it.skipIf(!process.env.OPEN_SCIENCE_RISK_PYTHON).each(
    [
      '""',
      "''",
      'r""',
      'b""',
      'f""',
      '"" ""',
      '""+""',
      '[]',
      '()',
      '{}',
      '[*[]]',
      '(*(),)',
      '[*([]+[])]',
      '[]+[]',
      '()+()',
      '{**{}}',
      '{}|{}',
      '{**({}|{})}',
      'not "False"',
      'not b"False"',
      'not [False]',
      'not (False,)',
      'not {0}',
      'not {"flag":False}',
      'not [None,0,""]',
      '"x" and ""',
      '[] or ()',
      'None or ""',
      '"" if [1] else "x"',
      'not not []',
      ...pythonNativeFalseFlags
    ]
      .map((flag, index) => [
        `shell=(${flag})`,
        ['run', 'call', 'check_call', 'check_output', 'Popen'][index % 5]
      ])
      .concat(
        pythonNativeKeywordForms.map((form, index) => [
          `**(${form})`,
          ['run', 'call', 'check_call', 'check_output', 'Popen'][index % 5]
        ]),
        [
          ['**dict(check=True)', 'run'],
          ['**dict(stdout=subprocess.PIPE,check=True)', 'run']
        ]
      )
  )('gates real Python closed false shell flag=%s method=%s once', async (flag, method) => {
    const { service, execute, request } = await harness()
    const target = join(request.workspaceCwd, 'truth-target.txt')
    const keep = join(request.workspaceCwd, 'keep.txt')
    await writeFile(target, 'test')
    await writeFile(keep, 'keep')
    execute.mockImplementation(async (execution) => {
      const { stdout, stderr } = await promisify(execFile)(
        process.env.OPEN_SCIENCE_RISK_PYTHON!,
        ['-c', execution.code],
        { cwd: execution.cwd, timeout: 5000 }
      )
      return {
        status: 'completed',
        stdout,
        stderr,
        traceback: '',
        cwdAfter: execution.cwd,
        outputs: [],
        kernelDispatched: true
      }
    })
    const program = JSON.stringify(process.env.OPEN_SCIENCE_RISK_PYTHON)
    const code = (danger: boolean): string => {
      const argv = danger
        ? `[${program},"-c",${JSON.stringify(`import os;os.unlink(${JSON.stringify(target)})`)}]`
        : `[${program},"--version"]`
      return (
        pythonNativeFlagPrelude +
        'from builtins import dict as D\n' +
        `print(subprocess.${method}(${argv},${flag}${method === 'run' && !flag.startsWith('**') ? ',check=True' : ''})${method === 'Popen' ? '.wait()' : ''})`
      )
    }
    const approve = vi.fn(async () => false)
    service.setExecutionApproval(approve)
    await service.execute({ ...request, code: code(false) })
    const output = await execute.mock.results[0].value
    expect(output.stdout + output.stderr).toContain('Python')
    expect(approve).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(1)
    await expect(service.execute({ ...request, code: code(true) })).rejects.toThrow(
      'one-time approval'
    )
    expect(execute).toHaveBeenCalledTimes(1)
    expect(await readFile(target, 'utf8')).toBe('test')
    approve.mockResolvedValueOnce(true)
    await service.execute({ ...request, code: code(true) })
    expect(execute).toHaveBeenCalledTimes(2)
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(target, 'next run')
    await expect(service.execute({ ...request, code: code(true) })).rejects.toThrow(
      'one-time approval'
    )
    expect(approve).toHaveBeenCalledTimes(3)
    expect(execute).toHaveBeenCalledTimes(2)
    expect(await readFile(target, 'utf8')).toBe('next run')
    expect(await readFile(keep, 'utf8')).toBe('keep')
  })

  it
    .skipIf(!process.env.OPEN_SCIENCE_RISK_PYTHON)
    .each([
      'functools.partial(METHOD,PATH)()',
      'saved=functools.partial(METHOD,PATH);saved()',
      'functools.partial(functools.partial(METHOD),PATH)()',
      'functools.partial(METHOD).__call__(PATH)',
      'functools.partial(METHOD,PATH).func(PATH)',
      'getattr(functools.partial(METHOD,PATH),"func")(PATH)',
      'saved=functools.partial(METHOD,PATH).func;saved(PATH)',
      'list(map(functools.partial(METHOD),[PATH]))',
      'sorted([PATH],key=functools.partial(METHOD))',
      'operator.call(functools.partial,METHOD,PATH)()',
      'operator.call(functools.partial(METHOD),PATH)',
      'functools.partial(*(METHOD,PATH))()',
      'fn=METHOD;saved=functools.partial(fn,((fn:=OTHER),PATH)[1]);saved()'
    ])('gates real Python partial read/delete form=%s once', async (template) => {
    const { service, execute, request } = await harness()
    const target = join(request.workspaceCwd, 'partial-target.txt')
    const keep = join(request.workspaceCwd, 'keep.txt')
    await writeFile(target, 'test')
    await writeFile(keep, 'keep')
    execute.mockImplementation(async (execution) => {
      const { stdout, stderr } = await promisify(execFile)(
        process.env.OPEN_SCIENCE_RISK_PYTHON!,
        ['-c', execution.code],
        { cwd: execution.cwd, timeout: 5000 }
      )
      return {
        status: 'completed',
        stdout,
        stderr,
        traceback: '',
        cwdAfter: execution.cwd,
        outputs: [],
        kernelDispatched: true
      }
    })
    const code = (danger: boolean): string => {
      const statements = template
        .replaceAll('METHOD', danger ? 'os.unlink' : 'pathlib.Path.read_text')
        .replaceAll('OTHER', danger ? 'str' : 'os.unlink')
        .replaceAll('PATH', `pathlib.Path(${JSON.stringify(target)})`)
        .split(';')
      const expression = statements.pop()!
      return ['import functools,operator,os,pathlib', ...statements, `print(${expression})`].join(
        ';'
      )
    }
    const approve = vi.fn(async () => false)
    service.setExecutionApproval(approve)
    await service.execute({ ...request, code: code(false) })
    expect((await execute.mock.results[0].value).stdout).toContain(
      template.startsWith('sorted') ? 'partial-target.txt' : 'test'
    )
    expect(approve).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(1)
    await expect(service.execute({ ...request, code: code(true) })).rejects.toThrow(
      'one-time approval'
    )
    expect(execute).toHaveBeenCalledTimes(1)
    expect(await readFile(target, 'utf8')).toBe('test')
    approve.mockResolvedValueOnce(true)
    await service.execute({ ...request, code: code(true) })
    expect(execute).toHaveBeenCalledTimes(2)
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(target, 'next run')
    await expect(service.execute({ ...request, code: code(true) })).rejects.toThrow(
      'one-time approval'
    )
    expect(approve).toHaveBeenCalledTimes(3)
    expect(execute).toHaveBeenCalledTimes(2)
    expect(await readFile(target, 'utf8')).toBe('next run')
    expect(await readFile(keep, 'utf8')).toBe('keep')
  })

  it.each([
    ['arrow', 'const handlers={cleanup:()=>{OP}};', 'handlers.cleanup'],
    ['function', 'const handlers={cleanup:function(){OP}};', 'handlers.cleanup'],
    ['named function', 'const handlers={cleanup:function action(){OP}};', 'handlers.cleanup'],
    ['parenthesized arrow', 'const handlers={cleanup:(()=>{OP})};', 'handlers.cleanup'],
    ['shorthand', 'function cleanup(){OP};const handlers={cleanup};', 'handlers.cleanup'],
    ['direct reference', 'const handlers={cleanup:fs.METHOD};', 'handlers.cleanup'],
    ['nested reference', 'const handlers={nested:{cleanup:fs.METHOD}};', 'handlers.nested.cleanup'],
    ['saved alias', 'const handlers={cleanup:()=>{OP}};const saved=handlers.cleanup;', 'saved'],
    ['destructuring', 'const handlers={cleanup:()=>{OP}};const {cleanup:saved}=handlers;', 'saved'],
    [
      'forwarded reference',
      'const handlers={cleanup:fs.METHOD};',
      'handlers.cleanup.call.bind(handlers.cleanup,null)'
    ],
    [
      'different bound receiver',
      'const handlers={read:console.log,cleanup:fs.METHOD};',
      'handlers.read.call.bind(handlers.cleanup,null)'
    ],
    [
      'aliased forwarder',
      'const handlers={cleanup:fs.METHOD};const forward=handlers.cleanup.call;const saved=forward.bind(handlers.cleanup,null);',
      'saved'
    ],
    [
      'replaced method',
      'const handlers={cleanup(){fs.unlinkSync("target.txt")},cleanup:()=>{OP}};',
      'handlers.cleanup'
    ],
    [
      'replaced reference',
      'const handlers={cleanup(){fs.unlinkSync("target.txt")},cleanup:fs.METHOD};',
      'handlers.cleanup'
    ],
    [
      'bound variable capture',
      'let fn=fs.METHOD;const handlers={cleanup:fn.bind(null,(fn=fs.OTHER,"target.txt"),"utf8")};',
      'handlers.cleanup'
    ],
    [
      'bound member capture',
      'let object={run:fs.METHOD};const handlers={cleanup:object.run.bind(null,(object.run=fs.OTHER,"target.txt"),"utf8")};',
      'handlers.cleanup'
    ],
    [
      'bound forwarding receiver capture',
      'let fn=fs.METHOD;const handlers={cleanup:Function.prototype.call.bind(fn,(fn=fs.OTHER,null))};',
      'handlers.cleanup'
    ],
    [
      'reflected object capture',
      'let object={run:fs.METHOD};const handlers={cleanup:Reflect.get(object,"run",(object={run:fs.OTHER}))};',
      'handlers.cleanup'
    ],
    [
      'called reflected object capture',
      'let object={run:fs.METHOD};const handlers={cleanup:Reflect.get.call(null,object,"run",(object={run:fs.OTHER}))};',
      'handlers.cleanup'
    ],
    [
      'applied reflected object capture',
      'let object={run:fs.METHOD};const handlers={cleanup:Reflect.get.apply(null,[object,"run",(object={run:fs.OTHER})])};',
      'handlers.cleanup'
    ],
    [
      'forwarded reflected object capture',
      'let object={run:fs.METHOD};const handlers={cleanup:Reflect.apply(Reflect.get,null,[object,"run",(object={run:fs.OTHER})])};',
      'handlers.cleanup'
    ],
    [
      'bound reflected object capture',
      'let object={run:fs.METHOD};const handlers={cleanup:Reflect.get.bind(null)(object,"run",(object={run:fs.OTHER}))};',
      'handlers.cleanup'
    ],
    [
      'reflected lookup capture',
      'let lookup=Reflect.get;const handlers={cleanup:lookup(fs,"METHOD",(lookup=()=>fs.OTHER))};',
      'handlers.cleanup'
    ],
    [
      'reflected property update',
      'const object={run:fs.OTHER};const handlers={cleanup:Reflect.get(object,"run",(object.run=fs.METHOD,object))};',
      'handlers.cleanup'
    ],
    [
      'reflected bound member capture',
      'const object={run:fs.METHOD};const handlers={cleanup:Reflect.get(object,"run").bind(null,(object.run=fs.OTHER,"target.txt"),"utf8")};',
      'handlers.cleanup'
    ],
    [
      'reflected callback capture',
      'let object={run:()=>{OP}};const handlers={};',
      '(() => ["target.txt"].map(Reflect.get(object,"run",(object={run:fs.OTHER})))[0])'
    ],
    ['parenthesized binding', 'const handlers={};', '(fs.METHOD.bind)(null)'],
    ['computed parenthesized binding', 'const handlers={};', '(fs.METHOD["bind"])(null)'],
    ['called binding', 'const handlers={};', 'Function.prototype.bind.call(fs.METHOD,null)'],
    ['applied binding', 'const handlers={};', 'Function.prototype.bind.apply(fs.METHOD,[null])'],
    [
      'reflected binding',
      'const handlers={};',
      'Reflect.apply(Function.prototype.bind,fs.METHOD,[null])'
    ],
    [
      'nested reflected binding',
      'const handlers={};',
      'Reflect.apply(Reflect.apply,null,[Function.prototype.bind,fs.METHOD,[null]])'
    ],
    [
      'saved binding helper',
      'const handlers={};const bind=Function.prototype.bind;',
      'bind.call(fs.METHOD,null)'
    ],
    [
      'destructured binding helper',
      'const handlers={};const {bind}=Function.prototype;',
      'bind.apply(fs.METHOD,[null])'
    ],
    [
      'different binding helper receiver',
      'const handlers={};',
      'fs.OTHER.bind.call(fs.METHOD,null)'
    ],
    [
      'called binding receiver capture',
      'const handlers={};let fn=fs.METHOD;',
      'Function.prototype.bind.call(fn,(fn=fs.OTHER,null))'
    ],
    [
      'applied binding receiver capture',
      'const handlers={};let fn=fs.METHOD;',
      'Function.prototype.bind.apply(fn,[(fn=fs.OTHER,null)])'
    ],
    [
      'reflected binding receiver capture',
      'const handlers={};let fn=fs.METHOD;',
      'Reflect.apply(Function.prototype.bind,fn,[(fn=fs.OTHER,null)])'
    ],
    [
      'bound apply forwarding',
      'const handlers={};',
      '(() => Function.prototype.apply.bind(fs.METHOD,null)(["target.txt","utf8"]))'
    ],
    [
      'reflected bound apply forwarding',
      'const handlers={};',
      '(() => Reflect.apply(Function.prototype.bind,Function.prototype.apply,[fs.METHOD,null])(["target.txt","utf8"]))'
    ],
    [
      'reflected bound call forwarding',
      'const handlers={};',
      'Reflect.apply(Function.prototype.bind,Function.prototype.call,[fs.METHOD,null])'
    ],
    [
      'nested called reader',
      'const handlers={};',
      '(() => Function.prototype.call.call(fs.METHOD,null,"target.txt","utf8"))'
    ],
    [
      'nested applied reader',
      'const handlers={};',
      '(() => Function.prototype.apply.call(fs.METHOD,null,["target.txt","utf8"]))'
    ],
    [
      'reflected call reader',
      'const handlers={};',
      '(() => Reflect.apply(Function.prototype.call,fs.METHOD,[null,"target.txt","utf8"]))'
    ],
    [
      'reflected apply reader',
      'const handlers={};',
      '(() => Reflect.apply(Function.prototype.apply,fs.METHOD,[null,["target.txt","utf8"]]))'
    ],
    [
      'different nested helper receiver',
      'const handlers={};',
      '(() => fs.OTHER.call.call(fs.METHOD,null,"target.txt","utf8"))'
    ],
    [
      'saved nested apply helper',
      'const handlers={};const invoke=Function.prototype.apply;',
      '(() => Reflect.apply(invoke,fs.METHOD,[null,["target.txt","utf8"]]))'
    ],
    [
      'bound apply called alias',
      'const handlers={};const invoke=Function.prototype.apply.bind(fs.METHOD,null);',
      '(() => invoke.call(null,["target.txt","utf8"]))'
    ],
    [
      'bound apply rebound alias',
      'const handlers={};const invoke=Function.prototype.apply.bind(fs.METHOD,null);',
      '(() => invoke.bind(null)(["target.txt","utf8"]))'
    ],
    [
      'repeated apply callback',
      'const handlers={};const first=Function.prototype.apply.bind(fs.METHOD,null);const second=Function.prototype.apply.bind(first,null);',
      '(() => [[["target.txt","utf8"]]].map(second)[0])'
    ],
    ['immediate reference', 'const handlers={};', '({cleanup:fs.METHOD}).cleanup'],
    ['immediate computed', 'const handlers={};', '(({cleanup:fs.METHOD}))["cleanup"]'],
    ['immediate method', 'const handlers={};', '({cleanup(){OP}}).cleanup'],
    ['immediate arrow', 'const handlers={};', '({cleanup:()=>{OP}}).cleanup'],
    ['immediate function', 'const handlers={};', '({cleanup:function(){OP}}).cleanup'],
    ['reflected module', 'const handlers={};', 'Reflect.get(fs,"METHOD")'],
    ['qualified reflection', 'const handlers={};', 'globalThis.Reflect.get(fs,"METHOD")'],
    ['imported reflection', 'const handlers={};', 'Reflect.get(require("node:fs"),"METHOD")'],
    [
      'reflected immediate reference',
      'const handlers={};',
      'Reflect.get({cleanup:fs.METHOD},"cleanup")'
    ],
    ['reflected immediate method', 'const handlers={};', 'Reflect.get({cleanup(){OP}},"cleanup")'],
    [
      'reflected bound arrow',
      'const handlers={};',
      'Reflect.get({cleanup:()=>{OP}},"cleanup").bind(null)'
    ],
    ['reflection via call', 'const handlers={};', 'Reflect.get.call(null,fs,"METHOD")'],
    ['reflection via apply', 'const handlers={};', 'Reflect.get.apply(null,[fs,"METHOD"])'],
    [
      'reflection via Reflect.apply',
      'const handlers={};',
      'Reflect.apply(Reflect.get,null,[fs,"METHOD"])'
    ],
    ['reflection via bound lookup', 'const handlers={};', 'Reflect.get.bind(null)(fs,"METHOD")'],
    [
      'reflected nested reference',
      'const handlers={};',
      'Reflect.get({nested:{cleanup:fs.METHOD}},"nested").cleanup'
    ],
    ['reflected receiver', 'const handlers={};', 'Reflect.get(fs,"METHOD",{})'],
    [
      'saved reflected reference',
      'const handlers={cleanup:fs.METHOD};const saved=Reflect.get(handlers,"cleanup");',
      'saved'
    ],
    [
      'saved reflected lookup',
      'const handlers={cleanup:fs.METHOD};const lookup=Reflect.get;const saved=lookup(handlers,"cleanup");',
      'saved'
    ],
    [
      'captured callback',
      'const handlers={cleanup:()=>{OP}};',
      '(() => ["target.txt"].map(handlers.cleanup,(handlers.cleanup=()=>{},null))[0])'
    ],
    [
      'forwarded captured callback',
      'const handlers={cleanup:()=>{OP}};',
      '(() => Reflect.apply(Array.prototype.map,["target.txt"],[handlers.cleanup,(handlers.cleanup=()=>{},null)])[0])'
    ],
    [
      'called captured callback',
      'const handlers={cleanup:()=>{OP}};',
      '(() => Array.prototype.map.call(["target.txt"],handlers.cleanup,(handlers.cleanup=()=>{},null))[0])'
    ],
    [
      'earlier argument callback update',
      'const handlers={cleanup:()=>1};',
      '(() => Array.from((handlers.cleanup=()=>{OP},["target.txt"]),handlers.cleanup)[0])'
    ]
  ])(
    'runs real fixed property %s readers and gates deletion once',
    async (_label, template, callable) => {
      const { service, execute, request } = await harness()
      const target = join(request.workspaceCwd, 'target.txt')
      const keep = join(request.workspaceCwd, 'keep.txt')
      await writeFile(target, 'original')
      await writeFile(keep, 'keep')
      execute.mockImplementation(async (execution) => {
        const { stdout, stderr } = await promisify(execFile)(
          process.execPath,
          ['-e', execution.code],
          {
            cwd: execution.cwd,
            timeout: 10000
          }
        )
        return {
          status: 'completed',
          stdout,
          stderr,
          traceback: '',
          cwdAfter: execution.cwd,
          outputs: [],
          kernelDispatched: true
        }
      })
      const source = (danger: boolean, invoke: boolean): string =>
        (
          'const fs=require("fs");' +
          template +
          (invoke
            ? `console.log(${callable}("target.txt","utf8"))`
            : 'console.log(Object.keys(handlers))')
        )
          .replaceAll(
            'OP',
            danger ? 'fs.unlinkSync("target.txt")' : 'return fs.readFileSync("target.txt","utf8")'
          )
          .replaceAll('METHOD', danger ? 'unlinkSync' : 'readFileSync')
          .replaceAll('OTHER', danger ? 'readFileSync' : 'unlinkSync')
          .replaceAll('"target.txt"', JSON.stringify(target))
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      await service.executeControl({ ...request, code: source(true, false) })
      await service.executeControl({ ...request, code: source(false, true) })
      expect(approve).not.toHaveBeenCalled()
      expect(execute).toHaveBeenCalledTimes(2)
      expect((await execute.mock.results[1].value).stdout).toBe('original\n')
      expect(await readFile(target, 'utf8')).toBe('original')
      await service.executeControl({ ...request, code: source(true, true) })
      expect(approve).toHaveBeenCalledTimes(1)
      expect(execute).toHaveBeenCalledTimes(2)
      expect(await readFile(target, 'utf8')).toBe('original')
      approve.mockResolvedValueOnce(true)
      await service.executeControl({ ...request, code: source(true, true) })
      expect(execute).toHaveBeenCalledTimes(3)
      await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
      await writeFile(target, 'original')
      await service.executeControl({ ...request, code: source(true, true) })
      expect(approve).toHaveBeenCalledTimes(3)
      expect(execute).toHaveBeenCalledTimes(3)
      expect(await readFile(target, 'utf8')).toBe('original')
      expect(await readFile(keep, 'utf8')).toBe('keep')
    }
  )

  it.each(['direct', 'alias', 'destructured', 'coercion', 'reassigned'])(
    'admits passive object methods and gates real %s effects once',
    async (form) => {
      const { service, execute, request } = await harness()
      await writeFile(join(request.workspaceCwd, 'target.txt'), 'original')
      await writeFile(join(request.workspaceCwd, 'keep.txt'), 'keep')
      execute.mockImplementation(async (execution) => {
        const { stdout, stderr } = await promisify(execFile)(
          process.execPath,
          ['-e', execution.code],
          { cwd: request.workspaceCwd, timeout: 10000 }
        )
        return {
          status: 'completed',
          stdout,
          stderr,
          traceback: '',
          cwdAfter: request.workspaceCwd,
          outputs: [],
          kernelDispatched: true
        }
      })
      const definition =
        'const fs=require("fs"); const object={cleanup(){fs.unlinkSync("target.txt")}};'
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      await service.executeControl({
        ...request,
        code: definition + 'console.log(Object.keys(object))'
      })
      expect(approve).not.toHaveBeenCalled()
      expect(await readFile(join(request.workspaceCwd, 'target.txt'), 'utf8')).toBe('original')
      const effect =
        form === 'direct'
          ? 'object.cleanup()'
          : form === 'alias'
            ? 'const saved=object.cleanup;saved()'
            : form === 'destructured'
              ? 'const {cleanup}=object;cleanup()'
              : form === 'coercion'
                ? 'String({toString(){fs.unlinkSync("target.txt");return "value"}})'
                : 'object.cleanup=()=>fs.unlinkSync("target.txt");object.cleanup()'
      const code = definition + effect
      await service.executeControl({ ...request, code })
      expect(approve).toHaveBeenCalledTimes(1)
      expect(await readFile(join(request.workspaceCwd, 'target.txt'), 'utf8')).toBe('original')
      approve.mockResolvedValueOnce(true)
      await service.executeControl({ ...request, code })
      await expect(readFile(join(request.workspaceCwd, 'target.txt'))).rejects.toThrow()
      expect(await readFile(join(request.workspaceCwd, 'keep.txt'), 'utf8')).toBe('keep')
      await writeFile(join(request.workspaceCwd, 'target.txt'), 'original')
      await service.executeControl({ ...request, code })
      expect(approve).toHaveBeenCalledTimes(3)
      expect(await readFile(join(request.workspaceCwd, 'target.txt'), 'utf8')).toBe('original')
    }
  )

  for (const form of Array.from({ length: 13 }, (_, i) => i)) {
    const python = form < 4 || [7, 8, 11].includes(form)
    it.skipIf(process.platform === 'win32' || (python && !process.env.OPEN_SCIENCE_RISK_PYTHON))(
      `gates real effective process environment form=${form} once`,
      async () => {
        const { service, execute, request } = await harness()
        const target = join(request.workspaceCwd, 'target.txt')
        const keep = join(request.workspaceCwd, 'keep.txt')
        await writeFile(target, 'original')
        await writeFile(keep, 'keep')
        execute.mockImplementation(async (execution) => {
          const { stdout, stderr } = await promisify(execFile)(
            python ? process.env.OPEN_SCIENCE_RISK_PYTHON! : process.execPath,
            python ? ['-c', execution.code] : ['-e', execution.code],
            { cwd: request.workspaceCwd, timeout: 10000 }
          )
          return {
            status: 'completed',
            stdout,
            stderr,
            traceback: '',
            cwdAfter: request.workspaceCwd,
            outputs: [],
            kernelDispatched: true
          }
        })
        const code = (danger: boolean): string => {
          const key = '"PYTHONIOENCODING"'
          let first = danger
            ? python
              ? 'os.unlink("target.txt")'
              : 'require("fs").unlinkSync("target.txt")'
            : '"custom-codec"'
          let prelude = python ? 'import os,subprocess\n' : ''
          let env = ''
          if (form === 7) {
            prelude +=
              'class Value:\n    def __str__(self):\n        os.unlink("target.txt")\n        return "custom-codec"\n'
            first = danger ? 'str(Value())' : '"custom-codec"'
          }
          if (form === 8) {
            prelude +=
              'class Mapping:\n    def keys(self):\n        os.unlink("target.txt")\n        return ["PYTHONIOENCODING"]\n    def __getitem__(self,key):\n        return "custom-codec"\n'
            env = danger
              ? `{**Mapping(),${key}:"utf-8"}`
              : `{**{${key}:"custom-codec"},${key}:"utf-8"}`
          }
          if (form === 9)
            env = danger
              ? '{...{get PYTHONIOENCODING(){require("fs").unlinkSync("target.txt");return "custom-codec"}},PYTHONIOENCODING:"utf-8"}'
              : '{...{PYTHONIOENCODING:"custom-codec"},PYTHONIOENCODING:"utf-8"}'
          if (form === 10) {
            prelude = danger
              ? 'const value={toString(){require("fs").unlinkSync("target.txt");return "custom-codec"}};'
              : ''
            first = danger ? 'String(value)' : '"custom-codec"'
          }
          if (form === 11) {
            prelude += 'def value():\n    os.unlink("target.txt")\n    return "custom-codec"\n'
            first = danger ? 'value()' : '"custom-codec"'
          }
          if (form === 12) {
            prelude =
              'function value(){require("fs").unlinkSync("target.txt");return {PYTHONIOENCODING:"custom-codec"}};'
            env = danger
              ? '{...value(),PYTHONIOENCODING:"utf-8"}'
              : '{...{PYTHONIOENCODING:"custom-codec"},PYTHONIOENCODING:"utf-8"}'
          }
          if (!env) {
            const a = `${key}:${first}`,
              b = `${key}:"utf-8"`
            if (form === 1) env = `{**{${a}},**{${b}}}`
            else if (form === 2) env = `{${a}}|{${b}}`
            else if (form === 3) env = `{**({${a}}|{}),**({}|{${b}})}`
            else if (form === 5) env = `{...{${a}},...{${b}}}`
            else if (form === 6) env = `{...({...{${a}}}),...{...{${b}}}}`
            else env = `{${a},${b}}`
          }
          return (
            prelude +
            (python
              ? `print(subprocess.run(["env"],env=${env},capture_output=True,text=True,check=True).stdout)`
              : `console.log(require("child_process").execFileSync("env",[],{env:${env},encoding:"utf8"}))`)
          )
        }
        const run = async (source: string): Promise<unknown> =>
          python
            ? service.execute({ ...request, language: 'python', code: source })
            : service.executeControl({ ...request, code: source })
        const approve = vi.fn(async () => false)
        service.setExecutionApproval(approve)
        await run(code(false))
        expect(approve).not.toHaveBeenCalled()
        expect(execute).toHaveBeenCalledTimes(1)
        expect((await execute.mock.results[0].value).stdout).toContain('PYTHONIOENCODING=utf-8')
        if (python) await expect(run(code(true))).rejects.toThrow('one-time approval')
        else await run(code(true))
        expect(execute).toHaveBeenCalledTimes(1)
        expect(await readFile(target, 'utf8')).toBe('original')
        approve.mockResolvedValueOnce(true)
        await run(code(true))
        expect(execute).toHaveBeenCalledTimes(2)
        await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
        await writeFile(target, 'next run')
        if (python) await expect(run(code(true))).rejects.toThrow('one-time approval')
        else await run(code(true))
        expect(approve).toHaveBeenCalledTimes(3)
        expect(execute).toHaveBeenCalledTimes(2)
        expect(await readFile(target, 'utf8')).toBe('next run')
        expect(await readFile(keep, 'utf8')).toBe('keep')
      }
    )
  }

  it.skipIf(process.platform === 'win32').each(Array.from({ length: 20 }, (_, i) => i))(
    'gates real JavaScript process option spreads form=%s once',
    async (form) => {
      const { service, execute, request } = await harness()
      const target = join(request.workspaceCwd, 'target.txt')
      const keep = join(request.workspaceCwd, 'keep.txt')
      await writeFile(target, 'original')
      await writeFile(keep, 'keep')
      execute.mockImplementation(async (execution) => {
        const { stdout, stderr } = await promisify(execFile)(
          process.execPath,
          ['-e', execution.code],
          { cwd: request.workspaceCwd, timeout: 10000 }
        )
        return {
          status: 'completed',
          stdout,
          stderr,
          traceback: '',
          cwdAfter: request.workspaceCwd,
          outputs: [],
          kernelDispatched: true
        }
      })
      const wrap = (options: string): string => {
        switch (form % 5) {
          case 0:
            return `{...{${options}}}`
          case 1:
            return `{...({${options}})}`
          case 2:
            return `{...{},...{...{${options}}},encoding:"utf8"}`
          case 3:
            return `{cwd:".",...{...({${options}})},...{encoding:"utf8"}}`
          default:
            return `{...{${options}},...{}}`
        }
      }
      const code = (danger: boolean): string => {
        const api = form % 2 === 0 ? 'execFileSync' : 'spawnSync'
        const options = wrap('shell:false,encoding:"utf8",env:{...{NO_COLOR:"1"}}')
        if (form < 5) {
          const call = `require("child_process").${api}("${danger ? 'rm' : 'cat'}",["target.txt"],${options})`
          return `console.log(${call}${api === 'spawnSync' ? '.stdout' : ''})`
        }
        if (form < 10)
          return `console.log(require("child_process").execSync("${danger ? 'rm target.txt' : 'cat target.txt'}",${wrap('encoding:"utf8"')}))`
        if (form >= 16) {
          const merged = `{...${wrap('shell:true,env:{LD_PRELOAD:"module"}')},...{shell:${danger},env:{NO_COLOR:"1"},encoding:"utf8"}}`
          return `console.log(require("child_process").execFileSync("echo",["original; rm target.txt"],${merged}))`
        }
        const field = form < 14 ? 'shell' : 'env'
        const value = field === 'shell' ? 'false' : '{NO_COLOR:"1"}'
        const entries = danger
          ? `get ${field}(){require("fs").unlinkSync("target.txt");return ${value}}`
          : `${field}:${value}`
        const wrapped = wrap(entries)
        // Copying invokes getters even if an explicit later field replaces their values.
        const merged = `{...${wrapped},shell:false,env:{NO_COLOR:"1"},encoding:"utf8"}`
        const call = `require("child_process").${api}("echo",["original"],${merged})`
        return `console.log(${call}${api === 'spawnSync' ? '.stdout' : ''})`
      }
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      await service.executeControl({ ...request, code: code(false) })
      expect(approve).not.toHaveBeenCalled()
      expect(execute).toHaveBeenCalledTimes(1)
      expect((await execute.mock.results[0].value).stdout).toContain('original')
      await service.executeControl({ ...request, code: code(true) })
      expect(execute).toHaveBeenCalledTimes(1)
      expect(await readFile(target, 'utf8')).toBe('original')
      approve.mockResolvedValueOnce(true)
      await service.executeControl({ ...request, code: code(true) })
      expect(execute).toHaveBeenCalledTimes(2)
      await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      await writeFile(target, 'next run')
      await service.executeControl({ ...request, code: code(true) })
      expect(approve).toHaveBeenCalledTimes(3)
      expect(execute).toHaveBeenCalledTimes(2)
      expect(await readFile(target, 'utf8')).toBe('next run')
      expect(await readFile(keep, 'utf8')).toBe('keep')
    }
  )

  it.skipIf(process.platform === 'win32').each(Array.from({ length: 16 }, (_, i) => i))(
    'gates real JavaScript fixed text construction form=%s once',
    async (form) => {
      const { service, execute, request } = await harness()
      const target = join(request.workspaceCwd, 'target.txt')
      const keep = join(request.workspaceCwd, 'keep.txt')
      await writeFile(target, 'original')
      await writeFile(keep, 'keep')
      execute.mockImplementation(async (execution) => {
        const { stdout, stderr } = await promisify(execFile)(
          process.execPath,
          ['-e', execution.code],
          { cwd: request.workspaceCwd, timeout: 10000 }
        )
        return {
          status: 'completed',
          stdout,
          stderr,
          traceback: '',
          cwdAfter: execution.cwd,
          outputs: [],
          kernelDispatched: true
        }
      })
      const joinText = (a: string, b: string): string => {
        if (form % 3 === 0) return `${JSON.stringify(a)}+${JSON.stringify(b)}`
        if (form % 3 === 1) return `(${JSON.stringify(a)})+(${JSON.stringify(b)}+"")`
        return `\`${a}\`+${JSON.stringify(b)}`
      }
      const code = (danger: boolean): string => {
        if (form < 6)
          return `const fs=require("node:fs");console.log(fs[${joinText(danger ? 'un' : 'read', danger ? 'linkSync' : 'FileSync')}]("target.txt"${danger ? '' : ',"utf8"'}))`
        if (form < 10) {
          const api = form % 2 === 0 ? 'execFileSync' : 'spawnSync'
          const call = `require("child_process").${api}(${joinText(danger ? 'r' : 'ca', danger ? 'm' : 't')},[${joinText('target', '.txt')}],{encoding:"utf8"})`
          return `console.log(${call}${api === 'spawnSync' ? '.stdout' : ''})`
        }
        if (form < 12)
          return `console.log(require("child_process").execSync(${joinText(danger ? 'r' : 'ca', danger ? 'm target.txt' : 't target.txt')},{encoding:"utf8"}))`
        if (form >= 14) {
          return `console.log(require("child_process").execFileSync("echo",["original; rm target.txt"],{[${joinText('sh', 'ell')}]:${danger},env:{[${joinText('NO_', 'COLOR')}]:${joinText('1', '')}},encoding:"utf8"}))`
        }
        const hook = form === 12 ? 'toString' : '[Symbol.toPrimitive]'
        return danger
          ? `const payload={${hook}(){require("fs").unlinkSync("target.txt");return "original"}};console.log(require("child_process").execSync("echo "+payload,{encoding:"utf8"}))`
          : `console.log(require("child_process").execSync(${joinText('echo ', 'original')},{encoding:"utf8"}))`
      }
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      await service.executeControl({ ...request, code: code(false) })
      expect(approve).not.toHaveBeenCalled()
      expect(execute).toHaveBeenCalledTimes(1)
      expect((await execute.mock.results[0].value).stdout).toContain('original')
      await service.executeControl({ ...request, code: code(true) })
      expect(execute).toHaveBeenCalledTimes(1)
      expect(await readFile(target, 'utf8')).toBe('original')
      approve.mockResolvedValueOnce(true)
      await service.executeControl({ ...request, code: code(true) })
      expect(execute).toHaveBeenCalledTimes(2)
      await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      await writeFile(target, 'next run')
      await service.executeControl({ ...request, code: code(true) })
      expect(approve).toHaveBeenCalledTimes(3)
      expect(execute).toHaveBeenCalledTimes(2)
      expect(await readFile(target, 'utf8')).toBe('next run')
      expect(await readFile(keep, 'utf8')).toBe('keep')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'gates real archive extraction overwrite once',
    async () => {
      const { service, execute, request } = await harness()
      const target = join(request.workspaceCwd, 'archive-input.txt')
      const archive = join(request.workspaceCwd, 'input.tar')
      const keep = join(request.workspaceCwd, 'keep.txt')
      await writeFile(target, 'archived data')
      await writeFile(keep, 'keep')
      await promisify(execFile)(
        'tar',
        ['-cf', archive, '-C', request.workspaceCwd, 'archive-input.txt'],
        { timeout: 5000 }
      )
      await writeFile(target, 'original')
      execute.mockImplementation(async (execution) => {
        const { stdout, stderr } = await promisify(execFile)(
          process.execPath,
          ['-e', execution.code],
          {
            cwd: execution.cwd,
            timeout: 5000
          }
        )
        return {
          status: 'completed',
          stdout,
          stderr,
          traceback: '',
          cwdAfter: execution.cwd,
          outputs: [],
          kernelDispatched: true
        }
      })
      const code = (danger: boolean): string =>
        `console.log(require("node:child_process").execFileSync("tar",${JSON.stringify([danger ? '-xf' : '-tf', archive, '-C', request.workspaceCwd])},{encoding:"utf8"}))`
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      await service.executeControl({ ...request, code: code(false) })
      expect(approve).not.toHaveBeenCalled()
      expect(execute).toHaveBeenCalledTimes(1)
      expect((await execute.mock.results[0].value).stdout).toContain('archive-input.txt')
      await service.executeControl({ ...request, code: code(true) })
      expect(execute).toHaveBeenCalledTimes(1)
      expect(await readFile(target, 'utf8')).toBe('original')
      approve.mockResolvedValueOnce(true)
      await service.executeControl({ ...request, code: code(true) })
      expect(execute).toHaveBeenCalledTimes(2)
      expect(await readFile(target, 'utf8')).toBe('archived data')
      await writeFile(target, 'next run')
      await service.executeControl({ ...request, code: code(true) })
      expect(approve).toHaveBeenCalledTimes(3)
      expect(execute).toHaveBeenCalledTimes(2)
      expect(await readFile(target, 'utf8')).toBe('next run')
      expect(await readFile(keep, 'utf8')).toBe('keep')
    }
  )

  for (const [tool, extension] of [
    ['gzip', '.gz'],
    ['bzip2', '.bz2'],
    ['xz', '.xz']
  ]) {
    it.skipIf(process.platform === 'win32')(
      `gates real compression source removal once: ${tool}`,
      async (context) => {
        try {
          await promisify(execFile)(tool, ['--help'], { timeout: 5000 })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return context.skip()
          throw error
        }
        const { service, execute, request } = await harness()
        const input = join(request.workspaceCwd, 'compression-input.txt')
        const archive = input + extension
        const keep = join(request.workspaceCwd, 'keep.txt')
        await writeFile(input, 'data')
        await writeFile(keep, 'keep')
        execute.mockImplementation(async (execution) => {
          const { stdout, stderr } = await promisify(execFile)(
            process.execPath,
            ['-e', execution.code],
            {
              cwd: execution.cwd,
              env: { ...process.env, POSIXLY_CORRECT: '1' },
              timeout: 5000
            }
          )
          return {
            status: 'completed',
            stdout,
            stderr,
            traceback: '',
            cwdAfter: execution.cwd,
            outputs: [],
            kernelDispatched: true
          }
        })
        const code = (danger: boolean): string =>
          `console.log(require("node:child_process").execFileSync(${JSON.stringify(tool)},${JSON.stringify(danger ? [input] : ['-c', input])}).length)`
        const approve = vi.fn(async () => false)
        service.setExecutionApproval(approve)
        await service.executeControl({ ...request, code: code(false) })
        expect(approve).not.toHaveBeenCalled()
        expect(execute).toHaveBeenCalledTimes(1)
        expect(await readFile(input, 'utf8')).toBe('data')
        let safeExecutions = 1
        if (tool === 'bzip2') {
          const { stdout: compressed } = await promisify(execFile)(tool, ['-c', input], {
            encoding: 'buffer',
            timeout: 5000
          })
          for (const [index, flag] of [
            '-c',
            '-k',
            '-t',
            '-dc',
            '-dk',
            '--stdout',
            '--keep',
            '--test'
          ].entries()) {
            const inspect = ['-t', '-dc', '-dk', '--test'].includes(flag)
            const safeInput = join(
              request.workspaceCwd,
              `preserved-${index}${inspect ? '.bz2' : '.txt'}`
            )
            const content = inspect ? compressed : Buffer.from('data')
            await writeFile(safeInput, content)
            await service.executeControl({
              ...request,
              code: `console.log(require("node:child_process").execFileSync("bzip2",${JSON.stringify([safeInput, flag])}).length)`
            })
            safeExecutions++
            expect(approve).not.toHaveBeenCalled()
            expect(execute).toHaveBeenCalledTimes(safeExecutions)
            expect(await readFile(safeInput)).toEqual(content)
          }
        }
        await service.executeControl({ ...request, code: code(true) })
        expect(execute).toHaveBeenCalledTimes(safeExecutions)
        expect(await readFile(input, 'utf8')).toBe('data')
        approve.mockResolvedValueOnce(true)
        await service.executeControl({ ...request, code: code(true) })
        expect(execute).toHaveBeenCalledTimes(safeExecutions + 1)
        await expect(readFile(input)).rejects.toMatchObject({ code: 'ENOENT' })
        expect((await readFile(archive)).length).toBeGreaterThan(0)
        await writeFile(input, 'next run')
        await service.executeControl({ ...request, code: code(true) })
        expect(approve).toHaveBeenCalledTimes(3)
        expect(execute).toHaveBeenCalledTimes(safeExecutions + 1)
        expect(await readFile(input, 'utf8')).toBe('next run')
        expect(await readFile(keep, 'utf8')).toBe('keep')
      }
    )
  }
  it.skipIf(process.platform === 'win32')(
    'gates real synchronization deletion once',
    async (context) => {
      try {
        await promisify(execFile)('rsync', ['--version'])
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return context.skip()
        throw error
      }
      const { service, execute, request } = await harness()
      const src = join(request.workspaceCwd, 'src')
      const dst = join(request.workspaceCwd, 'dst')
      const extra = join(dst, 'extra.txt')
      const keep = join(request.workspaceCwd, 'keep.txt')
      await mkdir(src)
      await mkdir(dst)
      await writeFile(join(src, 'copy.txt'), 'data')
      await writeFile(extra, 'extra')
      await writeFile(keep, 'keep')
      execute.mockImplementation(async (execution) => {
        const { stdout, stderr } = await promisify(execFile)(
          process.execPath,
          ['-e', execution.code],
          {
            cwd: execution.cwd,
            timeout: 5000
          }
        )
        return {
          status: 'completed',
          stdout,
          stderr,
          traceback: '',
          cwdAfter: execution.cwd,
          outputs: [],
          kernelDispatched: true
        }
      })
      const code = (danger: boolean): string =>
        `require("node:child_process").execFileSync("rsync",${JSON.stringify(['-r', '--size-only', '--modify-window=2', '--delete', ...(danger ? [] : ['--dry-run']), src + '/', dst + '/'])})`
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      await service.executeControl({ ...request, code: code(false) })
      expect(approve).not.toHaveBeenCalled()
      expect(execute).toHaveBeenCalledTimes(1)
      expect(await readFile(extra, 'utf8')).toBe('extra')
      let safeExecutions = 1
      for (const flags of [
        ['--size-only'],
        ['--ignore-times'],
        ['-I'],
        ['--modify-window=2'],
        ['--modify-window', '2'],
        ['--checksum-seed=7'],
        ['--checksum-seed', '7']
      ]) {
        await service.executeControl({
          ...request,
          code: `require("node:child_process").execFileSync("rsync",${JSON.stringify(['-rn', '--delete', ...flags, src + '/', dst + '/'])})`
        })
        safeExecutions++
        expect(approve).not.toHaveBeenCalled()
        expect(execute).toHaveBeenCalledTimes(safeExecutions)
        expect(await readFile(extra, 'utf8')).toBe('extra')
        await expect(readFile(join(dst, 'copy.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
      }
      await service.executeControl({ ...request, code: code(true) })
      expect(execute).toHaveBeenCalledTimes(safeExecutions)
      expect(await readFile(extra, 'utf8')).toBe('extra')
      approve.mockResolvedValueOnce(true)
      await service.executeControl({ ...request, code: code(true) })
      expect(execute).toHaveBeenCalledTimes(safeExecutions + 1)
      await expect(readFile(extra)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(join(dst, 'copy.txt'), 'utf8')).toBe('data')
      await writeFile(extra, 'next run')
      await service.executeControl({ ...request, code: code(true) })
      expect(approve).toHaveBeenCalledTimes(3)
      expect(execute).toHaveBeenCalledTimes(safeExecutions + 1)
      expect(await readFile(extra, 'utf8')).toBe('next run')
      expect(await readFile(keep, 'utf8')).toBe('keep')
    }
  )

  it.skipIf(process.platform === 'win32').each([0, 1, 2])(
    'gates real dd input and overwrite form=%s once',
    async (form) => {
      const { service, execute, request } = await harness()
      const input = join(request.workspaceCwd, 'dd-input.txt')
      const target = join(request.workspaceCwd, 'dd-target.txt')
      const keep = join(request.workspaceCwd, 'keep.txt')
      await writeFile(input, 'data')
      await writeFile(target, 'original')
      await writeFile(keep, 'keep')
      execute.mockImplementation(async (execution) => {
        const { stdout, stderr } = await promisify(execFile)(
          process.execPath,
          ['-e', execution.code],
          {
            cwd: execution.cwd,
            timeout: 5000
          }
        )
        return {
          status: 'completed',
          stdout,
          stderr,
          traceback: '',
          cwdAfter: execution.cwd,
          outputs: [],
          kernelDispatched: true
        }
      })
      const code = (danger: boolean): string => {
        const argv = [`if=${input}`, 'bs=1', `count=${danger && form === 1 ? 0 : 2}`]
        if (danger) argv.push(`of=${target}`)
        if (form === 2) argv.push('conv=notrunc')
        return `console.log(require("node:child_process").execFileSync("dd",${JSON.stringify(argv)},{encoding:"utf8"}))`
      }
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      await service.executeControl({ ...request, code: code(false) })
      expect((await execute.mock.results[0].value).stdout).toContain('da')
      expect(approve).not.toHaveBeenCalled()
      expect(execute).toHaveBeenCalledTimes(1)
      await service.executeControl({ ...request, code: code(true) })
      expect(execute).toHaveBeenCalledTimes(1)
      expect(await readFile(target, 'utf8')).toBe('original')
      approve.mockResolvedValueOnce(true)
      await service.executeControl({ ...request, code: code(true) })
      expect(execute).toHaveBeenCalledTimes(2)
      expect(await readFile(target, 'utf8')).toBe(form === 1 ? '' : form === 2 ? 'daiginal' : 'da')
      await service.executeControl({ ...request, code: code(true) })
      expect(approve).toHaveBeenCalledTimes(3)
      expect(execute).toHaveBeenCalledTimes(2)
      expect(await readFile(input, 'utf8')).toBe('data')
      expect(await readFile(keep, 'utf8')).toBe('keep')
    }
  )
  it.skipIf(process.platform === 'win32').each([0, 1, 2])(
    'gates real xargs reader commands form=%s once',
    async (form) => {
      const { service, execute, request } = await harness()
      const target = join(request.workspaceCwd, 'xargs-target.txt')
      const keep = join(request.workspaceCwd, 'keep.txt')
      await writeFile(target, 'test')
      await writeFile(keep, 'keep')
      execute.mockImplementation(async (execution) => {
        const { stdout, stderr } = await promisify(execFile)(
          process.execPath,
          ['-e', execution.code],
          {
            cwd: execution.cwd,
            timeout: 5000
          }
        )
        return {
          status: 'completed',
          stdout,
          stderr,
          traceback: '',
          cwdAfter: execution.cwd,
          outputs: [],
          kernelDispatched: true
        }
      })
      const code = (danger: boolean): string => {
        const argv = form === 1 ? ['-I{}'] : form === 2 ? ['-0', '-n1'] : ['-0']
        argv.push(danger ? 'rm' : 'cat', '--')
        if (form === 1) argv.push('{}')
        return `console.log(require("node:child_process").execFileSync("xargs",${JSON.stringify(argv)},{encoding:"utf8",input:${JSON.stringify(target + (form === 1 ? '\n' : '\0'))}}))`
      }
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      await service.executeControl({ ...request, code: code(false) })
      expect((await execute.mock.results[0].value).stdout).toContain('test')
      expect(approve).not.toHaveBeenCalled()
      expect(execute).toHaveBeenCalledTimes(1)
      await service.executeControl({ ...request, code: code(true) })
      expect(execute).toHaveBeenCalledTimes(1)
      expect(await readFile(target, 'utf8')).toBe('test')
      approve.mockResolvedValueOnce(true)
      await service.executeControl({ ...request, code: code(true) })
      expect(execute).toHaveBeenCalledTimes(2)
      await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      await service.executeControl({ ...request, code: code(true) })
      expect(approve).toHaveBeenCalledTimes(3)
      expect(execute).toHaveBeenCalledTimes(2)
      expect(await readFile(keep, 'utf8')).toBe('keep')
    }
  )
  it.skipIf(process.platform === 'win32').each([0, 1, 2, 3])(
    'gates real find child commands form=%s once',
    async (form) => {
      const { service, execute, request } = await harness()
      const target = join(request.workspaceCwd, 'find-target.txt')
      const keep = join(request.workspaceCwd, 'keep.txt')
      await writeFile(target, 'test')
      await writeFile(keep, 'keep')
      execute.mockImplementation(async (execution) => {
        const { stdout, stderr } = await promisify(execFile)(
          process.execPath,
          ['-e', execution.code],
          {
            cwd: execution.cwd,
            timeout: 5000
          }
        )
        return {
          status: 'completed',
          stdout,
          stderr,
          traceback: '',
          cwdAfter: execution.cwd,
          outputs: [],
          kernelDispatched: true
        }
      })
      const code = (danger: boolean): string => {
        const argv = [
          request.workspaceCwd,
          '-type',
          'f',
          '-name',
          'find-target.txt',
          form < 2 ? '-exec' : '-execdir',
          danger ? 'rm' : 'cat',
          '{}',
          form % 2 ? '+' : ';'
        ]
        return `console.log(require("node:child_process").execFileSync("find",${JSON.stringify(argv)},{encoding:"utf8"}))`
      }
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      await service.executeControl({ ...request, code: code(false) })
      expect((await execute.mock.results[0].value).stdout).toContain('test')
      expect(approve).not.toHaveBeenCalled()
      expect(execute).toHaveBeenCalledTimes(1)
      await service.executeControl({ ...request, code: code(true) })
      expect(execute).toHaveBeenCalledTimes(1)
      expect(await readFile(target, 'utf8')).toBe('test')
      approve.mockResolvedValueOnce(true)
      await service.executeControl({ ...request, code: code(true) })
      expect(execute).toHaveBeenCalledTimes(2)
      await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      await service.executeControl({ ...request, code: code(true) })
      expect(approve).toHaveBeenCalledTimes(3)
      expect(execute).toHaveBeenCalledTimes(2)
      expect(await readFile(keep, 'utf8')).toBe('keep')
    }
  )
  it
    .skipIf(!process.env.OPEN_SCIENCE_RISK_PYTHON || process.platform === 'win32')
    .each([0, 1, 2, 3, 4, 5, 6])(
    'gates real persistent Python incomplete cell form=%s once',
    async (form) => {
      const { service, execute, request } = await harness()
      const target = join(request.workspaceCwd, 'incomplete-target.txt')
      const keep = join(request.workspaceCwd, 'keep.txt')
      await writeFile(target, 'test')
      await writeFile(keep, 'keep')
      const worker = spawn(
        process.env.OPEN_SCIENCE_RISK_PYTHON!,
        [
          '-u',
          '-c',
          `
import sys,json,io,contextlib,traceback
scope={}
for line in sys.stdin:
    output=io.StringIO()
    errors=io.StringIO()
    status="completed"
    stack=""
    try:
        with contextlib.redirect_stdout(output),contextlib.redirect_stderr(errors):
            exec(json.loads(line),scope)
    except BaseException:
        status="failed"
        stack=traceback.format_exc()
    print(json.dumps({"status":status,"stdout":output.getvalue(),"stderr":errors.getvalue(),"traceback":stack}),flush=True)
`
        ],
        { cwd: request.workspaceCwd }
      )
      const lines = createInterface({ input: worker.stdout })
      const diagnostics: string[] = []
      worker.stderr.on('data', (data) => diagnostics.push(String(data)))
      const failure = [
        'erase=1/0',
        '1/0\nerase=False',
        'erase=f"{1:invalid}"',
        'erase=os.unlink\n1/0\nerase=None',
        'raise RuntimeError("failed")\nerase=os.listdir',
        'import time\ntime.sleep(5)\nerase=os.listdir',
        'erase=os.unlink\nimport time\ntime.sleep(5)\nerase=os.listdir'
      ][form]
      let interrupt: ReturnType<typeof setTimeout> | undefined
      execute.mockImplementation(async (execution) => {
        type Reply = {
          status: 'completed' | 'failed'
          stdout: string
          stderr: string
          traceback: string
        }
        const reply = await new Promise<Reply>((resolve, reject) => {
          const fail = (error: Error): void => reject(error)
          const exited = (): void =>
            reject(new Error(diagnostics.join('') || 'Python worker exited'))
          worker.once('error', fail)
          worker.once('exit', exited)
          lines.once('line', (line) => {
            worker.off('error', fail)
            worker.off('exit', exited)
            try {
              resolve(JSON.parse(line) as Reply)
            } catch (error) {
              reject(error)
            }
          })
          worker.stdin.write(JSON.stringify(execution.code) + '\n')
          if (form >= 5 && execution.code === failure)
            interrupt = setTimeout(() => worker.kill('SIGINT'), 500)
        })
        return {
          ...reply,
          status: reply.traceback.includes('KeyboardInterrupt')
            ? form === 6
              ? 'cancelled'
              : 'timeout'
            : reply.status,
          cwdAfter: execution.cwd,
          outputs: [],
          kernelDispatched: true
        }
      })
      try {
        const approve = vi.fn(async () => false)
        service.setExecutionApproval(approve)
        await service.execute({
          ...request,
          code: 'import os\nerase=' + (form === 3 || form === 6 ? 'os.listdir' : 'os.unlink')
        })
        const failed = await service.execute({ ...request, code: failure })
        if (interrupt) clearTimeout(interrupt)
        expect(failed.status).toBe(form === 6 ? 'cancelled' : form === 5 ? 'timeout' : 'failed')
        expect(execute).toHaveBeenCalledTimes(2)
        expect(approve).not.toHaveBeenCalled()
        expect(await readFile(target, 'utf8')).toBe('test')
        const danger = `erase(${JSON.stringify(target)})`
        await expect(service.execute({ ...request, code: danger })).rejects.toThrow(
          'one-time approval'
        )
        expect(execute).toHaveBeenCalledTimes(2)
        expect(await readFile(target, 'utf8')).toBe('test')
        approve.mockResolvedValueOnce(true)
        await service.execute({ ...request, code: danger })
        expect(execute).toHaveBeenCalledTimes(3)
        await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
        await writeFile(target, 'next run')
        await expect(service.execute({ ...request, code: danger })).rejects.toThrow(
          'one-time approval'
        )
        expect(approve).toHaveBeenCalledTimes(3)
        expect(execute).toHaveBeenCalledTimes(3)
        expect(await readFile(target, 'utf8')).toBe('next run')
        await service.execute({ ...request, code: 'erase=os.listdir' })
        const result = await service.execute({ ...request, code: 'print(erase("."))' })
        expect(result.status).toBe('completed')
        expect(execute).toHaveBeenCalledTimes(5)
        expect((await execute.mock.results[4].value).stdout).toContain('incomplete-target.txt')
        expect(approve).toHaveBeenCalledTimes(3)
        expect(await readFile(target, 'utf8')).toBe('next run')
        expect(await readFile(keep, 'utf8')).toBe('keep')
      } finally {
        if (interrupt) clearTimeout(interrupt)
        lines.close()
        if (worker.exitCode === null && worker.signalCode === null) {
          const exited = once(worker, 'exit')
          worker.kill()
          await exited
        }
      }
    }
  )
  it
    .skipIf(!process.env.OPEN_SCIENCE_RISK_RSCRIPT || process.platform === 'win32')
    .each(Array.from({ length: 15 }, (_, i) => i))(
    'gates real R quoted process arguments form=%s once',
    async (form) => {
      const { service, execute, request } = await harness()
      const target = join(request.workspaceCwd, 'quote-target.txt')
      const names = [
        'hello world.txt',
        '$HOME.txt',
        '`uname`.txt',
        'semi;colon.txt',
        "a'b.txt",
        'a"b.txt',
        '你好.txt',
        "don't $HOME.txt",
        "don't `uname`.txt"
      ]
      const keep = join(
        request.workspaceCwd,
        form >= 12 ? 'keep file.txt' : names[form % names.length]
      )
      await writeFile(target, 'test')
      await writeFile(keep, 'keep')
      execute.mockImplementation(async (execution) => {
        const { stdout, stderr } = await promisify(execFile)(
          process.env.OPEN_SCIENCE_RISK_RSCRIPT!,
          ['--vanilla', '-e', execution.code],
          {
            cwd: execution.cwd,
            env: {
              ...process.env,
              LC_ALL: process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8'
            },
            timeout: 15000
          }
        )
        return {
          status: 'completed',
          stdout,
          stderr,
          traceback: '',
          cwdAfter: execution.cwd,
          outputs: [],
          kernelDispatched: true
        }
      })
      const literal = (value: string): string =>
        value.includes('"') ? `'${value}'` : JSON.stringify(value)
      const quote = (value: string): string =>
        [
          `shQuote(${value})`,
          `base::shQuote(${value})`,
          `quote_arg(${value})`,
          `shQuote(string=${value})`,
          `shQuote(str=${value},type="sh")`,
          `base::shQuote(${value},type="s")`
        ][form % 6]
      const code = (danger: boolean): string => {
        if (form >= 12)
          return `quote_arg <- base::shQuote\ncat(system2("find",c(${quote(literal(danger ? target : keep))},"-exec","${danger ? 'rm' : ['cat', 'wc', 'echo'][form - 12]}",${quote('"{}"')},${quote('";"')}),stdout=TRUE),sep="")`
        const read = `cat(system2("cat",c(NULL,${quote(literal(keep))},character(0)),stdout=TRUE),sep="")`
        const prelude = 'quote_arg <- base::shQuote\n'
        if (!danger) return prelude + read
        if (form < 7)
          return (
            prelude +
            `cat(system2("cat",c(${quote(literal(keep))},"; rm --",${quote(literal(target))}),stdout=TRUE),sep="")`
          )
        if (form < 10)
          return prelude + `system2("rm",c("--",${quote(literal(target))}),stdout=TRUE)`
        if (form === 10)
          return `quote_arg <- function(string) { unlink(${literal(target)});base::shQuote(string) }\ncat(system2("cat",quote_arg(${literal(keep)}),stdout=TRUE),sep="")`
        return (
          prelude +
          `mutate <- function() { quote_arg <<- function(string) { unlink(${literal(target)});base::shQuote(string) };TRUE }\ncat(system2("cat",wait=mutate(),stdout=TRUE,args=quote_arg(${literal(keep)})),sep="")`
        )
      }
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      await service.execute({ ...request, language: 'r', code: code(false) })
      const output = await execute.mock.results[0].value
      expect(output.stdout).toContain('keep')
      expect(approve).not.toHaveBeenCalled()
      expect(execute).toHaveBeenCalledTimes(1)
      expect(await readFile(target, 'utf8')).toBe('test')
      await expect(
        service.execute({ ...request, language: 'r', code: code(true) })
      ).rejects.toThrow('one-time approval')
      expect(execute).toHaveBeenCalledTimes(1)
      expect(await readFile(target, 'utf8')).toBe('test')
      approve.mockResolvedValueOnce(true)
      await service.execute({ ...request, language: 'r', code: code(true) })
      expect(execute).toHaveBeenCalledTimes(2)
      await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
      await writeFile(target, 'next run')
      await expect(
        service.execute({ ...request, language: 'r', code: code(true) })
      ).rejects.toThrow('one-time approval')
      expect(approve).toHaveBeenCalledTimes(3)
      expect(execute).toHaveBeenCalledTimes(2)
      expect(await readFile(target, 'utf8')).toBe('next run')
      expect(await readFile(keep, 'utf8')).toBe('keep')
    }
  )
  it.skipIf(!process.env.OPEN_SCIENCE_RISK_PYTHON).each(Array.from({ length: 17 }, (_, i) => i))(
    'gates real Python dictionary union arguments form=%s once',
    async (form) => {
      const { service, execute, request } = await harness()
      const target = join(request.workspaceCwd, 'union-target.txt')
      const keep = join(request.workspaceCwd, 'keep.txt')
      await writeFile(target, 'test')
      await writeFile(keep, 'keep')
      execute.mockImplementation(async (execution) => {
        const { stdout, stderr } = await promisify(execFile)(
          process.env.OPEN_SCIENCE_RISK_PYTHON!,
          ['-c', execution.code],
          { cwd: execution.cwd, timeout: 5000 }
        )
        return {
          status: 'completed',
          stdout,
          stderr,
          traceback: '',
          cwdAfter: execution.cwd,
          outputs: [],
          kernelDispatched: true
        }
      })
      const unions = [
        (a: string, b: string): string => `{${a}}|{${b}}`,
        (a: string, b: string): string => `({}|{${a}})|({${b}}|{})`,
        (a: string, b: string): string => `({${a}}|{})|({}|{${b}})`,
        (a: string, b: string): string => `{**({${a}}|{})}|{**({}|{${b}})}`,
        (a: string, b: string): string => `({${a}} # prefix\n | {${b}})`
      ]
      const union = unions[form % unions.length]
      const path = JSON.stringify(target)
      const program = JSON.stringify(process.env.OPEN_SCIENCE_RISK_PYTHON)
      const argv = (danger: boolean): string =>
        `[${program},${danger ? `"-c",${JSON.stringify(`import os;os.unlink(${path})`)}` : '"--version"'}]`
      const code = (danger: boolean): string => {
        if (form < 5)
          return `import os
def opener(path,flags):
    ${danger ? 'os.unlink(path)' : 'pass'}
    return os.open(${JSON.stringify(keep)},flags)
print(open(${path},**(${union('"mode":"r"', '"opener":opener')})).read())`
        if (form < 10)
          return `import subprocess\nsubprocess.run(**(${union('"args":' + argv(!danger), '"args":' + argv(danger) + ',"shell":False')}),check=True)`
        if (form < 15)
          return `import subprocess\nsubprocess.run(${argv(danger)},env=(${union('"NO_COLOR":"1"', '"PYTHONUNBUFFERED":"1"')}),check=True)`
        if (!danger) return `print(open(${path},**({"mode":"r"}|{"encoding":"utf-8"})).read())`
        return `import os
class Options:
    def ${form === 15 ? '__or__' : '__ror__'}(self,other):
        os.unlink(${path})
        return {"mode":"r"}
print(open(${JSON.stringify(keep)},**(${form === 15 ? 'Options()|{}' : '{}|Options()'})).read())`
      }
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      await service.execute({ ...request, code: code(false) })
      const output = await execute.mock.results[0].value
      expect(output.stdout + output.stderr).toContain(
        form < 5 ? 'keep' : form < 15 ? 'Python' : 'test'
      )
      expect(approve).not.toHaveBeenCalled()
      expect(execute).toHaveBeenCalledTimes(1)
      expect(await readFile(target, 'utf8')).toBe('test')
      await expect(service.execute({ ...request, code: code(true) })).rejects.toThrow(
        'one-time approval'
      )
      expect(execute).toHaveBeenCalledTimes(1)
      expect(await readFile(target, 'utf8')).toBe('test')
      approve.mockResolvedValueOnce(true)
      await service.execute({ ...request, code: code(true) })
      expect(execute).toHaveBeenCalledTimes(2)
      await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
      await writeFile(target, 'next run')
      await expect(service.execute({ ...request, code: code(true) })).rejects.toThrow(
        'one-time approval'
      )
      expect(approve).toHaveBeenCalledTimes(3)
      expect(execute).toHaveBeenCalledTimes(2)
      expect(await readFile(target, 'utf8')).toBe('next run')
      expect(await readFile(keep, 'utf8')).toBe('keep')
    }
  )
  it.skipIf(!process.env.OPEN_SCIENCE_RISK_PYTHON).each(Array.from({ length: 22 }, (_, i) => i))(
    'gates real Python fixed text construction form=%s once',
    async (form) => {
      const { service, execute, request } = await harness()
      const target = join(request.workspaceCwd, 'text-target.txt')
      const keep = join(request.workspaceCwd, 'keep.txt')
      await writeFile(target, 'test')
      await writeFile(keep, 'keep')
      execute.mockImplementation(async (execution) => {
        const { stdout, stderr } = await promisify(execFile)(
          process.env.OPEN_SCIENCE_RISK_PYTHON!,
          ['-c', execution.code],
          { cwd: execution.cwd, timeout: 5000 }
        )
        return {
          status: 'completed',
          stdout,
          stderr,
          traceback: '',
          cwdAfter: execution.cwd,
          outputs: [],
          kernelDispatched: true
        }
      })
      const joins = [
        (a: string, b: string): string => `${JSON.stringify(a)}+${JSON.stringify(b)}`,
        (a: string, b: string): string => `(${JSON.stringify(a)}+"")+(${JSON.stringify(b)}+"")`,
        (a: string, b: string): string => `""+(${JSON.stringify(a)}+${JSON.stringify(b)})+""`,
        (a: string, b: string): string => `f${JSON.stringify(a)}+f${JSON.stringify(b)}`,
        (a: string, b: string): string => `r${JSON.stringify(a)}+r${JSON.stringify(b)}`,
        (a: string, b: string): string => `(${JSON.stringify(a)} "")+(${JSON.stringify(b)} "")`,
        (a: string, b: string): string =>
          `(${JSON.stringify(a)} # prefix\n + ${JSON.stringify(b)})`,
        (a: string, b: string): string => `u${JSON.stringify(a)}+(""+u${JSON.stringify(b)})`
      ]
      const joinText = joins[form % joins.length]
      const path = JSON.stringify(target)
      const program = JSON.stringify(process.env.OPEN_SCIENCE_RISK_PYTHON)
      const code = (danger: boolean): string => {
        if (form >= 20)
          return `import subprocess
subprocess.run([${program},${danger ? `"-c",${JSON.stringify(`import os;os.unlink(${path})`)}` : '"--version"'}],env={${form === 20 ? '("NO_"+"COLOR")' : '(("NO_COLOR"))'}:"1"},check=True)`
        if (form < 8)
          return `import os
with open(${path}) as handle:
    action=getattr(${danger ? 'os' : 'handle'},${joinText(danger ? 'un' : 'r', danger ? 'link' : 'ead')},None)
    print(action(${danger ? path : ''}))`
        if (form < 16)
          return `import subprocess
subprocess.run(**{${joinText('ar', 'gs')}:[${program},${danger ? `"-c",${JSON.stringify(`import os;os.unlink(${path})`)}` : joinText('--ver', 'sion')}],${joinText('sh', 'ell')}:False},check=True)`
        if (!danger)
          return `with open(${path}) as handle:
    print(getattr(handle,"r"+"ead")())`
        const method = form % 2 ? '__radd__' : '__add__'
        const expression = form % 2 ? '"r"+Text()' : 'Text()+"ead"'
        return `import os
class Text:
    def ${method}(self,other):
        os.unlink(${path})
        return ${form < 18 ? '"read"' : program}
${form < 18 ? `with open(${JSON.stringify(keep)}) as handle:\n    print(getattr(handle,${expression})())` : `import subprocess\nsubprocess.run([${expression},"--version"],check=True)`}`
      }
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      await service.execute({ ...request, code: code(false) })
      const output = await execute.mock.results[0].value
      expect(output.stdout + output.stderr).toContain(
        (form >= 8 && form < 16) || form >= 20 ? 'Python' : 'test'
      )
      expect(approve).not.toHaveBeenCalled()
      expect(execute).toHaveBeenCalledTimes(1)
      expect(await readFile(target, 'utf8')).toBe('test')
      await expect(service.execute({ ...request, code: code(true) })).rejects.toThrow(
        'one-time approval'
      )
      expect(execute).toHaveBeenCalledTimes(1)
      expect(await readFile(target, 'utf8')).toBe('test')
      approve.mockResolvedValueOnce(true)
      await service.execute({ ...request, code: code(true) })
      expect(execute).toHaveBeenCalledTimes(2)
      await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
      await writeFile(target, 'next run')
      await expect(service.execute({ ...request, code: code(true) })).rejects.toThrow(
        'one-time approval'
      )
      expect(approve).toHaveBeenCalledTimes(3)
      expect(execute).toHaveBeenCalledTimes(2)
      expect(await readFile(target, 'utf8')).toBe('next run')
      expect(await readFile(keep, 'utf8')).toBe('keep')
    }
  )
  it.skipIf(!process.env.OPEN_SCIENCE_RISK_PYTHON).each(Array.from({ length: 26 }, (_, i) => i))(
    'gates real Python literal process flags form=%s once',
    async (form) => {
      const { service, execute, request } = await harness()
      const target = join(request.workspaceCwd, 'flag-target.txt')
      const keep = join(request.workspaceCwd, 'keep.txt')
      await writeFile(target, 'test')
      await writeFile(keep, 'keep')
      execute.mockImplementation(async (execution) => {
        const { stdout, stderr } = await promisify(execFile)(
          process.env.OPEN_SCIENCE_RISK_PYTHON!,
          ['-c', execution.code],
          { cwd: execution.cwd, timeout: 5000 }
        )
        return {
          status: 'completed',
          stdout,
          stderr,
          traceback: '',
          cwdAfter: execution.cwd,
          outputs: [],
          kernelDispatched: true
        }
      })
      const flags = [
        '0',
        '0x_0',
        '0o0',
        '0b0',
        '0_0',
        '0.0',
        '0e5',
        '0j',
        '-0',
        '+0.0',
        'not True',
        'not not False',
        'not 1',
        '1e-999'
      ]
      const trueFlags = ['1', '-1', '0x10', '1j', 'not False', 'not None', 'not 0', 'not not True']
      const flag = form >= 18 ? trueFlags[form - 18] : flags[form % flags.length]
      const path = JSON.stringify(target)
      const program = JSON.stringify(process.env.OPEN_SCIENCE_RISK_PYTHON)
      const argv = `[${program},"--version"]`
      const code = (danger: boolean): string => {
        if (form >= 18) {
          const command = danger
            ? `${program} -c ${JSON.stringify(`import os;os.unlink(${path})`)}`
            : 'echo test'
          return `import subprocess\nsubprocess.run(${JSON.stringify(command)},shell=(${flag}),check=True)`
        }
        if (!danger) return `import subprocess\nsubprocess.run(${argv},shell=(${flag}),check=True)`
        if (form >= 14)
          return `import os,subprocess
class Flag:
    def ${form < 16 ? '__bool__' : '__len__'}(self):
        os.unlink(${path})
        return ${form < 16 ? 'False' : '0'}
subprocess.run(${form % 2 ? '"echo test"' : argv},shell=${form % 2 ? 'not Flag()' : 'Flag()'})`
        return `import subprocess\nsubprocess.run([${program},"-c",${JSON.stringify(`import os;os.unlink(${path})`)}],shell=(${flag}),check=True)`
      }
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      await service.execute({ ...request, code: code(false) })
      const output = await execute.mock.results[0].value
      expect(output.stdout + output.stderr).toContain(form >= 18 ? 'test' : 'Python')
      expect(approve).not.toHaveBeenCalled()
      expect(execute).toHaveBeenCalledTimes(1)
      expect(await readFile(target, 'utf8')).toBe('test')
      await expect(service.execute({ ...request, code: code(true) })).rejects.toThrow(
        'one-time approval'
      )
      expect(execute).toHaveBeenCalledTimes(1)
      expect(await readFile(target, 'utf8')).toBe('test')
      approve.mockResolvedValueOnce(true)
      await service.execute({ ...request, code: code(true) })
      expect(execute).toHaveBeenCalledTimes(2)
      await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
      await writeFile(target, 'next run')
      await expect(service.execute({ ...request, code: code(true) })).rejects.toThrow(
        'one-time approval'
      )
      expect(approve).toHaveBeenCalledTimes(3)
      expect(execute).toHaveBeenCalledTimes(2)
      expect(await readFile(target, 'utf8')).toBe('next run')
      expect(await readFile(keep, 'utf8')).toBe('keep')
    }
  )
  it.skipIf(!process.env.OPEN_SCIENCE_RISK_PYTHON).each(Array.from({ length: 14 }, (_, i) => i))(
    'gates real Python visible sequence concatenation form=%s once',
    async (form) => {
      const { service, execute, request } = await harness()
      const target = join(request.workspaceCwd, 'sequence-target.txt')
      const keep = join(request.workspaceCwd, 'keep.txt')
      await writeFile(target, 'test')
      await writeFile(keep, 'keep')
      execute.mockImplementation(async (execution) => {
        const { stdout, stderr } = await promisify(execFile)(
          process.env.OPEN_SCIENCE_RISK_PYTHON!,
          ['-c', execution.code],
          { cwd: execution.cwd, timeout: 5000 }
        )
        return {
          status: 'completed',
          stdout,
          stderr,
          traceback: '',
          cwdAfter: execution.cwd,
          outputs: [],
          kernelDispatched: true
        }
      })
      const packs = [
        (a: string, b: string): string => `[${a}]+[${b}]`,
        (a: string, b: string): string => `(${a},)+(${b},)`,
        (a: string, b: string): string => `([]+[${a}])+([${b}]+[])`,
        (a: string, b: string): string => `(()+(${a},))+((${b},)+())`,
        (a: string, b: string): string => `[*((${a},)+())]+[*(()+(${b},))]`,
        (a: string, b: string): string => `(*([${a}]+[]),)+(*([]+[${b}]),)`
      ]
      const pack = packs[form % packs.length]
      const path = JSON.stringify(target)
      const program = JSON.stringify(process.env.OPEN_SCIENCE_RISK_PYTHON)
      const code = (danger: boolean): string => {
        if (form >= 12)
          return danger
            ? `import os,subprocess
class Arguments:
    def ${form === 12 ? '__add__' : '__radd__'}(self, other):
        os.unlink(${path})
        return [${program},"--version"]
subprocess.run(${form === 12 ? 'Arguments()+["--version"]' : '["unused"]+Arguments()'},check=True)`
            : `import subprocess\nsubprocess.run(${pack(program, '"--version"')},check=True)`
        if (form < 6)
          return `import subprocess\nsubprocess.run(${pack(
            program,
            danger ? `"-c", ${JSON.stringify(`import os;os.unlink(${path})`)}` : '"--version"'
          )}, check=True)`
        if (form < 8)
          return `import os,operator
def action(path):
    ${danger ? 'os.unlink(path)' : 'print(open(path).read())'}
    return len(path)
list(${form === 6 ? 'map' : 'operator.call'}(*(${pack(form === 6 ? 'action' : 'map,action', `[${path}]`)})))`
        if (form < 10)
          return `import os
with open(${path}) as handle:
    print(getattr(*(${pack(danger ? 'os' : 'handle', danger ? '"unlink"' : '"read"')}))(${danger ? path : ''}))`
        return `import os
def opener(path,flags):
    ${danger ? 'os.unlink(path)' : 'pass'}
    return os.open(${JSON.stringify(keep)},flags)
print(open(*(${pack(`${path},"r",-1,None,None,None,True`, 'opener')})).read())`
      }
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      await service.execute({ ...request, code: code(false) })
      const output = await execute.mock.results[0].value
      expect(output.stdout + output.stderr).toContain(
        form < 6 || form >= 12 ? 'Python' : form >= 10 ? 'keep' : 'test'
      )
      expect(approve).not.toHaveBeenCalled()
      expect(execute).toHaveBeenCalledTimes(1)
      expect(await readFile(target, 'utf8')).toBe('test')
      await expect(service.execute({ ...request, code: code(true) })).rejects.toThrow(
        'one-time approval'
      )
      expect(execute).toHaveBeenCalledTimes(1)
      expect(await readFile(target, 'utf8')).toBe('test')
      approve.mockResolvedValueOnce(true)
      await service.execute({ ...request, code: code(true) })
      expect(execute).toHaveBeenCalledTimes(2)
      await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
      await writeFile(target, 'next run')
      await expect(service.execute({ ...request, code: code(true) })).rejects.toThrow(
        'one-time approval'
      )
      expect(approve).toHaveBeenCalledTimes(3)
      expect(execute).toHaveBeenCalledTimes(2)
      expect(await readFile(target, 'utf8')).toBe('next run')
      expect(await readFile(keep, 'utf8')).toBe('keep')
    }
  )
  it
    .skipIf(!process.env.OPEN_SCIENCE_RISK_PYTHON)
    .each(Array.from({ length: 18 }, (_, index) => index))(
    'gates real Python scalar data and custom operator form=%s once',
    async (form) => {
      const { service, execute, request } = await harness()
      const target = join(request.workspaceCwd, 'scalar-target.txt')
      const keep = join(request.workspaceCwd, 'keep.txt')
      await writeFile(target, 'test')
      await writeFile(keep, 'keep')
      execute.mockImplementation(async (execution) => {
        const { stdout, stderr } = await promisify(execFile)(
          process.env.OPEN_SCIENCE_RISK_PYTHON!,
          ['-c', execution.code],
          { cwd: execution.cwd, timeout: 5000 }
        )
        return {
          status: 'completed',
          stdout,
          stderr,
          traceback: '',
          cwdAfter: execution.cwd,
          outputs: [],
          kernelDispatched: true
        }
      })
      const path = JSON.stringify(target)
      const expressions = [
        '-1',
        '+1',
        '~1',
        'not False',
        '1+2',
        '3+4j',
        '1>0',
        '1<2<3',
        '"%s" % "data"',
        '"a"+"b"',
        'b"a"+b"b"',
        '7//2',
        '2**3',
        '1<<2',
        'f"{-1}"',
        'f"{1+2}"',
        'f"{1 < 2}"',
        'f"{-1:>{2+3}}"'
      ]
      const safe = `import os
fallback=${expressions[form]};alias=fallback
with open(${path}) as handle:
    print(getattr(handle,"read",alias)())`
      const custom = [
        ['__neg__', '-Value()'],
        ['__pos__', '+Value()'],
        ['__invert__', '~Value()'],
        ['__add__', 'Value()+1'],
        ['__radd__', '1+Value()'],
        ['__eq__', 'Value()==1'],
        ['__lt__', 'Value()<1'],
        ['__bool__', 'not Value()'],
        ['__format__', 'f"{Value()}"'],
        ['__repr__', '"%s" % [Value()]']
      ]
      const [method, expression] = custom[Math.max(0, form - 8)]
      const danger =
        form < 8
          ? `import os
fallback=${expressions[form]}
getattr(os,"unlink",fallback)(${path})`
          : `import os
class Value:
    def ${method}(self,*args):
        os.unlink(${path})
        return ${['__repr__', '__format__'].includes(method) ? '"data"' : 'True'}
fallback=${expression}
print(getattr(os,"listdir",fallback)("."))`
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      await service.execute({ ...request, code: safe })
      expect((await execute.mock.results[0].value).stdout).toContain('test')
      expect(approve).not.toHaveBeenCalled()
      expect(execute).toHaveBeenCalledTimes(1)
      expect(await readFile(target, 'utf8')).toBe('test')
      await expect(service.execute({ ...request, code: danger })).rejects.toThrow(
        'one-time approval'
      )
      expect(execute).toHaveBeenCalledTimes(1)
      expect(await readFile(target, 'utf8')).toBe('test')
      approve.mockResolvedValueOnce(true)
      await service.execute({ ...request, code: danger })
      expect(execute).toHaveBeenCalledTimes(2)
      await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
      await writeFile(target, 'next run')
      await expect(service.execute({ ...request, code: danger })).rejects.toThrow(
        'one-time approval'
      )
      expect(approve).toHaveBeenCalledTimes(3)
      expect(execute).toHaveBeenCalledTimes(2)
      expect(await readFile(target, 'utf8')).toBe('next run')
      expect(await readFile(keep, 'utf8')).toBe('keep')
    }
  )
  it.skipIf(!process.env.OPEN_SCIENCE_RISK_PYTHON).each([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])(
    'gates real Python expression selection form=%s once',
    async (form) => {
      const { service, execute, request } = await harness()
      const target = join(request.workspaceCwd, 'selection-target.txt')
      const keep = join(request.workspaceCwd, 'keep.txt')
      await writeFile(target, 'test')
      await writeFile(keep, 'keep')
      execute.mockImplementation(async (execution) => {
        const { stdout, stderr } = await promisify(execFile)(
          process.env.OPEN_SCIENCE_RISK_PYTHON!,
          ['-c', execution.code],
          { cwd: execution.cwd, timeout: 5000 }
        )
        return {
          status: 'completed',
          stdout,
          stderr,
          traceback: '',
          cwdAfter: execution.cwd,
          outputs: [],
          kernelDispatched: true
        }
      })
      const path = JSON.stringify(target)
      const setup = `import os,operator
flag=True;other=False
read=open(${path}).read;erase=os.unlink
`
      const choices = (target: string): string[] => [
        `${target} if flag else ${target}`,
        `(${target} if flag else ${target}) if other else ${target}`,
        `None or ${target}`,
        `False or ${target}`,
        `flag and ${target}`,
        `None or (${target} if flag else ${target})`,
        `${target} if True else os.unlink`,
        `os.unlink if False else ${target}`,
        `True and ${target}`,
        `(selected:=${target}) if flag else (selected:=${target})`
      ]
      const safe =
        setup +
        (form < 10
          ? `reader=${choices('read')[form]};print(reader())`
          : form === 10
            ? `fallback=None if flag else False;print(getattr(open(${path}),"read",fallback)())`
            : `reader=read if True else os.unlink(${path});print(reader())`)
      const danger =
        setup +
        (form < 10
          ? `selected=${choices('erase')[form]};selected(${path})`
          : form === 10
            ? `fallback=os.unlink if flag else None;getattr(os,"missing",fallback)(${path})`
            : `class Flag:
    def __bool__(self):
        os.unlink(${path})
        return True
flag=Flag()
reader=((flag:=True) and os.listdir) if flag else ((flag:=False) or os.listdir)
print(reader("."))`)
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      await service.execute({ ...request, code: safe })
      expect((await execute.mock.results[0].value).stdout).toContain('test')
      expect(approve).not.toHaveBeenCalled()
      expect(execute).toHaveBeenCalledTimes(1)
      expect(await readFile(target, 'utf8')).toBe('test')
      await expect(service.execute({ ...request, code: danger })).rejects.toThrow(
        'one-time approval'
      )
      expect(execute).toHaveBeenCalledTimes(1)
      expect(await readFile(target, 'utf8')).toBe('test')
      approve.mockResolvedValueOnce(true)
      await service.execute({ ...request, code: danger })
      expect(execute).toHaveBeenCalledTimes(2)
      await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
      await writeFile(target, 'next run')
      await expect(service.execute({ ...request, code: danger })).rejects.toThrow(
        'one-time approval'
      )
      expect(approve).toHaveBeenCalledTimes(3)
      expect(execute).toHaveBeenCalledTimes(2)
      expect(await readFile(target, 'utf8')).toBe('next run')
      expect(await readFile(keep, 'utf8')).toBe('keep')
    }
  )
  it.skipIf(!process.env.OPEN_SCIENCE_RISK_PYTHON).each([0, 1, 2, 3, 4, 5, 6, 7])(
    'gates real Python inert default bindings form=%s once',
    async (form) => {
      const { service, execute, request } = await harness()
      const target = join(request.workspaceCwd, 'default-binding-target.txt')
      const keep = join(request.workspaceCwd, 'keep.txt')
      await writeFile(target, 'test')
      await writeFile(keep, 'keep')
      execute.mockImplementation(async (execution) => {
        const { stdout, stderr } = await promisify(execFile)(
          process.env.OPEN_SCIENCE_RISK_PYTHON!,
          ['-c', execution.code],
          { cwd: execution.cwd, timeout: 5000 }
        )
        return {
          status: 'completed',
          stdout,
          stderr,
          traceback: '',
          cwdAfter: execution.cwd,
          outputs: [],
          kernelDispatched: true
        }
      })
      const path = JSON.stringify(target)
      const safe =
        'import os\n' +
        [
          `fallback=False;print(getattr(open(${path}),"read",fallback)())`,
          `fallback=[];alias=fallback;print(getattr(open(${path}),"read",alias)())`,
          `fallback=alias={};reader=getattr(open(${path}),"read",alias);print(reader())`,
          `fallback,unused=(False,42);print(getattr(open(${path}),"read",fallback)())`,
          `print(getattr(open(${path}),"read",(fallback:=False))())`,
          `fallback=[];reader=getattr(open(${path}),"read",fallback);fallback=os.unlink;print(reader())`,
          `for fallback in [False]:\n    print(getattr(open(${path}),"read",fallback)())`,
          `fallback=[os.unlink];print(getattr(open(${path}),"read",fallback)())`
        ][form]
      const danger =
        'import os\n' +
        [
          `fallback=False;getattr(os,"unlink",fallback)(${path})`,
          `fallback=[];alias=fallback;getattr(os,"unlink",alias)(${path})`,
          `fallback=alias={};alias=os.unlink;getattr(os,"missing",alias)(${path})`,
          `fallback,erase=(False,os.unlink);erase(${path})`,
          `getattr(os,"unlink",(fallback:=False))(${path})`,
          `fallback=os.unlink;erase=getattr(os,"missing",fallback);fallback=[];erase(${path})`,
          `for fallback in [False]:\n    getattr(os,"unlink",fallback)(${path})`,
          `fallback=[os.unlink];erase=fallback[0];erase(${path})`
        ][form]
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      await service.execute({ ...request, code: safe })
      expect((await execute.mock.results[0].value).stdout).toContain('test')
      expect(approve).not.toHaveBeenCalled()
      expect(execute).toHaveBeenCalledTimes(1)
      expect(await readFile(target, 'utf8')).toBe('test')
      await expect(service.execute({ ...request, code: danger })).rejects.toThrow(
        'one-time approval'
      )
      expect(execute).toHaveBeenCalledTimes(1)
      expect(await readFile(target, 'utf8')).toBe('test')
      approve.mockResolvedValueOnce(true)
      await service.execute({ ...request, code: danger })
      expect(execute).toHaveBeenCalledTimes(2)
      await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
      await writeFile(target, 'next run')
      await expect(service.execute({ ...request, code: danger })).rejects.toThrow(
        'one-time approval'
      )
      expect(approve).toHaveBeenCalledTimes(3)
      expect(execute).toHaveBeenCalledTimes(2)
      expect(await readFile(target, 'utf8')).toBe('next run')
      expect(await readFile(keep, 'utf8')).toBe('keep')
    }
  )
  for (const language of ['python', 'r'] as const) {
    const executable =
      language === 'python'
        ? process.env.OPEN_SCIENCE_RISK_PYTHON
        : process.env.OPEN_SCIENCE_RISK_RSCRIPT
    it.skipIf(!executable).each([0, 1, 2, 3, 4, 5, 6, 7])(
      `gates real ${language} guarded lookup and forwarding form=%s once`,
      async (form) => {
        const { service, execute, request } = await harness()
        const target = join(request.workspaceCwd, 'guarded-target.txt')
        const keep = join(request.workspaceCwd, 'keep.txt')
        await writeFile(target, 'test\n')
        await writeFile(keep, 'keep')
        execute.mockImplementation(async (execution) => {
          const { stdout, stderr } = await promisify(execFile)(
            executable!,
            language === 'python' ? ['-c', execution.code] : ['--vanilla', '-e', execution.code],
            { cwd: execution.cwd, env: { ...process.env, LC_ALL: 'C' }, timeout: 5000 }
          )
          return {
            status: 'completed',
            stdout,
            stderr,
            traceback: '',
            cwdAfter: execution.cwd,
            outputs: [],
            kernelDispatched: true
          }
        })
        const path = JSON.stringify(target)
        const safe =
          language === 'python'
            ? [
                `print(getattr(open(${path}),"read",None)())`,
                `read=getattr(open(${path}),"read",None);print(read())`,
                `fallback=open(${path}).read;read=getattr(open(${path}),"read",fallback);print(read())`,
                `def fallback():\n    return "fallback"\nprint(getattr(open(${path}),"read",fallback)())`,
                `print(getattr(open(${path}),"read",False)())`,
                `reader=getattr(open(${path}),"read",[]);print(reader())`,
                `print(getattr(open(${path}),"read",{})())`,
                `print(getattr(open(${path}),"read",b"")())`
              ][form]
            : [
                `print(do.call(base::readLines,list(con=${path},warn=FALSE)))`,
                `print(do.call("readLines",list(${path},warn=FALSE)))`,
                `invoke <- base::do.call;print(invoke(base::readLines,list(${path},warn=FALSE)))`,
                `print(do.call("do.call",list("readLines",list(${path},warn=FALSE))))`,
                `print(base::match.fun(base::readLines)(${path}))`,
                `print(match.fun("readLines")(${path}))`,
                `lookup <- base::match.fun;reader <- lookup(base::readLines);print(reader(${path}))`,
                `print(base::match.fun(base::match.fun(base::readLines))(${path}))`
              ][form]
        const danger =
          language === 'python'
            ? 'import os\n' +
              [
                `getattr(os,"unlink",None)(${path})`,
                `erase=getattr(os,"unlink",None);erase(${path})`,
                `erase=getattr(os,"missing",os.unlink);erase(${path})`,
                `def fallback(path):\n    os.unlink(path)\nerase=getattr(os,"missing",fallback);erase(${path})`,
                `getattr(os,"unlink",False)(${path})`,
                `erase=getattr(os,"unlink",[]);erase(${path})`,
                `getattr(os,"unlink",{})(${path})`,
                `getattr(os,"unlink",b"")(${path})`
              ][form]
            : [
                `do.call(base::unlink,list(${path}))`,
                `do.call("unlink",list(${path}))`,
                `invoke <- base::do.call;invoke("file.remove",list(${path}))`,
                `do.call("do.call",list("unlink",list(${path})))`,
                `base::match.fun(base::unlink)(${path})`,
                `match.fun("unlink")(${path})`,
                `lookup <- base::match.fun;erase <- lookup(base::unlink);erase(${path})`,
                `base::match.fun(base::match.fun(base::unlink))(${path})`
              ][form]
        const approve = vi.fn(async () => false)
        service.setExecutionApproval(approve)
        await service.execute({ ...request, language, code: safe })
        expect((await execute.mock.results[0].value).stdout).toContain('test')
        expect(approve).not.toHaveBeenCalled()
        expect(execute).toHaveBeenCalledTimes(1)
        await expect(service.execute({ ...request, language, code: danger })).rejects.toThrow(
          'one-time approval'
        )
        expect(execute).toHaveBeenCalledTimes(1)
        expect(await readFile(target, 'utf8')).toBe('test\n')
        approve.mockResolvedValueOnce(true)
        await service.execute({ ...request, language, code: danger })
        expect(execute).toHaveBeenCalledTimes(2)
        await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
        await writeFile(target, 'next run')
        await expect(service.execute({ ...request, language, code: danger })).rejects.toThrow(
          'one-time approval'
        )
        expect(approve).toHaveBeenCalledTimes(3)
        expect(execute).toHaveBeenCalledTimes(2)
        expect(await readFile(target, 'utf8')).toBe('next run')
        expect(await readFile(keep, 'utf8')).toBe('keep')
      }
    )
  }
  it.skipIf(!process.env.OPEN_SCIENCE_RISK_PYTHON).each([0, 1, 2, 3, 4, 5, 6, 7])(
    'gates real Python explicit callable forwarding form=%s once',
    async (form) => {
      const { service, execute, request } = await harness()
      const target = join(request.workspaceCwd, 'forwarded-target.txt')
      const keep = join(request.workspaceCwd, 'keep.txt')
      await writeFile(target, 'test')
      await writeFile(keep, 'keep')
      execute.mockImplementation(async (execution) => {
        const { stdout, stderr } = await promisify(execFile)(
          process.env.OPEN_SCIENCE_RISK_PYTHON!,
          ['-c', execution.code],
          { cwd: execution.cwd, timeout: 5000 }
        )
        return {
          status: 'completed',
          stdout,
          stderr,
          traceback: '',
          cwdAfter: execution.cwd,
          outputs: [],
          kernelDispatched: true
        }
      })
      const pack = (args: string): string =>
        [`*(${args},)`, `*[${args}]`, `*((${args},))`, `*(*[${args}],)`][form % 4]
      const invoke = form < 4 ? 'operator.call' : 'operator.__call__'
      const code = (danger: boolean): string =>
        `import operator,os\n` +
        (danger
          ? `${invoke}(${pack('os.unlink,' + JSON.stringify(target))})`
          : `print(${invoke}(${pack('getattr,open(' + JSON.stringify(target) + '),"read"')})())`)
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      await service.execute({ ...request, code: code(false) })
      expect((await execute.mock.results[0].value).stdout).toContain('test')
      expect(approve).not.toHaveBeenCalled()
      expect(execute).toHaveBeenCalledTimes(1)
      await expect(service.execute({ ...request, code: code(true) })).rejects.toThrow(
        'one-time approval'
      )
      expect(execute).toHaveBeenCalledTimes(1)
      expect(await readFile(target, 'utf8')).toBe('test')
      approve.mockResolvedValueOnce(true)
      await service.execute({ ...request, code: code(true) })
      expect(execute).toHaveBeenCalledTimes(2)
      await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(service.execute({ ...request, code: code(true) })).rejects.toThrow(
        'one-time approval'
      )
      expect(approve).toHaveBeenCalledTimes(3)
      expect(execute).toHaveBeenCalledTimes(2)
      expect(await readFile(keep, 'utf8')).toBe('keep')
    }
  )
  it.skipIf(!process.env.OPEN_SCIENCE_RISK_PYTHON).each([0, 1, 2, 3])(
    'gates real Python packed accessor provenance form=%s once',
    async (form) => {
      const { service, execute, request } = await harness()
      const target = join(request.workspaceCwd, 'accessor-target.txt')
      const keep = join(request.workspaceCwd, 'keep.txt')
      await writeFile(target, 'test')
      await writeFile(keep, 'keep')
      execute.mockImplementation(async (execution) => {
        const { stdout, stderr } = await promisify(execFile)(
          process.env.OPEN_SCIENCE_RISK_PYTHON!,
          ['-c', execution.code],
          { cwd: execution.cwd, timeout: 5000 }
        )
        return {
          status: 'completed',
          stdout,
          stderr,
          traceback: '',
          cwdAfter: execution.cwd,
          outputs: [],
          kernelDispatched: true
        }
      })
      const pack = (args: string): string =>
        [`*(${args},)`, `*[${args}]`, `*((${args},))`, `*(*[${args}],)`][form]
      const code = (danger: boolean): string =>
        danger
          ? `import operator\nfrom pathlib import Path\nerase=operator.methodcaller(${pack('"unlink"')})\nerase(${pack('Path(' + JSON.stringify(target) + ')')})`
          : `print(getattr(${pack('open(' + JSON.stringify(target) + '),"read"')})())`
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      await service.execute({ ...request, code: code(false) })
      expect((await execute.mock.results[0].value).stdout).toContain('test')
      expect(approve).not.toHaveBeenCalled()
      expect(execute).toHaveBeenCalledTimes(1)
      await expect(service.execute({ ...request, code: code(true) })).rejects.toThrow(
        'one-time approval'
      )
      expect(execute).toHaveBeenCalledTimes(1)
      expect(await readFile(target, 'utf8')).toBe('test')
      approve.mockResolvedValueOnce(true)
      await service.execute({ ...request, code: code(true) })
      expect(execute).toHaveBeenCalledTimes(2)
      await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(service.execute({ ...request, code: code(true) })).rejects.toThrow(
        'one-time approval'
      )
      expect(approve).toHaveBeenCalledTimes(3)
      expect(execute).toHaveBeenCalledTimes(2)
      expect(await readFile(keep, 'utf8')).toBe('keep')
    }
  )
  it.skipIf(!process.env.OPEN_SCIENCE_RISK_PYTHON).each([0, 1, 2, 3])(
    'gates real Python literal positional unpacking form=%s once',
    async (form) => {
      const { service, execute, request } = await harness()
      const target = join(request.workspaceCwd, 'packed-target.txt')
      const keep = join(request.workspaceCwd, 'keep.txt')
      await writeFile(target, 'test')
      await writeFile(keep, 'keep')
      execute.mockImplementation(async (execution) => {
        const { stdout, stderr } = await promisify(execFile)(
          process.env.OPEN_SCIENCE_RISK_PYTHON!,
          ['-c', execution.code],
          { cwd: execution.cwd, timeout: 5000 }
        )
        return {
          status: 'completed',
          stdout,
          stderr,
          traceback: '',
          cwdAfter: execution.cwd,
          outputs: [],
          kernelDispatched: true
        }
      })
      const pack = (args: string): string =>
        [`*(${args},)`, `*[${args}]`, `*((${args},))`, `*(*[${args}],)`][form]
      const code = (danger: boolean): string =>
        `import os\ndef action(path):\n    ${danger ? 'os.unlink(path)' : 'print(open(path).read())'}\n    return len(path)\nlist(map(${pack('action,' + JSON.stringify([target]))}))`
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      await service.execute({ ...request, code: code(false) })
      expect((await execute.mock.results[0].value).stdout).toContain('test')
      expect(approve).not.toHaveBeenCalled()
      expect(execute).toHaveBeenCalledTimes(1)
      await expect(service.execute({ ...request, code: code(true) })).rejects.toThrow(
        'one-time approval'
      )
      expect(execute).toHaveBeenCalledTimes(1)
      expect(await readFile(target, 'utf8')).toBe('test')
      approve.mockResolvedValueOnce(true)
      await service.execute({ ...request, code: code(true) })
      expect(execute).toHaveBeenCalledTimes(2)
      await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(service.execute({ ...request, code: code(true) })).rejects.toThrow(
        'one-time approval'
      )
      expect(approve).toHaveBeenCalledTimes(3)
      expect(execute).toHaveBeenCalledTimes(2)
      expect(await readFile(keep, 'utf8')).toBe('keep')
    }
  )
  it.each([0, 1, 2, 3].flatMap((form) => [false, true].map((nested) => [form, nested] as const)))(
    'gates real static module destructuring form=%s nested=%s once',
    async (form, nested) => {
      const { service, execute, request } = await harness()
      const target = join(request.workspaceCwd, 'module-target.txt')
      const keep = join(request.workspaceCwd, 'keep.txt')
      await writeFile(target, 'test')
      await writeFile(keep, 'keep')
      execute.mockImplementation(async (execution) => {
        const { stdout, stderr } = await promisify(execFile)(
          process.execPath,
          ['-e', execution.code],
          {
            cwd: execution.cwd,
            timeout: 5000
          }
        )
        return {
          status: 'completed',
          stdout,
          stderr,
          traceback: '',
          cwdAfter: execution.cwd,
          outputs: [],
          kernelDispatched: true
        }
      })
      const fixed = (value: string): string => {
        const text = form < 2 ? JSON.stringify(value) : '`' + value + '`'
        return form % 2 ? '(' + text + ')' : text
      }
      const code = (danger: boolean): string => {
        const method = nested
          ? danger
            ? 'unlink'
            : 'readFile'
          : danger
            ? 'unlinkSync'
            : 'readFileSync'
        const pattern = nested
          ? `{[${fixed('promises')}]:{[${fixed(method)}]:run}}`
          : `{[${fixed(method)}]:run}`
        return `const ${pattern}=require(${fixed('node:fs')}); (async()=>{const result=await run(${JSON.stringify(target)}); if(result) console.log(result.toString())})().catch(error=>{console.error(error);process.exitCode=1})`
      }
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      await service.executeControl({ ...request, code: code(false) })
      expect((await execute.mock.results[0].value).stdout).toContain('test')
      expect(approve).not.toHaveBeenCalled()
      expect(execute).toHaveBeenCalledTimes(1)
      await service.executeControl({ ...request, code: code(true) })
      expect(execute).toHaveBeenCalledTimes(1)
      expect(await readFile(target, 'utf8')).toBe('test')
      approve.mockResolvedValueOnce(true)
      await service.executeControl({ ...request, code: code(true) })
      expect(execute).toHaveBeenCalledTimes(2)
      await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      await service.executeControl({ ...request, code: code(true) })
      expect(approve).toHaveBeenCalledTimes(3)
      expect(execute).toHaveBeenCalledTimes(2)
      expect(await readFile(keep, 'utf8')).toBe('keep')
    }
  )
  it
    .skipIf(process.platform === 'win32')
    .each(
      ['spawnSync', 'execFileSync', 'execSync'].flatMap((method) =>
        ['call', 'apply'].flatMap((forward) =>
          [false, true].map((parenthesized) => [method, forward, parenthesized] as const)
        )
      )
    )('gates real %s template %s parenthesized=%s once', async (method, forward, parenthesized) => {
    const { service, execute, request } = await harness()
    const target = join(request.workspaceCwd, 'forward-target.txt')
    const keep = join(request.workspaceCwd, 'keep.txt')
    await writeFile(target, 'test')
    await writeFile(keep, 'keep')
    execute.mockImplementation(async (execution) => {
      const { stdout, stderr } = await promisify(execFile)(
        process.execPath,
        ['-e', execution.code],
        { cwd: execution.cwd, timeout: 5000 }
      )
      return {
        status: 'completed',
        stdout,
        stderr,
        traceback: '',
        cwdAfter: execution.cwd,
        outputs: [],
        kernelDispatched: true
      }
    })
    const code = (command: string): string => {
      const member = parenthesized ? '(`' + forward + '`)' : '`' + forward + '`'
      const args =
        method === 'execSync'
          ? JSON.stringify(command + ' forward-target.txt')
          : `${JSON.stringify(command)},["forward-target.txt"]`
      const argv = `${args},{cwd:${JSON.stringify(request.workspaceCwd)},encoding:"utf8"}`
      const call = `cp.${method}[${member}](null,${forward === 'apply' ? '[' + argv + ']' : argv})`
      return (
        'const cp=require("child_process"); const result=' +
        call +
        '; ' +
        (method === 'spawnSync'
          ? 'if(result.status || result.error) throw result.error || Error(result.stderr); console.log(result.stdout)'
          : 'console.log(result)')
      )
    }
    const approve = vi.fn(async () => false)
    service.setExecutionApproval(approve)
    await service.executeControl({ ...request, code: code('cat') })
    expect((await execute.mock.results[0].value).stdout).toContain('test')
    expect(approve).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(1)
    await service.executeControl({ ...request, code: code('rm') })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(await readFile(target, 'utf8')).toBe('test')
    approve.mockResolvedValueOnce(true)
    await service.executeControl({ ...request, code: code('rm') })
    expect(execute).toHaveBeenCalledTimes(2)
    await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await service.executeControl({ ...request, code: code('rm') })
    expect(approve).toHaveBeenCalledTimes(3)
    expect(execute).toHaveBeenCalledTimes(2)
    expect(await readFile(keep, 'utf8')).toBe('keep')
  })
  it
    .skipIf(process.platform === 'win32')
    .each(
      ['run', 'call', 'check_call', 'check_output', 'Popen'].flatMap((method) =>
        [false, true].map((shell) => [method, shell] as const)
      )
    )('gates Python %s packed literal shell=%s once', async (method, shell) => {
    const { service, execute, request } = await harness()
    const approve = vi.fn(async () => false)
    service.setExecutionApproval(approve)
    const code = (command: string): string => {
      const args = shell
        ? JSON.stringify(command + ' target.txt')
        : `[${JSON.stringify(command)},"target.txt"]`
      return `import subprocess; subprocess.${method}(**{**{"ar" "gs":${args}},"sh" "ell":${shell ? 'True' : 'False'},"env":{"LC_ALL":"C"}})`
    }
    await service.execute({ ...request, code: code('cat') })
    expect(approve).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(1)
    await expect(service.execute({ ...request, code: code('rm') })).rejects.toThrow(
      'one-time approval'
    )
    expect(execute).toHaveBeenCalledTimes(1)
    approve.mockResolvedValueOnce(true)
    await service.execute({ ...request, code: code('rm') })
    expect(execute).toHaveBeenCalledTimes(2)
    await expect(service.execute({ ...request, code: code('rm') })).rejects.toThrow(
      'one-time approval'
    )
    expect(approve).toHaveBeenCalledTimes(3)
    expect(execute).toHaveBeenCalledTimes(2)
  })
  it.skipIf(process.platform === 'win32').each([
    ['spawnSync', false],
    ['execFileSync', false],
    ['execSync', false],
    ['spawnSync', true],
    ['execFileSync', true],
    ['execSync', true]
  ] as const)('gates real %s static templates computed=%s once', async (method, computed) => {
    const { service, execute, request } = await harness()
    const target = join(request.workspaceCwd, 'template-target.txt')
    const keep = join(request.workspaceCwd, 'keep.txt')
    await writeFile(target, 'test')
    await writeFile(keep, 'keep')
    execute.mockImplementation(async (execution) => {
      const { stdout, stderr } = await promisify(execFile)(
        process.execPath,
        ['-e', execution.code],
        {
          cwd: execution.cwd,
          timeout: 5000
        }
      )
      return {
        status: 'completed',
        stdout,
        stderr,
        traceback: '',
        cwdAfter: execution.cwd,
        outputs: [],
        kernelDispatched: true
      }
    })
    const code = (command: string): string => {
      const call = computed ? 'cp[`' + method + '`]' : 'cp.' + method
      const args =
        method === 'execSync'
          ? '`' + command + ' template-target.txt`'
          : '`' + command + '`, [`template-target.txt`]'
      const result = `${call}(${args}, {cwd:${JSON.stringify(request.workspaceCwd)},encoding:'utf8'})`
      return (
        'const cp=require(`node:child_process`); ' +
        (method === 'spawnSync'
          ? `const result=${result}; if(result.status || result.error) throw result.error || Error(result.stderr); console.log(result.stdout)`
          : `console.log(${result})`)
      )
    }
    const approve = vi.fn(async () => false)
    service.setExecutionApproval(approve)
    await service.executeControl({ ...request, code: code('cat') })
    expect((await execute.mock.results[0].value).stdout).toContain('test')
    expect(approve).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(1)
    await service.executeControl({ ...request, code: code('rm') })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(await readFile(target, 'utf8')).toBe('test')
    approve.mockResolvedValueOnce(true)
    await service.executeControl({ ...request, code: code('rm') })
    expect(execute).toHaveBeenCalledTimes(2)
    await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await service.executeControl({ ...request, code: code('rm') })
    expect(approve).toHaveBeenCalledTimes(3)
    expect(execute).toHaveBeenCalledTimes(2)
    expect(await readFile(keep, 'utf8')).toBe('keep')
  })
  for (const language of ['python', 'r'] as const) {
    const executable =
      language === 'python'
        ? process.env.OPEN_SCIENCE_RISK_PYTHON
        : process.env.OPEN_SCIENCE_RISK_RSCRIPT
    it.skipIf(process.platform === 'win32' || !executable).each([0, 1, 2, 3])(
      `gates real ${language} output-only subprocess settings form=%s once`,
      async (form) => {
        const { service, execute, request } = await harness()
        const target = join(request.workspaceCwd, 'output-settings-target.txt')
        const keep = join(request.workspaceCwd, 'keep.txt')
        await writeFile(target, 'test')
        await writeFile(keep, 'keep')
        execute.mockImplementation(async (execution) => {
          const { stdout, stderr } = await promisify(execFile)(
            executable!,
            language === 'python' ? ['-c', execution.code] : ['--vanilla', '-e', execution.code],
            { cwd: execution.cwd, env: { ...process.env, LC_ALL: 'C' }, timeout: 5000 }
          )
          return {
            status: 'completed',
            stdout,
            stderr,
            traceback: '',
            cwdAfter: execution.cwd,
            outputs: [],
            kernelDispatched: true
          }
        })
        const env =
          language === 'python'
            ? [
                '{"NO_COLOR":"1"}',
                '{"PYTHONUTF8":"1","PYTHONUNBUFFERED":"1"}',
                '{"PYTHONIOENCODING":"utf-8:replace"}',
                '{**{"NO_COLOR":"1"},**{"PYTHONUTF8":"1"}}'
              ][form]
            : [
                '"NO_COLOR=1"',
                'c("PYTHONUTF8=1","PYTHONUNBUFFERED=1")',
                '"PYTHONIOENCODING=utf-8:replace"',
                'base::c("NO_COLOR=1","FORCE_COLOR=0")'
              ][form]
        const code = (command: string): string =>
          language === 'python'
            ? `import subprocess\nprint(subprocess.run(["${command}",${JSON.stringify(target)}],env=${env},check=True,capture_output=True,text=True).stdout)`
            : `print(system2("${command}",args=${JSON.stringify(target)},env=${env},stdout=TRUE))`
        const approve = vi.fn(async () => false)
        service.setExecutionApproval(approve)
        await service.execute({ ...request, language, code: code('cat') })
        expect((await execute.mock.results[0].value).stdout).toContain('test')
        expect(approve).not.toHaveBeenCalled()
        expect(execute).toHaveBeenCalledTimes(1)
        expect(await readFile(target, 'utf8')).toBe('test')
        await expect(service.execute({ ...request, language, code: code('rm') })).rejects.toThrow(
          'one-time approval'
        )
        expect(execute).toHaveBeenCalledTimes(1)
        expect(await readFile(target, 'utf8')).toBe('test')
        approve.mockResolvedValueOnce(true)
        await service.execute({ ...request, language, code: code('rm') })
        expect(execute).toHaveBeenCalledTimes(2)
        await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
        await writeFile(target, 'next run')
        await expect(service.execute({ ...request, language, code: code('rm') })).rejects.toThrow(
          'one-time approval'
        )
        expect(approve).toHaveBeenCalledTimes(3)
        expect(execute).toHaveBeenCalledTimes(2)
        expect(await readFile(target, 'utf8')).toBe('next run')
        expect(await readFile(keep, 'utf8')).toBe('keep')
      }
    )
  }
  it.skipIf(process.platform === 'win32').each([
    ['spawnSync', {}],
    ['execSync', {}],
    ['spawnSync', { LC_ALL: 'C', TZ: 'UTC' }],
    ['execSync', { LC_ALL: 'C', TZ: 'UTC' }],
    ['spawnSync', { OMP_NUM_THREADS: '2' }],
    ['execSync', { OMP_NUM_THREADS: '2' }],
    ['spawnSync', { NO_COLOR: '1' }],
    ['execSync', { NO_COLOR: '1' }],
    ['spawnSync', { FORCE_COLOR: '0' }],
    ['execSync', { FORCE_COLOR: '0' }],
    ['spawnSync', { PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' }],
    ['execSync', { PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' }],
    ['spawnSync', { PYTHONIOENCODING: 'utf-8:replace' }],
    ['execSync', { PYTHONIOENCODING: 'utf-8:replace' }],
    ['spawnSync', { NO_COLOR: '$(rm environment-target.txt)' }],
    ['execSync', { NO_COLOR: '$(rm environment-target.txt)' }],
    ['spawnSync', { NODE_DISABLE_COLORS: '1\nrm environment-target.txt' }],
    ['execSync', { NODE_DISABLE_COLORS: '1\nrm environment-target.txt' }]
  ] as const)('gates real %s with literal env %j once', async (method, env) => {
    const { service, execute, request } = await harness()
    const target = join(request.workspaceCwd, 'environment-target.txt')
    const keep = join(request.workspaceCwd, 'keep.txt')
    await writeFile(target, 'test')
    await writeFile(keep, 'keep')
    execute.mockImplementation(async (execution) => {
      const { stdout, stderr } = await promisify(execFile)(
        process.execPath,
        ['-e', execution.code],
        {
          cwd: execution.cwd,
          timeout: 5000
        }
      )
      return {
        status: 'completed',
        stdout,
        stderr,
        traceback: '',
        cwdAfter: execution.cwd,
        outputs: [],
        kernelDispatched: true
      }
    })
    const code = (command: string): string =>
      method === 'spawnSync'
        ? `const cp=require('child_process'); const result=cp.spawnSync('${command}', [${JSON.stringify(target)}], {env:${JSON.stringify(env)},encoding:'utf8'}); if(result.status || result.error) throw result.error || Error(result.stderr); console.log(result.stdout)`
        : `const cp=require('child_process'); console.log(cp.execSync(${JSON.stringify(`${command} '${target.replaceAll("'", "'\\''")}'`)}, {env:${JSON.stringify(env)}}).toString())`
    const approve = vi.fn(async () => false)
    service.setExecutionApproval(approve)
    await service.executeControl({ ...request, code: code('cat') })
    expect((await execute.mock.results[0].value).stdout).toContain('test')
    expect(approve).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(await readFile(target, 'utf8')).toBe('test')
    await service.executeControl({ ...request, code: code('rm') })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(await readFile(target, 'utf8')).toBe('test')
    approve.mockResolvedValueOnce(true)
    await service.executeControl({ ...request, code: code('rm') })
    expect(execute).toHaveBeenCalledTimes(2)
    await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await service.executeControl({ ...request, code: code('rm') })
    expect(approve).toHaveBeenCalledTimes(3)
    expect(execute).toHaveBeenCalledTimes(2)
    expect(await readFile(keep, 'utf8')).toBe('keep')
  })
  it.skipIf(process.platform === 'win32').each([
    ['nice', 'spawnSync'],
    ['nice', 'execSync'],
    ['nohup', 'spawnSync'],
    ['nohup', 'execSync']
  ] as const)('gates real %s %s payloads once', async (wrapper, method) => {
    const { service, execute, request } = await harness()
    const target = join(request.workspaceCwd, 'wrapped-target.txt')
    const keep = join(request.workspaceCwd, 'keep.txt')
    await writeFile(target, 'test')
    await writeFile(keep, 'keep')
    execute.mockImplementation(async (execution) => {
      const { stdout, stderr } = await promisify(execFile)(
        process.execPath,
        ['-e', execution.code],
        {
          cwd: execution.cwd,
          timeout: 5000
        }
      )
      return {
        status: 'completed',
        stdout,
        stderr,
        traceback: '',
        cwdAfter: execution.cwd,
        outputs: [],
        kernelDispatched: true
      }
    })
    const approve = vi.fn(async () => false)
    service.setExecutionApproval(approve)
    const code = (payload: string[]): string => {
      const argv = [wrapper, ...(wrapper === 'nice' ? ['-n', '5'] : ['--']), ...payload]
      return method === 'spawnSync'
        ? `const cp=require('child_process'); const result=cp.spawnSync(${JSON.stringify(argv[0])}, ${JSON.stringify(argv.slice(1))}, {encoding:'utf8'}); if(result.status) throw Error(result.stderr); console.log(result.stdout)`
        : `const cp=require('child_process'); console.log(cp.execSync(${JSON.stringify(argv.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(' '))}).toString())`
    }
    await service.executeControl({ ...request, code: code(['cat', target]) })
    expect(approve).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(await readFile(target, 'utf8')).toBe('test')
    await service.executeControl({ ...request, code: code(['rm', target]) })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(await readFile(target, 'utf8')).toBe('test')
    approve.mockResolvedValueOnce(true)
    await service.executeControl({ ...request, code: code(['rm', target]) })
    expect(execute).toHaveBeenCalledTimes(2)
    await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await service.executeControl({ ...request, code: code(['rm', target]) })
    expect(approve).toHaveBeenCalledTimes(3)
    expect(execute).toHaveBeenCalledTimes(2)
    expect(await readFile(keep, 'utf8')).toBe('keep')
  })
  it.each(['restore', 'branch', 'stash'] as const)(
    'gates real Git %s effects before Node dispatch',
    async (effect) => {
      const { service, execute, request } = await harness()
      const git = async (args: string[]): Promise<string> => {
        const { stdout } = await promisify(execFile)(
          'git',
          [
            '-c',
            'core.hooksPath=',
            '-c',
            'commit.gpgsign=false',
            '-c',
            'user.name=Notebook Test',
            '-c',
            'user.email=notebook@example.invalid',
            ...args
          ],
          { cwd: request.workspaceCwd, timeout: 5000 }
        )
        return stdout.trim()
      }
      const target = join(request.workspaceCwd, 'tracked.txt')
      const keep = join(request.workspaceCwd, 'keep.txt')
      await git(['init', '--quiet'])
      await writeFile(target, 'base')
      await writeFile(keep, 'keep')
      await git(['add', '--', 'tracked.txt'])
      await git(['commit', '--quiet', '-m', 'base'])
      await writeFile(target, 'changed')
      await git(['add', '--', 'tracked.txt'])
      if (effect === 'branch') await git(['branch', 'topic'])
      if (effect === 'stash') await git(['stash', 'push', '--quiet', '--', 'tracked.txt'])
      execute.mockImplementation(async (execution) => {
        const { stdout, stderr } = await promisify(execFile)(
          process.execPath,
          ['-e', execution.code],
          { cwd: execution.cwd, timeout: 5000 }
        )
        return {
          status: 'completed',
          stdout,
          stderr,
          traceback: '',
          cwdAfter: execution.cwd,
          outputs: [],
          kernelDispatched: true
        }
      })
      const code = (args: string[]): string =>
        `const cp=require('child_process'); const result=cp.spawnSync('git', ${JSON.stringify(['-C', request.workspaceCwd, ...args])}, {encoding:'utf8'}); if(result.status) throw Error(result.stderr); console.log(result.stdout)`
      const ordinary =
        effect === 'restore'
          ? ['restore', '--staged', '--', 'tracked.txt']
          : effect === 'branch'
            ? ['branch', '--list']
            : ['stash', 'list']
      const destructive =
        effect === 'restore'
          ? ['restore', '--', 'tracked.txt']
          : effect === 'branch'
            ? ['branch', '-D', 'topic']
            : ['stash', 'clear']
      const exists = async (): Promise<boolean> =>
        effect === 'restore'
          ? (await readFile(target, 'utf8')) === 'changed'
          : effect === 'branch'
            ? (await git(['branch', '--list', 'topic'])) === 'topic'
            : (await git(['stash', 'list'])).length > 0
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      await service.executeControl({ ...request, code: code(ordinary) })
      expect(approve).not.toHaveBeenCalled()
      expect(await exists()).toBe(true)
      if (effect === 'restore') expect(await git(['show', ':tracked.txt'])).toBe('base')
      await service.executeControl({ ...request, code: code(destructive) })
      expect(execute).toHaveBeenCalledTimes(1)
      expect(await exists()).toBe(true)
      approve.mockResolvedValueOnce(true)
      await service.executeControl({ ...request, code: code(destructive) })
      expect(execute).toHaveBeenCalledTimes(2)
      expect(await exists()).toBe(false)
      await service.executeControl({ ...request, code: code(destructive) })
      expect(approve).toHaveBeenCalledTimes(3)
      expect(execute).toHaveBeenCalledTimes(2)
      expect(await readFile(keep, 'utf8')).toBe('keep')
    }
  )
  it
    .skipIf(process.platform === 'win32')
    .each([
      'os.system(COMMAND)',
      'os.popen(COMMAND).read()',
      'subprocess.getoutput(COMMAND)',
      'subprocess.getstatusoutput(COMMAND)',
      'subprocess.run(COMMAND, shell=True, check=True)'
    ])('reviews actual Python shell source once: %s', async (template) => {
    const { service, execute, request } = await harness()
    const approve = vi.fn(async () => false)
    service.setExecutionApproval(approve)
    const code = (command: string): string =>
      `import os, subprocess; ${template.replace('COMMAND', JSON.stringify(command))}`
    await service.execute({ ...request, code: code('echo hello') })
    expect(approve).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(1)
    await expect(service.execute({ ...request, code: code('rm target.txt') })).rejects.toThrow(
      'one-time approval'
    )
    expect(execute).toHaveBeenCalledTimes(1)
    approve.mockResolvedValueOnce(true)
    await service.execute({ ...request, code: code('rm target.txt') })
    expect(execute).toHaveBeenCalledTimes(2)
    await expect(service.execute({ ...request, code: code('rm target.txt') })).rejects.toThrow(
      'one-time approval'
    )
    expect(approve).toHaveBeenCalledTimes(3)
    expect(execute).toHaveBeenCalledTimes(2)
  })
  it.skipIf(process.platform === 'win32').each(['system', 'base::system', 'read'])(
    'preserves streamed R shell admission: %s',
    async (method) => {
      const { service, execute, request } = await harness()
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      const run = async (command: string): Promise<void> => {
        const cell = await service.beginCodeCell({ ...request, language: 'r' })
        await service.appendCodeCell({
          ...request,
          ...cell,
          delta: `read <- base::system; ${method}(${JSON.stringify(command)}, intern=TRUE)`
        })
        await service.finishCodeCell({ ...request, ...cell })
        await service.runCell({ ...request, cellId: cell.cellId })
      }
      await run('echo hello')
      expect(approve).not.toHaveBeenCalled()
      expect(execute).toHaveBeenCalledTimes(1)
      await expect(run('rm target.txt')).rejects.toThrow('one-time approval')
      expect(execute).toHaveBeenCalledTimes(1)
      approve.mockResolvedValueOnce(true)
      await run('rm target.txt')
      expect(execute).toHaveBeenCalledTimes(2)
      await expect(run('rm target.txt')).rejects.toThrow('one-time approval')
      expect(approve).toHaveBeenCalledTimes(3)
      expect(execute).toHaveBeenCalledTimes(2)
    }
  )
  it.skipIf(process.platform === 'win32').each(['exec', 'execSync'])(
    'gates a real Node %s shell deletion before dispatch',
    async (method) => {
      const { service, execute, request } = await harness()
      const target = join(request.workspaceCwd, 'shell-target.txt')
      const keep = join(request.workspaceCwd, 'keep.txt')
      await writeFile(target, 'test')
      await writeFile(keep, 'keep')
      execute.mockImplementation(async (execution) => {
        const { stdout, stderr } = await promisify(execFile)(
          process.execPath,
          ['-e', execution.code],
          {
            cwd: execution.cwd,
            timeout: 5000
          }
        )
        return {
          status: 'completed',
          stdout,
          stderr,
          traceback: '',
          cwdAfter: execution.cwd,
          outputs: [],
          kernelDispatched: true
        }
      })
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      const code = (command: string): string =>
        `const cp=require('child_process'); cp.${method}(${JSON.stringify(command.replace('shell-target.txt', `'${target.replaceAll("'", "'\\''")}'`))}${method === 'exec' ? ', function done(error,out){if(error) throw error; console.log(out)}' : ''})`
      await service.executeControl({ ...request, code: code('cat shell-target.txt') })
      expect(approve).not.toHaveBeenCalled()
      await service.executeControl({ ...request, code: code('rm shell-target.txt') })
      expect(execute).toHaveBeenCalledTimes(1)
      expect(await readFile(target, 'utf8')).toBe('test')
      approve.mockResolvedValueOnce(true)
      await service.executeControl({ ...request, code: code('rm shell-target.txt') })
      expect(execute).toHaveBeenCalledTimes(2)
      await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      await service.executeControl({ ...request, code: code('rm shell-target.txt') })
      expect(approve).toHaveBeenCalledTimes(3)
      expect(execute).toHaveBeenCalledTimes(2)
      expect(await readFile(keep, 'utf8')).toBe('keep')
    }
  )
  const nestedProcessRoutes = [
    'Function.prototype.call.call(cp.execFileSync,null,ARGV)',
    'Function.prototype.apply.call(cp.execFileSync,null,[ARGV])',
    'Reflect.apply(Function.prototype.call,cp.execFileSync,[null,ARGV])',
    'Reflect.apply(Function.prototype.apply,cp.execFileSync,[null,[ARGV]])',
    'const run=Function.prototype.apply.bind(cp.execFileSync,null);run([ARGV])',
    'const run=Function.prototype.apply.bind(cp.execFileSync,null);run.call(null,[ARGV])',
    'const run=Function.prototype.apply.bind(cp.execFileSync,null);Reflect.apply(run,null,[[ARGV]])',
    'const run=Function.prototype.apply.bind(cp.execFileSync,null);run.bind(null)([ARGV])'
  ]
  const nestedProcessSource = (route: string, argv: string): string => {
    const statements = route.split(';')
    const expression = statements.pop()!
    return [
      'const cp=require("child_process")',
      ...statements,
      `process.stdout.write((${expression}).toString())`
    ]
      .join(';')
      .replaceAll('ARGV', argv)
  }
  it.each(nestedProcessRoutes)(
    'runs real nested process forwarding and gates deletion once: %s',
    async (route) => {
      const { service, execute, request } = await harness()
      const target = join(request.workspaceCwd, 'nested-process-target.txt')
      const keep = join(request.workspaceCwd, 'keep.txt')
      await writeFile(target, 'original')
      await writeFile(keep, 'keep')
      execute.mockImplementation(async (execution) => {
        const { stdout, stderr } = await promisify(execFile)(
          process.execPath,
          ['-e', execution.code],
          { cwd: execution.cwd, timeout: 10000 }
        )
        return {
          status: 'completed',
          stdout,
          stderr,
          traceback: '',
          cwdAfter: execution.cwd,
          outputs: [],
          kernelDispatched: true
        }
      })
      const code = (danger: boolean): string => {
        const args = danger
          ? ['-e', `require('fs').unlinkSync(${JSON.stringify(target)})`]
          : ['--version']
        return nestedProcessSource(
          route,
          JSON.stringify(process.execPath.replaceAll('\\', '/')) + ',' + JSON.stringify(args)
        )
      }
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      await service.executeControl({ ...request, code: code(false) })
      expect(approve).not.toHaveBeenCalled()
      expect((await execute.mock.results[0].value).stdout.trim()).toBe(process.version)
      await service.executeControl({ ...request, code: code(true) })
      expect(approve).toHaveBeenCalledTimes(1)
      expect(execute).toHaveBeenCalledTimes(1)
      expect(await readFile(target, 'utf8')).toBe('original')
      approve.mockResolvedValueOnce(true)
      await service.executeControl({ ...request, code: code(true) })
      expect(execute).toHaveBeenCalledTimes(2)
      await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
      await writeFile(target, 'restored')
      await service.executeControl({ ...request, code: code(true) })
      expect(approve).toHaveBeenCalledTimes(3)
      expect(execute).toHaveBeenCalledTimes(2)
      expect(await readFile(target, 'utf8')).toBe('restored')
      expect(await readFile(keep, 'utf8')).toBe('keep')
    }
  )
  it.skipIf(process.platform === 'win32').each(nestedProcessRoutes.slice(4, 6))(
    'runs real bound apply echo without risk review: %s',
    async (route) => {
      const { service, execute, request } = await harness()
      execute.mockImplementation(async (execution) => {
        const { stdout, stderr } = await promisify(execFile)(
          process.execPath,
          ['-e', execution.code],
          { cwd: execution.cwd, timeout: 10000 }
        )
        return {
          status: 'completed',
          stdout,
          stderr,
          traceback: '',
          cwdAfter: execution.cwd,
          outputs: [],
          kernelDispatched: true
        }
      })
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      await service.executeControl({
        ...request,
        code: nestedProcessSource(route, '"echo",["hello"]')
      })
      expect(approve).not.toHaveBeenCalled()
      expect((await execute.mock.results[0].value).stdout).toBe('hello\n')
    }
  )
  it.each(['spawn', 'spawnSync', 'execFile', 'execFileSync'])(
    'bypasses ordinary Node %s argv and reviews deletion once',
    async (method) => {
      const { service, execute, request } = await harness()
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      const code = (command: string, args: string): string =>
        `const cp=require('child_process'); cp.${method}(${JSON.stringify(command)}, ${args})`
      await service.executeControl({ ...request, code: code('echo', '["hello"]') })
      expect(approve).not.toHaveBeenCalled()
      expect(execute).toHaveBeenCalledTimes(1)
      await service.executeControl({ ...request, code: code('rm', '["--", "target.txt"]') })
      expect(execute).toHaveBeenCalledTimes(1)
      approve.mockResolvedValueOnce(true)
      await service.executeControl({ ...request, code: code('rm', '["--", "target.txt"]') })
      expect(execute).toHaveBeenCalledTimes(2)
      await service.executeControl({ ...request, code: code('rm', '["--", "target.txt"]') })
      expect(approve).toHaveBeenCalledTimes(3)
      expect(execute).toHaveBeenCalledTimes(2)
    }
  )
  it.each(['system2', 'base::system2', 'launch'])(
    'preserves streamed R %s process admission',
    async (method) => {
      const { service, execute, request } = await harness()
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      const run = async (command: string, argument: string): Promise<void> => {
        const cell = await service.beginCodeCell({ ...request, language: 'r' })
        await service.appendCodeCell({
          ...request,
          ...cell,
          delta: `launch <- base::system2; ${method}("${command}", "${argument}", stdout=TRUE)`
        })
        await service.finishCodeCell({ ...request, ...cell })
        await service.runCell({ ...request, cellId: cell.cellId })
      }
      await run('echo', 'hello')
      expect(approve).not.toHaveBeenCalled()
      expect(execute).toHaveBeenCalledTimes(1)
      await expect(run('rm', 'target.txt')).rejects.toThrow('one-time approval')
      expect(execute).toHaveBeenCalledTimes(1)
      approve.mockResolvedValueOnce(true)
      await run('rm', 'target.txt')
      expect(execute).toHaveBeenCalledTimes(2)
      await expect(run('rm', 'target.txt')).rejects.toThrow('one-time approval')
      expect(approve).toHaveBeenCalledTimes(3)
      expect(execute).toHaveBeenCalledTimes(2)
    }
  )
  it.for([
    "cp.execFile('node', ['--version'], done)",
    "cp.execFile('node', ['--version'], {}, done)",
    "cp.exec('echo hello', done)"
  ])('gates actual completion callback deletion: %s', async (invocation, context) => {
    if (process.platform === 'win32' && invocation.startsWith('cp.exec(')) context.skip()
    const { service, execute, request } = await harness()
    const target = join(request.workspaceCwd, 'callback-target.txt')
    const keep = join(request.workspaceCwd, 'keep.txt')
    await writeFile(target, 'test')
    await writeFile(keep, 'keep')
    execute.mockImplementation(async (execution) => {
      const { stdout, stderr } = await promisify(execFile)(
        process.execPath,
        ['-e', execution.code],
        {
          cwd: execution.cwd,
          timeout: 5000
        }
      )
      return {
        status: 'completed',
        stdout,
        stderr,
        traceback: '',
        cwdAfter: execution.cwd,
        outputs: [],
        kernelDispatched: true
      }
    })
    const approve = vi.fn(async () => false)
    service.setExecutionApproval(approve)
    const code = (deleteFile: boolean): string =>
      `const cp=require('child_process'); const fs=require('fs'); const path=${JSON.stringify(target)};
       function done(error,stdout){if(error) throw error; ${deleteFile ? 'fs.unlinkSync(path)' : 'console.log(fs.readFileSync(path,"utf8"))'}}
       ${invocation}`
    await service.executeControl({ ...request, code: code(false) })
    expect(approve).not.toHaveBeenCalled()
    expect(await readFile(target, 'utf8')).toBe('test')
    await service.executeControl({ ...request, code: code(true) })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(await readFile(target, 'utf8')).toBe('test')
    approve.mockResolvedValueOnce(true)
    await service.executeControl({ ...request, code: code(true) })
    expect(execute).toHaveBeenCalledTimes(2)
    await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await service.executeControl({ ...request, code: code(true) })
    expect(approve).toHaveBeenCalledTimes(3)
    expect(execute).toHaveBeenCalledTimes(2)
    expect(await readFile(keep, 'utf8')).toBe('keep')
  })
  it.each(['run', 'call', 'check_call', 'check_output', 'Popen'])(
    'bypasses ordinary subprocess.%s argv and reviews deletion once',
    async (method) => {
      const { service, execute, request } = await harness()
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      const safe = `import subprocess; subprocess.${method}(["echo", "hello"]${method === 'run' ? ', check=True' : ''})`
      const risky = `import subprocess; subprocess.${method}(["rm", "--", "target.txt"])`
      await service.execute({ ...request, code: safe })
      expect(approve).not.toHaveBeenCalled()
      expect(execute).toHaveBeenCalledTimes(1)
      await expect(service.execute({ ...request, code: risky })).rejects.toThrow(
        'one-time approval'
      )
      expect(execute).toHaveBeenCalledTimes(1)
      approve.mockResolvedValueOnce(true)
      await service.execute({ ...request, code: risky })
      expect(execute).toHaveBeenCalledTimes(2)
      await expect(service.execute({ ...request, code: risky })).rejects.toThrow(
        'one-time approval'
      )
      expect(approve).toHaveBeenCalledTimes(3)
      expect(execute).toHaveBeenCalledTimes(2)
    }
  )
  it.each([
    [
      'python',
      'import os\nselected = DANGER\nfor item in []:\n    selected = open\nselected("target.txt")',
      'open',
      'os.unlink'
    ],
    [
      'python',
      'import os\nfor selected in [open, DANGER]:\n    selected("target.txt")',
      'open',
      'os.unlink'
    ],
    [
      'python',
      'import os\nselected = open\nfor item in [0, 1]:\n    selected("target.txt")\n    selected = DANGER',
      'open',
      'os.unlink'
    ],
    [
      'python',
      'import os\nselected = open\ntry:\n    selected = DANGER\n    may_fail()\n    selected = open\nexcept Exception:\n    pass\nselected("target.txt")',
      'open',
      'os.unlink'
    ],
    [
      'r',
      'selected <- DANGER\nfor (item in list()) { selected <- readLines }\nselected("target.txt")',
      'readLines',
      'unlink'
    ],
    [
      'r',
      'for (selected in list(readLines, DANGER)) { selected("target.txt") }',
      'readLines',
      'unlink'
    ]
  ] as const)(
    'preserves %s loop/exception one-shot admission: %s',
    async (language, template, reader, danger) => {
      const { service, execute, request } = await harness()
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      const run = async (target: string): Promise<void> => {
        const code = template.replaceAll('DANGER', target)
        if (language === 'python') {
          await service.execute({ ...request, code })
          return
        }
        const cell = await service.beginCodeCell({ ...request, language })
        await service.appendCodeCell({ ...request, ...cell, delta: code })
        await service.finishCodeCell({ ...request, ...cell })
        await service.runCell({ ...request, cellId: cell.cellId })
      }
      await run(reader)
      expect(approve).not.toHaveBeenCalled()
      expect(execute).toHaveBeenCalledTimes(1)
      await expect(run(danger)).rejects.toThrow('one-time approval')
      expect(execute).toHaveBeenCalledTimes(1)
      approve.mockResolvedValueOnce(true)
      await run(danger)
      expect(execute).toHaveBeenCalledTimes(2)
      await expect(run(danger)).rejects.toThrow('one-time approval')
      expect(approve).toHaveBeenCalledTimes(3)
      expect(execute).toHaveBeenCalledTimes(2)
    }
  )
  it.each([
    'let selected = fs.readFileSync; for (const item of [0, 1]) { selected(path); selected = DANGER; }',
    'for (const selected of [fs.readFileSync, DANGER]) { selected(path); }',
    'let selected = fs.readFileSync; try { selected = DANGER; throw new Error("probe"); selected = fs.readFileSync; } catch (error) {} selected(path)'
  ])('stops real Node loop/exception deletion before dispatch: %s', async (template) => {
    const { service, execute, request } = await harness()
    const target = join(request.workspaceCwd, 'flow-target.txt')
    const keep = join(request.workspaceCwd, 'keep.txt')
    await writeFile(target, 'test')
    await writeFile(keep, 'keep')
    execute.mockImplementation(async (execution) => {
      const { stdout, stderr } = await promisify(execFile)(
        process.execPath,
        ['-e', execution.code],
        { cwd: execution.cwd, timeout: 5000 }
      )
      return {
        status: 'completed',
        stdout,
        stderr,
        traceback: '',
        cwdAfter: execution.cwd,
        outputs: [],
        kernelDispatched: true
      }
    })
    const approve = vi.fn(async () => false)
    service.setExecutionApproval(approve)
    const code = (callee: string): string =>
      `const fs = require("node:fs"); const path = ${JSON.stringify(target)}; ` +
      template.replaceAll('DANGER', callee)
    await service.executeControl({ ...request, code: code('fs.readFileSync') })
    expect(approve).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(1)
    await service.executeControl({ ...request, code: code('fs.unlinkSync') })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(await readFile(target, 'utf8')).toBe('test')
    approve.mockResolvedValueOnce(true)
    await service.executeControl({ ...request, code: code('fs.unlinkSync') })
    expect(execute).toHaveBeenCalledTimes(2)
    await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await service.executeControl({ ...request, code: code('fs.unlinkSync') })
    expect(approve).toHaveBeenCalledTimes(3)
    expect(execute).toHaveBeenCalledTimes(2)
    expect(await readFile(keep, 'utf8')).toBe('keep')
  })
  it.each([
    ['r', 'selected <- DANGER\nif (FALSE) { selected <- readLines }\nselected("target.txt")'],
    [
      'r',
      'if (enabled) { selected <- DANGER } else { selected <- readLines }\nlapply("target.txt", selected)'
    ],
    ['r', 'selected <- DANGER\nif (enabled) { selected <- readLines }\nselected("target.txt")']
  ] as const)('preserves streamed %s conditional admission: %s', async (language, template) => {
    const { service, execute, request } = await harness()
    const approve = vi.fn(async () => false)
    service.setExecutionApproval(approve)
    const run = async (target: string): Promise<void> => {
      const cell = await service.beginCodeCell({ ...request, language })
      await service.appendCodeCell({
        ...request,
        ...cell,
        delta: template.replaceAll('DANGER', target)
      })
      await service.finishCodeCell({ ...request, ...cell })
      await service.runCell({ ...request, cellId: cell.cellId })
    }
    await run('readLines')
    expect(approve).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(1)
    await expect(run('unlink')).rejects.toThrow('one-time approval')
    expect(execute).toHaveBeenCalledTimes(1)
    approve.mockResolvedValueOnce(true)
    await run('unlink')
    expect(execute).toHaveBeenCalledTimes(2)
    await expect(run('unlink')).rejects.toThrow('one-time approval')
    expect(approve).toHaveBeenCalledTimes(3)
    expect(execute).toHaveBeenCalledTimes(2)
  })
  it.each([
    'selected = DANGER; if (false) { selected = fs.readFileSync; } selected(path)',
    'if (enabled) { selected = DANGER; } else { selected = fs.readFileSync; } selected(path)',
    'selected = DANGER; if (enabled) { selected = fs.readFileSync; } selected.call(null, path)',
    'if (false) { selected = fs.readFileSync; } else if (true) { selected = DANGER; } else { selected = fs.readFileSync; } Reflect.apply(selected, null, [path])'
  ])('gates a real Node conditional deletion before dispatch: %s', async (template) => {
    const { service, execute, request } = await harness()
    const target = join(request.workspaceCwd, 'branch-target.txt')
    const keep = join(request.workspaceCwd, 'keep.txt')
    await writeFile(target, 'test')
    await writeFile(keep, 'keep')
    execute.mockImplementation(async (execution) => {
      const { stdout, stderr } = await promisify(execFile)(
        process.execPath,
        ['-e', execution.code],
        { cwd: execution.cwd, timeout: 5000 }
      )
      return {
        status: 'completed',
        stdout,
        stderr,
        traceback: '',
        cwdAfter: execution.cwd,
        outputs: [],
        kernelDispatched: true
      }
    })
    const approve = vi.fn(async () => false)
    service.setExecutionApproval(approve)
    const code = (callee: string): string =>
      `const fs = require("node:fs"); const path = ${JSON.stringify(target)}; const enabled = ${template.startsWith('if (enabled)')}; let selected; ` +
      template.replaceAll('DANGER', callee)
    await service.executeControl({ ...request, code: code('fs.readFileSync') })
    expect(approve).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(1)
    await service.executeControl({ ...request, code: code('fs.unlinkSync') })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(await readFile(target, 'utf8')).toBe('test')
    approve.mockResolvedValueOnce(true)
    await service.executeControl({ ...request, code: code('fs.unlinkSync') })
    expect(execute).toHaveBeenCalledTimes(2)
    await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await service.executeControl({ ...request, code: code('fs.unlinkSync') })
    expect(approve).toHaveBeenCalledTimes(3)
    expect(execute).toHaveBeenCalledTimes(2)
    expect(await readFile(keep, 'utf8')).toBe('keep')
  })
  it.each([
    'selected = DANGER\nif False:\n    selected = open',
    'if enabled:\n    selected = DANGER\nelse:\n    selected = open',
    'selected = DANGER\nif enabled:\n    selected = open',
    'if False:\n    selected = open\nelif True:\n    selected = DANGER\nelse:\n    selected = open',
    'if enabled:\n    selected = open\nelif other_flag:\n    selected = DANGER\nelse:\n    selected = open'
  ])('admits conditional Python readers and approves deletion only once: %s', async (branch) => {
    const { service, execute, request } = await harness()
    const approve = vi.fn(async () => false)
    service.setExecutionApproval(approve)
    const source = (target: string): string =>
      'import os\n' + branch.replaceAll('DANGER', target) + '\nselected("target.txt")'
    await service.execute({ ...request, code: source('open') })
    expect(approve).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(1)
    await expect(service.execute({ ...request, code: source('os.unlink') })).rejects.toThrow(
      'one-time approval'
    )
    expect(execute).toHaveBeenCalledTimes(1)
    approve.mockResolvedValueOnce(true)
    await service.execute({ ...request, code: source('os.unlink') })
    expect(execute).toHaveBeenCalledTimes(2)
    await expect(service.execute({ ...request, code: source('os.unlink') })).rejects.toThrow(
      'one-time approval'
    )
    expect(approve).toHaveBeenCalledTimes(3)
    expect(execute).toHaveBeenCalledTimes(2)
  })
  it.each([
    ...[
      'list(itertools.starmap(callback, [(target,)]))',
      'list(itertools.dropwhile(callback, [target]))',
      'list(itertools.takewhile(callback, [target]))',
      'list(itertools.filterfalse(callback, [target]))',
      'list(itertools.accumulate([target, target], callback))',
      'list(itertools.accumulate([target, target], func=callback))',
      'list(itertools.accumulate([target, target], **{"func": callback}))',
      'list(itertools.groupby([target], callback))',
      'list(itertools.groupby([target], key=callback))',
      'list(itertools.groupby([target], **{"key": callback}))',
      'list(iter(callback, 0))',
      'list(builtins.iter(callback, 0))',
      'from itertools import starmap as consume\nlist(consume(callback, [(target,)]))',
      'consume = itertools.groupby\nlist(consume([target], key=callback))',
      'operator.methodcaller("__call__")(callback)'
    ].map((invocation) => [invocation, invocation, 'ordinary callback']),
    ...['open', 'builtins.open', 'io.open'].flatMap((target) => [
      [
        `${target}(target, opener=callback).read()`,
        `${target}(target, opener=callback).read()`,
        'opener'
      ],
      [
        `${target}(target, **{"opener": callback}).read()`,
        `${target}(target, **{"opener": callback}).read()`,
        'opener'
      ]
    ]),
    [
      'operator.methodcaller("read_text")(path)',
      'operator.methodcaller("unlink")(path)',
      'method wrapper'
    ],
    [
      'invoke = operator.methodcaller("read_text")\ninvoke(path)',
      'invoke = operator.methodcaller("unlink")\ninvoke(path)',
      'saved wrapper'
    ],
    [
      'operator.methodcaller("stat", target)(os)',
      'operator.methodcaller("unlink", target)(os)',
      'module receiver'
    ],
    [
      'with open(target) as handle:\n    operator.methodcaller("read")(handle)',
      'operator.methodcaller("remove", target)(os)',
      'handle receiver'
    ]
  ])(
    'keeps Python safe counterparts prompt-free and admits effects once: %s',
    async (safe, risky, kind) => {
      const { service, execute, request } = await harness()
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      const prelude =
        'import os\nimport itertools\nimport operator\nimport builtins\nimport io\nfrom pathlib import Path\ntarget = "target.txt"\npath = Path(target)\n'
      const callback = (body: string): string =>
        kind === 'opener'
          ? `def callback(file, flags):\n    ${body}\n    return os.open(file, flags)\n`
          : `def callback(*args):\n    ${body}\n    return 0\n`
      await service.execute({
        ...request,
        code: prelude + callback('print(open(target).read())') + safe
      })
      expect(approve).not.toHaveBeenCalled()
      expect(execute).toHaveBeenCalledTimes(1)
      const code = prelude + callback('os.unlink(target)') + risky
      await expect(service.execute({ ...request, code })).rejects.toThrow('one-time approval')
      expect(execute).toHaveBeenCalledTimes(1)
      approve.mockResolvedValueOnce(true)
      await service.execute({ ...request, code })
      expect(execute).toHaveBeenCalledTimes(2)
      await expect(service.execute({ ...request, code })).rejects.toThrow('one-time approval')
      expect(approve).toHaveBeenCalledTimes(3)
      expect(execute).toHaveBeenCalledTimes(2)
    }
  )
  it.each([
    'import itertools\nlist(itertools.repeat(os.unlink, 2))',
    'import itertools\nlist(itertools.groupby([os.unlink]))',
    'import itertools\nlist(itertools.zip_longest([], [1], fillvalue=os.unlink))',
    'import operator\ninvoke = operator.methodcaller("unlink")\nprint(invoke)',
    'import operator\noperator.methodcaller("remove", "a")(["a", "b"])',
    'open(3, opener=os.unlink).read()',
    'import io\nio.open(3, **{"opener": os.unlink}).read()',
    'import operator\ninvoke = operator.methodcaller(\n# named method\n"read"\n)\nwith open("target.txt") as handle:\n    invoke(handle)'
  ])(
    'does not request host approval for stored functions, data or descriptor reads: %s',
    async (code) => {
      const { service, execute, request } = await harness()
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      await service.execute({ ...request, code: 'import os\n' + code })
      expect(approve).not.toHaveBeenCalled()
      expect(execute).toHaveBeenCalledTimes(1)
    }
  )

  it.each([
    [
      'global timeout',
      'await new Promise(done => { function run() { OP; done() }; setTimeout(run, 0) })'
    ],
    [
      'qualified timeout',
      'await new Promise(done => { function run() { OP; done() }; globalThis.setTimeout(run, 0) })'
    ],
    [
      'module immediate',
      'await new Promise(done => { function run() { OP; done() }; timers.setImmediate(run) })'
    ],
    [
      'module interval',
      'await new Promise(done => { let handle; function run() { timers.clearInterval(handle); OP; done() }; handle = timers.setInterval(run, 0) })'
    ],
    [
      'process next tick',
      'await new Promise(done => { function run() { OP; done() }; process.nextTick(run) })'
    ],
    [
      'saved timeout',
      'await new Promise(done => { function run() { OP; done() }; const saved = setTimeout; saved(run, 0) })'
    ],
    [
      'forwarded timeout',
      'await new Promise(done => { function run() { OP; done() }; setTimeout.apply(null, [run, 0]) })'
    ],
    [
      'reflected timeout',
      'await new Promise(done => { function run() { OP; done() }; Reflect.apply(setTimeout, null, [run, 0]) })'
    ],
    [
      'bound next tick',
      'await new Promise(done => { function run() { OP; done() }; const saved = process.nextTick.bind(process); saved(run) })'
    ],
    [
      'reflected Promise',
      'function run(done) { OP; done() }; await Reflect.construct(Promise, [run])'
    ],
    [
      'qualified reflected Promise',
      'function run(done) { OP; done() }; await globalThis.Reflect.construct(globalThis.Promise, [run])'
    ],
    [
      'forwarded reflected Promise',
      'function run(done) { OP; done() }; await Reflect.construct.apply(Reflect, [Promise, [run]])'
    ],
    [
      'nested reflected Promise',
      'function run(done) { OP; done() }; await Reflect.apply(Reflect.construct, Reflect, [Promise, [run]])'
    ],
    [
      'captured Script constructor',
      'let Constructor=vm.Script;const prepared=new Constructor((Constructor=Array,"OP"));prepared.runInNewContext({fs, target, console})'
    ],
    [
      'captured bound Script constructor',
      'let Constructor=vm.Script;const prepared=new (Constructor.bind(null))((Constructor=Array,"OP"));prepared.runInNewContext({fs, target, console})'
    ],
    [
      'captured reflected Script constructor',
      'let Constructor=vm.Script;const prepared=Reflect.construct(Constructor,[(Constructor=Array,"OP")]);prepared.runInNewContext({fs, target, console})'
    ],
    [
      'captured called Script constructor',
      'let Constructor=vm.Script;const prepared=Reflect.construct.call(null,Constructor,[(Constructor=Array,"OP")]);prepared.runInNewContext({fs, target, console})'
    ],
    [
      'captured forwarded Script constructor',
      'let Constructor=vm.Script;const prepared=Reflect.apply(Reflect.construct,null,[Constructor,[(Constructor=Array,"OP")]]);prepared.runInNewContext({fs, target, console})'
    ],
    [
      'called bound Script',
      'const Constructor=Function.prototype.bind.call(vm.Script,null);const prepared=new Constructor("OP");prepared.runInNewContext({fs, target, console})'
    ],
    [
      'applied bound Script',
      'const Constructor=Function.prototype.bind.apply(vm.Script,[null]);const prepared=new Constructor("OP");prepared.runInNewContext({fs, target, console})'
    ],
    [
      'reflected bound Script',
      'const Constructor=Reflect.apply(Function.prototype.bind,vm.Script,[null]);const prepared=new Constructor("OP");prepared.runInNewContext({fs, target, console})'
    ],
    [
      'nested call constructed Script',
      'const prepared=Reflect.apply(Function.prototype.call,Reflect.construct,[null,vm.Script,["OP"]]);prepared.runInNewContext({fs, target, console})'
    ],
    [
      'nested apply constructed Script',
      'const prepared=Function.prototype.apply.call(Reflect.construct,null,[vm.Script,["OP"]]);prepared.runInNewContext({fs, target, console})'
    ],
    [
      'reflected Script',
      'const prepared = Reflect.construct(vm.Script, ["OP"]); prepared.runInNewContext({fs, target, console})'
    ],
    [
      'forwarded reflected Script',
      'const prepared = Reflect.construct.call(Reflect, vm.Script, ["OP"]); prepared.runInNewContext({fs, target, console})'
    ],
    [
      'nested reflected Script',
      'const prepared = Reflect.apply(Reflect.construct, Reflect, [vm.Script, ["OP"]]); prepared.runInNewContext({fs, target, console})'
    ]
  ])(
    'runs real %s readers without approval but admits deletion only once',
    async (_label, template) => {
      const { service, execute, request } = await harness()
      const target = join(request.workspaceCwd, 'scheduled-target.txt')
      const sentinel = join(request.workspaceCwd, 'keep.txt')
      await writeFile(target, 'scheduled reader')
      await writeFile(sentinel, 'keep')
      execute.mockImplementation(async (execution) => {
        // Match the REPL's exposed globals. Timer APIs beyond setTimeout are accessed via require.
        const bootstrap = `const vm = require("node:vm"); Promise.resolve(vm.runInNewContext(${JSON.stringify(`(async () => { ${execution.code} })()`)}, {console, process, require, setTimeout})).catch(error => { console.error(error); process.exitCode = 1 })`
        const { stdout, stderr } = await promisify(execFile)(process.execPath, ['-e', bootstrap], {
          cwd: execution.cwd,
          timeout: 5_000
        })
        return {
          status: 'completed',
          stdout,
          stderr,
          traceback: '',
          cwdAfter: execution.cwd,
          outputs: [],
          kernelDispatched: true
        }
      })
      const definitions = `const fs = require("fs"); const timers = require("node:timers"); const vm = require("node:vm"); const target = ${JSON.stringify(target)};`
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      // VM run methods are explicit nested execution even with a reader payload. The prompt-free
      // contrast is compilation of the destructive payload, cache creation and a direct file read.
      const reader = template.includes('vm.Script')
        ? template
            .replace('OP', 'fs.unlinkSync(target)')
            .replace(
              'prepared.runInNewContext({fs, target, console})',
              "prepared.createCachedData(); console.log(fs.readFileSync(target, 'utf8'))"
            )
        : template.replace('OP', "console.log(fs.readFileSync(target, 'utf8'))")
      const reading = `${definitions} ${reader}`
      await service.executeControl({ ...request, code: reading })
      expect(approve).not.toHaveBeenCalled()
      expect(execute).toHaveBeenCalledTimes(1)
      expect((await execute.mock.results[0].value).stdout).toBe('scheduled reader\n')
      const code = `${definitions} ${template.replace('OP', 'fs.unlinkSync(target)')}`
      await service.executeControl({ ...request, code })
      expect(approve).toHaveBeenCalledTimes(1)
      expect(execute).toHaveBeenCalledTimes(1)
      expect(await readFile(target, 'utf8')).toBe('scheduled reader')
      approve.mockResolvedValueOnce(true)
      await service.executeControl({ ...request, code })
      expect(execute).toHaveBeenCalledTimes(2)
      await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      await service.executeControl({ ...request, code })
      expect(approve).toHaveBeenCalledTimes(3)
      expect(execute).toHaveBeenCalledTimes(2)
      expect(await readFile(sentinel, 'utf8')).toBe('keep')
    }
  )
  it.each([
    'const values = require("node:timers/promises"); const value = await values.setTimeout(0, fs.unlinkSync); console.log(typeof value)',
    'const values = require("node:timers/promises"); const value = await values.setImmediate(fs.unlinkSync); console.log(typeof value)',
    'const values = require("node:timers/promises"); for await (const value of values.setInterval(1, fs.unlinkSync)) {console.log(typeof value); break}',
    'const value = Reflect.construct(Array, [fs.unlinkSync]); console.log(typeof value[0])'
  ])(
    'does not invoke or prompt for function-valued timer/constructor data: %s',
    async (invocation) => {
      const { service, execute, request } = await harness()
      const target = join(request.workspaceCwd, 'function-data.txt')
      await writeFile(target, 'keep')
      execute.mockImplementation(async (execution) => {
        const { stdout, stderr } = await promisify(execFile)(
          process.execPath,
          [
            '-e',
            `(async () => {${execution.code}})().catch(error => {console.error(error); process.exitCode = 1})`
          ],
          { cwd: execution.cwd, timeout: 5_000 }
        )
        return {
          status: 'completed',
          stdout,
          stderr,
          traceback: '',
          cwdAfter: execution.cwd,
          outputs: [],
          kernelDispatched: true
        }
      })
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      await service.executeControl({ ...request, code: `const fs = require("fs"); ${invocation}` })
      expect(approve).not.toHaveBeenCalled()
      expect(execute).toHaveBeenCalledTimes(1)
      expect((await execute.mock.results[0].value).stdout).toBe('function\n')
      expect(await readFile(target, 'utf8')).toBe('keep')
    }
  )

  it.each([
    ['module context', 'vm.runInContext(payload, context, { timeout: 1000 })'],
    ['module new context', 'vm.runInNewContext(payload, { fs, target }, { timeout: 1000 })'],
    ['module this context', 'vm.runInThisContext(payload, { timeout: 1000 })'],
    ['compiled context', 'prepared.runInContext(context, { timeout: 1000 })'],
    [
      'bound compiled context',
      'const launch = prepared.runInNewContext.bind(prepared); launch({ fs, target }, { timeout: 1000 })'
    ],
    [
      'forwarded compiled context',
      'Reflect.apply(prepared.runInThisContext, prepared, [{ timeout: 1000 }])'
    ]
  ])('compiles without approval but gates actual VM execution: %s', async (_label, invocation) => {
    const { service, execute, request } = await harness()
    const marker = join(request.workspaceCwd, 'vm-target.txt')
    const sentinel = join(request.workspaceCwd, 'keep.txt')
    await writeFile(marker, 'compile without execution')
    await writeFile(sentinel, 'keep')
    execute.mockImplementation(async (execution) => {
      const { stdout, stderr } = await promisify(execFile)(
        process.execPath,
        ['-e', execution.code],
        {
          cwd: execution.cwd,
          timeout: 5_000
        }
      )
      return {
        status: 'completed',
        stdout,
        stderr,
        traceback: '',
        cwdAfter: execution.cwd,
        outputs: [],
        kernelDispatched: true
      }
    })
    const approve = vi.fn(async () => false)
    service.setExecutionApproval(approve)
    const definitions = `const fs = require("fs"); const vm = require("node:vm"); const target = ${JSON.stringify(marker)}; globalThis.fs = fs; globalThis.target = target; const context = vm.createContext({ fs, target }); const payload = "fs.unlinkSync(target)"; const prepared = new vm.Script(payload);`
    await service.executeControl({
      ...request,
      code: `${definitions} prepared.createCachedData(); console.log(fs.readFileSync(target, "utf8"))`
    })
    expect(approve).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(1)
    expect((await execute.mock.results[0].value).stdout).toBe('compile without execution\n')
    const code = `${definitions} ${invocation}`
    await service.executeControl({ ...request, code })
    expect(approve).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(await readFile(marker, 'utf8')).toBe('compile without execution')
    approve.mockResolvedValueOnce(true)
    await service.executeControl({ ...request, code })
    expect(execute).toHaveBeenCalledTimes(2)
    await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await service.executeControl({ ...request, code })
    expect(approve).toHaveBeenCalledTimes(3)
    expect(execute).toHaveBeenCalledTimes(2)
    expect(await readFile(sentinel, 'utf8')).toBe('keep')
  })
  it('does not prompt for ordinary execution across fresh Sessions', async () => {
    const { service, execute, request } = await harness()
    const approve = vi.fn(async () => true)
    service.setExecutionApproval(approve)
    for (const sessionId of ['one', 'two'])
      await service.execute({ ...request, sessionId, code: 'print(1)' })
    expect(execute).toHaveBeenCalledTimes(2)
    expect(approve).not.toHaveBeenCalled()
  })

  it('dispatches chained reads without approval while still stopping a subsequent deletion', async () => {
    const { service, execute, request } = await harness()
    const approve = vi.fn(async () => false)
    service.setExecutionApproval(approve)
    await service.execute({
      ...request,
      code: 'import os\nprint(open(os.path.join(os.getcwd(), "a.txt")).read())'
    })
    expect(approve).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(1)
    await expect(service.execute({ ...request, code: 'os.unlink("a.txt")' })).rejects.toThrow(
      'one-time approval'
    )
    expect(approve).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it.each([
    [
      'computed callback',
      'const read = fs["readFileSync"]',
      'const handlers = { erase: fs.unlinkSync }; const method = "erase"; const erase = handlers[method]'
    ],
    [
      'bound callback',
      'const read = fs.readFileSync.bind(fs)',
      'const erase = fs.unlinkSync.bind(fs)'
    ],
    [
      'destructured callback',
      'const [read] = [fs.readFileSync]',
      'const [erase] = [fs.unlinkSync]'
    ],
    [
      'chained callback',
      'let read, alias; read = alias = fs.readFileSync',
      'let erase, alias; erase = alias = fs.unlinkSync'
    ],
    [
      'call forwarding',
      'const read = (path, encoding) => fs.readFileSync.call(fs, path, encoding)',
      'const erase = path => fs.unlinkSync.call(fs, path)'
    ],
    [
      'apply forwarding',
      'const read = (path, encoding) => fs.readFileSync.apply(fs, [path, encoding])',
      'const erase = path => fs.unlinkSync.apply(fs, [path])'
    ],
    [
      'Reflect.apply forwarding',
      'const read = (path, encoding) => Reflect.apply(fs.readFileSync, fs, [path, encoding])',
      'const erase = path => Reflect.apply(fs.unlinkSync, fs, [path])'
    ],
    [
      'quoted object destructuring',
      'const { "readFileSync": read } = fs',
      'const { "unlinkSync": erase } = fs'
    ],
    [
      'computed literal object destructuring',
      'const { ["readFileSync"]: read } = fs',
      'const { ["unlinkSync"]: erase } = fs'
    ],
    [
      'nested object destructuring',
      'const { promises: { readFile: read } } = fs',
      'const { promises: { unlink: erase } } = fs'
    ],
    [
      'object destructuring default',
      'const { readFileSync: read = fs.readFileSync } = fs',
      'const { notExported: erase = fs.unlinkSync } = fs'
    ],
    [
      'bare var redeclaration',
      'var read = fs.readFileSync; var read',
      'var erase = fs.unlinkSync; var erase'
    ]
  ])(
    'executes a real file read but preserves the file when a %s is denied',
    async (_name, reader, deletion) => {
      const { service, execute, request } = await harness()
      const marker = join(request.workspaceCwd, 'approval-sentinel.txt')
      await writeFile(marker, 'keep this content\n')
      execute.mockImplementation(async (execution) => {
        expect(execution.kind).toBe('repl')
        const { stdout, stderr } = await promisify(execFile)(
          process.execPath,
          ['-e', execution.code],
          {
            cwd: execution.cwd,
            timeout: 5_000
          }
        )
        return {
          status: 'completed',
          stdout,
          stderr,
          traceback: '',
          cwdAfter: execution.cwd,
          outputs: [],
          kernelDispatched: true
        }
      })
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      await service.executeControl({
        ...request,
        code: `const fs = require("fs"); ${reader}; Promise.resolve(read(${JSON.stringify(marker)}, "utf8")).then(text => console.log(text.trim()))`
      })
      expect(approve).not.toHaveBeenCalled()
      expect(execute).toHaveBeenCalledTimes(1)
      expect((await execute.mock.results[0].value).stdout).toBe('keep this content\n')
      await service.executeControl({
        ...request,
        code: `const fs = require("fs"); ${deletion}; [${JSON.stringify(marker)}].forEach(erase)`
      })
      expect(approve).toHaveBeenCalledTimes(1)
      expect(execute).toHaveBeenCalledTimes(1)
      expect(await readFile(marker, 'utf8')).toBe('keep this content\n')
    }
  )

  it('preserves Python callable identity across annotation-only cells before host admission', async () => {
    const { service, execute, request } = await harness()
    const approve = vi.fn(async () => false)
    service.setExecutionApproval(approve)
    await service.execute({ ...request, code: 'import os\nreader = open\nerase = os.unlink' })
    await service.execute({ ...request, code: 'reader: object\nprint(reader("data.txt").read())' })
    expect(approve).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(2)
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        service.execute({ ...request, code: 'erase: object\nerase("data.txt")' })
      ).rejects.toThrow('one-time approval')
    }
    expect(approve).toHaveBeenCalledTimes(2)
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it.each(['getoutput', 'getstatusoutput'])(
    'requires a fresh decision for saved subprocess.%s calls before dispatch',
    async (method) => {
      const { service, execute, request } = await harness()
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      await service.execute({
        ...request,
        code: `from subprocess import ${method} as run\nsaved = run\nrun = open`
      })
      await service.execute({ ...request, code: 'print(run("data.txt").read())' })
      expect(approve).not.toHaveBeenCalled()
      expect(execute).toHaveBeenCalledTimes(2)
      const code = 'saved("rm data.txt")'
      await expect(service.execute({ ...request, code })).rejects.toThrow('one-time approval')
      expect(execute).toHaveBeenCalledTimes(2)
      approve.mockResolvedValueOnce(true)
      await service.execute({ ...request, code })
      expect(execute).toHaveBeenCalledTimes(3)
      await expect(service.execute({ ...request, code })).rejects.toThrow('one-time approval')
      expect(approve).toHaveBeenCalledTimes(3)
      expect(execute).toHaveBeenCalledTimes(3)
    }
  )

  it.each([
    ['compile', 'exec', ''],
    ['builtins.compile', 'builtins.exec', 'import builtins\n'],
    ['prepare', 'run', 'from builtins import compile as prepare, eval as run\n'],
    ['compile', 'exec.__call__', ''],
    ['compile', 'getattr(exec, "__call__")', '']
  ])(
    'admits Python compilation but reviews every later %s/%s execution',
    async (prepare, run, imports) => {
      const { service, execute, request } = await harness()
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      await service.execute({
        ...request,
        code: `${imports}compiled = ${prepare}('import os; os.unlink("data.txt")', "<cell>", "exec")`
      })
      await service.execute({ ...request, code: 'print(compiled.co_names)' })
      expect(approve).not.toHaveBeenCalled()
      expect(execute).toHaveBeenCalledTimes(2)
      for (let attempt = 0; attempt < 2; attempt++)
        await expect(service.execute({ ...request, code: `${run}(compiled)` })).rejects.toThrow(
          'one-time approval'
        )
      expect(approve).toHaveBeenCalledTimes(2)
      expect(execute).toHaveBeenCalledTimes(2)
    }
  )

  it('updates deleted Python name bindings across cells without granting saved destructive aliases', async () => {
    const { service, execute, request } = await harness()
    const approve = vi.fn(async () => false)
    service.setExecutionApproval(approve)
    await service.execute({
      ...request,
      code: 'import os\nopen = os.unlink\nerase = open\neval = print'
    })
    await service.execute({ ...request, code: 'del open\nprint(open("data.txt").read())' })
    await service.execute({ ...request, code: 'del eval' })
    expect(approve).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(3)
    for (const code of ['eval("1 + 2")', 'erase("data.txt")']) {
      await expect(service.execute({ ...request, code })).rejects.toThrow('one-time approval')
    }
    expect(approve).toHaveBeenCalledTimes(2)
    expect(execute).toHaveBeenCalledTimes(3)
  })

  it.each([
    ['sorted(["b", "a"], key=str.lower)', 'sorted(["data.txt"], key=os.unlink)'],
    ['min(["bb", "a"], key=len)', 'min(["data.txt"], key=os.unlink)'],
    ['max([], default=os.unlink, key=None)', 'max(["data.txt"], key=os.unlink)'],
    [
      'from functools import reduce\nimport operator\nreduce(operator.add, [1, 2], 0)',
      'from functools import reduce\ndef erase(acc, path):\n    os.unlink(path)\n    return acc\nreduce(erase, ["data.txt"], [])'
    ]
  ])(
    'admits ordinary Python collection work and blocks destructive callbacks: %s',
    async (safe, destructive) => {
      const { service, execute, request } = await harness()
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      await service.execute({ ...request, code: `import os\n${safe}` })
      expect(approve).not.toHaveBeenCalled()
      expect(execute).toHaveBeenCalledTimes(1)
      await expect(
        service.execute({ ...request, code: `import os\n${destructive}` })
      ).rejects.toThrow('one-time approval')
      expect(approve).toHaveBeenCalledTimes(1)
      expect(execute).toHaveBeenCalledTimes(1)
    }
  )

  it.each([
    [
      'import os\nreader = getattr(os, "listdir")\nerase = getattr(os, "unlink")',
      'reader(".")',
      'erase("data.txt")'
    ],
    ['import os', 'getattr(os, "listdir")(".")', 'getattr(os, "unlink")("data.txt")'],
    ['import builtins', 'getattr(builtins, "str")(42)', 'getattr(builtins, "eval")("1 + 2")'],
    ['import builtins', 'builtins.getattr(builtins, "str")(42)', 'builtins.exec("print(42)")']
  ])(
    'reviews Python attribute invocation at host dispatch: %s',
    async (definition, safe, risky) => {
      const { service, execute, request } = await harness()
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      await service.execute({ ...request, code: definition })
      await service.execute({ ...request, code: safe })
      expect(approve).not.toHaveBeenCalled()
      expect(execute).toHaveBeenCalledTimes(2)
      for (let attempt = 0; attempt < 2; attempt++)
        await expect(service.execute({ ...request, code: risky })).rejects.toThrow(
          'one-time approval'
        )
      expect(approve).toHaveBeenCalledTimes(2)
      expect(execute).toHaveBeenCalledTimes(2)
    }
  )

  it.each([
    ['nlargest', 'key='],
    ['nsmallest', '']
  ])('admits heapq %s reads and reviews destructive keys: %s', async (method, keyword) => {
    const { service, execute, request } = await harness()
    const approve = vi.fn(async () => false)
    service.setExecutionApproval(approve)
    await service.execute({ ...request, code: 'import heapq, os' })
    await service.execute({ ...request, code: `heapq.${method}(1, ["ab", "c"], ${keyword}len)` })
    expect(approve).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(2)
    const code = `heapq.${method}(1, ["data.txt"], ${keyword}os.unlink)`
    await expect(service.execute({ ...request, code })).rejects.toThrow('one-time approval')
    expect(execute).toHaveBeenCalledTimes(2)
    approve.mockResolvedValueOnce(true)
    await service.execute({ ...request, code })
    expect(execute).toHaveBeenCalledTimes(3)
    await expect(service.execute({ ...request, code })).rejects.toThrow('one-time approval')
    expect(approve).toHaveBeenCalledTimes(3)
    expect(execute).toHaveBeenCalledTimes(3)
  })

  it('executes a saved numeric callback after its original global name is rebound', async () => {
    const { service, execute, request } = await harness()
    execute.mockImplementation(async (execution) => {
      const { stdout, stderr } = await promisify(execFile)(
        process.execPath,
        ['-e', execution.code],
        {
          cwd: execution.cwd,
          timeout: 5_000
        }
      )
      return {
        status: 'completed',
        stdout,
        stderr,
        traceback: '',
        cwdAfter: execution.cwd,
        outputs: [],
        kernelDispatched: true
      }
    })
    const approve = vi.fn(async () => false)
    service.setExecutionApproval(approve)
    await service.executeControl({
      ...request,
      code: 'const fs = require("fs"); const parse = Number; Number = fs.unlinkSync; console.log(["10", "20"].map(parse).join(","))'
    })
    expect(approve).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(1)
    expect((await execute.mock.results[0].value).stdout).toBe('10,20\n')
  })

  it('preserves R callback values across cells when the original name is rebound', async () => {
    const { service, execute, request } = await harness()
    const approve = vi.fn(async () => false)
    service.setExecutionApproval(approve)
    const run = async (code: string): Promise<void> => {
      const cell = await service.beginCodeCell({ ...request, language: 'r' })
      await service.appendCodeCell({ ...request, ...cell, delta: code })
      await service.finishCodeCell({ ...request, ...cell })
      await service.runCell({ ...request, cellId: cell.cellId })
    }
    await run('reader <- mean; erase <- unlink; mean <- unlink; unlink <- print')
    await run('lapply(list(1:3), reader)')
    expect(approve).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(2)
    await expect(run('lapply("sentinel.txt", erase)')).rejects.toThrow('one-time approval')
    await expect(run('lapply("sentinel.txt", "erase")')).rejects.toThrow('one-time approval')
    expect(approve).toHaveBeenCalledTimes(2)
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it.skipIf(process.platform === 'win32')(
    'executes a shell function definition without truncating its output and denies its invocation',
    async () => {
      const { service, shell, request } = await harness()
      const marker = join(request.workspaceCwd, 'approval-sentinel.txt')
      await writeFile(marker, 'keep this content\n')
      shell.mockImplementation(async (execution) => {
        const { stdout, stderr } = await promisify(execFile)('/bin/sh', ['-c', execution.command], {
          cwd: request.workspaceCwd,
          timeout: 5_000
        })
        return { stdout, stderr, exitCode: 0 }
      })
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      const definition = 'report() { printf replacement; } > approval-sentinel.txt'
      await service.executeShell({ ...request, command: definition })
      expect(await readFile(marker, 'utf8')).toBe('keep this content\n')
      await service.executeShell({
        ...request,
        command: 'read_report() { cat approval-sentinel.txt; } 2>&-; read_report'
      })
      expect(approve).not.toHaveBeenCalled()
      expect((await shell.mock.results[1].value).stdout).toBe('keep this content\n')
      await expect(
        service.executeShell({ ...request, command: `${definition}; report` })
      ).rejects.toThrow('one-time approval')
      expect(approve).toHaveBeenCalledTimes(1)
      expect(shell).toHaveBeenCalledTimes(2)
      expect(await readFile(marker, 'utf8')).toBe('keep this content\n')
    }
  )

  it('reviews implicit decorator effects at definition time and deferred function effects on a call', async () => {
    const { service, execute, request } = await harness()
    const approve = vi.fn(async () => false)
    service.setExecutionApproval(approve)
    await service.execute({
      ...request,
      code: 'import os\ndef cleanup(fn):\n    os.unlink("sentinel.txt")\n    return fn\ndef annotate(fn):\n    return fn'
    })
    expect(approve).not.toHaveBeenCalled()
    await expect(
      service.execute({ ...request, code: '@cleanup\ndef work():\n    pass' })
    ).rejects.toThrow('one-time approval')
    expect(execute).toHaveBeenCalledTimes(1)
    await service.execute({
      ...request,
      code: '@annotate\ndef erase():\n    os.unlink("sentinel.txt")'
    })
    expect(approve).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledTimes(2)
    await expect(service.execute({ ...request, code: 'erase()' })).rejects.toThrow(
      'one-time approval'
    )
    expect(approve).toHaveBeenCalledTimes(2)
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('uses Python assignment-expression rebinding from the latest cell before dispatch', async () => {
    const { service, execute, request } = await harness()
    const approve = vi.fn(async () => false)
    service.setExecutionApproval(approve)
    for (const code of [
      'import os\nreader = os.unlink',
      '(reader := open)\nprint(reader("sentinel.txt").read())',
      '(reader := os.unlink)'
    ])
      await service.execute({ ...request, code })
    expect(approve).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(3)
    await expect(service.execute({ ...request, code: 'reader("sentinel.txt")' })).rejects.toThrow(
      'one-time approval'
    )
    expect(approve).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledTimes(3)
  })

  it.each([
    ['python', 'import os\nerase = os.unlink'],
    ['r', 'erase <- unlink'],
    ['repl', 'const erase = require("fs").unlinkSync']
  ] as const)(
    'replays only dispatched cancelled %s bindings for later risk review',
    async (language, code) => {
      for (const kernelDispatched of [false, true]) {
        const { service, execute, request } = await harness()
        const approve = vi.fn(async () => false)
        service.setExecutionApproval(approve)
        execute.mockImplementationOnce(async (execution) => ({
          status: 'cancelled',
          stdout: '',
          stderr: '',
          traceback: '',
          cwdAfter: execution.cwd,
          outputs: [],
          kernelDispatched
        }))
        const invoke = (source: string): Promise<unknown> =>
          language === 'repl'
            ? service.executeControl({ ...request, code: source })
            : service.execute({ ...request, language, code: source })
        await invoke(code)
        expect(approve).not.toHaveBeenCalled()
        if (kernelDispatched && language !== 'repl')
          await expect(invoke('erase("sentinel.txt")')).rejects.toThrow('one-time approval')
        else await invoke('erase("sentinel.txt")')
        expect(approve).toHaveBeenCalledTimes(kernelDispatched ? 1 : 0)
        expect(execute).toHaveBeenCalledTimes(kernelDispatched ? 1 : 2)
      }
    }
  )

  it('reviews a stored dynamic callable on every invocation without reusing the prior approval', async () => {
    const { service, execute, request } = await harness()
    const approve = vi.fn(async () => false)
    service.setExecutionApproval(approve)
    await service.execute({
      ...request,
      code: 'import os\nhandlers = {"erase": os.unlink}\nmethod = "erase"\nerase = handlers[method]'
    })
    expect(approve).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(1)

    approve.mockResolvedValueOnce(true)
    await service.execute({ ...request, code: 'erase(path)' })
    expect(approve).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledTimes(2)

    await expect(service.execute({ ...request, code: 'erase(path)' })).rejects.toThrow(
      'one-time approval'
    )
    expect(approve).toHaveBeenCalledTimes(2)
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it.skipIf(process.platform === 'win32')(
    'admits command discovery but denies in-place shell editing before dispatch',
    async () => {
      const { service, shell, request } = await harness()
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      await service.executeShell({ ...request, command: 'command -v conda || true' })
      expect(approve).not.toHaveBeenCalled()
      expect(shell).toHaveBeenCalledTimes(1)
      await expect(
        service.executeShell({ ...request, command: 'sed -i.bak "s/old/new/" data.csv' })
      ).rejects.toThrow('one-time approval')
      expect(approve).toHaveBeenCalledTimes(1)
      expect(shell).toHaveBeenCalledTimes(1)
    }
  )

  it('waits before dispatch and requests approval again on the next deletion', async () => {
    const { service, execute, request } = await harness()
    let release!: (value: boolean) => void
    const approve = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve
        })
    )
    service.setExecutionApproval(approve)
    const run = service.execute({ ...request, code: 'import os\nos.unlink("x")' })
    await vi.waitFor(() => expect(approve).toHaveBeenCalledTimes(1))
    expect(execute).not.toHaveBeenCalled()
    release(true)
    await run
    expect(execute).toHaveBeenCalledTimes(1)
    const second = service.execute({ ...request, code: 'os.unlink("x")' })
    await vi.waitFor(() => expect(approve).toHaveBeenCalledTimes(2))
    release(false)
    await expect(second).rejects.toThrow('one-time approval')
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it
    .skipIf(process.platform === 'win32')
    .each(['env LABEL=rm', 'env -u rm', 'env -- LANG=C', 'env env LANG=C'])(
    'executes an env-wrapped file read and denies deletion: %s',
    async (wrapper) => {
      const { service, shell, request } = await harness()
      const marker = join(request.workspaceCwd, 'approval-sentinel.txt')
      await writeFile(marker, 'keep this content\n')
      shell.mockImplementation(async (execution) => {
        const { stdout, stderr } = await promisify(execFile)('/bin/sh', ['-c', execution.command], {
          cwd: request.workspaceCwd,
          timeout: 5_000
        })
        return { stdout, stderr, exitCode: 0 }
      })
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      await service.executeShell({ ...request, command: `${wrapper} cat approval-sentinel.txt` })
      expect(approve).not.toHaveBeenCalled()
      expect(shell).toHaveBeenCalledTimes(1)
      expect((await shell.mock.results[0].value).stdout).toBe('keep this content\n')
      await expect(
        service.executeShell({ ...request, command: `${wrapper} rm approval-sentinel.txt` })
      ).rejects.toThrow('one-time approval')
      expect(approve).toHaveBeenCalledTimes(1)
      expect(shell).toHaveBeenCalledTimes(1)
      expect(await readFile(marker, 'utf8')).toBe('keep this content\n')
    }
  )

  it
    .skipIf(process.platform === 'win32')
    .each([
      'builtin eval "rm approval-sentinel.txt"',
      'builtin source cleanup.sh',
      'builtin -- . cleanup.sh',
      'command builtin eval "rm approval-sentinel.txt"'
    ])('executes ordinary Bash builtins but denies nested execution: %s', async (command) => {
    const { service, shell, request } = await harness()
    const marker = join(request.workspaceCwd, 'approval-sentinel.txt')
    await writeFile(marker, 'keep this content\n')
    await writeFile(join(request.workspaceCwd, 'cleanup.sh'), 'rm approval-sentinel.txt\n')
    shell.mockImplementation(async (execution) => {
      const { stdout, stderr } = await promisify(execFile)('/bin/bash', ['-c', execution.command], {
        cwd: request.workspaceCwd,
        timeout: 5_000
      })
      return { stdout, stderr, exitCode: 0 }
    })
    const approve = vi.fn(async () => false)
    service.setExecutionApproval(approve)
    await service.executeShell({
      ...request,
      command: 'builtin printf "%s" "$(cat approval-sentinel.txt)"'
    })
    expect(approve).not.toHaveBeenCalled()
    expect((await shell.mock.results[0].value).stdout).toBe('keep this content')
    await expect(service.executeShell({ ...request, command })).rejects.toThrow('one-time approval')
    expect(approve).toHaveBeenCalledTimes(1)
    expect(shell).toHaveBeenCalledTimes(1)
    expect(await readFile(marker, 'utf8')).toBe('keep this content\n')
  })

  it.skipIf(process.platform === 'win32').each(['--help', '--version'])(
    'does not trust a real script to interpret %s as read-only',
    async (flag) => {
      const { service, shell, request } = await harness()
      const script = join(request.workspaceCwd, 'custom.sh')
      const marker = join(request.workspaceCwd, 'invocations.txt')
      await writeFile(script, '#!/bin/sh\nprintf "%s\\n" "$1" >> invocations.txt\n', {
        mode: 0o700
      })
      // Real execution demonstrates that these arguments do not prevent script-owned effects.
      await promisify(execFile)(script, [flag], { cwd: request.workspaceCwd, timeout: 5_000 })
      expect(await readFile(marker, 'utf8')).toBe(`${flag}\n`)
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      await expect(
        service.executeShell({ ...request, command: `./custom.sh ${flag}` })
      ).rejects.toThrow('one-time approval')
      expect(approve).toHaveBeenCalledTimes(1)
      expect(shell).not.toHaveBeenCalled()
      expect(await readFile(marker, 'utf8')).toBe(`${flag}\n`)
    }
  )

  it
    .skipIf(process.platform === 'win32')
    .each(['tee approval-sentinel.txt -a', 'env POSIXLY_CORRECT=1 tee approval-sentinel.txt -a'])(
    'permits real tee append but blocks a trailing append flag: %s',
    async (command) => {
      const { service, shell, request } = await harness()
      const marker = join(request.workspaceCwd, 'approval-sentinel.txt')
      await writeFile(marker, 'before\n')
      shell.mockImplementation(async (execution) => {
        const { stdout, stderr } = await promisify(execFile)('/bin/sh', ['-c', execution.command], {
          cwd: request.workspaceCwd,
          env: { ...process.env, POSIXLY_CORRECT: '1' },
          timeout: 5_000
        })
        return { stdout, stderr, exitCode: 0 }
      })
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      await service.executeShell({
        ...request,
        command: 'printf "after\\n" | tee -a approval-sentinel.txt'
      })
      expect(approve).not.toHaveBeenCalled()
      expect(shell).toHaveBeenCalledTimes(1)
      expect(await readFile(marker, 'utf8')).toBe('before\nafter\n')
      await expect(
        service.executeShell({ ...request, command: `printf "replace\\n" | ${command}` })
      ).rejects.toThrow('one-time approval')
      expect(approve).toHaveBeenCalledTimes(1)
      expect(shell).toHaveBeenCalledTimes(1)
      expect(await readFile(marker, 'utf8')).toBe('before\nafter\n')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'executes a real find pattern search but preserves its result when deletion is denied',
    async () => {
      const { service, shell, request } = await harness()
      const marker = join(request.workspaceCwd, '-delete')
      await writeFile(marker, 'keep this content\n')
      shell.mockImplementation(async (execution) => {
        const { stdout, stderr } = await promisify(execFile)('/bin/sh', ['-c', execution.command], {
          cwd: request.workspaceCwd,
          timeout: 5_000
        })
        return { stdout, stderr, exitCode: 0 }
      })
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      await service.executeShell({ ...request, command: 'find . -name "-delete" -print' })
      expect(approve).not.toHaveBeenCalled()
      expect(shell).toHaveBeenCalledTimes(1)
      expect((await shell.mock.results[0].value).stdout).toBe('./-delete\n')
      await expect(
        service.executeShell({ ...request, command: 'find . -name "-delete" -delete' })
      ).rejects.toThrow('one-time approval')
      expect(approve).toHaveBeenCalledTimes(1)
      expect(shell).toHaveBeenCalledTimes(1)
      expect(await readFile(marker, 'utf8')).toBe('keep this content\n')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'executes a real Git cleanup preview but rejects deletion and forced checkout before dispatch',
    async () => {
      const { service, shell, request } = await harness()
      const cwd = request.workspaceCwd
      const marker = join(cwd, 'approval-sentinel.txt')
      await promisify(execFile)('git', ['-c', 'init.defaultBranch=main', 'init', '--quiet', cwd])
      await writeFile(marker, 'keep this content\n')
      shell.mockImplementation(async (execution) => {
        const { stdout, stderr } = await promisify(execFile)('/bin/sh', ['-c', execution.command], {
          cwd,
          timeout: 5_000
        })
        return { stdout, stderr, exitCode: 0 }
      })
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      await service.executeShell({ ...request, command: 'git clean -nd' })
      expect(approve).not.toHaveBeenCalled()
      expect(shell).toHaveBeenCalledTimes(1)
      expect((await shell.mock.results[0].value).stdout).toContain('approval-sentinel.txt')
      // Native Git must stop recognizing a preview after --no-dry-run. Requiring force makes
      // this probe refuse execution, so even the semantic check cannot delete the sentinel.
      await expect(
        promisify(execFile)(
          'git',
          ['-c', 'clean.requireForce=true', 'clean', '-n', '--no-dry-run'],
          { cwd }
        )
      ).rejects.toMatchObject({ stderr: expect.stringContaining('clean.requireForce') })
      for (const command of [
        'git clean -f',
        'git clean -n --no-dry-run -f',
        'git checkout -f main',
        'git switch --discard-changes main'
      ]) {
        await expect(service.executeShell({ ...request, command })).rejects.toThrow(
          'one-time approval'
        )
      }
      expect(approve).toHaveBeenCalledTimes(4)
      expect(shell).toHaveBeenCalledTimes(1)
      expect(await readFile(marker, 'utf8')).toBe('keep this content\n')
    }
  )

  it.each([
    ['expr <- quote(unlink("data.txt"))', 'base::eval(expr)'],
    ['expr <- base::expression(unlink("data.txt"))', 'runner <- base::eval; runner(expr)'],
    ['erase <- unlink; quote(erase <- identity)', 'erase("data.txt")']
  ])('admits R expression construction and denies its later execution: %s', async (safe, risky) => {
    const { service, execute, request } = await harness()
    const approve = vi.fn(async () => false)
    service.setExecutionApproval(approve)
    const run = async (code: string): Promise<void> => {
      const cell = await service.beginCodeCell({ ...request, language: 'r' })
      await service.appendCodeCell({ ...request, ...cell, delta: code })
      await service.finishCodeCell({ ...request, ...cell })
      await service.runCell({ ...request, cellId: cell.cellId })
    }
    await run(safe)
    expect(approve).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(1)
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(run(risky)).rejects.toThrow('one-time approval')
    expect(approve).toHaveBeenCalledTimes(2)
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('admits reordered R analysis callbacks but rejects reordered deletion before dispatch', async () => {
    const { service, execute, request } = await harness()
    const approve = vi.fn(async () => false)
    service.setExecutionApproval(approve)
    for (const code of ['lapply(mean, X=list(1:3))', 'lapply(unlink, X="sentinel.txt")']) {
      const cell = await service.beginCodeCell({ ...request, language: 'r' })
      await service.appendCodeCell({ ...request, ...cell, delta: code })
      await service.finishCodeCell({ ...request, ...cell })
      const execution = service.runCell({ ...request, cellId: cell.cellId })
      if (code.includes('unlink')) await expect(execution).rejects.toThrow('one-time approval')
      else {
        await execution
        expect(approve).not.toHaveBeenCalled()
      }
    }
    expect(approve).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['Filter(is.finite, c(1, NA))', 'Filter(file.remove, "data.txt")'],
    ['Find(is.finite, numeric(), nomatch = unlink)', 'Find(file.remove, "data.txt")'],
    ['Position(is.finite, numeric(), nomatch = file.remove)', 'Position(file.remove, "data.txt")'],
    [
      'Reduce(function(acc, item) acc, list(), init = unlink)',
      'Reduce(erase, "data.txt", init = 0)'
    ]
  ])('admits R functional data but reviews callback execution: %s', async (safe, risky) => {
    const { service, execute, request } = await harness()
    const approve = vi.fn(async () => false)
    service.setExecutionApproval(approve)
    const run = async (code: string): Promise<void> => {
      const cell = await service.beginCodeCell({ ...request, language: 'r' })
      await service.appendCodeCell({ ...request, ...cell, delta: code })
      await service.finishCodeCell({ ...request, ...cell })
      await service.runCell({ ...request, cellId: cell.cellId })
    }
    await run('erase <- function(acc, path) { unlink(path); acc }')
    await run(safe)
    expect(approve).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(2)
    await expect(run(risky)).rejects.toThrow('one-time approval')
    await expect(run(risky)).rejects.toThrow('one-time approval')
    expect(approve).toHaveBeenCalledTimes(2)
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it.each([
    'new Promise(HANDLER)',
    'const P = globalThis.Promise; new P(HANDLER)',
    'const P = Promise.bind(null); new P(HANDLER)',
    'Promise.resolve().then(HANDLER)',
    'Promise.reject("reason").then(null, HANDLER)',
    'Promise.reject("reason").catch(HANDLER)',
    'Promise.resolve().finally(HANDLER)',
    'Reflect.apply(Promise.prototype.then, Promise.reject("reason"), [, HANDLER])'
  ])(
    'executes an ordinary Promise reader and blocks cleanup before execution: %s',
    async (chain) => {
      const { service, execute, request } = await harness()
      const marker = join(request.workspaceCwd, 'approval-sentinel.txt')
      await writeFile(marker, 'keep this content\n')
      execute.mockImplementation(async (execution) => {
        const { stdout, stderr } = await promisify(execFile)(
          process.execPath,
          ['-e', execution.code],
          {
            cwd: execution.cwd,
            timeout: 5_000
          }
        )
        return {
          status: 'completed',
          stdout,
          stderr,
          traceback: '',
          cwdAfter: execution.cwd,
          outputs: [],
          kernelDispatched: true
        }
      })
      const approve = vi.fn(async () => false)
      service.setExecutionApproval(approve)
      const definitions = `const fs = require("fs"); function read() { console.log(fs.readFileSync(${JSON.stringify(marker)}, "utf8").trim()) } function erase() { fs.unlinkSync(${JSON.stringify(marker)}) }`
      await service.executeControl({
        ...request,
        code: `${definitions}; ${chain.replace('HANDLER', 'read')}`
      })
      expect(approve).not.toHaveBeenCalled()
      expect(execute).toHaveBeenCalledTimes(1)
      expect((await execute.mock.results[0].value).stdout).toBe('keep this content\n')
      await service.executeControl({
        ...request,
        code: `${definitions}; ${chain.replace('HANDLER', 'erase')}`
      })
      expect(approve).toHaveBeenCalledTimes(1)
      expect(execute).toHaveBeenCalledTimes(1)
      expect(await readFile(marker, 'utf8')).toBe('keep this content\n')
    }
  )

  it.each([
    ['', 'cp.fork'],
    ['const { fork: launch } = cp;', 'launch'],
    ['const launch = cp.fork.bind(cp);', 'launch']
  ])('requires one-shot approval before a real Node fork: %s %s', async (binding, launch) => {
    const { service, execute, request } = await harness()
    const marker = join(request.workspaceCwd, 'fork-target.txt')
    const sentinel = join(request.workspaceCwd, 'keep.txt')
    const script = join(request.workspaceCwd, 'worker.cjs')
    await writeFile(marker, 'delete only after approval')
    await writeFile(sentinel, 'keep')
    await writeFile(script, `require("node:fs").unlinkSync(${JSON.stringify(marker)})`)
    execute.mockImplementation(async (execution) => {
      const { stdout, stderr } = await promisify(execFile)(
        process.execPath,
        ['-e', execution.code],
        {
          cwd: execution.cwd,
          timeout: 5_000
        }
      )
      return {
        status: 'completed',
        stdout,
        stderr,
        traceback: '',
        cwdAfter: execution.cwd,
        outputs: [],
        kernelDispatched: true
      }
    })
    const approve = vi.fn(async () => false)
    service.setExecutionApproval(approve)
    await service.executeControl({
      ...request,
      code: 'const cp = require("node:child_process"); const stored = cp.fork.bind(cp); console.log(stored.name)'
    })
    expect(approve).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(1)
    const code = `const cp = require("node:child_process"); ${binding} ${launch}(${JSON.stringify(script)}, [], { stdio: "ignore", execArgv: [], timeout: 2000 })`
    await service.executeControl({ ...request, code })
    expect(approve).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(await readFile(marker, 'utf8')).toBe('delete only after approval')
    approve.mockResolvedValueOnce(true)
    await service.executeControl({ ...request, code })
    expect(execute).toHaveBeenCalledTimes(2)
    await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await service.executeControl({ ...request, code })
    expect(approve).toHaveBeenCalledTimes(3)
    expect(execute).toHaveBeenCalledTimes(2)
    expect(await readFile(sentinel, 'utf8')).toBe('keep')
  })

  it.each([
    'Array.from([PATH], HANDLER)',
    'Array.fromAsync([PATH], HANDLER)',
    'Object.groupBy([PATH], HANDLER)',
    'Map.groupBy([PATH], HANDLER)',
    '[PATH].findLast(HANDLER)',
    '[PATH].findLastIndex(HANDLER)',
    'Reflect.apply(Array.from, Array, [[PATH], HANDLER])',
    'const collect = Array.from.bind(Array); collect([PATH], HANDLER)',
    'Uint8Array.from([PATH], HANDLER)',
    'Float64Array.from([PATH], HANDLER)',
    'Reflect.apply(Int16Array.from, Int16Array, [[PATH], HANDLER])',
    'PATH.replace(PATH, HANDLER)',
    'PATH.replaceAll(PATH, HANDLER)',
    'String.prototype.replace.call(PATH, PATH, HANDLER)',
    'Reflect.apply(String.prototype.replaceAll, PATH, [PATH, HANDLER])'
  ])('reviews real collection mapping before dispatch: %s', async (template) => {
    const { service, execute, request } = await harness()
    const marker = join(request.workspaceCwd, 'mapping-target.txt')
    const sentinel = join(request.workspaceCwd, 'keep.txt')
    await writeFile(marker, 'read me')
    await writeFile(sentinel, 'keep')
    execute.mockImplementation(async (execution) => {
      const { stdout, stderr } = await promisify(execFile)(
        process.execPath,
        ['-e', execution.code],
        {
          cwd: execution.cwd,
          timeout: 5_000
        }
      )
      return {
        status: 'completed',
        stdout,
        stderr,
        traceback: '',
        cwdAfter: execution.cwd,
        outputs: [],
        kernelDispatched: true
      }
    })
    const approve = vi.fn(async () => false)
    service.setExecutionApproval(approve)
    const definitions =
      'const fs = require("fs"); function read(path) { console.log(fs.readFileSync(path, "utf8")) }; function erase(path) { fs.unlinkSync(path) };'
    const code = (handler: string): string =>
      `${definitions} ${template.replaceAll('PATH', JSON.stringify(marker)).replace('HANDLER', handler)}`
    await service.executeControl({ ...request, code: code('read') })
    expect(approve).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(1)
    expect((await execute.mock.results[0].value).stdout).toBe('read me\n')
    await service.executeControl({ ...request, code: code('erase') })
    expect(approve).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(await readFile(marker, 'utf8')).toBe('read me')
    approve.mockResolvedValueOnce(true)
    await service.executeControl({ ...request, code: code('erase') })
    expect(execute).toHaveBeenCalledTimes(2)
    await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await service.executeControl({ ...request, code: code('erase') })
    expect(approve).toHaveBeenCalledTimes(3)
    expect(execute).toHaveBeenCalledTimes(2)
    expect(await readFile(sentinel, 'utf8')).toBe('keep')
  })

  it.each([
    [
      'python',
      'import bisect, os; bisect.insort([], "x", key=len)',
      'import bisect, os; bisect.insort([], "x", key=os.unlink)'
    ],
    [
      'python',
      'sorted(["ab", "c"], **{"key": len})',
      'import os; sorted(["x"], **{"key": os.unlink})'
    ],
    [
      'python',
      'sorted(["ab", "c"], **{**{"key": len}})',
      'import os; sorted(["x"], **{**{"key": os.unlink}})'
    ],
    ['bash', 'fc -l', 'fc -s'],
    ['bash', 'builtin fc -l', 'builtin fc -e -'],
    ['bash', 'enable -p', 'enable -f ./plugin.so plugin'],
    ['bash', 'python3.13 -I -V', 'python3.13 -c \'import os; os.unlink("x")\''],
    ['bash', 'python3.13 "-W*" -V', 'python3.13 -W* -V'],
    ['bash', 'python3.13 -X dev -h', 'python3.13 -m package --help'],
    ['bash', 'pypy3.10 -V', 'pypy3.10 script.py'],
    [
      'python',
      'import os; print(os.execv.__name__)',
      'import os; os.execv(program, [program, "-c", script])'
    ],
    [
      'python',
      'import os; print(os.spawnv.__name__)',
      'import os; os.spawnv(os.P_WAIT, program, [program, "-c", script])'
    ],
    [
      'python',
      'import os; print(os.posix_spawn.__name__)',
      'import os; os.posix_spawn(program, [program, "-c", script], env)'
    ],
    [
      'python',
      'import pty; print(pty.spawn.__name__)',
      'import pty; pty.spawn([program, "-c", script])'
    ],
    [
      'python',
      'import runpy; print(runpy.run_path.__name__)',
      'import runpy; runpy.run_path(path)'
    ],
    [
      'python',
      'import runpy; print(runpy.run_module.__name__)',
      'import runpy; runpy.run_module(name)'
    ],
    ['r', 'mapply(sum, 1:3)', 'mapply(unlink, "x")'],
    ['r', '.mapply(sum, list(1:3), NULL)', '.mapply(unlink, list("x"), NULL)'],
    ['r', 'eapply(new.env(), length)', 'eapply(unlink, env=new.env())'],
    ['r', 'tapply(1:3, c(1,1,2), sum)', 'tapply("x", 1, "unlink")'],
    ['r', 'rapply(list(1:3), sum)', 'rapply(list("x"), unlink)'],
    ['r', 'by(1:3, c(1,1,2), sum)', 'by("x", 1, unlink)'],
    ['r', 'outer(1:3, 1:3)', 'outer("x", TRUE, "unlink")'],
    [
      'python',
      'key = None; sorted([2, 1], key=key)',
      'import os; key = None; key = os.unlink; sorted(["x"], key=key)'
    ],
    ['r', 'f <- NULL; tapply(1:3, 1:3, f)', 'f <- NULL; f <- unlink; tapply("x", 1, f)'],
    ['r', 'f <- NULL; tapply(1:3, 1:3, f)', 'unlink <- NULL; unlink("x")']
  ] as const)('batch preserves one-shot admission for %s: %s', async (language, safe, risky) => {
    const { service, execute, shell, request } = await harness(
      0,
      language === 'bash' ? { kind: 'native-posix', shell: '/bin/bash' } : undefined
    )
    const approve = vi.fn(async () => false)
    service.setExecutionApproval(approve)
    const run = async (code: string): Promise<void> => {
      if (language === 'python') {
        await service.execute({ ...request, code })
        return
      }
      if (language === 'bash') {
        await service.executeShell({ ...request, command: code })
        return
      }
      const cell = await service.beginCodeCell({ ...request, language })
      await service.appendCodeCell({ ...request, ...cell, delta: code })
      await service.finishCodeCell({ ...request, ...cell })
      await service.runCell({ ...request, cellId: cell.cellId })
    }
    const executor = language === 'bash' ? shell : execute
    await run(safe)
    expect(approve).not.toHaveBeenCalled()
    expect(executor).toHaveBeenCalledTimes(1)
    await expect(run(risky)).rejects.toThrow('one-time approval')
    expect(executor).toHaveBeenCalledTimes(1)
    approve.mockResolvedValueOnce(true)
    await run(risky)
    expect(executor).toHaveBeenCalledTimes(2)
    await expect(run(risky)).rejects.toThrow('one-time approval')
    expect(approve).toHaveBeenCalledTimes(3)
    expect(executor).toHaveBeenCalledTimes(2)
  })

  it('blocks REPL and shell dispatch on declined approval', async () => {
    const { service, execute, shell, request } = await harness()
    const approve = vi.fn(async () => false)
    service.setExecutionApproval(approve)
    await service.executeControl({ ...request, code: 'const fs = require("fs"); fs.rmSync("x")' })
    await expect(service.executeShell({ ...request, command: 'rm -rf x' })).rejects.toThrow(
      'one-time approval'
    )
    expect(approve).toHaveBeenCalledTimes(2)
    expect(execute).not.toHaveBeenCalled()
    expect(shell).not.toHaveBeenCalled()
  })

  it('does not dispatch when cancellation arrives during approval', async () => {
    const { service, execute, request } = await harness()
    const controller = new AbortController()
    service.setExecutionApproval(async () => {
      controller.abort(new Error('stopped'))
      return true
    })
    await expect(
      service.execute({ ...request, code: 'import os\nos.unlink("x")' }, controller.signal)
    ).rejects.toThrow('stopped')
    expect(execute).not.toHaveBeenCalled()
  })

  it('reviews the finalized streamed cell, including destructive code appended last', async () => {
    const { service, execute, request } = await harness()
    const approve = vi.fn(async () => false)
    service.setExecutionApproval(approve)
    const cell = await service.beginCodeCell({ ...request, language: 'r' })
    await service.appendCodeCell({ ...request, ...cell, delta: 'x <- 1\n' })
    await service.appendCodeCell({ ...request, ...cell, delta: 'unlink("x")' })
    await service.finishCodeCell({ ...request, ...cell })
    await expect(service.runCell({ ...request, cellId: cell.cellId })).rejects.toThrow(
      'one-time approval'
    )
    expect(approve).toHaveBeenCalledTimes(1)
    expect(execute).not.toHaveBeenCalled()
  })
  it('uses a sole enabled environment without a Session permission prompt', async () => {
    const { service, execute, request, runtimes } = await harness(1)
    const approve = vi.fn(async () => true)
    service.setExecutionApproval(approve)
    await service.execute({ ...request, code: 'print(1)' })
    expect(approve).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(1)
    expect((await service.listRuntimes(request)).bindings.python?.runtimeId).toBe(runtimes[0].envId)
  })

  it('requires a concrete selection with multiple environments and preserves the binding on denied switch', async () => {
    const { service, request, runtimes } = await harness(2)
    const approve = vi.fn(async () => true)
    service.setExecutionApproval(approve)
    await expect(service.execute({ ...request, code: 'print(1)' })).rejects.toThrow(
      'Several python environments'
    )
    expect(approve).not.toHaveBeenCalled()
    const binding = {
      ...request,
      language: 'python' as const,
      runtimeId: runtimes[0].envId,
      provenanceContext: {
        rootFrameId: 'root',
        agentFrameId: 'root',
        messageBranchId: 'branch',
        runtimeSegmentId: 'segment',
        promptMessageId: 'prompt'
      }
    }
    expect(await service.bindRuntime(binding)).toHaveProperty('bound.runtimeId', runtimes[0].envId)
    expect(approve).toHaveBeenCalledTimes(1)
    expect(approve).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        rawInput: {
          notebookRuntimeSelection: {
            language: 'python',
            runtimeId: runtimes[0].envId,
            label: runtimes[0].label,
            interpreterPath: runtimes[0].interpreterPath,
            previousRuntimeId: undefined,
            previousLabel: undefined
          }
        }
      })
    )
    await service.bindRuntime(binding)
    expect(approve).toHaveBeenCalledTimes(1)
    await service.execute({ ...request, code: 'print(1)' })
    expect(approve).toHaveBeenCalledTimes(1)
    approve.mockResolvedValue(false)
    expect(
      await service.switchRuntime({ ...binding, runtimeId: runtimes[1].envId })
    ).toHaveProperty('bindingChanged', false)
    expect((await service.listRuntimes(request)).bindings.python?.runtimeId).toBe(runtimes[0].envId)
    expect(approve).toHaveBeenCalledTimes(2)
    expect(approve).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        rawInput: {
          notebookRuntimeSelection: {
            language: 'python',
            runtimeId: runtimes[1].envId,
            label: runtimes[1].label,
            interpreterPath: runtimes[1].interpreterPath,
            previousRuntimeId: runtimes[0].envId,
            previousLabel: runtimes[0].label
          }
        }
      })
    )
    await expect(
      service.execute({ ...request, code: 'import os\nos.unlink("a.txt")' })
    ).rejects.toThrow('one-time approval')
    expect(approve).toHaveBeenCalledTimes(3)
    expect(approve).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        rawInput: expect.objectContaining({
          notebookCodeRisk: expect.objectContaining({
            risks: [{ operation: 'os.unlink', source: 'os.unlink("a.txt")', line: 2 }]
          })
        })
      })
    )
  })
})

configureTestRuntimeMetadata()
