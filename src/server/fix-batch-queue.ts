import { getFixBatchRecord, upsertPendingFixBatch, type FixBatchRecord } from '@/db/fix-batches'
import { getReviewQueueRecord } from '@/db/review-queue'
import { listReviewFindingsForMr, type ReviewFindingRecord } from '@/db/review-findings'
import { mrLockKey, withMrLock } from '@/server/mr-locks'

export type FixBatchRequestOutcome =
  | {
      status: 'refused'
      reason: 'fix_loop_disabled' | 'no_accepted_findings' | 'pending_findings'
      acceptedCount: number
      pendingCount: number
    }
  | {
      status: 'queued'
      batch: FixBatchRecord
      acceptedCount: number
      pendingCount: number
      waitingForReview: boolean
    }
  | {
      status: 'duplicate'
      batch: FixBatchRecord
    }

interface RequestAcceptedFixBatchParams {
  projectKey: string
  mrIid: number
  enabled: boolean
  force: boolean
  requestNoteId?: string | null
  requestThreadId?: string | null
  requestedByExternalId?: string | null
  requestedByName?: string | null
}

const findingIds = (findings: ReviewFindingRecord[]): string[] =>
  findings.map((finding) => finding.id)

export const requestAcceptedFixBatch = async (
  params: RequestAcceptedFixBatchParams,
): Promise<FixBatchRequestOutcome> =>
  await withMrLock(mrLockKey(params.projectKey, params.mrIid), async () => {
    if (!params.enabled) {
      return {
        status: 'refused',
        reason: 'fix_loop_disabled',
        acceptedCount: 0,
        pendingCount: 0,
      }
    }

    const existing = await getFixBatchRecord(params.projectKey, params.mrIid)
    if (existing?.status === 'pending' || existing?.status === 'running') {
      return { status: 'duplicate', batch: existing }
    }

    const findings = await listReviewFindingsForMr({
      projectKey: params.projectKey,
      mrIid: params.mrIid,
    })
    const acceptedFindings = findings.filter((finding) => finding.state === 'accepted')
    const pendingFindings = findings.filter((finding) => finding.state === 'pending')

    if (acceptedFindings.length === 0) {
      return {
        status: 'refused',
        reason: 'no_accepted_findings',
        acceptedCount: 0,
        pendingCount: pendingFindings.length,
      }
    }

    if (pendingFindings.length > 0 && !params.force) {
      return {
        status: 'refused',
        reason: 'pending_findings',
        acceptedCount: acceptedFindings.length,
        pendingCount: pendingFindings.length,
      }
    }

    const reviewQueueRecord = await getReviewQueueRecord(params.projectKey, params.mrIid)
    const waitingForReview = Boolean(reviewQueueRecord?.runningEvent)
    const batch = await upsertPendingFixBatch({
      projectKey: params.projectKey,
      mrIid: params.mrIid,
      force: params.force,
      requestNoteId: params.requestNoteId,
      requestThreadId: params.requestThreadId,
      requestedByExternalId: params.requestedByExternalId,
      requestedByName: params.requestedByName,
      acceptedFindingIds: findingIds(acceptedFindings),
      pendingFindingIds: findingIds(pendingFindings),
    })

    return {
      status: 'queued',
      batch,
      acceptedCount: acceptedFindings.length,
      pendingCount: pendingFindings.length,
      waitingForReview,
    }
  })
