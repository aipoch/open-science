import { execFile } from 'node:child_process'

import { promisify } from 'node:util'

import { expect, it } from 'vitest'

import { analyzeNotebookCodeRisk } from './index'

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
    expect(mappings.slice(0, pythonNativeKeywordForms.length).every((value) => !value.shell)).toBe(
      true
    )
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
