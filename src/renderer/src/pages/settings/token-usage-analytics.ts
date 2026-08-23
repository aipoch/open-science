import {
  isHiddenControlMessage,
  isHumanUserMessage,
  type PersistedChatMessage,
  type PersistedChatSession,
  type SessionUsageProjection
} from '../../../../shared/session-persistence'
import type { Project } from '../../../../shared/projects'

export type TokenUsagePeriod = 'today' | 'week' | '30-days' | 'all'

export type TokenUsageHeatmapMetric =
  | 'totalTokens'
  | 'inputTokens'
  | 'outputTokens'
  | 'cacheTokens'
  | 'newConversations'
  | 'newProjects'
  | 'newArtifacts'
  | 'runs'

export type TokenUsageDailyPoint = {
  dateKey: string
  dayStart: number
  inputTokens: number
  cacheTokens: number
  outputTokens: number
  totalTokens: number
  newConversations: number
  newProjects: number
  newArtifacts: number
  runs: number
}

type TokenUsageEvent = {
  timestamp: number
  inputTokens: number
  cacheTokens: number
  outputTokens: number
  rootRunUsage: boolean
}

export type TokenUsageAnalytics = {
  now: number
  last30Days: readonly TokenUsageDailyPoint[]
  sessionCreatedAt: readonly number[]
  projectCreatedAt: readonly number[]
  artifactCreatedAt: readonly number[]
  runsAt: readonly number[]
  usageEvents: readonly TokenUsageEvent[]
  totalArtifacts: number
}

export type TokenUsageSummary = {
  inputTokens: number
  cacheTokens: number
  outputTokens: number
  totalTokens: number
  cacheShare: number | null
  totalSessions: number
  newConversations: number
  totalProjects: number
  newProjects: number
  totalArtifacts: number
  newArtifacts: number
  totalRuns: number
  newRuns: number
  reportedRuns: number
}

const finiteNonNegative = (value: number): number =>
  Number.isFinite(value) && value > 0 ? value : 0

