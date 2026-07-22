import { describe, expect, test } from 'bun:test'
import { fixBatchStatusValues } from '@/db/schema'

describe('fixBatchStatusValues', () => {
  test('includes terminal states for completed and failed fixer batches', () => {
    expect(fixBatchStatusValues).toEqual(['pending', 'running', 'completed', 'failed'])
  })
})
