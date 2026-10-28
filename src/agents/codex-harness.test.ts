import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildCommand,
  extractInspectedChangedFilesFromEvents,
  resolveCodexInstallRoot,
} from '@/agents/codex-harness'

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

  it('confines Codex tool calls to reading the worktree with no network', () => {
    const command = buildCommand(
      {
        cwd: '/repo',
        model: 'gpt-5.5',
        instructions: 'Review carefully.',
        prompt: 'Review this MR.',
        sessionDir: '/sessions',
      },
      '/sessions/out.txt',
      '/opt/codex/@openai',
    )

    expect(command).toContain('default_permissions="mend-review"')
    expect(command).toContain(
      'permissions.mend-review.filesystem={ ":root" = "deny", ":minimal" = "read", ":workspace_roots" = "read", "/opt/codex/@openai" = "read" }',
    )
    expect(command).not.toContain('--sandbox')
  })
})

describe('resolveCodexInstallRoot', () => {
  it('grants the npm package scope when codex is the JavaScript launcher', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mend-codex-root-'))
    try {
      const launcherDir = join(tmp, 'node_modules', '@openai', 'codex', 'bin')
      mkdirSync(launcherDir, { recursive: true })
      writeFileSync(join(launcherDir, 'codex.js'), '')
      symlinkSync(join(launcherDir, 'codex.js'), join(tmp, 'codex'))

      expect(resolveCodexInstallRoot(() => join(tmp, 'codex'))).toBe(
        join(realpathSync(tmp), 'node_modules', '@openai'),
      )
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('grants the binary directory for a native codex executable', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mend-codex-native-'))
    try {
      writeFileSync(join(tmp, 'codex'), '')

      expect(resolveCodexInstallRoot(() => join(tmp, 'codex'))).toBe(realpathSync(tmp))
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('returns null when codex is not on PATH', () => {
    expect(resolveCodexInstallRoot(() => null)).toBeNull()
  })
})
