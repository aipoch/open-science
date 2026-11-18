/* eslint-disable @typescript-eslint/explicit-function-return-type -- standalone JavaScript benchmark */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, openSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { cpus, platform, release, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const option = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index < 0 ? fallback : process.argv[index + 1]
}
const formalOption = option('--formal-report')
const preparedInputOption = option('--prepared-input')
if (Boolean(formalOption) === Boolean(preparedInputOption))
  throw new Error('Provide exactly one of --formal-report or --prepared-input')
const formalPath = formalOption ? resolve(formalOption) : undefined
const preparedInputPath = preparedInputOption ? resolve(preparedInputOption) : undefined
const output = resolve(option('--output', '/tmp/open-science-runtime-benchmarks.json'))
const repeats = Number(option('--repeats', '3'))
if (!Number.isSafeInteger(repeats) || repeats < 1) throw new Error('Invalid repeat count')
const targetTurns = Number(option('--target-turns', '0'))
if (!Number.isSafeInteger(targetTurns) || targetTurns < 0)
  throw new Error('Target turns must be a nonnegative integer')
const retain = process.argv.includes('--retain')
const probeOnly = process.argv.includes('--probe-only')
const legacyOnly = process.argv.includes('--legacy-only')
if (targetTurns && legacyOnly) throw new Error('Target turns requires the full workload')
const candidateRoot = option('--candidate-root')
  ? await realpath(resolve(option('--candidate-root')))
  : undefined
if (candidateRoot === (await realpath(workspace)))
  throw new Error('Copy the candidate into an independent frozen source directory first')
