import type {
  CancelComputeJobRequest,
  RetryComputeJobHarvestRequest,
  ComputeApprovalDecision,
  ComputeApprovalRequest,
  ComputeJobsListFilter,
  ComputeJobsPendingNotificationFilter,
  ComputeJobAnalysisTransition,
  ComputeHost,
  ComputeHostDeletionStatus,
  ComputePasswordCapability,
  CreateComputeHostRequest,
  CreatePasswordComputeHostRequest,
  CreatePasswordComputeHostResult,
  ResetPasswordComputeHostRequest,
  ResetPasswordComputeHostResult,
  SetComputeJobRemoteCleanupRequest,
  ChangeComputeHostAuthenticationRequest,
  ChangeComputeHostAuthenticationResult,
  DeleteComputeHostRequest,
  DetailsAuthor,
  JobSummary,
  JobStatusResult,
  ProbeResult
} from '../compute'

import type { DirListing, DownloadDest, LocalFile } from '../remote-fs'

import type { PersistedChatSession } from '../session-persistence'

import { callable, LOCAL, EVENT } from './definition'

export const contracts = {
  'compute.bookmarksGet': callable<(providerId: string) => Promise<string[]>>()('compute', [
    'compute:bookmarks:get'
  ]),
  'compute.bookmarksSet': callable<(providerId: string, folders: string[]) => Promise<void>>()(
    'compute',
    ['compute:bookmarks:set']
  ),
  'compute.changeAuthentication': callable<
    (
      request: ChangeComputeHostAuthenticationRequest
    ) => Promise<ChangeComputeHostAuthenticationResult>
  >()('compute', ['compute:change-authentication', LOCAL]),
  'compute.concurrencySet': callable<(providerId: string, limit: number) => Promise<void>>()(
    'compute',
    ['compute:concurrency:set']
  ),
  'compute.executionModeSet': callable<
    (providerId: string, executionMode: import('../compute').ComputeExecutionMode) => Promise<void>
  >()('compute', ['compute:execution-mode:set']),
  'compute.create': callable<(request: CreateComputeHostRequest) => Promise<ComputeHost>>()(
    'compute',
    ['compute:create']
  ),
  'compute.createPassword': callable<
    (request: CreatePasswordComputeHostRequest) => Promise<CreatePasswordComputeHostResult>
  >()('compute', ['compute:create-password', LOCAL]),
  'compute.delete': callable<(request: DeleteComputeHostRequest) => Promise<void>>()('compute', [
    'compute:delete'
  ]),
  'compute.deletionStatus': callable<
    (request: DeleteComputeHostRequest) => Promise<ComputeHostDeletionStatus>
  >()('compute', ['compute:deletion-status']),
  'compute.detailsGet': callable<(providerId: string) => Promise<{ doc: string }>>()('compute', [
    'compute:details:get'
  ]),
  'compute.detailsSave': callable<
    (providerId: string, text: string, oldText: string, author: DetailsAuthor) => Promise<void>
  >()('compute', ['compute:details:save']),
  'compute.download': callable<
    (providerId: string, remotePath: string, dest: DownloadDest) => Promise<LocalFile>
  >()('compute', ['compute:download', LOCAL]),
  'compute.enabledHostsGet': callable<(sessionId: string) => Promise<string[]>>()('compute', [
    'compute:enabled-hosts:get'
  ]),
  'compute.enabledHostsSet': callable<
    (sessionId: string, providerIds: string[]) => Promise<PersistedChatSession>
  >()('compute', ['compute:enabled-hosts:set']),
  'compute.hostEnabledSet': callable<
    (sessionId: string, providerId: string, enabled: boolean) => Promise<PersistedChatSession>
  >()('compute', ['compute:host-enabled:set']),
  'compute.hostSelectedSet': callable<
    (sessionId: string, providerId: string, selected: boolean) => Promise<PersistedChatSession>
  >()('compute', ['compute:host-selected:set']),
  'compute.get': callable<(providerId: string) => Promise<ComputeHost | null>>()('compute', [
    'compute:get'
  ]),
  'compute.jobsList': callable<(filter: ComputeJobsListFilter) => Promise<JobSummary[]>>()(
    'compute',
    ['compute:jobs:list']
  ),
  'compute.jobsCancel': callable<(request: CancelComputeJobRequest) => Promise<JobStatusResult>>()(
    'compute',
    ['compute:jobs:cancel']
  ),
  'compute.jobsRetryHarvest': callable<(request: RetryComputeJobHarvestRequest) => Promise<void>>()(
    'compute',
    ['compute:jobs:retry-harvest']
  ),
  'compute.jobsSetRemoteCleanup': callable<
    (request: SetComputeJobRemoteCleanupRequest) => Promise<void>
  >()('compute', ['compute:jobs:set-remote-cleanup', LOCAL]),
  'compute.jobsMarkConsumed': callable<(sessionId: string, jobIds: string[]) => Promise<void>>()(
    'compute',
    ['compute:jobs:mark-consumed']
  ),
  'compute.jobsPendingNotification': callable<
    (filter: ComputeJobsPendingNotificationFilter) => Promise<JobSummary[]>
  >()('compute', ['compute:jobs:pending-notification']),
  'compute.jobsTransitionAnalysis': callable<
    (request: ComputeJobAnalysisTransition) => Promise<JobSummary[]>
  >()('compute', ['compute:jobs:transition-analysis']),
  'compute.list': callable<() => Promise<ComputeHost[]>>()('compute', ['compute:list']),
  'compute.listDir': callable<(providerId: string, path: string) => Promise<DirListing>>()(
    'compute',
    ['compute:list-dir']
  ),
  'compute.onApprovalRequest': callable<
    (listener: (request: ComputeApprovalRequest) => void) => () => void
  >()('compute', ['compute:approval-request', EVENT]),
  'compute.onApprovalSettled': callable<(listener: (id: string) => void) => () => void>()(
    'compute',
    ['compute:approval-settled', EVENT],
    { optionalMember: true }
  ),
  'compute.onJobUpdated': callable<(listener: (job: JobSummary) => void) => () => void>()(
    'compute',
    ['compute:job-updated', EVENT]
  ),
  'compute.passwordCapability': callable<() => Promise<ComputePasswordCapability>>()('compute', [
    'compute:password-capability',
    LOCAL
  ]),
  'compute.probe': callable<(providerId: string) => Promise<ProbeResult>>()('compute', [
    'compute:probe'
  ]),
  'compute.replayApproval': callable<(id: string) => Promise<ComputeApprovalRequest | null>>()(
    'compute',
    ['compute:approval-replay']
  ),
  'compute.replayPendingApprovals': callable<() => Promise<void>>()(
    'compute',
    ['compute:approval-replay-pending'],
    { optionalMember: true }
  ),
  'compute.resetPassword': callable<
    (request: ResetPasswordComputeHostRequest) => Promise<ResetPasswordComputeHostResult>
  >()('compute', ['compute:reset-password', LOCAL]),
  'compute.respondApproval': callable<
    (request: { id: string; decision: ComputeApprovalDecision }) => Promise<void>
  >()('compute', ['compute:approval-respond']),
  'compute.revealInFolder': callable<(filePath: string) => Promise<void>>()('compute', [
    'compute:reveal-in-folder',
    LOCAL
  ]),
  'compute.scratchSet': callable<(providerId: string, path: string) => Promise<void>>()('compute', [
    'compute:scratch:set'
  ]),
  'compute.scratchClear': callable<(providerId: string) => Promise<void>>()('compute', [
    'compute:scratch:clear'
  ]),
  'compute.sshConfigAliases': callable<() => Promise<string[]>>()('compute', [
    'compute:ssh-config-aliases'
  ])
} as const
