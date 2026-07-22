import type { ReviewMemoryScope } from '@/db/review-memory'
import type { ReviewConversationMarker } from '@/server/review-conversation-markers'
import {
  appendReviewConversationMarker,
  stripReviewConversationMarker,
} from '@/server/review-conversation-markers'

interface ConversationThreadContext {
  path?: string | null
  line?: number | null
  originalAgentBody?: string | null
}

interface LatestReviewContext {
  assessment: 'approve' | 'request_changes' | 'needs_discussion'
  summary: string
  findingsCount: number
  inlineCommentCount: number
}

export interface ReviewConversationPlan {
  relevant: boolean
  addSuccessReaction: boolean
  resolveThread: boolean
  requiresLlmReply?: boolean
  replyBody?: string
  memory?: {
    scope: ReviewMemoryScope
    kind: string
    instruction: string
    matchCategory?: string | null
    metadata?: Record<string, unknown>
  }
}

interface BuildReviewConversationPlanParams {
  noteBody: string
  botUsername: string
  trustedForProjectMemory: boolean
  pendingMarker?: ReviewConversationMarker | null
  thread?: ConversationThreadContext | null
  latestReview?: LatestReviewContext | null
}

const QUESTION_PREFIXES = ['why', 'what', 'how', 'does', 'do', 'can', 'could', 'should']
const AMBIGUOUS_DISMISSAL_PATTERNS = [
  /\b(this|that|it) is fine\b/,
  /\b(this|that|it) is okay\b/,
  /\bnot needed\b/,
  /\blooks good\b/,
]

const isMentionBoundary = (value: string): boolean =>
  value.length === 0 || /[^a-z0-9_.-]/i.test(value)

const findMentionRange = (
  body: string,
  botUsername: string,
): { start: number; end: number } | null => {
  const lowerBody = body.toLowerCase()
  const mention = `@${botUsername.toLowerCase()}`
  let start = lowerBody.indexOf(mention)

  while (start !== -1) {
    const before = start === 0 ? '' : (lowerBody[start - 1] ?? '')
    const after = lowerBody[start + mention.length] ?? ''
    if (isMentionBoundary(before) && isMentionBoundary(after)) {
      return {
        start,
        end: start + mention.length,
      }
    }

    start = lowerBody.indexOf(mention, start + mention.length)
  }

  return null
}

const stripMention = (body: string, botUsername: string): string => {
  const range = findMentionRange(body, botUsername)
  if (!range) {
    return body.trim()
  }

  return `${body.slice(0, range.start)} ${body.slice(range.end)}`.trim()
}

export const mentionsBot = (body: string, botUsername: string): boolean =>
  findMentionRange(body, botUsername) !== null

const normalize = (body: string): string =>
  stripReviewConversationMarker(body).toLowerCase().replace(/\s+/g, ' ').trim()

const isQuestion = (body: string): boolean => {
  if (body.includes('?')) {
    return true
  }

  return QUESTION_PREFIXES.some((prefix) => body.startsWith(`${prefix} `))
}

const indicatesFalsePositive = (body: string): boolean =>
  /\bfalse positive\b/.test(body) ||
  /\bthis is intentional\b/.test(body) ||
  /\bthis was intentional\b/.test(body) ||
  /\bthis is expected\b/.test(body) ||
  /\bthis was expected\b/.test(body)

const indicatesActionRequestDismissal = (body: string): boolean =>
  /^(can|could|would) you\b/.test(body) && /\b(ignore|dismiss|skip|drop|remove)\b/.test(body)

const indicatesMrScopedDismissal = (body: string): boolean =>
  /\bfor this mr\b/.test(body) ||
  /\bthis mr only\b/.test(body) ||
  /\bdon'?t flag (this|it) again\b/.test(body) ||
  indicatesActionRequestDismissal(body)

const indicatesDeferred = (body: string): boolean =>
  /\bnext mr\b/.test(body) ||
  /\bfollow-up\b/.test(body) ||
  /\bfix (this|it) later\b/.test(body) ||
  /\bwe'?ll handle (this|it) later\b/.test(body)

const indicatesTestingProjectRule = (body: string): boolean =>
  (/\b(component|ui) tests?\b/.test(body) || /\bthis kind of test\b/.test(body)) &&
  (/\bwe do not use\b/.test(body) ||
    /\bwe don't use\b/.test(body) ||
    /\bin this project\b/.test(body) ||
    /\bin this repo\b/.test(body))

const indicatesProjectRule = (body: string): boolean =>
  /\bin this project\b/.test(body) || /\bin this repo\b/.test(body)

const mentionsTestingRule = (body: string | null | undefined): boolean =>
  typeof body === 'string' && /\b(component|ui) tests?\b/i.test(body)

const indicatesAmbiguousDismissal = (body: string): boolean =>
  AMBIGUOUS_DISMISSAL_PATTERNS.some((pattern) => pattern.test(body))

const buildClarificationReply = (): string =>
  appendReviewConversationMarker(
    'Should I remember this just for this merge request, or as project guidance for future reviews too?',
    {
      type: 'scope_clarification',
      intent: 'dismissal',
    },
  )

const buildDismissalMemory = (
  scope: ReviewMemoryScope,
  kind: string,
  instruction: string,
  matchCategory?: string | null,
): ReviewConversationPlan => ({
  relevant: true,
  addSuccessReaction: true,
  resolveThread: scope === 'mr',
  memory: {
    scope,
    kind,
    instruction,
    matchCategory,
  },
})

