import type { ReplayRunIndex } from '../../shared/replay'
import type { HostArtifactCatalogItem } from '../../shared/project-files'
import type { ReviewWithChecks } from '../../shared/reviewer'
import { z } from 'zod'
import { sessionReadingPositions } from '../../shared/session-reading'
import {
  resolveMessageBranchPath,
  projectConversationMessage,
  resolveActiveConversationActivities
} from '../../shared/conversation-graph'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { NotebookRunRecord } from '../../shared/notebook'
import { SessionReplayRepository } from '../session-replay/repository'
import { readingFocus } from '../session-replay/session-reading'

const optionsSchema = z
  .object({
    kind: z
      .enum([
        'message',
        'activity',
        'notebook-run',
        'artifact-version',
        'upload-version',
        'review',
        'overview',
        'context'
      ])
      .optional(),
    branchId: z.string().min(1).max(1024).optional(),
    id: z.string().min(1).max(1024).optional(),
    part: z.enum(['input', 'result', 'record']).optional(),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(20000).default(8000)
  })
  .strict()

type Dependencies = {
  contexts: SessionReplayRepository
  readSession(projectId: string, sessionId: string): Promise<PersistedChatSession | undefined>
  readFiles?(projectId: string, sessionId: string): Promise<HostArtifactCatalogItem[]>
  readFile?(file: HostArtifactCatalogItem): Promise<string>
  readReviews?(projectId: string, sessionId: string): Promise<ReviewWithChecks[]>
  readRunIndex?(projectId: string, sessionId: string): Promise<ReplayRunIndex[]>
  readRun?(
    projectId: string,
    sessionId: string,
    runId: string
  ): Promise<NotebookRunRecord | undefined>
  readRuns(projectId: string, sessionId: string): Promise<NotebookRunRecord[]>
}

