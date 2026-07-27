const DRAFT_RUN_MARKER_PREFIX = '<!-- mend:draft-run:'

export const buildDraftRunMarker = (reviewRunId: string): string =>
  `${DRAFT_RUN_MARKER_PREFIX}${reviewRunId} -->`

export const hasDraftRunMarker = (body: string): boolean => body.includes(DRAFT_RUN_MARKER_PREFIX)
