import { describe, expect, it, mock } from 'bun:test'
import { createWithReconciliation } from '@/integrations/idempotent'

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

  it('retries create only after reconciliation confirms nothing was created', async () => {
    let creates = 0
    const result = await createWithReconciliation({
      action: 'Summary',
      create: async () => {
        creates += 1
        if (creates === 1) {
          throw new Error('429 rate limited')
        }
        return 'created'
      },
      list: async () => [],
      match: () => undefined,
      attempts: 3,
      retryDelayMs: 0,
    })

    expect(result).toEqual({ value: 'created', reconciled: false })
    expect(creates).toBe(2)
  })

  it('stops after the configured attempts when create keeps failing', async () => {
    let creates = 0
    await expect(
      createWithReconciliation({
        action: 'Summary',
        create: async () => {
          creates += 1
          throw new Error(`failure ${creates}`)
        },
        list: async () => [],
        match: () => undefined,
        attempts: 3,
        retryDelayMs: 0,
      }),
    ).rejects.toThrow('failure 3')
    expect(creates).toBe(3)
  })
})
