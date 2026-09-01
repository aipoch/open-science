// Test-only architecture metadata. Runtime deletion must continue to flow through
// ProjectDeletionCoordinator and the subsystem owners named below; this catalog never executes it.

type ProjectOwnerFieldName = 'projectId' | 'sessionId' | 'sourceProjectId' | 'sourceSessionId'

type ProjectOwnerField = Readonly<{
  name: ProjectOwnerFieldName
  required: boolean
}>

type PrismaRelationContract = Readonly<{
  field: string
  target: string
  fromFields: readonly string[]
  onDelete: 'Cascade' | 'Restrict'
}>

type PrismaOwnerModel = Readonly<{
  name: string
  ownerFields: readonly ProjectOwnerField[]
  relationContracts?: readonly PrismaRelationContract[]
}>

type ProjectDeletionPath =
  | 'compute-job-project-delete'
  | 'delegated-runtime-quiescence'
  | 'notification-session-invalidation'
  | 'notebook-input-cache-tail'
  | 'execution-file-evidence-tail'
  | 'project-deletion-intent-protocol'
  | 'project-file-projection-delete'
  | 'project-metadata-soft-delete'
  | 'project-runtime-quiescence'
  | 'project-session-json-delete'
  | 'provenance-tail'
  | 'review-tail'
  | 'side-chat-profile-tail'

type ForeignKeyCascadePolicy = Readonly<{
  kind: 'foreign-key-cascade'
  note: string
}>

type CoordinatorCleanupPolicy = Readonly<{
  kind: 'coordinator-cleanup'
  effect: 'hard-delete' | 'logical-delete' | 'invalidate' | 'drain'
  path: ProjectDeletionPath
  operation: string
  note: string
}>

type RetainedHistoryPolicy = Readonly<{
  kind: 'retained-history'
  effect: 'invalidate' | 'retain'
  path?: ProjectDeletionPath
  operation?: string
  retention: string
  reason: string
}>

type DeletionProtocolPolicy = Readonly<{
  kind: 'deletion-protocol'
  path: 'project-deletion-intent-protocol'
  operation: string
  purpose: string
}>

type ProjectOwnedDataPolicy =
  | ForeignKeyCascadePolicy
  | CoordinatorCleanupPolicy
  | RetainedHistoryPolicy
  | DeletionProtocolPolicy

type ProjectOwnedDataCatalogEntry = Readonly<{
  id: string
  medium: 'sqlite' | 'filesystem' | 'remote-runtime' | 'runtime-state'
  resources: readonly string[]
  prismaModels?: readonly PrismaOwnerModel[]
  policy: ProjectOwnedDataPolicy
}>

const requiredOwner = (name: ProjectOwnerFieldName): ProjectOwnerField => ({
  name,
  required: true
})

const optionalOwner = (name: ProjectOwnerFieldName): ProjectOwnerField => ({
  name,
  required: false
})

