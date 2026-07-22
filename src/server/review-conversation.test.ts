import { describe, expect, test } from 'bun:test'
import { buildReviewConversationPlan, mentionsBot } from '@/server/review-conversation'
import {
  appendReviewConversationMarker,
  parseReviewConversationMarker,
} from '@/server/review-conversation-markers'

describe('mentionsBot', () => {
  test('detects direct mentions', () => {
    expect(mentionsBot('@nuxclaw please check this', 'nuxclaw')).toBe(true)
    expect(mentionsBot('please check this', 'nuxclaw')).toBe(false)
  })

  test('matches literal usernames with punctuation', () => {
    expect(mentionsBot('hey @mend.bot can you check this?', 'mend.bot')).toBe(true)
    expect(mentionsBot('hey @mendXbot can you check this?', 'mend.bot')).toBe(false)
  })
})

describe('parseReviewConversationMarker', () => {
  test('parses a valid marker with createdAt', () => {
    const body = appendReviewConversationMarker('Some reply text', {
      type: 'scope_clarification',
      intent: 'dismissal',
    })
    const marker = parseReviewConversationMarker(body)
    expect(marker?.type).toBe('scope_clarification')
    expect(marker?.intent).toBe('dismissal')
    expect(typeof marker?.createdAt).toBe('string')
  })

  test('returns null when createdAt is missing', () => {
    const body =
      '<!-- mend:conversation {"type":"scope_clarification","intent":"dismissal"} -->\nSome text'
    expect(parseReviewConversationMarker(body)).toBeNull()
  })

  test('returns null when marker is expired', () => {
    const expired = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
    const body = `<!-- mend:conversation {"type":"scope_clarification","intent":"dismissal","createdAt":"${expired}"} -->\nSome text`
    expect(parseReviewConversationMarker(body)).toBeNull()
  })

  test('returns null for bodies without markers', () => {
    expect(parseReviewConversationMarker('Just a plain note body')).toBeNull()
  })
})

