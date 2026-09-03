import { Worker } from 'node:worker_threads'

import {
  MANAGED_DIFF_MAX_OUTPUT_BYTES,
  MANAGED_DIFF_MAX_OUTPUT_LINES,
  type ManagedFileVersionDiffLine
} from '../../shared/managed-file-versions'
import { ManagedFileVersionError } from './error'

type DiffTask = { requestId: string; before: string; after: string }
type WorkerLike = {
  once(event: 'message', listener: (value: unknown) => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
  once(event: 'exit', listener: (code: number) => void): unknown
  terminate(): Promise<number>
}
type DiffWorkerResourceLimits = {
  maxOldGenerationSizeMb: number
  maxYoungGenerationSizeMb: number
  stackSizeMb: number
}
type DiffTaskRunnerOptions = {
  createWorker?: (task: DiffTask, resourceLimits: DiffWorkerResourceLimits) => WorkerLike
  timeoutMs?: number
}
const DEFAULT_DIFF_TASK_TIMEOUT_MS = 10_000
const DIFF_WORKER_RESOURCE_LIMITS: DiffWorkerResourceLimits = {
  maxOldGenerationSizeMb: 32,
  maxYoungGenerationSizeMb: 8,
  stackSizeMb: 2
}

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads')
const { diffArrays, diffChars, diffLines } = require('diff')
const LINE_ALIGNMENT_MAX_LINES = 400
const LINE_ALIGNMENT_MAX_CHARACTERS = 50000
const LINE_ALIGNMENT_MAX_EDIT_LENGTH = 1000
const LINE_ALIGNMENT_TIMEOUT_MS = 500
const CROSS_LINE_CONTINUATION_MIN_CHARACTERS = 3
const run = () => {
const splitChangedLines = (value) => {
  if (value.length === 0) return []
  const lines = []
  let start = 0
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '\n') continue
    const hasCarriageReturn = index > start && value[index - 1] === '\r'
    lines.push({
      text: value.slice(start, hasCarriageReturn ? index - 1 : index),
      ending: hasCarriageReturn ? '\r\n' : '\n'
    })
    start = index + 1
  }
  if (start < value.length) lines.push({ text: value.slice(start), ending: '' })
  return lines
}
const anchorCharacterChanges = (changes) => {
  const anchored = []
  let nextAnchor = 0
  for (const change of changes) {
    if (change.added || change.removed) {
      anchored.push(change)
      continue
    }
    let start = 0
    for (let index = 0; index < change.value.length; index += 1) {
      if (change.value[index] !== '\n') continue
      const endingStart = index > start && change.value[index - 1] === '\r' ? index - 1 : index
      if (endingStart > start) {
        anchored.push({ value: change.value.slice(start, endingStart), anchor: nextAnchor++ })
      }
      const ending = change.value.slice(endingStart, index + 1)
      const previous = anchored.at(-1)
      if (previous?.anchor !== undefined && !previous.added && !previous.removed) {
        previous.value += ending
      } else {
        anchored.push({ value: ending })
      }
      start = index + 1
    }
    if (start < change.value.length) {
      anchored.push({ value: change.value.slice(start), anchor: nextAnchor++ })
    }
  }
  return anchored
}
const projectCharacterChanges = (lines, changes, side) => {
  const projected = lines.map((line) => ({ ...line, segments: [] }))
  let lineIndex = 0
  let lineOffset = 0
  let forceBoundary = false
  for (const change of changes) {
    if ((side === 'removed' && change.added) || (side === 'added' && change.removed)) {
      forceBoundary = true
      continue
    }
    const kind = change.added || change.removed ? side : 'context'
    let valueOffset = 0
    while (valueOffset < change.value.length) {
      const line = projected[lineIndex]
      if (!line) return undefined
      const lineLength = line.text.length + line.ending.length
      const take = Math.min(change.value.length - valueOffset, lineLength - lineOffset)
      const text = change.value.slice(valueOffset, valueOffset + take)
      const previous = line.segments.at(-1)
      if (!forceBoundary && previous?.kind === kind && previous.anchor === change.anchor) {
        previous.text += text
      } else {
        line.segments.push({ kind, text, anchor: change.anchor })
      }
      forceBoundary = false
      valueOffset += take
      lineOffset += take
      if (lineOffset === lineLength) {
        lineIndex += 1
        lineOffset = 0
      }
    }
  }
  return lineIndex === projected.length && lineOffset === 0 ? projected : undefined
}
const segmentsForPair = (before, after, options) => {
  const beforeValue = before.text + before.ending
  const afterValue = after.text + after.ending
  const changes = diffChars(beforeValue, afterValue, options)
  if (!changes) return undefined
  const removed = []
  const added = []
  for (const change of changes) {
    if (change.added) added.push({ kind: 'added', text: change.value })
    else if (change.removed) removed.push({ kind: 'removed', text: change.value })
    else {
      removed.push({ kind: 'context', text: change.value })
      added.push({ kind: 'context', text: change.value })
    }
  }
  return { removed, added }
}
const segmentsForReplacement = (before, after) => {
  const markdownPrefix = (text) =>
    text.match(/^(?:(?: {0,3}> ?)|(?: {0,3}(?:[-+*] |\d{1,9}[.)] )))+/)?.[0] ??
    text.match(/^(?:[ \t]*#{1,6}[ \t]+|[ \t]+)/)?.[0] ??
    ''
  const beforePrefix = markdownPrefix(before.text)
  const afterPrefix = markdownPrefix(after.text)
  const contextPrefix = beforePrefix === afterPrefix ? beforePrefix : ''
  const endingSegments = segmentsForPair(
    { text: '', ending: before.ending },
    { text: '', ending: after.ending }
  )
  return {
    removed: [
      ...(contextPrefix.length > 0 ? [{ kind: 'context', text: contextPrefix }] : []),
      ...(before.text.length > contextPrefix.length
        ? [{ kind: 'removed', text: before.text.slice(contextPrefix.length) }]
        : []),
      ...endingSegments.removed
    ],
    added: [
      ...(contextPrefix.length > 0 ? [{ kind: 'context', text: contextPrefix }] : []),
      ...(after.text.length > contextPrefix.length
        ? [{ kind: 'added', text: after.text.slice(contextPrefix.length) }]
        : []),
      ...endingSegments.added
    ]
  }
}
const changedSegments = (line, kind) => [{ kind, text: line.text + line.ending }]
const conservativeLineAlignment = (beforeLines, afterLines) => [
  ...beforeLines.map((before) => ({ kind: 'removed', before })),
  ...afterLines.map((after) => ({ kind: 'added', after }))
]
const alignChangedLines = (beforeLines, afterLines) => {
  if (beforeLines.length === 0 || afterLines.length === 0) {
    return conservativeLineAlignment(beforeLines, afterLines)
  }
  const characterCount = [...beforeLines, ...afterLines].reduce(
    (total, line) => total + line.text.length + line.ending.length,
    0
  )
  if (
    beforeLines.length + afterLines.length > LINE_ALIGNMENT_MAX_LINES ||
    characterCount > LINE_ALIGNMENT_MAX_CHARACTERS
  ) {
    return conservativeLineAlignment(beforeLines, afterLines)
  }

  const deadline = Date.now() + LINE_ALIGNMENT_TIMEOUT_MS
  const characterChanges = diffChars(
    beforeLines.map((line) => line.text + line.ending).join(''),
    afterLines.map((line) => line.text + line.ending).join(''),
    { maxEditLength: LINE_ALIGNMENT_MAX_EDIT_LENGTH, timeout: LINE_ALIGNMENT_TIMEOUT_MS }
  )
  if (!characterChanges) return conservativeLineAlignment(beforeLines, afterLines)
  const anchoredCharacterChanges = anchorCharacterChanges(characterChanges)
  const projectedBeforeLines = projectCharacterChanges(beforeLines, anchoredCharacterChanges, 'removed')
  const projectedAfterLines = projectCharacterChanges(afterLines, anchoredCharacterChanges, 'added')
  if (!projectedBeforeLines || !projectedAfterLines) {
    return conservativeLineAlignment(beforeLines, afterLines)
  }
  const toToken = (line, index) => {
    const anchors = new Map()
    for (const segment of line.segments) {
      if (segment.kind !== 'context' || segment.anchor === undefined) continue
      const text = segment.text.replace(/\r?\n$/, '')
      if (text.length > 0) anchors.set(segment.anchor, [...text].length)
    }
    return { index, line, anchors }
  }
  const beforeTokens = projectedBeforeLines.map(toToken)
  const afterTokens = projectedAfterLines.map(toToken)
  const pairDetails = beforeTokens.map((before) =>
    afterTokens.map((after) => {
      const anchors = []
      let commonCharacters = 0
      let longestAnchor = 0
      for (const [candidate, length] of before.anchors) {
        if (!after.anchors.has(candidate)) continue
        anchors.push(candidate)
        commonCharacters += length
        longestAnchor = Math.max(longestAnchor, length)
      }
      const shortestLine = Math.min([...before.line.text].length, [...after.line.text].length)
      const isSameBlankLine =
        before.line.text.trim().length === 0 &&
        before.line.text === after.line.text &&
        before.line.ending === after.line.ending
      return {
        anchors,
        related: isSameBlankLine || (shortestLine > 0 && commonCharacters * 2 >= shortestLine),
        connectsCrossLine: longestAnchor >= CROSS_LINE_CONTINUATION_MIN_CHARACTERS
      }
    })
  )
  const linesAreRelated = (before, after) => pairDetails[before.index][after.index].related

  const parent = Array.from(
    { length: beforeTokens.length + afterTokens.length },
    (_, index) => index
  )
  const find = (node) => {
    while (parent[node] !== node) {
      parent[node] = parent[parent[node]]
      node = parent[node]
    }
    return node
  }
  const union = (left, right) => {
    const leftRoot = find(left)
    const rightRoot = find(right)
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot
  }
  const beforeDegrees = beforeTokens.map(() => 0)
  const afterDegrees = afterTokens.map(() => 0)
  const anchorEdges = []
  for (let beforeIndex = 0; beforeIndex < beforeTokens.length; beforeIndex += 1) {
    for (let afterIndex = 0; afterIndex < afterTokens.length; afterIndex += 1) {
      const detail = pairDetails[beforeIndex][afterIndex]
      if (!detail.related && !detail.connectsCrossLine) continue
      const beforeNode = beforeIndex
      const afterNode = beforeTokens.length + afterIndex
      union(beforeNode, afterNode)
      beforeDegrees[beforeIndex] += 1
      afterDegrees[afterIndex] += 1
      anchorEdges.push({ beforeNode, afterNode, anchors: detail.anchors })
    }
  }
  const crossLineRoots = new Set()
  for (let index = 0; index < beforeDegrees.length; index += 1) {
    if (beforeDegrees[index] > 1) crossLineRoots.add(find(index))
  }
  for (let index = 0; index < afterDegrees.length; index += 1) {
    if (afterDegrees[index] > 1) crossLineRoots.add(find(beforeTokens.length + index))
  }
  const crossLineAnchors = new Set()
  for (const edge of anchorEdges) {
    if (!crossLineRoots.has(find(edge.beforeNode))) continue
    for (const candidate of edge.anchors) crossLineAnchors.add(candidate)
  }
  const remainingMs = deadline - Date.now()
  if (remainingMs <= 0) return conservativeLineAlignment(beforeLines, afterLines)
  const changes = diffArrays(beforeTokens, afterTokens, {
    comparator: linesAreRelated,
    maxEditLength: beforeLines.length + afterLines.length,
    timeout: remainingMs
  })
  if (!changes) return conservativeLineAlignment(beforeLines, afterLines)

  const hasCrossLineAnchor = (token) => {
    for (const candidate of token.anchors.keys()) {
      if (crossLineAnchors.has(candidate)) return true
    }
    return false
  }
  const crossLineSegments = (line, kind) => {
    const segments = []
    for (const segment of line.segments) {
      const segmentKind =
        segment.kind === 'context' &&
        ((segment.anchor !== undefined && crossLineAnchors.has(segment.anchor)) ||
          (segment.anchor === undefined && /^(?:\r?\n)+$/.test(segment.text)))
          ? 'context'
          : kind
      const previous = segments.at(-1)
      if (previous?.kind === segmentKind) previous.text += segment.text
      else segments.push({ kind: segmentKind, text: segment.text })
    }
    return segments
  }
  const crossLinePairSegments = (beforeIndex, afterIndex) =>
    hasCrossLineAnchor(beforeTokens[beforeIndex]) || hasCrossLineAnchor(afterTokens[afterIndex])
      ? {
          removed: crossLineSegments(projectedBeforeLines[beforeIndex], 'removed'),
          added: crossLineSegments(projectedAfterLines[afterIndex], 'added')
        }
      : undefined

  const alignment = []
  let beforeIndex = 0
  let afterIndex = 0
  for (let changeIndex = 0; changeIndex < changes.length; changeIndex += 1) {
    const change = changes[changeIndex]
    const next = changes[changeIndex + 1]
    if (change.removed && next?.added) {
      const beforeRun = projectedBeforeLines.slice(beforeIndex, beforeIndex + change.value.length)
      const afterRun = projectedAfterLines.slice(afterIndex, afterIndex + next.value.length)
      const beforeNonBlankCount = beforeRun.filter((line) => line.text.length > 0).length
      const afterNonBlankCount = afterRun.filter((line) => line.text.length > 0).length
      if (
        beforeRun.length === afterRun.length ||
        beforeNonBlankCount === afterNonBlankCount
      ) {
        let beforeRunIndex = 0
        let afterRunIndex = 0
        while (beforeRunIndex < beforeRun.length || afterRunIndex < afterRun.length) {
          const before = beforeRun[beforeRunIndex]
          const after = afterRun[afterRunIndex]
          const beforeRemaining = beforeRun.length - beforeRunIndex
          const afterRemaining = afterRun.length - afterRunIndex
          if (before?.text.length === 0 && beforeRemaining > afterRemaining) {
            alignment.push({ kind: 'removed', before })
            beforeRunIndex += 1
          } else if (after?.text.length === 0 && afterRemaining > beforeRemaining) {
            alignment.push({ kind: 'added', after })
            afterRunIndex += 1
          } else if (before && after) {
            alignment.push({
              kind: 'replacement',
              before,
              after,
              segments: crossLinePairSegments(
                beforeIndex + beforeRunIndex,
                afterIndex + afterRunIndex
              )
            })
            beforeRunIndex += 1
            afterRunIndex += 1
          } else if (before) {
            alignment.push({ kind: 'removed', before })
            beforeRunIndex += 1
          } else if (after) {
            alignment.push({ kind: 'added', after })
            afterRunIndex += 1
          }
        }
        beforeIndex += change.value.length
        afterIndex += next.value.length
        changeIndex += 1
        continue
      }
    }
    for (let index = 0; index < change.value.length; index += 1) {
      if (change.removed) {
        alignment.push({
          kind: 'removed',
          before: projectedBeforeLines[beforeIndex],
          segments: hasCrossLineAnchor(beforeTokens[beforeIndex])
            ? crossLineSegments(projectedBeforeLines[beforeIndex], 'removed')
            : undefined
        })
        beforeIndex += 1
      } else if (change.added) {
        alignment.push({
          kind: 'added',
          after: projectedAfterLines[afterIndex],
          segments: hasCrossLineAnchor(afterTokens[afterIndex])
            ? crossLineSegments(projectedAfterLines[afterIndex], 'added')
            : undefined
        })
        afterIndex += 1
      }
      else {
        alignment.push({
          kind: 'paired',
          before: projectedBeforeLines[beforeIndex],
          after: projectedAfterLines[afterIndex],
          segments: crossLinePairSegments(beforeIndex, afterIndex),
          deadline
        })
        beforeIndex += 1
        afterIndex += 1
      }
    }
  }
  return alignment
}
let oldLine = 1
let newLine = 1
const lines = []
const changes = diffLines(workerData.before, workerData.after, { timeout: 9000, maxEditLength: 20000 })
if (!changes) {
  parentPort.postMessage({ error: 'DIFF_TIMEOUT' })
  return
}
let outputBytes = 2
const pushLine = (line) => {
  const nextBytes = Buffer.byteLength(JSON.stringify(line), 'utf8') + (lines.length === 0 ? 0 : 1)
  if (lines.length + 1 > workerData.maxOutputLines || outputBytes + nextBytes > workerData.maxOutputBytes) {
    parentPort.postMessage({ error: 'DIFF_OUTPUT_LIMIT_EXCEEDED' })
    return false
  }
  lines.push(line)
  outputBytes += nextBytes
  return true
}
const pushAlignedLine = (aligned) => {
  if (aligned.kind === 'paired') {
    const beforeText = aligned.before.text + aligned.before.ending
    const afterText = aligned.after.text + aligned.after.ending
    if (beforeText === afterText) {
      return pushLine({
        kind: 'context',
        oldLineNumber: oldLine++,
        newLineNumber: newLine++,
        segments: [{ kind: 'context', text: beforeText }]
      })
    }
    const remainingMs = aligned.deadline - Date.now()
    const exactSegments =
      aligned.segments ??
      (remainingMs > 0
        ? segmentsForPair(aligned.before, aligned.after, {
            maxEditLength: LINE_ALIGNMENT_MAX_EDIT_LENGTH,
            timeout: remainingMs
          })
        : undefined)
    const segments = exactSegments ?? segmentsForReplacement(aligned.before, aligned.after)
    return (
      pushLine({ kind: 'removed', oldLineNumber: oldLine++, segments: segments.removed }) &&
      pushLine({ kind: 'added', newLineNumber: newLine++, segments: segments.added })
    )
  }
  if (aligned.kind === 'replacement') {
    const segments = aligned.segments ?? segmentsForReplacement(aligned.before, aligned.after)
    return (
      pushLine({ kind: 'removed', oldLineNumber: oldLine++, segments: segments.removed }) &&
      pushLine({ kind: 'added', newLineNumber: newLine++, segments: segments.added })
    )
  }
  if (aligned.kind === 'removed') {
    return pushLine({
      kind: 'removed',
      oldLineNumber: oldLine++,
      segments: aligned.segments ?? changedSegments(aligned.before, 'removed')
    })
  }
  return pushLine({
    kind: 'added',
    newLineNumber: newLine++,
    segments: aligned.segments ?? changedSegments(aligned.after, 'added')
  })
}

let lineGroup = []
const pushContextEntry = (entry) =>
  pushLine({
    kind: 'context',
    oldLineNumber: oldLine++,
    newLineNumber: newLine++,
    segments: [{ kind: 'context', text: entry.line.text + entry.line.ending }]
  })
const alignLineGroup = (group) => {
  const hasChanges = group.some((entry) => entry.kind !== 'context')
  if (!hasChanges) return group.every(pushContextEntry)
  const beforeLines = group
    .filter((entry) => entry.kind !== 'added')
    .map((entry) => entry.line)
  const afterLines = group
    .filter((entry) => entry.kind !== 'removed')
    .map((entry) => entry.line)
  const characterCount = [...beforeLines, ...afterLines].reduce(
    (total, line) => total + line.text.length + line.ending.length,
    0
  )
  if (
    beforeLines.length + afterLines.length > LINE_ALIGNMENT_MAX_LINES ||
    characterCount > LINE_ALIGNMENT_MAX_CHARACTERS
  ) {
    const middle = (group.length - 1) / 2
    let splitIndex = -1
    let splitDistance = Number.POSITIVE_INFINITY
    for (let index = 0; index < group.length; index += 1) {
      if (group[index].kind !== 'context') continue
      const distance = Math.abs(index - middle)
      if (distance < splitDistance) {
        splitIndex = index
        splitDistance = distance
      }
    }
    if (splitIndex >= 0) {
      return (
        alignLineGroup(group.slice(0, splitIndex)) &&
        pushContextEntry(group[splitIndex]) &&
        alignLineGroup(group.slice(splitIndex + 1))
      )
    }
  }
  return alignChangedLines(beforeLines, afterLines).every(pushAlignedLine)
}
const flushLineGroup = () => {
  if (lineGroup.length === 0) return true
  const group = lineGroup
  lineGroup = []
  return alignLineGroup(group)
}

// Blank lines are weak diff anchors: repeated separators can make a newly inserted heading match
// the preceding paragraph. Re-align changes and their blank separators as one semantic region;
// unchanged non-blank lines remain hard boundaries and never enter the more expensive alignment.
for (const change of changes) {
  const kind = change.removed ? 'removed' : change.added ? 'added' : 'context'
  for (const line of splitChangedLines(change.value)) {
    if (kind === 'context' && line.text.trim().length > 0) {
      if (!flushLineGroup()) return
      if (
        !pushLine({
          kind: 'context',
          oldLineNumber: oldLine++,
          newLineNumber: newLine++,
          segments: [{ kind: 'context', text: line.text + line.ending }]
        })
      ) return
      continue
    }
    lineGroup.push({ kind, line })
  }
}
if (!flushLineGroup()) return
parentPort.postMessage(lines)
}
run()
`

class ManagedTextDiffTaskRunner {
  private readonly active = new Map<
    string,
    { worker: WorkerLike; reject: (error: ManagedFileVersionError) => void }
  >()

  constructor(private readonly options: DiffTaskRunnerOptions = {}) {}

  run(task: DiffTask): Promise<ManagedFileVersionDiffLine[]> {
    if (this.active.has(task.requestId)) {
      return Promise.reject(
        new ManagedFileVersionError('INVALID_REQUEST', 'Diff request id is already active.')
      )
    }
    const worker =
      this.options.createWorker?.(task, DIFF_WORKER_RESOURCE_LIMITS) ??
      new Worker(WORKER_SOURCE, {
        eval: true,
        resourceLimits: DIFF_WORKER_RESOURCE_LIMITS,
        workerData: {
          before: task.before,
          after: task.after,
          maxOutputLines: MANAGED_DIFF_MAX_OUTPUT_LINES,
          maxOutputBytes: MANAGED_DIFF_MAX_OUTPUT_BYTES
        }
      })
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.active.delete(task.requestId)) return
        reject(new ManagedFileVersionError('DIFF_TIMEOUT', 'Diff task exceeded the time limit.'))
        void worker.terminate()
      }, this.options.timeoutMs ?? DEFAULT_DIFF_TASK_TIMEOUT_MS)
      const clear = (): boolean => {
        clearTimeout(timeout)
        return this.active.delete(task.requestId)
      }
      this.active.set(task.requestId, {
        worker,
        reject: (error) => {
          clearTimeout(timeout)
          reject(error)
        }
      })
      worker.once('message', (value: unknown) => {
        clear()
        if (typeof value === 'object' && value !== null && 'error' in value) {
          const code = value.error === 'DIFF_OUTPUT_LIMIT_EXCEEDED' ? value.error : 'DIFF_TIMEOUT'
          reject(
            new ManagedFileVersionError(
              code,
              code === 'DIFF_TIMEOUT'
                ? 'Diff task exceeded the time limit.'
                : 'The complete diff exceeds the display limit.'
            )
          )
          return
        }
        const lines = value as ManagedFileVersionDiffLine[]
        if (
          lines.length > MANAGED_DIFF_MAX_OUTPUT_LINES ||
          Buffer.byteLength(JSON.stringify(lines), 'utf8') > MANAGED_DIFF_MAX_OUTPUT_BYTES
        ) {
          reject(
            new ManagedFileVersionError(
              'DIFF_OUTPUT_LIMIT_EXCEEDED',
              'The complete diff exceeds the display limit.'
            )
          )
          return
        }
        resolve(lines)
      })
      worker.once('error', (error: Error) => {
        if (!clear()) return
        reject(
          new ManagedFileVersionError('CONTENT_INTEGRITY_FAILED', 'Diff task failed.', {
            cause: error
          })
        )
      })
      worker.once('exit', (code: number) => {
        if (code === 0 || !clear()) return
        reject(
          new ManagedFileVersionError('CONTENT_INTEGRITY_FAILED', 'Diff task exited unexpectedly.')
        )
      })
    })
  }

  cancel(requestId: string): boolean {
    const active = this.active.get(requestId)
    if (!active) return false
    this.active.delete(requestId)
    active.reject(new ManagedFileVersionError('DIFF_CANCELLED', 'Diff request was cancelled.'))
    void active.worker.terminate()
    return true
  }
}

export { ManagedTextDiffTaskRunner }
