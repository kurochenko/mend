import { describe, expect, it } from 'bun:test'
import type { ProjectConfig } from '@/config'
import type { ReviewAgentHarness, ReviewAgentResult } from '@/agents/review-harness'
import { getEffectiveReviewAgentConfig, invokeReviewAgent } from '@/mastra/review/review-pipeline'

const validReviewOutput = JSON.stringify({
  version: 'v2',
  assessment: 'approve',
  summary: 'No issues found',
  meta: {
    templateId: 'mixed',
    intent: 'mixed',
    confidence: 1,
    selectionSource: 'fallback',
  },
  findings: [],
  inlineComments: [],
})

const nonBlockingReviewOutput = JSON.stringify({
  version: 'v2',
  assessment: 'request_changes',
  summary: 'Optional improvements',
  findings: [
    {
      id: 'recommended-cleanup',
      category: 'architecture',
      severity: 'bug',
      actionability: 'recommended',
      scope: 'single_file',
      title: 'Simplify this helper',
      body: 'The helper could be shorter.',
      files: ['src/app.ts'],
      evidence: [{ type: 'file_line', file: 'src/app.ts', line: 1 }],
    },
  ],
  inlineComments: [
    { file: 'src/app.ts', line: 1, severity: 'suggestion', body: 'Rename this variable.' },
  ],
})

const createProject = (overrides: Partial<ProjectConfig['review']> = {}): ProjectConfig => ({
  key: 'test',
  clone_path: '/tmp/test',
  platform: 'gitlab',
  url: 'https://gitlab.example.com',
  token: 'token',
  webhook_secret: 'secret',
  project_id: 1,
  repo_url: 'git@gitlab.example.com:org/repo.git',
  default_branch: 'main',
  trigger: { mode: 'ready' },
  tools: { context7: {} },
  review: {
    llm: { model: 'legacy-model', thinking_level: 'medium' },
    agent: { harness: 'pi' },
    template: { prompt: 'auto', label_prefix: 'ai-review:' },
    flags: {
      prompt_templates_v2: true,
      schema_v2: true,
      structured_findings_post: true,
      structural_signals: true,
      bug_history: true,
      dry_run: false,
    },
    intent: {
      harness: 'pi',
      model: 'intent-model',
      thinking_level: 'minimal',
      timeout_ms: 45_000,
      failure_policy: 'mixed',
    },
    comparison: { enabled: false, harness: 'opencode', timeout_ms: 300_000 },
    memory: { project_scope_usernames: [] },
    triage: { trusted_usernames: [] },
    fix: { enabled: false, automatic: false, max_loops: 3 },
    ...overrides,
  },
})

const createHarness = (
  id: ReviewAgentHarness['id'],
  results: Array<
    Pick<ReviewAgentResult, 'success' | 'output' | 'error' | 'sessionFile' | 'inspectedFiles'>
  >,
): ReviewAgentHarness => {
  let index = 0
  return {
    id,
    invoke: async (config) => {
      const result = results[Math.min(index, results.length - 1)]
      if (!result) {
        throw new Error('test harness requires at least one result')
      }
      index += 1
      return {
        harness: id,
        model: config.model,
        durationMs: index,
        ...result,
      }
    },
  }
}

