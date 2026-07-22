import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

export const reviewRunStatusEnum = pgEnum('review_run_status', ['running', 'success', 'failed'])
export const serviceRuntimeModeEnum = pgEnum('service_runtime_mode', ['running', 'draining'])
export const reviewMemoryStatusEnum = pgEnum('review_memory_status', ['active', 'archived'])
export const reviewFindingStateValues = [
  'pending',
  'accepted',
  'rejected',
  'deferred',
  'fixed',
  'not_fixed',
  'resolved',
] as const
export const reviewFindingStateEnum = pgEnum('review_finding_state', reviewFindingStateValues)
export type ReviewFindingState = (typeof reviewFindingStateValues)[number]
export const fixBatchStatusValues = ['pending', 'running', 'completed', 'failed'] as const
export const fixBatchStatusEnum = pgEnum('fix_batch_status', fixBatchStatusValues)
export type FixBatchStatus = (typeof fixBatchStatusValues)[number]
export const improvementProposalTypeValues = ['tooling', 'instructions', 'process'] as const
export const improvementProposalTypeEnum = pgEnum(
  'improvement_proposal_type',
  improvementProposalTypeValues,
)
export type ImprovementProposalType = (typeof improvementProposalTypeValues)[number]
export const improvementProposalStatusValues = [
  'proposed',
  'accepted',
  'dismissed',
  'shipped',
] as const
export const improvementProposalStatusEnum = pgEnum(
  'improvement_proposal_status',
  improvementProposalStatusValues,
)
export type ImprovementProposalStatus = (typeof improvementProposalStatusValues)[number]

