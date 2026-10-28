import { describe, expect, test } from 'bun:test'
import { findTriggerIgnoreReason } from '@/server/review-trigger'

const change = (overrides: Partial<Parameters<typeof findTriggerIgnoreReason>[1]> = {}) => ({
  action: 'update',
  reviewableAction: true,
  draft: false,
  ...overrides,
})

describe('findTriggerIgnoreReason', () => {
  test('ignores non-reviewable actions in every trigger mode', () => {
    for (const trigger of [{ mode: 'ready' }, { mode: 'all' }] as const) {
      expect(
        findTriggerIgnoreReason(trigger, change({ action: 'approved', reviewableAction: false })),
      ).toBe('action "approved"')
    }
  })

  test('ready mode skips drafts and all mode reviews them', () => {
    expect(findTriggerIgnoreReason({ mode: 'ready' }, change({ draft: true }))).toBe(
      'action "update", draft=true',
    )
    expect(findTriggerIgnoreReason({ mode: 'all' }, change({ draft: true }))).toBeNull()
    expect(findTriggerIgnoreReason({ mode: 'ready' }, change())).toBeNull()
  })

  test('label mode is not executed yet', () => {
    expect(findTriggerIgnoreReason({ mode: 'label', label: 'review' }, change())).toBe(
      'label trigger not yet implemented',
    )
  })
})
