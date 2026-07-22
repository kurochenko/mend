import { describe, expect, it } from 'bun:test'
import { buildCommand, extractInspectedChangedFilesFromEvents } from '@/agents/codex-harness'

const commandEvent = (command: string): string =>
  JSON.stringify({
    type: 'item.completed',
    item: {
      type: 'command_execution',
      command,
    },
  })

describe('extractInspectedChangedFilesFromEvents', () => {
  it('extracts changed files from exact file-content command paths', () => {
    const events = [
      commandEvent('/bin/zsh -lc "sed -n \'1,120p\' src/agents/codex-harness.ts"'),
      commandEvent('/bin/zsh -lc "nl -ba src/mastra/review/review-pipeline.ts | sed -n \'1,80p\'"'),
    ].join('\n')

    expect(
      extractInspectedChangedFilesFromEvents(events, [
        'src/agents/codex-harness.ts',
        'src/mastra/review/review-pipeline.ts',
      ]),
    ).toEqual(['src/agents/codex-harness.ts', 'src/mastra/review/review-pipeline.ts'])
  })

  it('does not count substring path matches or diff/search-only commands', () => {
    const events = [
      commandEvent('/bin/zsh -lc "sed -n \'1,120p\' src/foo.tsx"'),
      commandEvent('/bin/zsh -lc "git diff main...HEAD -- src/foo.ts"'),
      commandEvent('/bin/zsh -lc "rg src/foo.ts src"'),
    ].join('\n')

    expect(extractInspectedChangedFilesFromEvents(events, ['src/foo.ts'])).toEqual([])
  })
})

describe('buildCommand', () => {
  it('passes configured thinking level to Codex reasoning effort', () => {
    expect(
      buildCommand(
        {
          cwd: '/repo',
          model: 'gpt-5.5',
          thinkingLevel: 'medium',
          instructions: 'Review carefully.',
          prompt: 'Review this MR.',
          sessionDir: '/sessions',
        },
        '/sessions/out.txt',
      ),
    ).toContain('model_reasoning_effort="medium"')
  })

  it('maps off thinking level to Codex minimal reasoning effort', () => {
    expect(
      buildCommand(
        {
          cwd: '/repo',
          model: 'gpt-5.5',
          thinkingLevel: 'off',
          instructions: 'Review carefully.',
          prompt: 'Review this MR.',
          sessionDir: '/sessions',
        },
        '/sessions/out.txt',
      ),
    ).toContain('model_reasoning_effort="minimal"')
  })
})