export const reviewRuns = pgTable('review_runs', {
  id: text('id').primaryKey(),
  projectKey: text('project_key').notNull(),
  mrIid: integer('mr_iid').notNull(),
  commitSha: text('commit_sha'),
  model: text('model').notNull(),
  source: text('source').notNull(),
  status: reviewRunStatusEnum('status').notNull(),
  workflowRunId: text('workflow_run_id'),
  webhookPayload: jsonb('webhook_payload'),
  input: jsonb('input').notNull(),
  result: jsonb('result'),
  comparisonResult: jsonb('comparison_result'),
  error: text('error'),
  durationMs: integer('duration_ms'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
})

export const serviceRuntime = pgTable('service_runtime', {
  id: text('id').primaryKey(),
  mode: serviceRuntimeModeEnum('mode').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

export const mrReviewQueue = pgTable('mr_review_queue', {
  id: text('id').primaryKey(),
  projectKey: text('project_key').notNull(),
  mrIid: integer('mr_iid').notNull(),
  runningEvent: jsonb('running_event'),
  runningPayload: jsonb('running_payload'),
  runningCommitSha: text('running_commit_sha'),
  pendingEvent: jsonb('pending_event'),
  pendingPayload: jsonb('pending_payload'),
  pendingCommitSha: text('pending_commit_sha'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

export const mrStatusNotes = pgTable(
  'mr_status_notes',
  {
    id: text('id').primaryKey(),
    projectKey: text('project_key').notNull(),
    mrIid: integer('mr_iid').notNull(),
    noteId: bigint('note_id', { mode: 'number' }),
    renderedBody: text('rendered_body').notNull(),
    renderedBodyHash: text('rendered_body_hash').notNull(),
    syncAction: text('sync_action').notNull(),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    mrIdx: uniqueIndex('mr_status_notes_mr_idx').on(table.projectKey, table.mrIid),
  }),
)

export const mrFixBatches = pgTable(
  'mr_fix_batches',
  {
    id: text('id').primaryKey(),
    projectKey: text('project_key').notNull(),
    mrIid: integer('mr_iid').notNull(),
    status: fixBatchStatusEnum('status').notNull(),
    force: boolean('force').notNull(),
    loopCount: integer('loop_count').default(0).notNull(),
    requestNoteId: text('request_note_id'),
    requestThreadId: text('request_thread_id'),
    requestedByExternalId: text('requested_by_external_id'),
    requestedByName: text('requested_by_name'),
    acceptedFindingIds: jsonb('accepted_finding_ids').notNull(),
    pendingFindingIds: jsonb('pending_finding_ids').notNull(),
    sourceBranch: text('source_branch'),
    pushedCommitSha: text('pushed_commit_sha'),
    result: jsonb('result'),
    failureMessage: text('failure_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    mrIdx: uniqueIndex('mr_fix_batches_mr_idx').on(table.projectKey, table.mrIid),
    statusIdx: index('mr_fix_batches_status_idx').on(table.status),
  }),
)

export const reviewThreads = pgTable(
  'review_threads',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull(),
    projectKey: text('project_key').notNull(),
    repoExternalId: text('repo_external_id').notNull(),
    reviewExternalId: integer('review_external_id').notNull(),
    reviewRunId: text('review_run_id'),
    threadKind: text('thread_kind').notNull(),
    subjectType: text('subject_type').notNull(),
    path: text('path'),
    line: integer('line'),
    findingFingerprint: text('finding_fingerprint'),
    status: text('status').notNull(),
    providerThreadId: text('provider_thread_id').notNull(),
    providerUrl: text('provider_url'),
    rawProviderData: jsonb('raw_provider_data'),
    providerCreatedAt: timestamp('provider_created_at', { withTimezone: true }),
    providerUpdatedAt: timestamp('provider_updated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    providerThreadIdx: uniqueIndex('review_threads_provider_thread_idx').on(
      table.provider,
      table.providerThreadId,
    ),
    runIdx: index('review_threads_run_idx').on(table.reviewRunId),
    reviewIdx: index('review_threads_review_idx').on(table.projectKey, table.reviewExternalId),
  }),
)

export const reviewMessages = pgTable(
  'review_messages',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id')
      .notNull()
      .references(() => reviewThreads.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    reviewRunId: text('review_run_id'),
    authorType: text('author_type').notNull(),
    authorExternalId: text('author_external_id'),
    authorName: text('author_name'),
    direction: text('direction').notNull(),
    body: text('body').notNull(),
    bodyNormalized: text('body_normalized').notNull(),
    providerMessageId: text('provider_message_id').notNull(),
    providerParentMessageId: text('provider_parent_message_id'),
    processingStatus: text('processing_status'),
    processingClaimedAt: timestamp('processing_claimed_at', { withTimezone: true }),
    providerUrl: text('provider_url'),
    rawProviderData: jsonb('raw_provider_data'),
    providerCreatedAt: timestamp('provider_created_at', { withTimezone: true }),
    providerUpdatedAt: timestamp('provider_updated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    providerMessageIdx: uniqueIndex('review_messages_provider_message_idx').on(
      table.provider,
      table.providerMessageId,
    ),
    threadIdx: index('review_messages_thread_idx').on(table.threadId),
    runIdx: index('review_messages_run_idx').on(table.reviewRunId),
  }),
)

export const reviewFindings = pgTable(
  'review_findings',
  {
    id: text('id').primaryKey(),
    projectKey: text('project_key').notNull(),
    mrIid: integer('mr_iid').notNull(),
    reviewRunId: text('review_run_id'),
    threadId: text('thread_id')
      .notNull()
      .references(() => reviewThreads.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    providerThreadId: text('provider_thread_id').notNull(),
    providerNoteId: text('provider_note_id'),
    state: reviewFindingStateEnum('state').notNull(),
    decisionReason: text('decision_reason'),
    decidedByExternalId: text('decided_by_external_id'),
    decidedByName: text('decided_by_name'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    providerThreadIdx: uniqueIndex('review_findings_provider_thread_idx').on(
      table.provider,
      table.providerThreadId,
    ),
    threadIdx: uniqueIndex('review_findings_thread_idx').on(table.threadId),
    mrIdx: index('review_findings_mr_idx').on(table.projectKey, table.mrIid),
    runIdx: index('review_findings_run_idx').on(table.reviewRunId),
    stateIdx: index('review_findings_state_idx').on(table.state),
  }),
)

export const reviewMemoryEntries = pgTable(
  'review_memory_entries',
  {
    id: text('id').primaryKey(),
    scope: text('scope').notNull(),
    status: reviewMemoryStatusEnum('status').notNull(),
    projectKey: text('project_key').notNull(),
    mrIid: integer('mr_iid'),
    threadId: text('thread_id').references(() => reviewThreads.id, { onDelete: 'set null' }),
    sourceMessageId: text('source_message_id').references(() => reviewMessages.id, {
      onDelete: 'set null',
    }),
    kind: text('kind').notNull(),
    instruction: text('instruction').notNull(),
    matchFingerprint: text('match_fingerprint'),
    matchPath: text('match_path'),
    matchLine: integer('match_line'),
    matchCategory: text('match_category'),
    metadata: jsonb('metadata'),
    createdByExternalId: text('created_by_external_id'),
    createdByName: text('created_by_name'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    scopeIdx: index('review_memory_entries_scope_idx').on(
      table.scope,
      table.projectKey,
      table.mrIid,
    ),
    threadIdx: index('review_memory_entries_thread_idx').on(table.threadId),
    statusIdx: index('review_memory_entries_status_idx').on(table.status),
    sourceMessageIdx: uniqueIndex('review_memory_entries_source_message_idx').on(
      table.sourceMessageId,
    ),
  }),
)

export const reviewMemoryEvents = pgTable(
  'review_memory_events',
  {
    id: text('id').primaryKey(),
    memoryEntryId: text('memory_entry_id').references(() => reviewMemoryEntries.id, {
      onDelete: 'set null',
    }),
    projectKey: text('project_key').notNull(),
    mrIid: integer('mr_iid'),
    threadId: text('thread_id').references(() => reviewThreads.id, { onDelete: 'set null' }),
    messageId: text('message_id').references(() => reviewMessages.id, { onDelete: 'set null' }),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    memoryIdx: index('review_memory_events_memory_idx').on(table.memoryEntryId),
    threadIdx: index('review_memory_events_thread_idx').on(table.threadId),
  }),
)

export const improvementProposals = pgTable(
  'improvement_proposals',
  {
    id: text('id').primaryKey(),
    projectKey: text('project_key').notNull(),
    clusterSlug: text('cluster_slug').notNull(),
    title: text('title').notNull(),
    proposalType: improvementProposalTypeEnum('proposal_type').notNull(),
    body: text('body').notNull(),
    evidence: jsonb('evidence').notNull(),
    occurrenceCount: integer('occurrence_count').notNull(),
    status: improvementProposalStatusEnum('status').notNull(),
    lastDigestAt: timestamp('last_digest_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    clusterIdx: uniqueIndex('improvement_proposals_cluster_idx').on(
      table.projectKey,
      table.clusterSlug,
    ),
    statusIdx: index('improvement_proposals_status_idx').on(table.status),
  }),
)