let reference
let preparedReport
let prepared
if (formalPath) {
  reference = JSON.parse(await readFile(formalPath, 'utf8'))
  if (
    reference.status !== 'complete' ||
    !reference.equivalenceVerified ||
    !reference.frozenSourceReverified
  )
    throw new Error('The repository benchmark must finish and verify before runtime measurement')
  preparedReport = `${formalPath}.logs/prepare.json`
  prepared = JSON.parse(await readFile(preparedReport, 'utf8'))
} else {
  // Preparation is a separate prerequisite, not a completed repository performance run.
  const input = JSON.parse(await readFile(preparedInputPath, 'utf8'))
  const validHash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
  if (
    input.kind !== 'open-science-runtime-prepared-input' ||
    input.version !== 1 ||
    typeof input.preparedReport !== 'string' ||
    !input.preparedReport ||
    !validHash(input.preparedReportSha256) ||
    typeof input.baselineCommit !== 'string' ||
    !/^[a-f0-9]{40}$/.test(input.baselineCommit) ||
    typeof input.baselineRoot !== 'string' ||
    !input.baselineRoot ||
    !input.baselineSourceHashes ||
    typeof input.baselineSourceHashes !== 'object' ||
    Array.isArray(input.baselineSourceHashes) ||
    Object.keys(input.baselineSourceHashes).length === 0 ||
    !Object.entries(input.baselineSourceHashes).every(
      ([path, hash]) =>
        /^(src|scripts|e2e)\//.test(path) && !path.split('/').includes('..') && validHash(hash)
    ) ||
    !Array.isArray(input.sources?.cases) ||
    input.sources.cases.length !== 3
  )
    throw new Error('Invalid prepared-input manifest')
  preparedReport = resolve(dirname(preparedInputPath), input.preparedReport)
  const contents = await readFile(preparedReport)
  if (createHash('sha256').update(contents).digest('hex') !== input.preparedReportSha256)
    throw new Error('Prepared report does not match its recorded hash')
  prepared = JSON.parse(contents.toString('utf8'))
  if (
    prepared.phase !== 'prepare' ||
    !Array.isArray(prepared.seeds) ||
    prepared.seeds.length !== input.sources.cases.length ||
    new Set(input.sources.cases.map((source) => source.id)).size !== input.sources.cases.length ||
    new Set(prepared.seeds.map((seed) => seed.source?.id)).size !== prepared.seeds.length ||
    !input.sources.cases.every((source) => {
      const seed = prepared.seeds.find((item) => item.source?.id === source.id)
      return (
        typeof source.id === 'string' &&
        source.id.length > 0 &&
        validHash(source.sha256) &&
        Number.isSafeInteger(source.bytes) &&
        source.bytes > 0 &&
        seed?.source.sha256 === source.sha256 &&
        seed.source.bytes === source.bytes
      )
    })
  )
    throw new Error('Prepared report must contain the three verified source archives')
  const baselineRoot = await realpath(resolve(dirname(preparedInputPath), input.baselineRoot))
  reference = {
    baselineCommit: input.baselineCommit,
    sources: input.sources,
    frozenSourceRoots: { 'original-json': baselineRoot },
    frozenSourceHashes: { 'original-json': input.baselineSourceHashes }
  }
}
const testFile = 'src/main/session-persistence/official-science-runtime-storage.benchmark.test.ts'
const variants = ['original-json', 'current-legacy-json', 'current-jsonl']
const isCurrent = (variant) => variant !== 'original-json'
const isJournal = (variant) => variant === 'current-jsonl'
const orderForRepeat = (repeat) => {
  const offset = (repeat - 1) % variants.length
  return [...variants.slice(offset), ...variants.slice(0, offset)]
}
if (!candidateRoot) throw new Error('Provide an independent frozen --candidate-root')
const logs = `${output}.logs`
const sandbox = await mkdtemp(join(tmpdir(), 'open-science-runtime-source-'))
const rootsByVariant = Object.fromEntries(
  variants.map((variant) => [variant, join(sandbox, variant)])
)
const ownedDataRoots = new Set()
await mkdir(logs, { recursive: true })
const ensure = (condition, message) => {
  if (!condition) throw new Error(message)
}
const sourceInventory = async (root) => {
  const result = {}
  const visit = async (directory) => {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      const file = join(directory, entry.name)
      if (entry.isDirectory()) await visit(file)
      else if (entry.isFile())
        result[file] = createHash('sha256')
          .update(await readFile(join(root, file)))
          .digest('hex')
      else throw new Error(`Unexpected source symlink: ${file}`)
    }
  }
  for (const directory of ['src', 'scripts', 'e2e']) await visit(directory)
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)))
}
const candidateSourceHashes = candidateRoot ? await sourceInventory(candidateRoot) : undefined
const run = async (variant, phase, stem, extra = {}) => {
  const report = join(logs, `${stem}.json`)
  const fd = openSync(join(logs, `${stem}.log`), 'w')
  try {
    const code = await new Promise((resolveExit, reject) => {
      const child = spawn(
        process.execPath,
        ['node_modules/vitest/vitest.mjs', 'run', testFile, '--project=default', '--maxWorkers=1'],
        {
          cwd: rootsByVariant[variant],
          env: {
            ...process.env,
            OPEN_SCIENCE_RUNTIME_PHASE: phase,
            OPEN_SCIENCE_RUNTIME_VARIANT: variant,
            OPEN_SCIENCE_RUNTIME_REPORT: report,
            OPEN_SCIENCE_RUNTIME_INPUT: preparedReport,
            ...extra
          },
          stdio: ['ignore', fd, fd]
        }
      )
      child.on('error', reject)
      child.on('exit', resolveExit)
    })
    ensure(code === 0, `Runtime benchmark failed (${code}): ${join(logs, `${stem}.log`)}`)
  } finally {
    closeSync(fd)
  }
  return { report, value: JSON.parse(await readFile(report, 'utf8')) }
}
const stats = (values) => {
  ensure(values.length > 0 && values.every(Number.isFinite), 'Invalid measured values')
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return {
    count: sorted.length,
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    min: sorted[0],
    max: sorted.at(-1)
  }
}
const verifyEquivalence = (runs) => {
  for (const { source } of prepared.seeds) {
    const scenarios = runs.map((run) => run.writes.find(({ id }) => id === source.id))
    for (const stage of ['imported', 'fork']) {
      ensure(
        new Set(scenarios.map((item) => item[stage].digest)).size === 1,
        `Complete canonical documents differ: ${source.id}/${stage}`
      )
      ensure(
        new Set(scenarios.map((item) => item[stage].sqliteDigest)).size === 1,
        `Complete business SQL differs: ${source.id}/${stage}`
      )
    }
    ensure(
      new Set(scenarios.map((item) => JSON.stringify(item.fork.metadata))).size === 1,
      `Continuation metadata differs: ${source.id}`
    )
    if (scenarios[0].control) {
      for (const key of ['digest', 'sqliteDigest'])
        ensure(
          new Set(scenarios.map((item) => item.control[key])).size === 1,
          `Control differs: ${source.id}/${key}`
        )
      const expected = scenarios[0].fork.turns.map((turn) => ({
        absoluteUserTurn: turn.absoluteUserTurn,
        kind: turn.kind,
        sampleStart: turn.sampleStart,
        sampleEnd: turn.sampleEnd,
        endpoint: turn.endpoint,
        sqliteRows: turn.sqliteRows,
        sqliteDigest: turn.sqliteDigest,
        metadata: turn.metadata
      }))
      for (const scenario of scenarios)
        ensure(
          JSON.stringify(
            scenario.fork.turns.map((turn) => ({
              absoluteUserTurn: turn.absoluteUserTurn,
              kind: turn.kind,
              sampleStart: turn.sampleStart,
              sampleEnd: turn.sampleEnd,
              endpoint: turn.endpoint,
              sqliteRows: turn.sqliteRows,
              sqliteDigest: turn.sqliteDigest,
              metadata: turn.metadata
            }))
          ) === JSON.stringify(expected),
          `Intermediate turn differs: ${source.id}`
        )
    }
  }
}