// No global discovery or arbitrary Project override: each read resolves a current durable link
// owned by the authenticated receiving Session. Unlink immediately revokes this reading route.
export const readLinkedSession = async (
  dependencies: Dependencies,
  context: { projectId: string; sessionId: string },
  sessionId: unknown,
  options: unknown
): Promise<unknown> => {
  const targetId = z.string().min(1).max(512).optional().parse(sessionId)
  const request = optionsSchema.parse(options ?? {})
  const receiving = await dependencies.readSession(context.projectId, context.sessionId)
  const binding = receiving?.runtimeContext?.sessionContext?.bindings.at(-1)
  if (!binding || (targetId !== undefined && binding.sessionId !== targetId))
    throw new Error('This Session is not linked to the current conversation.')
  const positions = sessionReadingPositions(binding)
  const [source, snapshots] = await Promise.all([
    dependencies.readSession(binding.projectId, binding.sessionId),
    Promise.all(
      positions.map((position) =>
        dependencies.contexts.getSelectionSnapshot({
          projectId: binding.projectId,
          id: position.contextId
        })
      )
    )
  ])
  if (snapshots.some((snapshot) => !snapshot)) throw new Error('The linked Session is unavailable.')
  for (let index = 0; index < snapshots.length; index++) {
    const snapshot = snapshots[index]!
    if (
      snapshot.projectId !== binding.projectId ||
      snapshot.sourceSessionId !== binding.sessionId ||
      snapshot.branchId !== positions[index].branchId
    )
      throw new Error('The linked Session position is invalid.')
  }
  const selected = snapshots.flatMap((snapshot) =>
    snapshot!.evidence.map(({ kind, id, versionId, part }) => ({
      kind,
      id: versionId ?? id,
      branchId: snapshot!.branchId,
      title: snapshot!.stepTitle ?? kind,
      stepNumber: snapshot!.stepNumber,
      stepId: snapshot!.stepId,
      part: part ?? (snapshot!.phase === 'input' ? ('input' as const) : ('record' as const))
    }))
  )
  if (!request.kind && !request.id && snapshots.some((snapshot) => snapshot?.scope === 'session'))
    request.kind = 'overview'
  if (request.id) {
    const candidates = selected.filter(
      (record) =>
        record.id === request.id &&
        (!request.kind || record.kind === request.kind) &&
        (!request.branchId || record.branchId === request.branchId)
    )
    const kinds = new Set(candidates.map((record) => record.kind))
    if (!request.kind && kinds.size === 1) request.kind = candidates[0].kind
    if (!request.kind)
      throw new Error(
        'Record type is ambiguous or unknown. Call host.sessions.read() and pass a returned record.read object.'
      )
    const branches = new Set(candidates.map((record) => record.branchId))
    if (!request.branchId && branches.size === 1) request.branchId = candidates[0].branchId
    if (!request.branchId && new Set(positions.map((position) => position.branchId)).size > 1)
      throw new Error('Choose a linked branchId using a returned record.read object.')
    if (!request.part && new Set(candidates.map((record) => record.part)).size > 1)
      throw new Error(
        'This record has multiple selected parts. Pass a returned record.read object to choose input or result.'
      )
  }
  const branchId = request.branchId ?? binding.branchId
  const wholeSession = snapshots.some((snapshot) => snapshot?.scope === 'session')
  if (
    !positions.some((position) => position.branchId === branchId) &&
    !(wholeSession && source?.conversationGraph?.branches.some((branch) => branch.id === branchId))
  )
    throw new Error('This Branch is not linked to the conversation.')
  const availability = {
    sessionId: binding.sessionId,
    title: source?.title ?? binding.title,
    scope: wholeSession ? 'session' : 'selected-branches',
    contentBasis:
      'Current saved records; immutable file versions. Captured fragments are used only when a record is unavailable.',
    availability: source ? 'source-available' : 'saved-fragments-only',
    ...(!source
      ? {
          notice:
            'The source Session is unavailable. Only saved selected fragments remain; surrounding history and uncaptured outputs cannot be read.'
        }
      : {})
  }
  if (!request.id && !request.kind) {
    const records = [
      ...new Map(
        selected
          .filter((record) => !request.branchId || record.branchId === request.branchId)
          .map(({ title, stepNumber, stepId, ...read }) => [
            JSON.stringify(read),
            { ...read, title, stepNumber, stepId, read }
          ])
      ).values()
    ]
    const page = records.slice(request.offset, request.offset + Math.min(request.limit, 50))
    const nextOffset = request.offset + page.length
    return {
      ...availability,
      records: page,
      overview: { kind: 'overview' },
      nearby: { kind: 'context' },
      ...(!records.length
        ? { notice: 'No selected records remain. Select another step to discuss.' }
        : {}),
      ...(nextOffset < records.length
        ? { nextOffset, next: { ...request, offset: nextOffset } }
        : {})
    }
  }
  const selectedSnapshots = snapshots
    .filter((snapshot) => snapshot?.branchId === branchId)
    .map((snapshot) => snapshot!)
  const snapshot = selectedSnapshots.at(-1) ?? snapshots.at(-1)!
  const evidence = selectedSnapshots.flatMap((snapshot) => snapshot.evidence)
  const graph = source?.conversationGraph
  const branch = graph?.branches.find((row) => row.id === branchId)
  const selectedGraph =
    graph && branch
      ? {
          ...graph,
          activeFrameId: branch.agentFrameId,
          frames: graph.frames.map((frame) =>
            frame.id === branch.agentFrameId ? { ...frame, activeBranchId: branch.id } : frame
          )
        }
      : undefined
  const messages = selectedGraph
    ? resolveMessageBranchPath(selectedGraph, branchId).map(projectConversationMessage)
    : graph
      ? []
      : (source?.messages ?? [])
  const visibleActivities = selectedGraph
    ? resolveActiveConversationActivities(selectedGraph).activities
    : graph
      ? []
      : (source?.activities ?? [])
  const messageDescriptor = (
    message: (typeof messages)[number],
    index: number
  ): {
    kind: 'message'
    id: string
    role: typeof message.role
    messageNumber: number
    title: string
    read: { kind: 'message'; id: string; branchId: string }
  } => ({
    kind: 'message',
    id: message.id,
    role: message.role,
    messageNumber: index + 1,
    title: message.content.slice(0, 120),
    read: { kind: 'message', id: message.id, branchId }
  })
  if (request.kind === 'overview' || request.kind === 'context') {
    const focusIds = new Set(
      evidence.filter((record) => record.kind === 'message').map((record) => record.id)
    )
    const selectedActivityIds = new Set(
      evidence.filter((record) => record.kind === 'activity').map((record) => record.id)
    )
    for (const activity of source?.conversationGraph?.activities ?? source?.activities ?? []) {
      if (selectedActivityIds.has(activity.id) && activity.promptMessageId)
        focusIds.add(activity.promptMessageId)
    }
    if (
      request.kind === 'context' &&
      source &&
      dependencies.readRunIndex &&
      evidence.some((record) => record.kind === 'notebook-run')
    ) {
      const indices = await dependencies.readRunIndex(binding.projectId, binding.sessionId)
      for (const run of indices) {
        if (
          run.promptMessageId &&
          evidence.some((record) => record.kind === 'notebook-run' && record.id === run.runId)
        )
          focusIds.add(run.promptMessageId)
      }
    }
    const focusIndices = messages.flatMap((message, index) =>
      focusIds.has(message.id) ? [index] : []
    )
    const relevant =
      request.kind === 'overview'
        ? messages
            .map((message, index) => ({ message, index }))
            .filter(({ index }) => index < 3 || index >= messages.length - 3)
        : messages
            .map((message, index) => ({ message, index }))
            .filter(({ index }) => focusIndices.some((focus) => Math.abs(index - focus) <= 2))
    return {
      ...availability,
      branchId,
      branchCount: source?.conversationGraph?.branches.length ?? (source ? 1 : 0),
      messageCount: messages.length,
      activityCount: visibleActivities.length,
      package: source?.packageOrigin
        ? {
            imported: true,
            excludedFileCount: source.packageOrigin.excludedFiles?.length ?? 0,
            completeness:
              'Not verified; a zero exclusion count does not prove all dependencies or files are present.'
          }
        : undefined,
      coverage:
        request.kind === 'overview'
          ? 'Opening and closing messages of this branch; not a full-history summary.'
          : 'Messages within two positions of each located focus; later messages may include results.',
      ...(request.offset + 20 < relevant.length
        ? { next: { ...request, branchId, offset: request.offset + 20 } }
        : {}),
      records: relevant.slice(request.offset, request.offset + 20).map(({ message, index }) => ({
        ...messageDescriptor(message, index),
        excerpt: message.content.slice(0, 1200),
        truncated: message.content.length > 1200
      })),
      ...(source && request.kind === 'context' && !focusIndices.length
        ? {
            notice:
              'The selected records could not be matched to a message. Browse the branch history instead; no nearby context was inferred.'
          }
        : {}),
      branches: (source?.conversationGraph?.branches ?? [])
        .filter(
          (item) => wholeSession || positions.some((position) => position.branchId === item.id)
        )
        .map((item, index) => ({
          id: item.id,
          branchNumber: index + 1,
          read: { kind: 'overview', branchId: item.id }
        })),
      browse: [
        'message',
        'activity',
        'notebook-run',
        'artifact-version',
        'upload-version',
        'review'
      ].map((kind) => ({ kind, read: { kind, branchId } })),
      limitations: [
        'An imported package is a saved record, not a restored execution environment. Data files, dependencies, credentials and external services may be absent.',
        'Binary file metadata does not reveal image, PDF or spreadsheet contents. Inspect supported images before interpreting them.',
        ...(!wholeSession
          ? ['Only selected branches are readable. Select another branch to discuss it.']
          : []),
        ...(!source
          ? ['Only saved fragments remain. Whole-history reconstruction is unavailable.']
          : [])
      ]
    }
  }
  const runs =
    source && request.kind === 'notebook-run'
      ? (request.id && dependencies.readRun
          ? [await dependencies.readRun(binding.projectId, binding.sessionId, request.id)].filter(
              (run): run is NotebookRunRecord => Boolean(run)
            )
          : !request.id && dependencies.readRunIndex
            ? await dependencies.readRunIndex(binding.projectId, binding.sessionId)
            : await dependencies.readRuns(binding.projectId, binding.sessionId)
        ).filter(
          (run) =>
            evidence.some((record) => record.kind === 'notebook-run' && record.id === run.runId) ||
            (run.messageBranchId
              ? run.messageBranchId === branchId
              : Boolean(
                  run.promptMessageId &&
                  messages.some((message) => message.id === run.promptMessageId)
                ))
        )
      : []
  const files =
    source && (request.kind === 'artifact-version' || request.kind === 'upload-version')
      ? ((await dependencies.readFiles?.(binding.projectId, binding.sessionId)) ?? []).filter(
          (file) =>
            file.projectId === binding.projectId &&
            file.sessionId === binding.sessionId &&
            (evidence.some(
              (record) => record.versionId === file.versionId || record.id === file.versionId
            ) ||
              messages.some((message) => message.artifactIds?.includes(file.sourceFileId)))
        )
      : []
  const reviews =
    source && request.kind === 'review'
      ? ((await dependencies.readReviews?.(binding.projectId, binding.sessionId)) ?? []).filter(
          (review) =>
            review.projectId === binding.projectId &&
            review.sessionId === binding.sessionId &&
            (evidence.some((record) => record.kind === 'review' && record.id === review.id) ||
              (messages.some((message) => message.id === review.turnMessageId) &&
                (!review.scope.messageBranchId || review.scope.messageBranchId === branchId)))
        )
      : []
  const records = [
    ...messages.map((message, index) => ({
      ...messageDescriptor(message, index)
    })),
    ...visibleActivities.map((activity) => ({
      kind: 'activity',
      id: activity.id,
      title: activity.title
    })),
    ...runs.map((run) => ({ kind: 'notebook-run', id: run.runId, title: run.kernelKind })),
    ...files.map((file) => ({
      kind: file.source === 'artifact' ? 'artifact-version' : 'upload-version',
      id: file.versionId,
      title: file.filename
    })),
    ...reviews.map((review) => ({
      kind: 'review',
      id: review.id,
      title: review.outcome ?? review.lifecycle
    })),
    ...evidence
      .filter(
        (record) =>
          (!source ||
            record.kind === 'artifact-version' ||
            record.kind === 'upload-version' ||
            record.kind === 'review') &&
          !files.some((file) => file.versionId === record.versionId) &&
          !reviews.some((review) => review.id === record.id)
      )
      .map(({ kind, id, versionId }) => ({
        kind,
        id: versionId ?? id,
        title: snapshot.stepTitle ?? kind
      }))
  ].filter((record) => !request.kind || record.kind === request.kind)
  if (!request.id) {
    const page = records.slice(request.offset, request.offset + Math.min(request.limit, 50))
    const next = request.offset + page.length
    return {
      ...availability,
      branchId,
      focus: readingFocus(snapshot),
      positions: snapshots.map((snapshot) => ({
        branchId: snapshot!.branchId,
        ...readingFocus(snapshot!)
      })),
      records: page.map((record) => ({
        ...record,
        read: { kind: record.kind, id: record.id, branchId }
      })),
      ...(next < records.length
        ? { nextOffset: next, next: { ...request, branchId, offset: next } }
        : {})
    }
  }
  const focusedSnapshot = [...selectedSnapshots]
    .reverse()
    .find((candidate) =>
      candidate.evidence.some(
        (record) =>
          record.kind === request.kind &&
          (record.id === request.id || record.versionId === request.id) &&
          (!request.part ||
            request.part === (record.part ?? (candidate.phase === 'input' ? 'input' : 'record')))
      )
    )
  const focused = focusedSnapshot?.evidence.find(
    (record) =>
      record.kind === request.kind && (record.id === request.id || record.versionId === request.id)
  )
  // Reading a selected input must not reveal its later output by default. An explicit part request
  // can inspect the recorded result when a follow-up asks what happened next.
  const part =
    request.part ??
    focused?.part ??
    (focused && focusedSnapshot?.phase === 'input' ? 'input' : 'record')
  let text: string | undefined
  let viewImage: { versionId: string } | undefined
  let incomplete = !source
  if (request.kind === 'message')
    text = messages.find((message) => message.id === request.id)?.content
  if (request.kind === 'activity') {
    const activity = visibleActivities.find((row) => row.id === request.id)
    if (activity)
      text = JSON.stringify({
        title: activity.title,
        ...(part !== 'result' ? { input: activity.rawInput } : {}),
        ...(part !== 'input'
          ? {
              status: activity.status,
              output: activity.rawOutput,
              content: activity.toolContent,
              terminal: activity.terminalOutput,
              choice: activity.elicitation
            }
          : {})
      })
  }
  if (request.kind === 'notebook-run') {
    const run = runs.find((row) => row.runId === request.id)
    if (run && 'script' in run) {
      text = [
        part !== 'result' ? run.script : '',
        part !== 'input' ? JSON.stringify({ status: run.status, ...run.text }) : ''
      ]
        .filter(Boolean)
        .join('\n\n')
      incomplete = run.truncated === true
    }
  }
  if (request.kind === 'artifact-version' || request.kind === 'upload-version') {
    const file = files.find((file) => file.versionId === request.id)
    if (file && dependencies.readFile) {
      text = await dependencies.readFile(file)
      if (
        file.projectId === context.projectId &&
        (file.contentType?.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(file.filename))
      )
        viewImage = { versionId: file.versionId }
    }
  }
  if (request.kind === 'review') {
    const review = reviews.find((review) => review.id === request.id)
    if (review)
      text = JSON.stringify({
        lifecycle: review.lifecycle,
        outcome: review.outcome,
        checks: review.checks,
        submittedChecks: review.submittedChecks
      })
  }
  if (
    text === undefined &&
    focused &&
    (request.part === undefined ||
      request.part === focused.part ||
      (focused.part === undefined &&
        request.part === (focusedSnapshot?.phase === 'input' ? 'input' : 'record')))
  ) {
    const captured =
      focusedSnapshot?.records?.filter(
        (record) =>
          record.scope === 'step' &&
          (record.id === `${request.kind}:${focused.id}` ||
            (record.id === 'step' && request.kind === 'review'))
      ) ?? []
    if (captured.length) {
      text = captured.map((record) => record.text).join('\n\n')
      incomplete =
        !source || captured.some((record) => record.truncated || record.status === 'unavailable')
    }
  }
  if (text === undefined)
    throw new Error('The requested record is unavailable in the linked Branch.')
  const end = Math.min(text.length, request.offset + request.limit)
  return {
    ...availability,
    branchId,
    kind: request.kind,
    id: request.id,
    part,
    source: {
      title: binding.title,
      branchId,
      stepNumber: focusedSnapshot?.stepNumber,
      stepTitle: focusedSnapshot?.stepTitle,
      messageNumber:
        request.kind === 'message'
          ? messages.findIndex((message) => message.id === request.id) + 1 || undefined
          : undefined
    },
    text: text.slice(request.offset, end),
    incomplete,
    ...(viewImage ? { viewImage } : {}),
    ...(end < text.length
      ? { nextOffset: end, next: { ...request, branchId, part, offset: end } }
      : {})
  }
}
