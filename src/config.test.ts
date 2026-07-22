import { describe, expect, test } from 'bun:test'
import { parseProjectsFileConfig } from '@/config'

const baseProject = {
  platform: 'gitlab',
  url: 'https://gitlab.com',
  token: 'token',
  webhook_secret: 'secret',
  project_id: 123,
  repo_url: 'git@gitlab.com:org/repo.git',
  default_branch: 'main',
  trigger: { mode: 'ready' },
  tools: {},
  review: {
    llm: {
      model: 'gpt-5',
      thinking_level: 'medium',
    },
  },
}

describe('parseProjectsFileConfig', () => {
  test('keeps fixer workspace optional for existing project configs', () => {
    const config = parseProjectsFileConfig({
      projects: {
        app: baseProject,
      },
    })

    expect(config.projects.app?.review.fix.workspace).toBeUndefined()
    expect(config.projects.app?.review.fix.enabled).toBe(false)
    expect(config.projects.app?.review.fix.automatic).toBe(false)
    expect(config.projects.app?.review.fix.max_loops).toBe(3)
    expect(config.projects.app?.review.intent.harness).toBe('pi')
    expect(config.projects.app?.review.flags.bug_history).toBe(true)
  })

  test('parses codex intent classifier harness', () => {
    const config = parseProjectsFileConfig({
      projects: {
        app: {
          ...baseProject,
          review: {
            ...baseProject.review,
            intent: {
              harness: 'codex',
              model: 'gpt-5-mini',
              thinking_level: 'minimal',
              timeout_ms: 30_000,
              failure_policy: 'mixed',
            },
          },
        },
      },
    })

    expect(config.projects.app?.review.intent).toEqual({
      harness: 'codex',
      model: 'gpt-5-mini',
      thinking_level: 'minimal',
      timeout_ms: 30_000,
      failure_policy: 'mixed',
    })
  })

  test('parses ensemble review harness configuration with defaults', () => {
    const config = parseProjectsFileConfig({
      projects: {
        app: {
          ...baseProject,
          review: {
            ...baseProject.review,
            agent: {
              harness: 'ensemble',
              ensemble: {},
            },
            comparison: {
              enabled: true,
              harness: 'ensemble',
            },
          },
        },
      },
    })

    expect(config.projects.app?.review.agent.harness).toBe('ensemble')
    expect(config.projects.app?.review.agent.ensemble).toEqual({
      finder_harness: 'codex',
      finder_model: 'gpt-5.5',
      finder_thinking_level: 'low',
      finder_timeout_ms: 300_000,
      verify_enabled: true,
      verifier_model: 'gpt-5.5',
      verifier_thinking_level: 'low',
      verifier_timeout_ms: 180_000,
      deep_samples: 2,
      deep_model: 'gpt-5.5',
      deep_timeout_ms: 1_200_000,
      synthesizer_model: 'gpt-5.5',
      synthesizer_timeout_ms: 300_000,
    })
    expect(config.projects.app?.review.comparison.harness).toBe('ensemble')
  })

  test('requires workspace when fix loop is enabled', () => {
    expect(() =>
      parseProjectsFileConfig({
        projects: {
          app: {
            ...baseProject,
            review: {
              ...baseProject.review,
              fix: { enabled: true },
            },
          },
        },
      }),
    ).toThrow('review.fix.workspace is required')
  })

  test('rejects unsafe fixer workspace mounts', () => {
    expect(() =>
      parseProjectsFileConfig({
        projects: {
          app: {
            ...baseProject,
            review: {
              ...baseProject.review,
              fix: {
                enabled: true,
                workspace: {
                  provider: 'docker',
                  image: 'oven/bun:1.3.0',
                  mounts: [{ source: process.env.HOME ?? '/', target: '/host-home' }],
                },
              },
            },
          },
        },
      }),
    ).toThrow('mount source must not be a host home directory')
  })

  test('parses docker fixer workspace configuration', () => {
    const config = parseProjectsFileConfig({
      projects: {
        app: {
          ...baseProject,
          review: {
            ...baseProject.review,
            fix: {
              agent: {
                harness: 'codex',
                model: 'gpt-5.5',
                thinking_level: 'medium',
                timeout_ms: 1_200_000,
              },
              enabled: true,
              automatic: true,
              max_loops: 4,
              workspace: {
                provider: 'docker',
                image: 'oven/bun:1.3.0',
                env: {
                  TOKEN: { from_env: 'APP_TOKEN' },
                  MODE: { value: 'test' },
                  FLAG: true,
                },
                mounts: [{ source: '/tmp/cache', target: '/cache' }],
                setup: ['bun install'],
                checks: ['bun run check'],
              },
            },
          },
        },
      },
    })

    const workspace = config.projects.app?.review.fix.workspace
    expect(config.projects.app?.review.fix.agent).toEqual({
      harness: 'codex',
      model: 'gpt-5.5',
      thinking_level: 'medium',
      timeout_ms: 1_200_000,
    })
    expect(config.projects.app?.review.fix.enabled).toBe(true)
    expect(config.projects.app?.review.fix.automatic).toBe(true)
    expect(config.projects.app?.review.fix.max_loops).toBe(4)
    expect(config.projects.app?.review.triage.trusted_usernames).toEqual([])
    expect(workspace).toEqual({
      provider: 'docker',
      image: 'oven/bun:1.3.0',
      network: 'none',
      env: {
        TOKEN: { from_env: 'APP_TOKEN' },
        MODE: { value: 'test' },
        FLAG: true,
      },
      mounts: [{ source: '/tmp/cache', target: '/cache', read_only: true }],
      setup: ['bun install'],
      checks: ['bun run check'],
    })
  })

  test('rejects invalid fixer workspace env names', () => {
    expect(() =>
      parseProjectsFileConfig({
        projects: {
          app: {
            ...baseProject,
            review: {
              ...baseProject.review,
              fix: {
                enabled: true,
                workspace: {
                  provider: 'docker',
                  image: 'oven/bun:1.3.0',
                  env: {
                    'BAD-NAME': 'value',
                  },
                },
              },
            },
          },
        },
      }),
    ).toThrow('workspace env name must be a valid shell variable name')
  })
})