export const buildReviewConversationPlan = (
  params: BuildReviewConversationPlanParams,
): ReviewConversationPlan => {
  const normalizedBody = normalize(stripMention(params.noteBody, params.botUsername))

  if (!normalizedBody) {
    return {
      relevant: false,
      addSuccessReaction: false,
      resolveThread: false,
    }
  }

  if (params.pendingMarker?.type === 'scope_clarification') {
    if (/\b(project|future reviews?)\b/.test(normalizedBody)) {
      if (params.trustedForProjectMemory && mentionsTestingRule(params.thread?.originalAgentBody)) {
        return {
          relevant: true,
          addSuccessReaction: true,
          resolveThread: true,
          replyBody:
            'Understood — I’ll treat this as project guidance and stop asking for this kind of test here.',
          memory: {
            scope: 'project',
            kind: 'project_rule_testing',
            instruction: 'Do not require or request UI/component tests for this project.',
            matchCategory: 'testing',
            metadata: { testingRule: 'no_ui_component_tests' },
          },
        }
      }

      if (params.trustedForProjectMemory) {
        return {
          relevant: true,
          addSuccessReaction: true,
          resolveThread: true,
          replyBody:
            'I understood this as project guidance, but I can only store project-wide memory for specific rule types like testing right now. I’ll remember it for this merge request.',
          memory: {
            scope: 'mr',
            kind: 'ignore_this_mr',
            instruction: 'Do not re-raise this concern again on this merge request.',
          },
        }
      }

      return {
        relevant: true,
        addSuccessReaction: true,
        resolveThread: true,
        replyBody:
          'I understood this as project guidance, but I am only configured to store project-wide memory from trusted users right now. I’ll remember it for this merge request.',
        memory: {
          scope: 'mr',
          kind: 'ignore_this_mr',
          instruction: 'Do not re-raise this concern again on this merge request.',
        },
      }
    }

    if (/\b(this mr|merge request|here only|just here)\b/.test(normalizedBody)) {
      return {
        relevant: true,
        addSuccessReaction: true,
        resolveThread: true,
        replyBody: 'Understood — I’ll remember it for this merge request only.',
        memory: {
          scope: 'mr',
          kind: 'ignore_this_mr',
          instruction: 'Do not re-raise this concern again on this merge request.',
        },
      }
    }
  }

  if (indicatesTestingProjectRule(normalizedBody)) {
    if (params.trustedForProjectMemory) {
      return {
        relevant: true,
        addSuccessReaction: true,
        resolveThread: true,
        replyBody:
          'Understood — I’ll treat this as project guidance and stop asking for this kind of test here.',
        memory: {
          scope: 'project',
          kind: 'project_rule_testing',
          instruction: 'Do not require or request UI/component tests for this project.',
          matchCategory: 'testing',
          metadata: { testingRule: 'no_ui_component_tests' },
        },
      }
    }

    return {
      relevant: true,
      addSuccessReaction: true,
      resolveThread: true,
      replyBody:
        'I understood this as project guidance, but I am only configured to store project-wide memory from trusted users right now. I’ll remember it for this merge request.',
      memory: {
        scope: 'mr',
        kind: 'ignore_this_mr',
        instruction: 'Do not request this kind of test again on this merge request.',
        matchCategory: 'testing',
      },
    }
  }

  if (isQuestion(normalizedBody) && !indicatesActionRequestDismissal(normalizedBody)) {
    return {
      relevant: true,
      requiresLlmReply: true,
      addSuccessReaction: true,
      resolveThread: false,
    }
  }

  if (indicatesFalsePositive(normalizedBody)) {
    return buildDismissalMemory(
      'mr',
      'false_positive',
      'Do not re-raise this concern again on this merge request because the developer marked it as a false positive.',
    )
  }

  if (indicatesDeferred(normalizedBody)) {
    return buildDismissalMemory(
      'mr',
      'defer_to_later',
      'Do not re-raise this concern again on this merge request because the developer deferred it to a later merge request.',
    )
  }

  if (indicatesMrScopedDismissal(normalizedBody)) {
    return buildDismissalMemory(
      'mr',
      'ignore_this_mr',
      'Do not re-raise this concern again on this merge request.',
    )
  }

  if (indicatesProjectRule(normalizedBody)) {
    if (params.trustedForProjectMemory) {
      return {
        relevant: true,
        addSuccessReaction: true,
        resolveThread: true,
        replyBody:
          'I understood this as project guidance, but I can only store project-wide memory for specific rule types like testing right now. I’ll remember it for this merge request.',
        memory: {
          scope: 'mr',
          kind: 'ignore_this_mr',
          instruction: 'Do not re-raise this concern again on this merge request.',
        },
      }
    }

    return {
      relevant: true,
      addSuccessReaction: true,
      resolveThread: true,
      replyBody:
        'I understood this as project guidance, but I am only configured to store project-wide memory from trusted users right now. I’ll remember it for this merge request.',
      memory: {
        scope: 'mr',
        kind: 'ignore_this_mr',
        instruction: 'Do not re-raise this concern again on this merge request.',
      },
    }
  }

  if (indicatesAmbiguousDismissal(normalizedBody)) {
    return {
      relevant: true,
      addSuccessReaction: false,
      resolveThread: false,
      replyBody: buildClarificationReply(),
    }
  }

  return {
    relevant: false,
    addSuccessReaction: false,
    resolveThread: false,
  }
}
