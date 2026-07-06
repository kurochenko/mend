import { describe, expect, test } from 'bun:test'
import { mapReaction } from '@/integrations/github/reactions'

describe('mapReaction', () => {
  test('maps GitLab award emoji names to GitHub reaction content', () => {
    expect(mapReaction('thumbsup')).toBe('+1')
    expect(mapReaction('thumbsdown')).toBe('-1')
    expect(mapReaction('laughing')).toBe('laugh')
    expect(mapReaction('laugh')).toBe('laugh')
    expect(mapReaction('confused')).toBe('confused')
    expect(mapReaction('heart')).toBe('heart')
    expect(mapReaction('tada')).toBe('hooray')
    expect(mapReaction('hooray')).toBe('hooray')
    expect(mapReaction('rocket')).toBe('rocket')
    expect(mapReaction('eyes')).toBe('eyes')
  })

  test('falls back to +1 for unknown names', () => {
    expect(mapReaction('unknown')).toBe('+1')
  })
})