const summarizeTurns = (result) => ({
  targetTurns,
  controlFreshFullReads: result.runs.reduce((n, run) => n + run.controlReads.length, 0),
  controlPageOperations: result.runs.reduce((n, run) => n + run.controlPages.length, 0),
  cases: prepared.seeds.map(({ source }) => ({
    id: source.id,
    variants: Object.fromEntries(
      variants.map((variant) => {
        const runs = result.runs.filter((run) => run.variant === variant)
        const scenarios = runs.map((run) => run.writes.find(({ id }) => id === source.id))
        const turns = scenarios[0].fork.turns.map((first, index) => {
          const samples = scenarios.flatMap((scenario) => {
            const turn = scenario.fork.turns[index]
            return scenario.fork.samples.slice(turn.sampleStart, turn.sampleEnd)
          })
          return {
            absoluteUserTurn: first.absoluteUserTurn,
            kind: first.kind,
            metadata: first.metadata,
            endpoint: first.endpoint,
            sqliteRows: first.sqliteRows,
            commitsPerRun: first.saveSummary.commits,
            cumulativeOwnerMs: stats(
              scenarios.map((scenario) => scenario.fork.turns[index].saveSummary.ownerMs)
            ),
            bytesPerRun: stats(
              scenarios.map((scenario) => scenario.fork.turns[index].saveSummary.bytes)
            ),
            allSaveOwnerMs: stats(samples.map((sample) => sample.ownerMs)),
            streamingSaveOwnerMs: samples.some((sample) => sample.kind === 'message')
              ? stats(
                  samples
                    .filter((sample) => sample.kind === 'message')
                    .map((sample) => sample.ownerMs)
                )
              : null
          }
        })
        return [
          variant,
          {
            turns,
            allMeasuredSavesOwnerMs: stats(
              scenarios.map((scenario) => scenario.fork.samples.reduce((n, s) => n + s.ownerMs, 0))
            ),
            simulatedFollowupSavesOwnerMs: stats(
              scenarios.map((scenario) =>
                scenario.fork.turns.slice(1).reduce((n, t) => n + t.saveSummary.ownerMs, 0)
              )
            ),
            simulatedFollowupBytes: stats(
              scenarios.map((scenario) =>
                scenario.fork.turns.slice(1).reduce((n, t) => n + t.saveSummary.bytes, 0)
              )
            ),
            control: {
              fullReadMs: stats(
                runs.flatMap((run) =>
                  run.controlReads
                    .filter(({ id }) => id === source.id)
                    .map(({ restoreMs }) => restoreMs)
                )
              ),
              recentPageMs: stats(
                runs.flatMap((run) =>
                  run.controlPages
                    .filter(({ id, mode }) => id === source.id && mode === 'recent')
                    .map(({ elapsedMs }) => elapsedMs)
                )
              ),
              allPagesMs: stats(
                runs.flatMap((run) =>
                  run.controlPages
                    .filter(({ id, mode }) => id === source.id && mode === 'all')
                    .map(({ elapsedMs }) => elapsedMs)
                )
              )
            }
          }
        ]
      })
    )
  }))
})
const summarize = (result) => ({
  status: result.status,
  equivalenceVerified: result.equivalenceVerified,
  frozenSourceReverified: result.frozenSourceReverified,
  measuredSaveCount: result.runs.reduce(
    (sum, run) =>
      sum +
      run.writes.reduce(
        (n, item) =>
          n +
          item.imported.sample.commits +
          item.fork.samples.reduce((x, sample) => x + sample.commits, 0),
        0
      ),
    0
  ),
  measuredFreshFullReadCount: result.runs.reduce((sum, run) => sum + run.reads.length, 0),
  measuredPageOperationCount: result.runs.reduce((sum, run) => sum + run.pages.length, 0),
  measuredDisplayPageOperationCount: result.runs.reduce(
    (sum, run) =>
      sum + run.pages.filter(({ mode, complete }) => mode !== 'legacy-first' && !complete).length,
    0
  ),
  measuredCompleteLegacyReadCount: result.runs.reduce(
    (sum, run) => sum + run.pages.filter(({ complete }) => complete).length,
    0
  ),
  untimedProbeCases: result.probes.reduce((sum, run) => sum + run.writes.length, 0),
  cases: prepared.seeds.map(({ source }) => {
    const compared = Object.fromEntries(
      variants.map((variant) => {
        const runs = result.runs.filter((run) => run.variant === variant)
        if (!runs.length) return [variant, undefined]
        const scenarios = runs.map((run) => run.writes.find(({ id }) => id === source.id))
        const pageRuns = runs.flatMap((run) => run.pages.filter(({ id }) => id === source.id))
        const saves = scenarios.flatMap((scenario) => scenario.fork.samples)
        const statSaves = (kind, field = 'ownerMs') =>
          stats(saves.filter((sample) => sample.kind === kind).map((sample) => sample[field]))
        return [
          variant,
          {
            messageOwnerMs: statSaves('message'),
            messageRepositorySaveMs: statSaves('message', 'repositorySaveMs'),
            allForkCommitOwnerMs: stats(saves.map(({ ownerMs }) => ownerMs)),
            promptOwnerMs: statSaves('prompt'),
            admissionOwnerMs: statSaves('admission'),
            terminalOwnerMs: statSaves('terminal'),
            importedTitleOwnerMs: stats(
              scenarios.map((scenario) => scenario.imported.sample.ownerMs)
            ),
            allForkBytesPerRun: stats(
              scenarios.map((scenario) =>
                scenario.fork.samples.reduce((sum, sample) => sum + sample.bytes, 0)
              )
            ),
            messageBytesPerRun: stats(
              scenarios.map((scenario) =>
                scenario.fork.samples
                  .filter(({ kind }) => kind === 'message')
                  .reduce((sum, sample) => sum + sample.bytes, 0)
              )
            ),
            fullReadMs: stats(
              runs.flatMap((run) =>
                run.reads
                  .filter((read) => read.id === source.id && read.stage === 'fork')
                  .map(({ restoreMs }) => restoreMs)
              )
            ),
            recentPageMs: stats(
              pageRuns.filter(({ mode }) => mode === 'recent').map(({ elapsedMs }) => elapsedMs)
            ),
            allPagesMs: stats(
              pageRuns.filter(({ mode }) => mode === 'all').map(({ elapsedMs }) => elapsedMs)
            ),
            legacyFirstPageMs: stats(
              pageRuns
                .filter(({ mode }) => mode === 'legacy-first')
                .map(({ elapsedMs }) => elapsedMs)
            ),
            pageDetails: pageRuns
              .filter(({ mode }) => mode !== 'all')
              .slice(0, 2)
              .map(
                ({
                  mode,
                  complete,
                  paginatedResponse,
                  storageFormat,
                  totalItems,
                  pageCount,
                  firstPageMessages,
                  firstPageActivities,
                  completeMessages,
                  completeActivities,
                  pageBytes
                }) => ({
                  mode,
                  complete,
                  paginatedResponse,
                  storageFormat,
                  totalItems,
                  pageCount,
                  firstPageMessages,
                  firstPageActivities,
                  completeMessages,
                  completeActivities,
                  pageBytes
                })
              ),
            totalPages: pageRuns.find(({ mode }) => mode === 'all').pageCount,
            seedStorage: scenarios[0].seedStorage,
            storage: scenarios[0].fork.storage
          }
        ]
      })
    )
    const original = compared['original-json']
    return {
      id: source.id,
      variants: compared,
      percentChangeVsOriginalJson: Object.fromEntries(
        variants.filter(isCurrent).map((variant) => {
          const candidate = compared[variant]
          return [
            variant,
            original && candidate
              ? Object.fromEntries(
                  [
                    'messageOwnerMs',
                    'messageRepositorySaveMs',
                    'fullReadMs',
                    'recentPageMs',
                    'allPagesMs',
                    'legacyFirstPageMs',
                    'messageBytesPerRun',
                    'allForkBytesPerRun'
                  ].map((key) => [key, 100 * (candidate[key].median / original[key].median - 1)])
                )
              : undefined
          ]
        })
      )
    }
  })
})
const describe = (result, summary) => {
  const fixed = (value) => value.toFixed(2)
  const lines = [
    '# Open Science：保留旧 JSON 与新 JSONL 分路实测',
    '',
    `状态：${result.status}；完整 canonical 文档、SQLite 业务字段及全部返回展示字段：${result.equivalenceVerified ? '校验通过' : '未完成'}；冻结源码：${result.frozenSourceReverified ? '复核通过' : '未完成'}。`,
    '',
    '三种路径分别为原版 JSON、当前版保留旧 JSON、当前版新 JSONL。后两路使用同一冻结源码。三份官方静态历史不变，各追加同一份32 KiB受控回复。每四个原500 ms批次合并为一次虚拟2秒flush，保留768个文本事件；48次文本提交+prompt+admission+terminal=51次fork保存，另有导入会话标题保存。这些是提交次数，不是用户提问次数。',
    '',
    '当前JSONL在计时前将临时副本中的相同canonical文档写成一条session_snapshot，revision及业务SQL不变；这是测试初始格式构造，不是产品自动迁移，也不包含创建或导入完整会话的耗时。保存计时覆盖后续真实RuntimeSessionOwner → StateOwner → Repository → SQLite/文件路径，包括首次保存建立JSONL历史索引的成本。不含真实模型、IPC/renderer、文件索引或provenance观察器，不代表整个Electron端到端。',
    '',
    '不计2秒调度等待；owner耗时包含处理与保存，repositorySaveMs为嵌套子区间，不能相加。完整读取在新进程中计时Repository构造及load，不启用分页SQLite连接；打开会话/展示分页也使用新进程，但从SQLite连接/迁移和Repository构造完成后计时。均排除进程启动、编译以及计时后内容校验；没有清空OS文件缓存。',
    '',
    '新JSONL最近页固定80条业务记录（message+完整tool activity），相关用户问题额外附带、去重；这与80个DOM条目并不等同。原版JSON完整读取一次，再在内存切页；加载全部展示页不会反复读取原JSON。当前旧JSON的页面API直接返回完整会话、不分页、不建索引，故其打开和全部页列实质上均为一次完整返回。新JSONL最近页使用保存时维护的SQLite索引。',
    '',
    `计时保存${summary.measuredSaveCount}次；保存后新进程完整读取${summary.measuredFreshFullReadCount}次；展示分页操作${summary.measuredDisplayPageOperationCount}次；旧JSON完整返回操作${summary.measuredCompleteLegacyReadCount}次（后二者合计${summary.measuredPageOperationCount}次读取API操作）。另有${summary.untimedProbeCases}个不计时probe案例。${probeOnly ? '这是功能smoke，无正式性能结论。' : `每条路径${repeats}轮，按循环移位交错执行。`}`
  ]
  for (const [variant, title] of [
    ['current-legacy-json', '旧 JSON：修改前后'],
    ['current-jsonl', '新 JSONL：与修改前 JSON 对比']
  ]) {
    lines.push(
      '',
      `## ${title}`,
      '',
      '|案例|原版保存 ms|当前保存 ms|原版完整读 ms|当前完整读 ms|原版最近展示页 ms|当前打开/最近页 ms|原版全部展示页 ms|当前全部返回/页 ms|',
      '|---|---:|---:|---:|---:|---:|---:|---:|---:|'
    )
    for (const item of summary.cases) {
      const a = item.variants['original-json']
      const b = item.variants[variant]
      if (!a || !b) continue
      lines.push(
        `|${item.id}|${[a.messageOwnerMs.median, b.messageOwnerMs.median, a.fullReadMs.median, b.fullReadMs.median, a.recentPageMs.median, b.recentPageMs.median, a.allPagesMs.median, b.allPagesMs.median].map(fixed).join('|')}|`
      )
    }
  }
  lines.push(
    '',
    `上述各列均为各自操作的中位数。保存列汇总每案例每路径${repeats}轮共${repeats * 48}次连续正文提交；完整读取等读取指标每案例每路径${repeats}个样本。最近页和全部展示页均不能当作完整图及运行状态恢复速度。小会话不足80条时一页返回全部活动分支展示内容。旧JSON直接完整返回，不能据其页面API名称声称存在分页。`,
    '',
    '## 读取内容与旧记录只读检查',
    '',
    '|案例|路径|原始旧JSON完整返回 ms|续写后业务记录数|续写后完整消息/工具数|续写后首屏消息/工具数（含问题上下文）|返回页数|',
    '|---|---|---:|---:|---|---|---:|'
  )
  for (const item of summary.cases)
    for (const [variant, value] of Object.entries(item.variants)) {
      if (!value) continue
      const detail = value.pageDetails.find(({ mode }) => mode === 'recent')
      lines.push(
        `|${item.id}|${variant}|${fixed(value.legacyFirstPageMs.median)}|${detail.totalItems}|${detail.completeMessages}/${detail.completeActivities}|${detail.firstPageMessages}/${detail.firstPageActivities}|${value.totalPages}|`
      )
    }
  lines.push(
    '',
    '原始旧JSON完整返回列测未续写种子，其余内容列是续写后的会话；两类输入分别比较。即使在current-jsonl源码路径中，原始旧JSON只读检查仍使用JSON并断言未改写、未生成JSONL、未建立索引。',
    '',
    '|案例|路径|保存 mean/p95 ms|完整读 mean/p95 ms|prompt/admission/terminal ms|51次fork写入字节|',
    '|---|---|---|---|---|---:|'
  )
  for (const item of summary.cases)
    for (const [variant, value] of Object.entries(item.variants))
      if (value)
        lines.push(
          `|${item.id}|${variant}|${fixed(value.messageOwnerMs.mean)}/${fixed(value.messageOwnerMs.p95)}|${fixed(value.fullReadMs.mean)}/${fixed(value.fullReadMs.p95)}|${[value.promptOwnerMs.median, value.admissionOwnerMs.median, value.terminalOwnerMs.median].map(fixed).join('/')}|${value.allForkBytesPerRun.median}|`
        )
  lines.push(
    '',
    '文件写入量记录同一组file hooks，仅包含计时阶段的51次fork保存；测试准备阶段的初始JSON/JSONL文件不计入，不包含SQLite/WAL字节或设备物理写放大。SQLite索引更新耗时包含在保存时间内。当前旧JSON每次仍完整原子写入，新JSONL追加业务记录。',
    '',
    '校验在计时外比较全部canonical字段（含图、消息、工具、token、产物等）和业务SQL字段；JSONL及原版内存分页逐页与完整decoder的独立80条切页结果比较全部展示字段，旧JSON完整返回与全部canonical逐字段比较。仅通过官方便携路径codec归一化隔离数据根路径，没有删字段来制造相等。返回语义不同的完整文档与分页投影不直接比较pageDigest，各自有完整内容oracle。',
    '',
    '本轮新JSONL没有manifest、周期checkpoint、receipt、整会话摘要或逐行checksum；probe核对实际追加行和原始chunk。历史兼容、删除及恢复由存储回归验证；本性能driver未测试旧版应用打开新格式。',
    '',
    `完整原始数据：${output}`,
    `统计分布：${output.replace(/\.json$/, '')}.summary.json`,
    `进程日志：${logs}`,
    `官方来源与种子：${preparedReport}`,
    ''
  )
  return lines.join('\n')
}