describe('getEffectiveReviewAgentConfig', () => {
  it('defaults to Pi and legacy review llm settings', () => {
    const config = getEffectiveReviewAgentConfig(createProject())

    expect(config).toEqual({
      harness: 'pi',
      model: 'legacy-model',
      thinkingLevel: 'medium',
      timeoutMs: undefined,
    })
  })

  it('uses configured review agent overrides', () => {
    const config = getEffectiveReviewAgentConfig(
      createProject({
        agent: {
          harness: 'codex',
          model: 'gpt-5',
          thinking_level: 'high',
          timeout_ms: 900_000,
        },
      }),
    )

    expect(config).toEqual({
      harness: 'codex',
      model: 'gpt-5',
      thinkingLevel: 'high',
      timeoutMs: 900_000,
    })
  })

  it('uses the synthesizer model as the effective ensemble model', () => {
    const config = getEffectiveReviewAgentConfig(
      createProject({
        agent: {
          harness: 'ensemble',
          ensemble: {
            finder_harness: 'codex',
            finder_model: 'gpt-5-mini',
            finder_thinking_level: 'low',
            finder_timeout_ms: 300_000,
            verify_enabled: true,
            verifier_model: 'gpt-5.5',
            verifier_thinking_level: 'low',
            verifier_timeout_ms: 180_000,
            deep_samples: 2,
            deep_model: 'gpt-5.5',
            deep_timeout_ms: 1_200_000,
            synthesizer_model: 'gpt-6',
            synthesizer_timeout_ms: 300_000,
          },
        },
      }),
    )

    expect(config).toEqual({
      harness: 'ensemble',
      model: 'gpt-6',
      thinkingLevel: 'medium',
      timeoutMs: undefined,
    })
  })
})

