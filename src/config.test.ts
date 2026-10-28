import { describe, expect, test } from 'bun:test'
import {
  findRemovedSettings,
  withoutRemovedSettings,
  parseProjectsFileConfig,
  parseProjectsFileConfigOrExplain,
} from '@/config'

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

const githubProject = {
  platform: 'github',
  url: 'https://github.com',
  token: 'token',
  webhook_secret: 'secret',
  repo: 'org/repo',
  repo_url: 'git@github.com:org/repo.git',
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
  test('allows a gitlab project with only a webhook signing token', () => {
    const { webhook_secret: _secret, ...signedProject } = baseProject
    const config = parseProjectsFileConfig({
      projects: {
        app: { ...signedProject, webhook_signing_token: 'whsec_dGVzdA==' },
      },
    })

    const project = config.projects.app
    expect(project?.platform === 'gitlab' && project.webhook_signing_token).toEqual(
      Buffer.from('test'),
    )
  })

  test.each(['whsec_', 'whsec_not base64!', 'whsec_dGVzdA==\n'])(
    'rejects a malformed webhook signing token %p',
    (signingToken) => {
      expect(() =>
        parseProjectsFileConfig({
          projects: { app: { ...baseProject, webhook_signing_token: signingToken } },
        }),
      ).toThrow('must be whsec_ followed by a base64 key')
    },
  )

  test('rejects a gitlab project without a webhook secret or signing token', () => {
    const { webhook_secret: _secret, ...unsignedProject } = baseProject

    expect(() => parseProjectsFileConfig({ projects: { app: unsignedProject } })).toThrow(
      'gitlab projects need webhook_secret or webhook_signing_token',
    )
  })

  test('requires a webhook secret for github projects', () => {
    const { webhook_secret: _secret, ...unsignedProject } = githubProject

    expect(() => parseProjectsFileConfig({ projects: { app: unsignedProject } })).toThrow()
  })

  test('applies review defaults for a minimal project config', () => {
    const config = parseProjectsFileConfig({ projects: { app: baseProject } })

    expect(config.projects.app?.review.flags).toEqual({
      structured_findings_post: true,
      structural_signals: true,
      bug_history: true,
      dry_run: false,
    })
  })

  test('ignores fix loop and triage settings left over from older configs', () => {
    const config = parseProjectsFileConfig({
      projects: {
        app: {
          ...baseProject,
          review: {
            ...baseProject.review,
            triage: { trusted_usernames: ['someone'] },
            fix: { enabled: true, workspace: { provider: 'docker', image: 'oven/bun:1.3.0' } },
          },
        },
      },
    })

    expect(config.projects.app?.review).not.toHaveProperty('fix')
    expect(config.projects.app?.review).not.toHaveProperty('triage')
  })

  test('lists removed settings so startup can warn about them', () => {
    expect(
      findRemovedSettings({
        projects: {
          app: {
            review: {
              fix: { enabled: true },
              triage: {},
              intent: { harness: 'codex' },
              template: { prompt: 'auto' },
              flags: { prompt_templates_v2: true, schema_v2: true },
            },
          },
          other: { review: { llm: { model: 'm' } } },
        },
      }),
    ).toEqual([
      'projects.app.review.fix is no longer used and is ignored (the fix loop was removed; Mend only reviews); remove it from your config',
      'projects.app.review.triage is no longer used and is ignored (@mend triage commands were removed); remove it from your config',
      'projects.app.review.intent is no longer used and is ignored (the intent classifier was removed); remove it from your config',
      'projects.app.review.template is no longer used and is ignored (review templates were removed); remove it from your config',
      'projects.app.review.flags.prompt_templates_v2 is no longer used and is ignored (review templates were removed); remove it from your config',
      'projects.app.review.flags.schema_v2 is no longer used and is ignored (schema v2 is always used); remove it from your config',
    ])
    expect(findRemovedSettings(null)).toEqual([])
  })

  test('drops removed settings before env references inside them are resolved', () => {
    const config = parseProjectsFileConfig(
      withoutRemovedSettings({
        projects: {
          app: {
            ...baseProject,
            review: {
              ...baseProject.review,
              fix: { workspace: { env: { TOKEN: '${MEND_REMOVED_SETTING_VAR}' } } },
              flags: { schema_v2: '${MEND_REMOVED_SETTING_VAR}' },
            },
          },
        },
      }),
    )

    expect(config.projects.app?.review).not.toHaveProperty('fix')
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

  test('explains invalid config with the file name and field path', () => {
    expect(() =>
      parseProjectsFileConfigOrExplain('mend.yml', {
        projects: { app: { ...baseProject, platform: 'github', repo: 'not-a-repo' } },
      }),
    ).toThrow(/^Invalid mend\.yml:\n[\s\S]*→ at projects\.app/)
  })

  test('parses github project configs', () => {
    const config = parseProjectsFileConfig({
      projects: {
        app: githubProject,
      },
    })

    const project = config.projects.app
    expect(project?.platform).toBe('github')
    if (project?.platform !== 'github') {
      throw new Error('expected github project')
    }
    expect(project.url).toBe('https://github.com')
    expect(project.repo).toBe('org/repo')
    expect(project.review.flags.bug_history).toBe(true)
  })

  test('requires github repo', () => {
    const { repo: _repo, ...withoutRepo } = githubProject
    expect(() =>
      parseProjectsFileConfig({
        projects: {
          app: withoutRepo,
        },
      }),
    ).toThrow()
  })

  test('rejects bad github repo format', () => {
    expect(() =>
      parseProjectsFileConfig({
        projects: {
          app: {
            ...githubProject,
            repo: 'org/repo/extra',
          },
        },
      }),
    ).toThrow('repo must match owner/name')
  })
})