const startOfLocalDay = (timestamp: number): number => {
  const date = new Date(timestamp)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

const addLocalDays = (timestamp: number, days: number): number => {
  const date = new Date(timestamp)
  date.setDate(date.getDate() + days)
  return date.getTime()
}

const localDateKey = (timestamp: number): string => {
  const date = new Date(timestamp)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

const periodStart = (now: number, period: TokenUsagePeriod): number => {
  const today = startOfLocalDay(now)
  if (period === 'today') return today
  if (period === '30-days') return addLocalDays(today, -29)
  if (period === 'all') return Number.NEGATIVE_INFINITY

  const weekday = new Date(today).getDay()
  return addLocalDays(today, -(weekday === 0 ? 6 : weekday - 1))
}

const isInPeriod = (timestamp: number, start: number, now: number): boolean =>
  Number.isFinite(timestamp) && timestamp >= start && timestamp <= now

const usageTimestamp = (message: PersistedChatMessage): number =>
  message.completedAt ?? message.updatedAt ?? message.createdAt

const createEmptyDailyPoint = (dayStart: number): TokenUsageDailyPoint => ({
  dateKey: localDateKey(dayStart),
  dayStart,
  inputTokens: 0,
  cacheTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  newConversations: 0,
  newProjects: 0,
  newArtifacts: 0,
  runs: 0
})

export const buildTokenUsageAnalytics = (
  sessions: readonly PersistedChatSession[],
  now: number = Date.now(),
  projects: readonly Project[] = []
): TokenUsageAnalytics => {
  const sessionCreatedAt: number[] = []
  const projectCreatedAt = projects.map((project) => project.createdAt)
  const runsAt: number[] = []
  const usageEvents: TokenUsageEvent[] = []
  const artifactIds = new Set<string>()
  const persistedArtifactCreatedAt = new Map<string, number>()
  const associatedArtifactCreatedAt = new Map<string, number>()

  for (const session of sessions) {
    sessionCreatedAt.push(session.createdAt)
    for (const artifact of session.artifacts ?? []) {
      artifactIds.add(artifact.id)
      const createdAt = artifact.createdAt
      if (createdAt !== undefined && Number.isFinite(createdAt) && createdAt >= 0) {
        persistedArtifactCreatedAt.set(artifact.id, createdAt)
      }
    }

    const graph = session.conversationGraph
    const messages: ReadonlyArray<{
      message: PersistedChatMessage
      isRootMessage: boolean
    }> = graph
      ? graph.messages.map((message) => ({
          message,
          isRootMessage: message.agentFrameId === graph.rootFrameId
        }))
      : session.messages.map((message) => ({ message, isRootMessage: true }))

    for (const { message, isRootMessage } of messages) {
      const associationTimestamp = message.completedAt ?? message.createdAt
      for (const artifactId of message.artifactIds ?? []) {
        const existingTimestamp = associatedArtifactCreatedAt.get(artifactId)
        if (
          Number.isFinite(associationTimestamp) &&
          associationTimestamp >= 0 &&
          (existingTimestamp === undefined || associationTimestamp < existingTimestamp)
        ) {
          associatedArtifactCreatedAt.set(artifactId, associationTimestamp)
        }
      }

      if (
        isRootMessage &&
        isHumanUserMessage(message) &&
        !isHiddenControlMessage(message) &&
        !message.delegatedCallerSource
      ) {
        runsAt.push(message.createdAt || session.createdAt)
      }

      if (message.role !== 'agent' || !message.turnUsage) continue

      const inputTokens = finiteNonNegative(message.turnUsage.inputTokens)
      const cacheTokens = finiteNonNegative(message.turnUsage.cacheTokens)
      const outputTokens = finiteNonNegative(message.turnUsage.outputTokens)
      usageEvents.push({
        timestamp: usageTimestamp(message),
        inputTokens,
        cacheTokens,
        outputTokens,
        rootRunUsage: isRootMessage
      })
    }
  }

  const artifactCreatedAt = Array.from(artifactIds).flatMap((artifactId) => {
    const timestamp =
      persistedArtifactCreatedAt.get(artifactId) ?? associatedArtifactCreatedAt.get(artifactId)
    return timestamp === undefined ? [] : [timestamp]
  })

  const today = startOfLocalDay(now)
  const last30Days = Array.from({ length: 30 }, (_, index) =>
    createEmptyDailyPoint(addLocalDays(today, index - 29))
  )
  const dailyByKey = new Map(last30Days.map((point) => [point.dateKey, point]))

  for (const timestamp of sessionCreatedAt) {
    const point = dailyByKey.get(localDateKey(timestamp))
    if (point && timestamp <= now) point.newConversations += 1
  }

  for (const timestamp of projectCreatedAt) {
    const point = dailyByKey.get(localDateKey(timestamp))
    if (point && timestamp <= now) point.newProjects += 1
  }

  for (const timestamp of artifactCreatedAt) {
    const point = dailyByKey.get(localDateKey(timestamp))
    if (point && timestamp <= now) point.newArtifacts += 1
  }

  for (const timestamp of runsAt) {
    const point = dailyByKey.get(localDateKey(timestamp))
    if (point && timestamp <= now) point.runs += 1
  }

  for (const event of usageEvents) {
    const point = dailyByKey.get(localDateKey(event.timestamp))
    if (!point || event.timestamp > now) continue
    point.inputTokens += event.inputTokens
    point.cacheTokens += event.cacheTokens
    point.outputTokens += event.outputTokens
    point.totalTokens += event.inputTokens + event.cacheTokens + event.outputTokens
  }

  return {
    now,
    last30Days,
    sessionCreatedAt,
    projectCreatedAt,
    artifactCreatedAt,
    runsAt,
    usageEvents,
    totalArtifacts: artifactIds.size
  }
}

export const buildTokenUsageAnalyticsFromProjection = (
  projection: SessionUsageProjection,
  now: number = Date.now()
): TokenUsageAnalytics => {
  const analytics: TokenUsageAnalytics = {
    now,
    last30Days: Array.from({ length: 30 }, (_, index) =>
      createEmptyDailyPoint(addLocalDays(startOfLocalDay(now), index - 29))
    ),
    sessionCreatedAt: projection.sessionCreatedAt,
    projectCreatedAt: projection.projectCreatedAt,
    artifactCreatedAt: projection.artifactCreatedAt,
    runsAt: projection.runsAt,
    usageEvents: projection.usageEvents,
    totalArtifacts: projection.totalArtifacts
  }
  const dailyByKey = new Map(analytics.last30Days.map((point) => [point.dateKey, point]))
  for (const timestamp of analytics.sessionCreatedAt) {
    const point = dailyByKey.get(localDateKey(timestamp))
    if (point && timestamp <= now) point.newConversations += 1
  }
  for (const timestamp of analytics.projectCreatedAt) {
    const point = dailyByKey.get(localDateKey(timestamp))
    if (point && timestamp <= now) point.newProjects += 1
  }
  for (const timestamp of analytics.artifactCreatedAt) {
    const point = dailyByKey.get(localDateKey(timestamp))
    if (point && timestamp <= now) point.newArtifacts += 1
  }
  for (const timestamp of analytics.runsAt) {
    const point = dailyByKey.get(localDateKey(timestamp))
    if (point && timestamp <= now) point.runs += 1
  }
  for (const event of analytics.usageEvents) {
    const point = dailyByKey.get(localDateKey(event.timestamp))
    if (!point || event.timestamp > now) continue
    point.inputTokens += event.inputTokens
    point.cacheTokens += event.cacheTokens
    point.outputTokens += event.outputTokens
    point.totalTokens += event.inputTokens + event.cacheTokens + event.outputTokens
  }
  return analytics
}

export const selectTokenUsageSummary = (
  analytics: TokenUsageAnalytics,
  period: TokenUsagePeriod
): TokenUsageSummary => {
  const start = periodStart(analytics.now, period)
  const usageEvents = analytics.usageEvents.filter((event) =>
    isInPeriod(event.timestamp, start, analytics.now)
  )
  const inputTokens = usageEvents.reduce((total, event) => total + event.inputTokens, 0)
  const cacheTokens = usageEvents.reduce((total, event) => total + event.cacheTokens, 0)
  const outputTokens = usageEvents.reduce((total, event) => total + event.outputTokens, 0)
  const cacheDenominator = inputTokens + cacheTokens
  const futureArtifactCount = analytics.artifactCreatedAt.filter(
    (timestamp) => timestamp > analytics.now
  ).length
  const totalArtifactsThroughNow = analytics.totalArtifacts - futureArtifactCount

  return {
    inputTokens,
    cacheTokens,
    outputTokens,
    totalTokens: inputTokens + cacheTokens + outputTokens,
    cacheShare: cacheDenominator > 0 ? cacheTokens / cacheDenominator : null,
    totalSessions: analytics.sessionCreatedAt.filter((timestamp) => timestamp <= analytics.now)
      .length,
    newConversations: analytics.sessionCreatedAt.filter((timestamp) =>
      isInPeriod(timestamp, start, analytics.now)
    ).length,
    totalProjects: analytics.projectCreatedAt.filter((timestamp) => timestamp <= analytics.now)
      .length,
    newProjects: analytics.projectCreatedAt.filter((timestamp) =>
      isInPeriod(timestamp, start, analytics.now)
    ).length,
    totalArtifacts: totalArtifactsThroughNow,
    newArtifacts:
      period === 'all'
        ? totalArtifactsThroughNow
        : analytics.artifactCreatedAt.filter((timestamp) =>
            isInPeriod(timestamp, start, analytics.now)
          ).length,
    totalRuns: analytics.runsAt.filter((timestamp) => timestamp <= analytics.now).length,
    newRuns: analytics.runsAt.filter((timestamp) => isInPeriod(timestamp, start, analytics.now))
      .length,
    reportedRuns: usageEvents.filter((event) => event.rootRunUsage).length
  }
}

export const tokenUsageMetricValue = (
  point: TokenUsageDailyPoint,
  metric: TokenUsageHeatmapMetric
): number => point[metric]