describe('invokeReviewAgent', () => {
  it('runs the configured primary harness and parses structured output', async () => {
    const result = await invokeReviewAgent({
      project: createProject({ agent: { harness: 'codex', model: 'gpt-5' } }),
      worktreePath: '/tmp/test',
      sessionDir: '/tmp/test/sessions',
      instructions: 'review instructions',
      prompt: 'review prompt',
      changedFiles: [],
      context7ApiKey: null,
      harnesses: {
        codex: createHarness('codex', [{ success: true, output: validReviewOutput }]),
      },
    })

    expect(result.reviewResult.harness).toBe('codex')
    expect(result.reviewResult.model).toBe('gpt-5')
    expect(result.validatedReview.assessment).toBe('approve')
  })

  it('normalizes non-blocking direct harness output before provider posting', async () => {
    const result = await invokeReviewAgent({
      project: createProject({ agent: { harness: 'codex', model: 'gpt-5' } }),
      worktreePath: '/tmp/test',
      sessionDir: '/tmp/test/sessions',
      instructions: 'review instructions',
      prompt: 'review prompt',
      changedFiles: [],
      context7ApiKey: null,
      harnesses: {
        codex: createHarness('codex', [{ success: true, output: nonBlockingReviewOutput }]),
      },
    })

    expect(result.validatedReview.findings).toEqual([])
    expect(result.validatedReview.inlineComments).toEqual([])
    expect(result.validatedReview.assessment).toBe('approve')
    expect(result.validatedReview.summary).toBe(
      'No release- or development-blocking defects found.',
    )
    expect(result.validatedReview.summary).not.toContain('Optional improvements')
  })

  it('retries invalid final output once without tools', async () => {
    const toolModes: Array<'full' | 'none' | undefined> = []
    const prompts: string[] = []
    const harness: ReviewAgentHarness = {
      id: 'pi',
      invoke: async (config) => {
        toolModes.push(config.toolMode)
        prompts.push(config.prompt)
        return {
          harness: 'pi',
          model: config.model,
          success: true,
          output: toolModes.length === 1 ? 'not json' : validReviewOutput,
          durationMs: toolModes.length,
        }
      },
    }

    const result = await invokeReviewAgent({
      project: createProject(),
      worktreePath: '/tmp/test',
      sessionDir: '/tmp/test/sessions',
      instructions: 'review instructions',
      prompt: 'review prompt',
      changedFiles: [],
      context7ApiKey: null,
      harnesses: { pi: harness },
    })

    expect(result.validatedReview.assessment).toBe('approve')
    expect(toolModes).toEqual([undefined, 'none'])
    expect(prompts[1]).toContain('Final output retry required.')
  })

  it('fails invalid final output for harnesses that cannot disable tools', async () => {
    let calls = 0
    const harness: ReviewAgentHarness = {
      id: 'codex',
      invoke: async (config) => {
        calls += 1
        return {
          harness: 'codex',
          model: config.model,
          success: true,
          output: 'not json',
          durationMs: calls,
        }
      },
    }

    await expect(
      invokeReviewAgent({
        project: createProject({ agent: { harness: 'codex', model: 'gpt-5' } }),
        worktreePath: '/tmp/test',
        sessionDir: '/tmp/test/sessions',
        instructions: 'review instructions',
        prompt: 'review prompt',
        changedFiles: [],
        context7ApiKey: null,
        harnesses: { codex: harness },
      }),
    ).rejects.toThrow(
      'codex review returned invalid final output and does not support no-tool retry',
    )

    expect(calls).toBe(1)
  })

  it('surfaces primary harness execution failure', async () => {
    await expect(
      invokeReviewAgent({
        project: createProject(),
        worktreePath: '/tmp/test',
        sessionDir: '/tmp/test/sessions',
        instructions: 'review instructions',
        prompt: 'review prompt',
        changedFiles: [],
        context7ApiKey: null,
        harnesses: {
          pi: createHarness('pi', [{ success: false, output: '', error: 'timeout' }]),
        },
      }),
    ).rejects.toThrow('pi review failed: timeout')
  })

  it('passes changed files to the primary harness for inspection reporting', async () => {
    let observedChangedFiles: string[] | undefined
    const harness: ReviewAgentHarness = {
      id: 'codex',
      invoke: async (config) => {
        observedChangedFiles = config.changedFiles
        return {
          harness: 'codex',
          model: config.model,
          success: true,
          output: validReviewOutput,
          durationMs: 1,
          inspectedFiles: config.changedFiles,
        }
      },
    }

    await invokeReviewAgent({
      project: createProject({ agent: { harness: 'codex', model: 'gpt-5' } }),
      worktreePath: '/tmp/test',
      sessionDir: '/tmp/test/sessions',
      instructions: 'review instructions',
      prompt: 'review prompt',
      changedFiles: ['src/agents/codex-harness.ts'],
      context7ApiKey: null,
      harnesses: { codex: harness },
    })

    expect(observedChangedFiles).toEqual(['src/agents/codex-harness.ts'])
  })

  it('runs ensemble through the review pipeline without inspection retry when it reports changed files', async () => {
    let calls = 0
    const harness: ReviewAgentHarness = {
      id: 'ensemble',
      invoke: async (config) => {
        calls += 1
        return {
          harness: 'ensemble',
          model: config.model,
          success: true,
          output: validReviewOutput,
          durationMs: 1,
          inspectedFiles: config.changedFiles,
        }
      },
    }

    const result = await invokeReviewAgent({
      project: createProject({
        agent: {
          harness: 'ensemble',
          model: 'gpt-5.5',
        },
      }),
      worktreePath: '/tmp/test',
      sessionDir: '/tmp/test/sessions',
      instructions: 'review instructions',
      prompt: 'review prompt',
      changedFiles: ['src/agents/ensemble-harness.ts'],
      context7ApiKey: null,
      harnesses: { ensemble: harness },
    })

    expect(result.reviewResult.harness).toBe('ensemble')
    expect(result.validatedReview.assessment).toBe('approve')
    expect(result.inspectionResult.inspectedChangedFileCoverage).toBe(1)
    expect(calls).toBe(1)
  })

  it('records comparison harness result through the same harness boundary', async () => {
    const result = await invokeReviewAgent({
      project: createProject({
        comparison: {
          enabled: true,
          harness: 'codex',
          model: 'gpt-5',
          timeout_ms: 300_000,
        },
      }),
      worktreePath: '/tmp/test',
      sessionDir: '/tmp/test/sessions',
      instructions: 'review instructions',
      prompt: 'review prompt',
      changedFiles: [],
      context7ApiKey: null,
      harnesses: {
        pi: createHarness('pi', [{ success: true, output: validReviewOutput }]),
        codex: createHarness('codex', [{ success: true, output: validReviewOutput }]),
      },
    })

    expect(result.comparisonExecutionResult?.harness).toBe('codex')
    expect(result.comparisonExecutionResult?.model).toBe('gpt-5')
  })
})
