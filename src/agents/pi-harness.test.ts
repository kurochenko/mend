import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import { getFinalAssistantError, invokePiReview, loadReviewResources } from '@/agents/pi-harness'

type SessionMessage = AgentSession['messages'][number]

const userMessage = (text: string): SessionMessage => ({
  role: 'user',
  content: text,
  timestamp: 0,
})

const assistantMessage = (
  stopReason: 'stop' | 'error',
  text: string,
  errorMessage?: string,
): SessionMessage => ({
  role: 'assistant',
  content: text ? [{ type: 'text', text }] : [],
  api: 'anthropic-messages',
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason,
  errorMessage,
  timestamp: 0,
})

describe('invokePiReview', () => {
  it('returns immediately when aborted before start', async () => {
    const controller = new AbortController()
    controller.abort()

    const result = await invokePiReview({
      cwd: '/tmp',
      sessionDir: '/tmp/mend-pi-test',
      model: 'missing/provider',
      instructions: 'instructions',
      prompt: 'prompt',
      signal: controller.signal,
    })

    expect(result).toEqual({
      success: false,
      output: '',
      sessionFile: undefined,
      error: 'Pi review aborted before start',
    })
  })

  it('returns a failed result instead of throwing for a malformed model string', async () => {
    const result = await invokePiReview({
      cwd: '/tmp',
      sessionDir: '/tmp/mend-pi-test',
      model: 'no-provider-prefix',
      instructions: 'instructions',
      prompt: 'prompt',
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('Invalid model string "no-provider-prefix"')
  })
})

describe('getFinalAssistantError', () => {
  it('returns the provider error when the final assistant response failed', () => {
    expect(
      getFinalAssistantError([
        userMessage('review'),
        assistantMessage('error', '', 'OAuth refresh failed for anthropic'),
      ]),
    ).toBe('OAuth refresh failed for anthropic')
  })

  it('falls back to a generic error when the provider omits the message', () => {
    expect(getFinalAssistantError([userMessage('review'), assistantMessage('error', '')])).toBe(
      'Pi assistant response ended with an error',
    )
  })

  it('returns undefined when the final assistant response succeeded', () => {
    expect(
      getFinalAssistantError([
        assistantMessage('error', '', 'transient'),
        userMessage('retry'),
        assistantMessage('stop', 'PI_OK'),
      ]),
    ).toBeUndefined()
  })

  it('returns undefined when there is no assistant response', () => {
    expect(getFinalAssistantError([userMessage('review')])).toBeUndefined()
  })
})

describe('loadReviewResources', () => {
  let tmp: string | undefined

  afterEach(() => {
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true })
      tmp = undefined
    }
  })

  it('ignores repo extensions, skills and system prompts, and context files outside the worktree and Pi agent dir', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'mend-pi-trust-'))
    const cwd = join(tmp, 'worktree')
    const agentDir = join(tmp, 'agent')
    const marker = join(tmp, 'extension-ran')
    mkdirSync(join(cwd, '.pi/extensions'), { recursive: true })
    mkdirSync(join(cwd, '.pi/skills/evil'), { recursive: true })
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(
      join(cwd, '.pi/extensions/evil.ts'),
      `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'ran')\nexport default () => {}\n`,
    )
    writeFileSync(
      join(cwd, '.pi/skills/evil/SKILL.md'),
      '---\nname: evil\ndescription: evil\n---\nevil\n',
    )
    writeFileSync(join(cwd, '.pi/SYSTEM.md'), 'repo system prompt')
    writeFileSync(join(cwd, 'AGENTS.md'), 'repo conventions')
    writeFileSync(join(tmp, 'AGENTS.md'), 'host instructions')
    writeFileSync(join(agentDir, 'AGENTS.md'), 'operator instructions')

    const { resourceLoader } = await loadReviewResources({
      cwd,
      agentDir,
      instructions: 'mend instructions',
    })

    expect(existsSync(marker)).toBe(false)
    expect(resourceLoader.getExtensions().extensions).toEqual([])
    expect(resourceLoader.getSkills().skills).toEqual([])
    expect(resourceLoader.getSystemPrompt()).not.toBe('repo system prompt')
    expect(resourceLoader.getAgentsFiles().agentsFiles.map((file) => file.content)).toEqual([
      'operator instructions',
      'repo conventions',
      'mend instructions',
    ])
  })
})
