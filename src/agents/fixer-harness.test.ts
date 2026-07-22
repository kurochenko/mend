import { describe, expect, test } from 'bun:test'
import { buildCodexFixerCommand } from '@/agents/fixer-harness'

describe('buildCodexFixerCommand', () => {
  test('builds a codex command that pipes prompt without touching the worktree', () => {
    const command = buildCodexFixerCommand({
      model: 'gpt-5.5',
      thinkingLevel: 'medium',
      prompt: 'hello world',
      runId: 'one',
    })

    expect(command).toContain("tmp_dir='/tmp/mend-fixer-one'")
    expect(command).toContain("'codex' 'exec'")
    expect(command).toContain("'--cd' '/workspace'")
    expect(command).toContain("'--sandbox' 'workspace-write'")
    expect(command).toContain("'--model' 'gpt-5.5'")
    expect(command).toContain('\'model_reasoning_effort="medium"\'')
    expect(command).toContain('base64 -d')
    expect(command).toContain('aGVsbG8gd29ybGQ=')
    expect(command).toContain('cat "$output_file"')
  })
})