describe('buildReviewConversationPlan', () => {
  test('uses reaction-only acknowledgement for clear false positives', () => {
    const plan = buildReviewConversationPlan({
      noteBody: 'This is a false positive.',
      botUsername: 'nuxclaw',
      trustedForProjectMemory: false,
      thread: {
        path: 'src/app.ts',
        line: 42,
        originalAgentBody: 'This check is unsafe.',
      },
    })

    expect(plan.relevant).toBe(true)
    expect(plan.addSuccessReaction).toBe(true)
    expect(plan.replyBody).toBeUndefined()
    expect(plan.memory?.scope).toBe('mr')
    expect(plan.memory?.kind).toBe('false_positive')
  })

  test('uses reply plus acknowledgement for trusted project guidance', () => {
    const plan = buildReviewConversationPlan({
      noteBody: 'We do not use this kind of test in this project.',
      botUsername: 'nuxclaw',
      trustedForProjectMemory: true,
    })

    expect(plan.relevant).toBe(true)
    expect(plan.addSuccessReaction).toBe(true)
    expect(plan.resolveThread).toBe(true)
    expect(plan.replyBody).toContain('project guidance')
    expect(plan.memory?.scope).toBe('project')
    expect(plan.memory?.matchCategory).toBe('testing')
  })

  test('falls back to MR memory when generic project guidance is unsupported', () => {
    const plan = buildReviewConversationPlan({
      noteBody: 'In this project we prefer a different pattern here.',
      botUsername: 'nuxclaw',
      trustedForProjectMemory: true,
    })

    expect(plan.relevant).toBe(true)
    expect(plan.addSuccessReaction).toBe(true)
    expect(plan.memory?.scope).toBe('mr')
    expect(plan.replyBody).toContain('remember it for this merge request')
  })

  test('asks a clarifying question for ambiguous dismissals', () => {
    const plan = buildReviewConversationPlan({
      noteBody: 'This is fine.',
      botUsername: 'nuxclaw',
      trustedForProjectMemory: false,
    })

    expect(plan.relevant).toBe(true)
    expect(plan.addSuccessReaction).toBe(false)
    expect(plan.replyBody).toContain('Should I remember this just for this merge request')
    expect(parseReviewConversationMarker(plan.replyBody ?? '')?.type).toBe('scope_clarification')
  })

  test('signals LLM reply for questions', () => {
    const plan = buildReviewConversationPlan({
      noteBody: 'Why did you flag this?',
      botUsername: 'nuxclaw',
      trustedForProjectMemory: false,
      thread: {
        originalAgentBody: 'The null check is missing on this path.',
      },
    })

    expect(plan.relevant).toBe(true)
    expect(plan.requiresLlmReply).toBe(true)
    expect(plan.addSuccessReaction).toBe(true)
    expect(plan.replyBody).toBeUndefined()
  })

  test('handles dismissal requests phrased as questions', () => {
    const plan = buildReviewConversationPlan({
      noteBody: 'Can you ignore this for this MR?',
      botUsername: 'nuxclaw',
      trustedForProjectMemory: false,
    })

    expect(plan.relevant).toBe(true)
    expect(plan.memory?.scope).toBe('mr')
    expect(plan.memory?.kind).toBe('ignore_this_mr')
  })

  test('handles action request dismissal without MR qualifier', () => {
    const plan = buildReviewConversationPlan({
      noteBody: 'Can you ignore this?',
      botUsername: 'nuxclaw',
      trustedForProjectMemory: false,
    })

    expect(plan.relevant).toBe(true)
    expect(plan.memory?.scope).toBe('mr')
    expect(plan.memory?.kind).toBe('ignore_this_mr')
  })

  test('treats intentionality questions as questions, not dismissals', () => {
    const plan = buildReviewConversationPlan({
      noteBody: 'Is this intentional?',
      botUsername: 'nuxclaw',
      trustedForProjectMemory: false,
      thread: {
        originalAgentBody: 'The null check is missing on this path.',
      },
    })

    expect(plan.memory).toBeUndefined()
    expect(plan.requiresLlmReply).toBe(true)
    expect(plan.replyBody).toBeUndefined()
  })

  test('treats false-positive questions as questions, not dismissals', () => {
    const plan = buildReviewConversationPlan({
      noteBody: 'Is this a false positive?',
      botUsername: 'nuxclaw',
      trustedForProjectMemory: false,
      thread: {
        originalAgentBody: 'The null check is missing on this path.',
      },
    })

    expect(plan.memory).toBeUndefined()
    expect(plan.requiresLlmReply).toBe(true)
    expect(plan.replyBody).toBeUndefined()
  })

  test('turns clarification answers into remembered MR guidance', () => {
    const plan = buildReviewConversationPlan({
      noteBody: 'Just this MR.',
      botUsername: 'nuxclaw',
      trustedForProjectMemory: false,
      pendingMarker: {
        type: 'scope_clarification',
        intent: 'dismissal',
        createdAt: new Date().toISOString(),
      },
    })

    expect(plan.relevant).toBe(true)
    expect(plan.addSuccessReaction).toBe(true)
    expect(plan.replyBody).toContain('merge request only')
    expect(plan.memory?.scope).toBe('mr')
  })

  test('promotes clarification answers into project testing memory when supported', () => {
    const plan = buildReviewConversationPlan({
      noteBody: 'For future reviews in this project.',
      botUsername: 'nuxclaw',
      trustedForProjectMemory: true,
      pendingMarker: {
        type: 'scope_clarification',
        intent: 'dismissal',
        createdAt: new Date().toISOString(),
      },
      thread: {
        originalAgentBody: 'Please add component tests for this behavior.',
      },
    })

    expect(plan.memory?.scope).toBe('project')
    expect(plan.memory?.matchCategory).toBe('testing')
  })
})