const PROJECT_OWNED_DATA_CATALOG: readonly ProjectOwnedDataCatalogEntry[] = [
  {
    id: 'project-memory',
    medium: 'sqlite',
    resources: ['MemoryEntry'],
    prismaModels: [
      {
        name: 'MemoryEntry',
        ownerFields: [optionalOwner('projectId'), optionalOwner('sourceSessionId')],
        relationContracts: [
          {
            field: 'project',
            target: 'Project',
            fromFields: ['projectId'],
            onDelete: 'Cascade'
          }
        ]
      }
    ],
    policy: {
      kind: 'coordinator-cleanup',
      effect: 'hard-delete',
      path: 'project-metadata-soft-delete',
      operation: 'ProjectRepository.delete',
      note: 'Project memories are removed before the Project metadata row is retained as history.'
    }
  },
  {
    id: 'permission-grants',
    medium: 'sqlite',
    resources: ['PermissionGrant'],
    prismaModels: [
      {
        name: 'PermissionGrant',
        ownerFields: [optionalOwner('projectId'), optionalOwner('sessionId')],
        relationContracts: [
          {
            field: 'project',
            target: 'Project',
            fromFields: ['projectId'],
            onDelete: 'Cascade'
          }
        ]
      }
    ],
    policy: {
      kind: 'coordinator-cleanup',
      effect: 'hard-delete',
      path: 'project-metadata-soft-delete',
      operation: 'PermissionGrantRegistry.prune',
      note: 'Permission rows are pruned before the Project metadata row is soft-deleted.'
    }
  },
  {
    id: 'project-preview-state',
    medium: 'sqlite',
    resources: ['ProjectPreviewState'],
    prismaModels: [
      {
        name: 'ProjectPreviewState',
        ownerFields: [requiredOwner('projectId')],
        relationContracts: [
          {
            field: 'project',
            target: 'Project',
            fromFields: ['projectId'],
            onDelete: 'Cascade'
          }
        ]
      }
    ],
    policy: {
      kind: 'coordinator-cleanup',
      effect: 'hard-delete',
      path: 'project-metadata-soft-delete',
      operation: 'ProjectRepository.delete',
      note: 'The preview projection is explicitly removed before retaining the Project metadata row.'
    }
  },
  {
    id: 'vision-evidence',
    medium: 'sqlite',
    resources: ['VisionEvidence'],
    prismaModels: [
      {
        name: 'VisionEvidence',
        ownerFields: [requiredOwner('projectId'), requiredOwner('sessionId')],
        relationContracts: [
          {
            field: 'project',
            target: 'Project',
            fromFields: ['projectId'],
            onDelete: 'Cascade'
          },
          {
            field: 'uploadVersion',
            target: 'UploadVersion',
            fromFields: ['uploadVersionId'],
            onDelete: 'Cascade'
          }
        ]
      }
    ],
    policy: {
      kind: 'coordinator-cleanup',
      effect: 'hard-delete',
      path: 'project-metadata-soft-delete',
      operation: 'ProjectRepository.delete',
      note: 'Derived evidence is explicitly removed before retaining the Project metadata row.'
    }
  },
  {
    id: 'session-metadata-usage-history',
    medium: 'sqlite',
    resources: [
      'Session',
      'PendingSessionReconciliation',
      'SessionTurnUsage',
      'SessionModelCallUsage',
      'SessionRun',
      'SessionArtifactRef'
    ],
    prismaModels: [
      {
        name: 'Session',
        ownerFields: [requiredOwner('projectId')],
        relationContracts: [
          {
            field: 'project',
            target: 'Project',
            fromFields: ['projectId'],
            onDelete: 'Restrict'
          }
        ]
      },
      {
        name: 'PendingSessionReconciliation',
        ownerFields: [requiredOwner('projectId'), requiredOwner('sessionId')]
      }
    ],
    policy: {
      kind: 'retained-history',
      effect: 'retain',
      retention: 'Retained with the soft-deleted Project row.',
      reason:
        'Project metadata and Session Usage facts remain queryable for per-Project and global historical totals.'
    }
  },
  {
    id: 'notification-inbox-history',
    medium: 'sqlite',
    resources: ['NotificationInboxItem'],
    prismaModels: [
      {
        name: 'NotificationInboxItem',
        ownerFields: [optionalOwner('projectId'), optionalOwner('sessionId')]
      }
    ],
    policy: {
      kind: 'retained-history',
      effect: 'invalidate',
      path: 'notification-session-invalidation',
      operation: 'NotificationInboxController.invalidateSessions',
      retention: 'Bounded to MAX_NOTIFICATION_INBOX_ITEMS rows and removed by age/order pressure.',
      reason: 'Deletion invalidates navigation targets while preserving bounded attention history.'
    }
  },
  {
    id: 'review-persistence',
    medium: 'sqlite',
    resources: ['Review', 'ReviewScopeSnapshot'],
    prismaModels: [
      {
        name: 'Review',
        ownerFields: [requiredOwner('projectId'), requiredOwner('sessionId')]
      },
      {
        name: 'ReviewScopeSnapshot',
        ownerFields: [requiredOwner('projectId'), requiredOwner('sessionId')],
        relationContracts: [
          {
            field: 'review',
            target: 'Review',
            fromFields: ['reviewId'],
            onDelete: 'Cascade'
          }
        ]
      }
    ],
    policy: {
      kind: 'coordinator-cleanup',
      effect: 'hard-delete',
      path: 'review-tail',
      operation: 'ReviewRepository.deleteReviewsForProject',
      note: 'The Project tail deletes Review roots; Review-owned rows cascade from those roots.'
    }
  },
  {
    id: 'project-deletion-intent',
    medium: 'sqlite',
    resources: ['ProjectDeletionIntent'],
    prismaModels: [
      {
        name: 'ProjectDeletionIntent',
        ownerFields: [requiredOwner('projectId')]
      }
    ],
    policy: {
      kind: 'deletion-protocol',
      path: 'project-deletion-intent-protocol',
      operation: 'ProjectDeletionCoordinator.finishDeletion',
      purpose:
        'Durable retry authority intentionally outlives the Project row until every fallible tail completes.'
    }
  },
  {
    id: 'managed-file-projection',
    medium: 'sqlite',
    resources: ['ManagedFile', 'ManagedFileSessionSync'],
    prismaModels: [
      {
        name: 'ManagedFile',
        ownerFields: [requiredOwner('projectId'), requiredOwner('sessionId')]
      },
      {
        name: 'ManagedFileSessionSync',
        ownerFields: [requiredOwner('projectId'), requiredOwner('sessionId')]
      }
    ],
    policy: {
      kind: 'coordinator-cleanup',
      effect: 'logical-delete',
      path: 'project-file-projection-delete',
      operation: 'ManagedFileIndexRepository.softDeleteProject',
      note: 'The rebuildable query projection uses deletion tombstones instead of a Project FK.'
    }
  },
  {
    id: 'artifact-provenance',
    medium: 'sqlite',
    resources: [
      'FileOriginSession',
      'ArtifactLineage',
      'UploadFile',
      'ArtifactMessageSnapshot',
      'ArtifactVersionInput'
    ],
    prismaModels: [
      {
        name: 'FileOriginSession',
        ownerFields: [requiredOwner('projectId'), requiredOwner('sessionId')]
      },
      {
        name: 'ArtifactLineage',
        ownerFields: [requiredOwner('projectId'), requiredOwner('sessionId')],
        relationContracts: [
          {
            field: 'originSession',
            target: 'FileOriginSession',
            fromFields: ['projectId', 'sessionId'],
            onDelete: 'Restrict'
          }
        ]
      },
      {
        name: 'UploadFile',
        ownerFields: [requiredOwner('projectId'), requiredOwner('sessionId')],
        relationContracts: [
          {
            field: 'originSession',
            target: 'FileOriginSession',
            fromFields: ['projectId', 'sessionId'],
            onDelete: 'Restrict'
          }
        ]
      },
      {
        name: 'ArtifactMessageSnapshot',
        ownerFields: [requiredOwner('projectId'), requiredOwner('sessionId')],
        relationContracts: [
          {
            field: 'originSession',
            target: 'FileOriginSession',
            fromFields: ['projectId', 'sessionId'],
            onDelete: 'Restrict'
          }
        ]
      },
      {
        name: 'ArtifactVersionInput',
        ownerFields: [requiredOwner('sourceProjectId'), requiredOwner('sourceSessionId')],
        relationContracts: [
          {
            field: 'sourceOrigin',
            target: 'FileOriginSession',
            fromFields: ['sourceProjectId', 'sourceSessionId'],
            onDelete: 'Restrict'
          }
        ]
      }
    ],
    policy: {
      kind: 'coordinator-cleanup',
      effect: 'hard-delete',
      path: 'provenance-tail',
      operation: 'ArtifactProvenanceRepository.deleteProjectProvenance',
      note: 'Restrict protects the graph until the provenance owner deletes children before roots.'
    }
  },
  {
    id: 'compute-jobs',
    medium: 'sqlite',
    resources: ['ComputeJob', 'ComputeJobOperation'],
    prismaModels: [
      {
        name: 'ComputeJob',
        ownerFields: [requiredOwner('projectId'), requiredOwner('sessionId')]
      }
    ],
    policy: {
      kind: 'coordinator-cleanup',
      effect: 'hard-delete',
      path: 'compute-job-project-delete',
      operation: 'ComputeJobDeletionOwner.commitProjectJobDeletion',
      note: 'The owner removes remote workdirs before rows. leftOnRemote is live-job metadata, not a Project-deletion retention exemption.'
    }
  },
  {
    id: 'compute-job-remote-workdirs',
    medium: 'remote-runtime',
    resources: ['remote Compute Job workdirs'],
    policy: {
      kind: 'coordinator-cleanup',
      effect: 'hard-delete',
      path: 'compute-job-project-delete',
      operation: 'ComputeJobDeletionOwner.commitProjectJobDeletion',
      note: 'Prepared remote cleanup removes the workdir before its ComputeJob row; failures retain deletion authority for retry.'
    }
  },
  {
    id: 'compute-session-cache',
    medium: 'filesystem',
    resources: ['compute/session-cache/<projectId>/<sessionId>/'],
    policy: {
      kind: 'coordinator-cleanup',
      effect: 'hard-delete',
      path: 'compute-job-project-delete',
      operation: 'SessionCacheOwner.removeProject',
      note: 'The composed Compute deletion owner drains and removes Session cache bytes after job cleanup.'
    }
  },
  {
    id: 'project-session-json',
    medium: 'filesystem',
    resources: ['sessions/<projectId>/', 'deleted-sessions/<projectId>/'],
    policy: {
      kind: 'coordinator-cleanup',
      effect: 'hard-delete',
      path: 'project-session-json-delete',
      operation: 'SessionRepository.deleteProjectSessions',
      note: 'The live directory is first renamed into a durable tombstone used by crash recovery.'
    }
  },
  {
    id: 'managed-session-workspaces',
    medium: 'filesystem',
    resources: ['workspaces/<workspaceId>/'],
    policy: {
      kind: 'retained-history',
      effect: 'retain',
      retention: 'Retained until the user removes the workspace files.',
      reason: 'Session and Project deletion preserve ordinary workspace files for user recovery.'
    }
  },
  {
    id: 'artifact-bytes',
    medium: 'filesystem',
    resources: ['artifacts/<projectId>/'],
    policy: {
      kind: 'coordinator-cleanup',
      effect: 'hard-delete',
      path: 'provenance-tail',
      operation: 'ArtifactProvenanceRepository.deleteProjectProvenance',
      note: 'The Project Artifact root is removed only while durable deletion intent remains.'
    }
  },
  {
    id: 'upload-bytes',
    medium: 'filesystem',
    resources: ['managed Upload version bytes addressed by storage keys under uploads/'],
    policy: {
      kind: 'coordinator-cleanup',
      effect: 'hard-delete',
      path: 'provenance-tail',
      operation: 'ArtifactProvenanceRepository.deleteProjectProvenance',
      note: 'Authoritative Upload storage keys are removed before their provenance rows.'
    }
  },
  {
    id: 'delegated-frame-workspaces',
    medium: 'filesystem',
    resources: ['delegation/<projectId>/'],
    policy: {
      kind: 'coordinator-cleanup',
      effect: 'hard-delete',
      path: 'delegated-runtime-quiescence',
      operation: 'ProductionFrameWorkspace.deleteProject',
      note: 'The delegated owner removes both live work and dormant Project workspace directories.'
    }
  },
  {
    id: 'side-chat-runtime-profiles',
    medium: 'filesystem',
    resources: ['runtime-support/side-chat/<sideChatId>/'],
    policy: {
      kind: 'coordinator-cleanup',
      effect: 'hard-delete',
      path: 'side-chat-profile-tail',
      operation: 'SideChatRuntimeOwner.completeProjectDeletion',
      note: 'The durable Project deletion tail removes restricted backend profiles for hydrated Side Chats before releasing its deletion intent.'
    }
  },
  {
    id: 'acp-runtime-state',
    medium: 'runtime-state',
    resources: ['ACP sessions and generations'],
    policy: {
      kind: 'coordinator-cleanup',
      effect: 'drain',
      path: 'project-runtime-quiescence',
      operation: 'ProjectRuntimeQuiescenceOwner.quiesceProject',
      note: 'Both pre- and post-delegation ACP ownership snapshots are deleted before authority removal.'
    }
  },
  {
    id: 'reviewer-runtime-state',
    medium: 'runtime-state',
    resources: ['Reviewer passes and correction loops'],
    policy: {
      kind: 'coordinator-cleanup',
      effect: 'drain',
      path: 'project-runtime-quiescence',
      operation: 'ReviewerProjectRuntimeOwner.quiesceProject',
      note: 'Reviewer publication is fenced before the first ACP ownership snapshot.'
    }
  },
  {
    id: 'side-chat-runtime-state',
    medium: 'runtime-state',
    resources: ['Side Chat parents, relays, and completions'],
    policy: {
      kind: 'coordinator-cleanup',
      effect: 'invalidate',
      path: 'project-runtime-quiescence',
      operation: 'SideChatRuntimeOwner.invalidateProject',
      note: 'Project runtime quiescence invalidates live work before Session authority is removed.'
    }
  },
  {
    id: 'notebook-kernel-runtime-state',
    medium: 'runtime-state',
    resources: ['Notebook kernels and pending Project operations'],
    policy: {
      kind: 'coordinator-cleanup',
      effect: 'drain',
      path: 'project-runtime-quiescence',
      operation: 'NotebookRuntimeService.shutdownProject',
      note: 'Kernel shutdown fences new operations but deliberately does not remove workspace bytes.'
    }
  },
  {
    id: 'compute-runtime-state',
    medium: 'remote-runtime',
    resources: ['Compute dispatch, polling, queues, and remote jobs'],
    policy: {
      kind: 'coordinator-cleanup',
      effect: 'drain',
      path: 'project-runtime-quiescence',
      operation: 'ComputeJobDeletionOwner.reconcileProjectOrphanJobs',
      note: 'Quiescence reconciles Project jobs after ACP, Notebook, and delegated work stop producing them.'
    }
  },
  {
    id: 'notebook-project-workspace',
    medium: 'filesystem',
    resources: ['notebooks/<projectId>/'],
    policy: {
      kind: 'retained-history',
      effect: 'retain',
      retention:
        'Retained until the user removes the Project working folder outside Project deletion.',
      reason:
        'The delete confirmation promises that files in the Project working folder are not deleted.'
    }
  },
  {
    id: 'notebook-input-cache',
    medium: 'filesystem',
    resources: ['notebook-inputs/<projectId>/'],
    policy: {
      kind: 'coordinator-cleanup',
      effect: 'hard-delete',
      path: 'notebook-input-cache-tail',
      operation: 'NotebookRuntimeService.deleteProjectInputs',
      note: 'The durable Project deletion intent removes derived, read-only Notebook input copies after runtime quiescence.'
    }
  },
  {
    id: 'execution-file-evidence',
    medium: 'filesystem',
    resources: ['execution-file-evidence/<projectId>/', 'notebook-file-evidence/<projectId>/'],
    policy: {
      kind: 'coordinator-cleanup',
      effect: 'hard-delete',
      path: 'execution-file-evidence-tail',
      operation: 'NotebookRuntimeService.deleteProjectFileEvidence',
      note: 'The durable Project deletion intent retries removal of frozen Notebook file generations after runtime quiescence.'
    }
  }
]

export { PROJECT_OWNED_DATA_CATALOG }
