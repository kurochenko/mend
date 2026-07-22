import { describe, expect, it } from 'bun:test'
import { buildBugHistoryPromptSection, type BugHistoryStore } from '@/mastra/review/bug-history'

describe('buildBugHistoryPromptSection', () => {
  it('renders resolved project findings while excluding the current MR from the store query', async () => {
    let requestedExcludeMrIid: number | undefined
    const store: BugHistoryStore = {
      listResolvedProjectFindings: async (params) => {
        requestedExcludeMrIid = params.excludeMrIid
        return [
          {
            path: 'src/billing.ts',
            decisionReason:
              'This bug previously shipped because retry state was reset before the failed attempt was persisted. Extra detail is omitted.',
          },
          {
            path: null,
            decisionReason: 'Project-wide migration ordering issue was confirmed.',
          },
        ]
      },
    }

    const section = await buildBugHistoryPromptSection({ projectKey: 'app', mrIid: 42 }, { store })

    expect(requestedExcludeMrIid).toBe(42)
    expect(section).toContain('## Bugs previously shipped in this project')
    expect(section).toContain(
      '- [src/billing.ts] This bug previously shipped because retry state was reset before the failed attempt was persisted.',
    )
    expect(section).toContain('- [project] Project-wide migration ordering issue was confirmed.')
    expect(section).not.toContain('Extra detail')
  })

  it('emits nothing when there is no history', async () => {
    const store: BugHistoryStore = {
      listResolvedProjectFindings: async () => [],
    }

    await expect(
      buildBugHistoryPromptSection({ projectKey: 'app', mrIid: 42 }, { store }),
    ).resolves.toBeNull()
  })
})