describe('intent pattern coverage', () => {
  const plan = (
    noteBody: string,
    overrides?: Partial<Parameters<typeof buildReviewConversationPlan>[0]>,
  ) =>
    buildReviewConversationPlan({
      noteBody,
      botUsername: 'nuxclaw',
      trustedForProjectMemory: false,
      ...overrides,
    })

  describe('false positive', () => {
    test('"This is a false positive" matches', () => {
      const result = plan('This is a false positive')
      expect(result.relevant).toBe(true)
      expect(result.memory?.kind).toBe('false_positive')
    })

    test('"This was intentional" matches', () => {
      const result = plan('This was intentional')
      expect(result.relevant).toBe(true)
      expect(result.memory?.kind).toBe('false_positive')
    })

    test('"Is this a false positive?" is treated as a question', () => {
      const result = plan('Is this a false positive?', {
        thread: { originalAgentBody: 'The null check is missing.' },
      })
      expect(result.memory).toBeUndefined()
      expect(result.requiresLlmReply).toBe(true)
      expect(result.replyBody).toBeUndefined()
    })
  })

  describe('MR-scoped dismissal', () => {
    test('"Don\'t flag this again for this MR" matches', () => {
      const result = plan("Don't flag this again for this MR")
      expect(result.relevant).toBe(true)
      expect(result.memory?.scope).toBe('mr')
      expect(result.memory?.kind).toBe('ignore_this_mr')
    })

    test('"This MR only" matches', () => {
      const result = plan('This MR only')
      expect(result.relevant).toBe(true)
      expect(result.memory?.scope).toBe('mr')
      expect(result.memory?.kind).toBe('ignore_this_mr')
    })

    test('"Don\'t flag this ever" does not match', () => {
      const result = plan("Don't flag this ever")
      expect(result.relevant).toBe(false)
    })
  })

  describe('deferred', () => {
    test('"We\'ll handle this in the next MR" matches', () => {
      const result = plan("We'll handle this in the next MR")
      expect(result.relevant).toBe(true)
      expect(result.memory?.kind).toBe('defer_to_later')
    })

    test('"Fix it later" matches', () => {
      const result = plan('Fix it later')
      expect(result.relevant).toBe(true)
      expect(result.memory?.kind).toBe('defer_to_later')
    })

    test('"Fix it now" does not match', () => {
      const result = plan('Fix it now')
      expect(result.relevant).toBe(false)
    })
  })

  describe('testing project rule', () => {
    test('"We don\'t use component tests in this project" matches', () => {
      const result = plan("We don't use component tests in this project", {
        trustedForProjectMemory: true,
      })
      expect(result.relevant).toBe(true)
      expect(result.memory?.scope).toBe('project')
      expect(result.memory?.matchCategory).toBe('testing')
    })

    test('"We do not use UI tests in this repo" matches', () => {
      const result = plan('We do not use UI tests in this repo', {
        trustedForProjectMemory: true,
      })
      expect(result.relevant).toBe(true)
      expect(result.memory?.scope).toBe('project')
      expect(result.memory?.matchCategory).toBe('testing')
    })

    test('"We use component tests" does not match', () => {
      const result = plan('We use component tests')
      expect(result.relevant).toBe(false)
    })
  })

  describe('project rule (generic)', () => {
    test('"In this project we handle it differently" matches', () => {
      const result = plan('In this project we handle it differently', {
        trustedForProjectMemory: true,
      })
      expect(result.relevant).toBe(true)
      expect(result.memory?.scope).toBe('mr')
      expect(result.replyBody).toContain('remember it for this merge request')
    })

    test('"In this repo that\'s expected" matches', () => {
      const result = plan("In this repo that's expected", {
        trustedForProjectMemory: true,
      })
      expect(result.relevant).toBe(true)
      expect(result.memory?.scope).toBe('mr')
    })

    test('"In my opinion that\'s fine" does not match', () => {
      const result = plan("In my opinion that's fine")
      expect(result.relevant).toBe(false)
    })
  })

  describe('ambiguous dismissal', () => {
    test('"This is fine" matches', () => {
      const result = plan('This is fine')
      expect(result.relevant).toBe(true)
      expect(result.replyBody).toContain('Should I remember this just for this merge request')
    })

    test('"Not needed" matches', () => {
      const result = plan('Not needed')
      expect(result.relevant).toBe(true)
      expect(result.replyBody).toContain('Should I remember this just for this merge request')
    })

    test('"Looks good" matches', () => {
      const result = plan('Looks good')
      expect(result.relevant).toBe(true)
      expect(result.replyBody).toContain('Should I remember this just for this merge request')
    })

    test('"This is a false positive" takes precedence over ambiguous', () => {
      const result = plan('This is a false positive')
      expect(result.memory?.kind).toBe('false_positive')
      expect(result.replyBody).toBeUndefined()
    })
  })

  describe('question', () => {
    test('"Why did you flag this?" matches', () => {
      const result = plan('Why did you flag this?', {
        thread: { originalAgentBody: 'The null check is missing.' },
      })
      expect(result.relevant).toBe(true)
      expect(result.memory).toBeUndefined()
      expect(result.requiresLlmReply).toBe(true)
      expect(result.replyBody).toBeUndefined()
    })

    test('"What is wrong here?" matches', () => {
      const result = plan('What is wrong here?', {
        thread: { originalAgentBody: 'The null check is missing.' },
      })
      expect(result.relevant).toBe(true)
      expect(result.memory).toBeUndefined()
      expect(result.requiresLlmReply).toBe(true)
      expect(result.replyBody).toBeUndefined()
    })

    test('"Can you ignore this?" is treated as MR-scoped dismissal', () => {
      const result = plan('Can you ignore this?')
      expect(result.relevant).toBe(true)
      expect(result.memory?.scope).toBe('mr')
      expect(result.memory?.kind).toBe('ignore_this_mr')
    })

    test('"Can you explain why this is risky?" uses LLM reply path', () => {
      const result = plan('Can you explain why this is risky?')
      expect(result.relevant).toBe(true)
      expect(result.requiresLlmReply).toBe(true)
    })

    test('"Could you point to the relevant code?" uses LLM reply path', () => {
      const result = plan('Could you point to the relevant code?')
      expect(result.relevant).toBe(true)
      expect(result.requiresLlmReply).toBe(true)
    })
  })
})