const result = {
  status: 'running',
  equivalenceVerified: false,
  frozenSourceReverified: false,
  description:
    'Three-path real-runtime 2s comparison: baseline JSON, current retained legacy JSON, current new JSONL. Same canonical starting histories; JSONL fixture setup excluded and no migration invoked. All canonical, business SQL and returned display fields checked outside timers. Warm OS cache; process startup, DB startup and compilation excluded. Legacy JSON complete-return without indexing; original JSON loads once before all in-memory display pages. No IPC, renderer, file index or provenance observers.',
  baselineCommit: reference.baselineCommit,
  targetTurns,
  variants,
  repeatOrders: Array.from({ length: repeats }, (_, index) => orderForRepeat(index + 1)),
  repositoryBenchmark: formalPath,
  preparedInput: preparedInputPath,
  preparedReport,
  sourceArchives: reference.sources,
  frozenSourceRoots: rootsByVariant,
  frozenSourceHashes: {},
  candidateSource: { root: candidateRoot, hashes: candidateSourceHashes },
  benchmarkSha256: createHash('sha256')
    .update(await readFile(join(workspace, testFile)))
    .digest('hex'),
  driverSha256: createHash('sha256')
    .update(await readFile(fileURLToPath(import.meta.url)))
    .digest('hex'),
  environment: {
    timestamp: new Date().toISOString(),
    node: process.version,
    platform: platform(),
    release: release(),
    cpu: cpus()[0]?.model
  },
  probes: [],
  runs: [],
  legacyReads: []
}
const summarizeLegacy = (result) => ({
  status: result.status,
  equivalenceVerified: result.equivalenceVerified,
  frozenSourceReverified: result.frozenSourceReverified,
  measuredCompleteLegacyReadCount: result.legacyReads.length,
  cases: prepared.seeds.map(({ source }) => ({
    id: source.id,
    variants: Object.fromEntries(
      variants.map((variant) => {
        const reads = result.legacyReads.filter(
          (item) => item.variant === variant && item.id === source.id
        )
        return [
          variant,
          {
            completeReadMs: stats(reads.map(({ elapsedMs }) => elapsedMs)),
            messages: reads[0].completeMessages,
            activities: reads[0].completeActivities,
            totalItems: reads[0].totalItems
          }
        ]
      })
    )
  }))
})
const describeLegacy = (result, summary) => {
  const lines = [
    '# 旧 JSON 完整读取补测',
    '',
    `状态：${result.status}；${summary.measuredCompleteLegacyReadCount}次新进程完整读取；每版${repeats}轮，同三份未续写的官方历史，顺序轮换。`,
    '',
    '原版直接完整load；新版调用loadSessionHistoryPage，但旧JSON必须返回complete:true、hasMore:false及完整会话，不切80条、不建立索引。逐字段比较完整canonical及业务SQL，并验证JSON逐字未变、没有新JSONL及索引行。',
    '',
    '计时在SQLite连接/迁移及Repository构造之后，仅围住对应读取调用；排除进程启动、编译及计时后全字段校验，没有清空OS文件缓存。这是新进程、暖OS缓存操作耗时，不是冷启动。三个路径均读取相同原始JSON；两条当前路径使用同一源码与同一读取策略。未重新测量保存或JSONL分页。',
    '',
    '|案例|路径|消息/工具|完整读 median ms|完整读 mean/p95 ms|',
    '|---|---|---:|---:|---:|'
  ]
  for (const item of summary.cases) {
    const f = (value) => value.toFixed(2)
    for (const [variant, value] of Object.entries(item.variants))
      lines.push(
        `|${item.id}|${variant}|${value.messages}/${value.activities}|${f(value.completeReadMs.median)}|${f(value.completeReadMs.mean)}/${f(value.completeReadMs.p95)}|`
      )
  }
  return [...lines, '', `原始数据：${output}`, `日志：${logs}`, ''].join('\n')
}
const describeExtension = (result, summary) => {
  const f = (value) => value.toFixed(2)
  const addedTurns = summary.extension.cases
    .map((item) => item.variants['original-json'].turns.length - 1)
    .join('/')
  const lines = [
    `# 官方历史延长至 ${targetTurns} 轮用户提问：存储对照`,
    '',
    `保留原始 2/2/3 轮历史和上次的 32 KiB 控制追问，再按原始历史中的回复/工具规模模拟 ${addedTurns} 轮。没有调用模型或执行真实工具。每条路径运行同一确定性事件序列，500 ms 输入批次按约 2 秒保存。控制轮与后续轮负载不同，不能把其耗时差全部归因于历史增长。`,
    '',
    `状态 ${result.status}；每路径 ${repeats} 次重复，顺序轮换。${summary.measuredSaveCount} 次计时保存；最终/导入控制完整读 ${summary.measuredFreshFullReadCount} 次，控制轮完整读 ${summary.extension.controlFreshFullReads} 次；最终/旧记录页面 API ${summary.measuredPageOperationCount} 次，控制轮页面 API ${summary.extension.controlPageOperations} 次。`,
    '',
    '保存覆盖 RuntimeOwner→StateOwner→Repository→SQLite/文件同步，排除 2 秒等待、模型、IPC/UI、文件索引/provenance。新进程读取排除启动/编译/计时外校验，OS 缓存未清空。JSONL 最近页为80条业务记录加问题上下文，当前旧 JSON 完整返回；原版 JSON 完整加载一次后由测试内存切页。全部展示页不等于全图/运行状态完整恢复。',
    '',
    '|案例|路径|模拟追问累计保存 ms|模拟追问写入 MB|最近展示 ms|全部展示 ms|完整恢复 ms|',
    '|---|---|---:|---:|---:|---:|---:|'
  ]
  for (const item of summary.cases) {
    const extension = summary.extension.cases.find(({ id }) => id === item.id)
    for (const variant of variants) {
      const value = item.variants[variant]
      const extra = extension.variants[variant]
      lines.push(
        `|${item.id}|${variant}|${f(extra.simulatedFollowupSavesOwnerMs.median)}|${f(extra.simulatedFollowupBytes.median / 1e6)}|${f(value.recentPageMs.median)}|${f(value.allPagesMs.median)}|${f(value.fullReadMs.median)}|`
      )
    }
  }
  lines.push(
    '',
    '累计保存先对每次重复的所有对应提交求和，再取重复中位数。写入量仅计会话文件，不含 SQLite/WAL 或设备物理写放大。控制轮及逐轮分布见 summary.extension。JSONL 初始格式构造在计时外，旧 JSON 不迁移；所有路径完整文档、业务 SQL、展示字段及原历史前缀均验证。',
    '',
    `原始数据：${output}`,
    `摘要：${output.replace(/\.json$/, '')}.summary.json`,
    `日志：${logs}`,
    ''
  )
  return lines.join('\n')
}
const verifyPages = (runs, modes = ['recent', 'all', 'legacy-first']) => {
  for (const { source } of prepared.seeds)
    for (const mode of modes) {
      const samples = runs.flatMap((run) =>
        run.pages.filter((item) => item.id === source.id && item.mode === mode)
      )
      for (const key of ['completeDigest', 'sqliteDigest'])
        ensure(
          new Set(samples.map((sample) => sample[key])).size === 1,
          `Complete page source differs: ${source.id}/${mode}/${key}`
        )
      // Legacy complete responses include the full graph/runtime document. Compare their
      // page digests separately from the active-branch display projection returned by paging.
      for (const complete of [true, false]) {
        const equivalent = samples.filter((sample) => Boolean(sample.complete) === complete)
        if (equivalent.length)
          ensure(
            new Set(equivalent.map(({ pageDigest }) => pageDigest)).size === 1,
            `Page content differs: ${source.id}/${mode}/complete=${complete}`
          )
      }
    }
}
try {
  for (const variant of variants) {
    const inputRoot = isCurrent(variant) ? candidateRoot : reference.frozenSourceRoots[variant]
    const expectedHashes = isCurrent(variant)
      ? candidateSourceHashes
      : reference.frozenSourceHashes[variant]
    await cp(inputRoot, rootsByVariant[variant], { recursive: true, verbatimSymlinks: true })
    ensure(
      JSON.stringify(await sourceInventory(rootsByVariant[variant])) ===
        JSON.stringify(expectedHashes),
      `Frozen input changed: ${variant}`
    )
    await cp(join(workspace, testFile), join(rootsByVariant[variant], testFile))
    await cp(
      join(workspace, 'scripts/performance/official-science-followups.ts'),
      join(rootsByVariant[variant], 'scripts/performance/official-science-followups.ts')
    )
    result.frozenSourceHashes[variant] = await sourceInventory(rootsByVariant[variant])
  }
  const execute = async (variant, phase, repeat) => {
    console.log(`Starting ${phase} ${variant} ${repeat}: same three official histories.`)
    const written = await run(
      variant,
      phase,
      `${phase}-${variant}-${repeat}`,
      targetTurns && phase === 'write'
        ? { OPEN_SCIENCE_RUNTIME_TARGET_TURNS: String(targetTurns) }
        : {}
    )
    const reads = []
    const pages = []
    const controlReads = []
    const controlPages = []
    for (const scenario of written.value.results) {
      ownedDataRoots.add(scenario.root)
      for (const turn of scenario.fork.turns ?? [])
        if (turn.milestoneRoot) ownedDataRoots.add(turn.milestoneRoot)
      ensure(
        scenario.fork.samples.length ===
          (scenario.fork.turns
            ? scenario.fork.turns.reduce((n, turn) => n + turn.saveSummary.commits, 0)
            : phase === 'probe'
              ? 5
              : 51),
        'Unexpected runtime commit count'
      )
      if (targetTurns && phase === 'write') {
        ensure(scenario.fork.turns.at(-1).absoluteUserTurn === targetTurns, 'Wrong final user turn')
        ensure(scenario.control.samples.length === 51, 'Control changed')
      }
      ensure(
        scenario.fork.samples.every(({ commits }) => commits === 1),
        'Runtime batch must commit once'
      )
      ensure(
        scenario.seedStorage.format === (isJournal(variant) ? 'journal' : 'json'),
        'Wrong starting authority format'
      )
      ensure(
        scenario.fork.storage.format === (isJournal(variant) ? 'journal' : 'json'),
        'Wrong authority format'
      )
      ensure(
        scenario.imported.storage.format === (isJournal(variant) ? 'journal' : 'json'),
        'Wrong imported authority format'
      )
      if (isJournal(variant)) {
        ensure(
          JSON.stringify(scenario.fork.storage.recordEnvelopeKeys) ===
            JSON.stringify(['records', 'revision', 'type']),
          'Unexpected JSONL envelope'
        )
        ensure(
          scenario.fork.storage.businessRecordTypes.includes('assistant_text_received'),
          'No business text events'
        )
        if (phase === 'probe') {
          const messages = scenario.fork.samples.filter(({ kind }) => kind === 'message')
          ensure(
            messages[0].wireProbe?.textChunks === 0 &&
              messages[0].wireProbe?.entityCollections.includes('graphMessages'),
            'First reply is not a complete item'
          )
          ensure(
            messages[1].wireProbe?.textChunks === 16,
            'Second 2s batch is not 16 original chunks'
          )
          const terminal = scenario.fork.samples.find(({ kind }) => kind === 'terminal')
          ensure(
            terminal.wireProbe?.textChunks === 0 &&
              terminal.wireProbe?.entityCollections.includes('graphMessages'),
            'Missing terminal complete item'
          )
        }
      }
      if (phase === 'probe')
        for (const sample of scenario.fork.samples) {
          if (sample.kind === 'message' && isJournal(variant))
            ensure(sample.fullCodecCalls === 0, `Runtime fast path missed: ${scenario.id}`)
          else
            ensure(
              sample.fullCodecCalls > 0,
              `Full codec control missing: ${scenario.id}/${sample.kind}`
            )
        }
      for (const stage of ['imported', 'fork']) {
        const read = await run(
          variant,
          'read',
          `${phase}-${variant}-${repeat}-${scenario.id}-${stage}`,
          {
            OPEN_SCIENCE_RUNTIME_INPUT: written.report,
            OPEN_SCIENCE_RUNTIME_CASE: scenario.id,
            OPEN_SCIENCE_RUNTIME_STAGE: stage
          }
        )
        reads.push(read.value)
      }
      for (const mode of ['recent', 'all', 'legacy-first']) {
        const page = await run(
          variant,
          'page',
          `${phase}-${variant}-${repeat}-${scenario.id}-${mode}`,
          {
            OPEN_SCIENCE_RUNTIME_INPUT: mode === 'legacy-first' ? preparedReport : written.report,
            OPEN_SCIENCE_RUNTIME_CASE: scenario.id,
            OPEN_SCIENCE_RUNTIME_MODE: mode
          }
        )
        ensure(page.value.hasNativePaging === isCurrent(variant), 'Wrong pagination implementation')
        ensure(
          page.value.paginatedResponse === (isJournal(variant) && mode !== 'legacy-first'),
          'Wrong page response semantics'
        )
        ensure(
          page.value.storageFormat ===
            (isJournal(variant) && mode !== 'legacy-first' ? 'journal' : 'json'),
          'Wrong page authority format'
        )
        if (mode === 'legacy-first') ownedDataRoots.add(page.value.root)
        pages.push(page.value)
      }
      if (scenario.control) {
        ownedDataRoots.add(scenario.control.root)
        const controlReport = join(
          logs,
          `${phase}-${variant}-${repeat}-${scenario.id}-control-input.json`
        )
        await writeFile(
          controlReport,
          JSON.stringify(
            { results: [{ ...scenario, root: scenario.control.root, fork: scenario.control }] },
            null,
            2
          ) + '\n'
        )
        const read = await run(
          variant,
          'read',
          `${phase}-${variant}-${repeat}-${scenario.id}-control-full`,
          {
            OPEN_SCIENCE_RUNTIME_INPUT: controlReport,
            OPEN_SCIENCE_RUNTIME_CASE: scenario.id,
            OPEN_SCIENCE_RUNTIME_STAGE: 'fork'
          }
        )
        controlReads.push(read.value)
        for (const mode of ['recent', 'all']) {
          const page = await run(
            variant,
            'page',
            `${phase}-${variant}-${repeat}-${scenario.id}-control-${mode}`,
            {
              OPEN_SCIENCE_RUNTIME_INPUT: controlReport,
              OPEN_SCIENCE_RUNTIME_CASE: scenario.id,
              OPEN_SCIENCE_RUNTIME_MODE: mode
            }
          )
          ensure(
            page.value.paginatedResponse === isJournal(variant),
            'Wrong control page semantics'
          )
          controlPages.push(page.value)
        }
      }
    }
    console.log(`Finished ${phase} ${variant} ${repeat}: full history, SQL and pages verified.`)
    return {
      variant,
      repeat,
      writeReport: written.report,
      writes: written.value.results,
      reads,
      pages,
      controlReads,
      controlPages
    }
  }
  if (legacyOnly) {
    result.description = 'Legacy JSON complete-return addendum only; no save or JSONL paging runs.'
    for (let repeat = 1; repeat <= repeats; repeat++) {
      for (const variant of orderForRepeat(repeat))
        for (const { source } of prepared.seeds) {
          const read = await run(variant, 'page', `legacy-${variant}-${repeat}-${source.id}`, {
            OPEN_SCIENCE_RUNTIME_CASE: source.id,
            OPEN_SCIENCE_RUNTIME_MODE: 'legacy-first'
          })
          ownedDataRoots.add(read.value.root)
          ensure(read.value.complete && !read.value.createdJsonl, 'Incomplete legacy response')
          ensure(read.value.hasNativePaging === isCurrent(variant), 'Wrong legacy API')
          result.legacyReads.push({ variant, repeat, ...read.value })
        }
      console.log(`Completed legacy-only repeat ${repeat}: complete content and no index verified.`)
      await writeFile(output, JSON.stringify(result, null, 2) + '\n')
    }
    for (const { source } of prepared.seeds) {
      const reads = result.legacyReads.filter(({ id }) => id === source.id)
      for (const key of ['pageDigest', 'completeDigest', 'sqliteDigest'])
        ensure(
          new Set(reads.map((read) => read[key])).size === 1,
          `Legacy differs: ${source.id}/${key}`
        )
    }
  } else {
    for (const variant of variants) result.probes.push(await execute(variant, 'probe', 1))
    verifyEquivalence(result.probes)
    verifyPages(result.probes)
    await writeFile(output, JSON.stringify(result, null, 2) + '\n')
    if (!probeOnly)
      for (let repeat = 1; repeat <= repeats; repeat++) {
        for (const variant of orderForRepeat(repeat)) {
          result.runs.push(await execute(variant, 'write', repeat))
          await writeFile(output, JSON.stringify(result, null, 2) + '\n')
        }
      }
    if (!probeOnly) {
      verifyEquivalence(result.runs)
      verifyPages(result.runs)
      if (targetTurns)
        verifyPages(
          result.runs.map((run) => ({ ...run, pages: run.controlPages })),
          ['recent', 'all']
        )
    }
  }
  for (const variant of variants)
    ensure(
      JSON.stringify(await sourceInventory(rootsByVariant[variant])) ===
        JSON.stringify(result.frozenSourceHashes[variant]),
      `Frozen source changed: ${variant}`
    )
  ensure(
    JSON.stringify(await sourceInventory(candidateRoot)) === JSON.stringify(candidateSourceHashes),
    'Candidate input changed'
  )
  result.status = 'complete'
  result.equivalenceVerified = true
  result.frozenSourceReverified = true
  await writeFile(output, JSON.stringify(result, null, 2) + '\n')
  const summary = legacyOnly ? summarizeLegacy(result) : summarize(result)
  if (targetTurns && !probeOnly) summary.extension = summarizeTurns(result)
  await writeFile(
    output.replace(/\.json$/, '') + '.summary.json',
    JSON.stringify(summary, null, 2) + '\n'
  )
  await writeFile(
    output.replace(/\.json$/, '') + '.md',
    legacyOnly
      ? describeLegacy(result, summary)
      : targetTurns && !probeOnly
        ? describeExtension(result, summary)
        : describe(result, summary)
  )
  console.log(`Runtime and pagination evidence: ${output}`)
} finally {
  if (retain)
    await writeFile(join(logs, 'owned-roots.json'), JSON.stringify([...ownedDataRoots], null, 2))
  else {
    for (const root of ownedDataRoots) {
      ensure(
        /^open-science-runtime-(run|turn-\d+)-/.test(basename(root)),
        'Unexpected cleanup path'
      )
      await rm(root, { recursive: true, force: true })
    }
    await rm(sandbox, { recursive: true, force: true })
  }
}
