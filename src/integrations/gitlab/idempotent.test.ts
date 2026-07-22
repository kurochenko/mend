import { describe, expect, it, mock } from 'bun:test'
import { createWithReconciliation } from '@/integrations/gitlab/idempotent'

describe('createWithReconciliation', () => {
  it('returns created value when create succeeds', async () => {
    await expect(
      createWithReconciliation({
        action: 'create thing',
        create: async () => ({ id: 1 }),
        list: async () => [],
        match: () => undefined,
      }),
    ).resolves.toEqual({ value: { id: 1 }, reconciled: false })
  })

  it('returns a matching listed value when create fails ambiguously', async () => {
    await expect(
      createWithReconciliation({
        action: 'create thing',
        create: async () => {
          throw new Error('timeout')
        },
        list: async () => [{ id: 2, body: 'same' }],
        match: (items) => items.find((item) => item.body === 'same'),
      }),
    ).resolves.toEqual({ value: { id: 2, body: 'same' }, reconciled: true })
  })

  it('rethrows the create error when reconciliation has no match', async () => {
    const error = new Error('timeout')
    await expect(
      createWithReconciliation({
        action: 'create thing',
        create: async () => {
          throw error
        },
        list: async () => [{ id: 2, body: 'different' }],
        match: (items) => items.find((item) => item.body === 'same'),
      }),
    ).rejects.toBe(error)
  })

  it('wraps create and reconciliation failures together', async () => {
    const list = mock(async () => {
      throw new Error('list failed')
    })

    await expect(
      createWithReconciliation({
        action: 'create thing',
        create: async () => {
          throw new Error('create failed')
        },
        list,
        match: () => undefined,
      }),
    ).rejects.toThrow('create thing failed: create failed')
  })
})
