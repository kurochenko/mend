import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'

const WORKSPACES_DIR = resolve('workspaces')

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3147),
  DATABASE_URL: z.string().default('postgres://mend:mend@localhost:5434/mend'),
  PROJECTS_CONFIG: z.string().default('mend.yml'),
  DASHBOARD_TOKEN: z.string().min(32, 'DASHBOARD_TOKEN must be at least 32 characters').optional(),
  RECORD_WEBHOOKS: z
    .enum(['0', '1', 'true', 'false'])
    .default('0')
    .transform((v) => v === '1' || v === 'true'),
})

export type EnvConfig = z.infer<typeof envSchema>

const triggerSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('ready') }),
  z.object({ mode: z.literal('all') }),
  z.object({ mode: z.literal('label'), label: z.string().min(1) }),
])

const context7Schema = z.preprocess(
  (value) => value ?? {},
  z.object({
    api_key: z.string().min(1).optional(),
  }),
)

const toolsSchema = z.preprocess(
  (value) => value ?? {},
  z.object({
    context7: context7Schema,
  }),
)

const comparisonSchema = z.preprocess(
  (value) => value ?? { enabled: false },
  z.object({
    enabled: z.boolean().default(false),
    harness: z.enum(['pi', 'codex', 'opencode', 'ensemble']).default('opencode'),
    model: z.string().min(1).optional(),
    thinking_level: z.enum(['off', 'minimal', 'low', 'medium', 'high']).optional(),
    timeout_ms: z.number().int().positive().default(300_000),
  }),
)

const ensembleAgentSchema = z.preprocess(
  (value) => value ?? {},
  z.object({
    finder_harness: z.enum(['pi', 'codex', 'opencode']).default('codex'),
    finder_model: z.string().min(1).default('gpt-5.5'),
    finder_thinking_level: z.enum(['off', 'minimal', 'low', 'medium', 'high']).default('low'),
    finder_timeout_ms: z.number().int().positive().default(300_000),
    verify_enabled: z.boolean().default(true),
    verifier_model: z.string().min(1).default('gpt-5.5'),
    verifier_thinking_level: z.enum(['off', 'minimal', 'low', 'medium', 'high']).default('low'),
    verifier_timeout_ms: z.number().int().positive().default(180_000),
    deep_samples: z.number().int().min(1).max(4).default(2),
    deep_model: z.string().min(1).default('gpt-5.5'),
    deep_timeout_ms: z.number().int().positive().default(1_200_000),
    synthesizer_model: z.string().min(1).default('gpt-5.5'),
    synthesizer_timeout_ms: z.number().int().positive().default(300_000),
  }),
)

const reviewAgentSchema = z.preprocess(
  (value) => value ?? {},
  z.object({
    harness: z.enum(['pi', 'codex', 'opencode', 'ensemble']).default('pi'),
    model: z.string().min(1).optional(),
    thinking_level: z.enum(['off', 'minimal', 'low', 'medium', 'high']).optional(),
    timeout_ms: z.number().int().positive().optional(),
    ensemble: ensembleAgentSchema.optional(),
  }),
)

const reviewMemorySchema = z.preprocess(
  (value) => value ?? {},
  z.object({
    project_scope_usernames: z.array(z.string().min(1)).default([]),
  }),
)

const reviewSchema = z.object({
  llm: z.object({
    model: z.string().min(1),
    thinking_level: z.enum(['off', 'minimal', 'low', 'medium', 'high']).default('medium'),
  }),
  agent: reviewAgentSchema,
  flags: z
    .object({
      structured_findings_post: z.boolean().default(true),
      structural_signals: z.boolean().default(true),
      bug_history: z.boolean().default(true),
      dry_run: z.boolean().default(false),
    })
    .prefault({}),
  comparison: comparisonSchema,
  memory: reviewMemorySchema,
})

const sharedProjectSchema = z.object({
  url: z.string().url(),
  token: z.string().min(1),
  repo_url: z.string().min(1),
  default_branch: z.string().default('main'),
  trigger: triggerSchema.default({ mode: 'ready' }),
  review: reviewSchema,
  tools: toolsSchema,
})

const gitlabProjectSchema = sharedProjectSchema.extend({
  platform: z.literal('gitlab'),
  webhook_secret: z.string().min(1).optional(),
  webhook_signing_token: z
    .string()
    .regex(/^whsec_[A-Za-z0-9+/]+={0,2}$/, 'must be whsec_ followed by a base64 key')
    .transform((token) => Buffer.from(token.slice('whsec_'.length), 'base64'))
    .optional(),
  project_id: z.union([z.number().int().positive(), z.string().min(1)]),
})

const githubProjectSchema = sharedProjectSchema.extend({
  platform: z.literal('github'),
  url: z.string().url().default('https://github.com'),
  webhook_secret: z.string().min(1),
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'repo must match owner/name'),
})

const projectSchema = z
  .discriminatedUnion('platform', [gitlabProjectSchema, githubProjectSchema])
  .refine(
    (project) =>
      project.platform !== 'gitlab' ||
      project.webhook_secret !== undefined ||
      project.webhook_signing_token !== undefined,
    {
      message: 'gitlab projects need webhook_secret or webhook_signing_token',
      path: ['webhook_secret'],
    },
  )

export type GitLabProjectConfig = z.infer<typeof gitlabProjectSchema> & {
  key: string
  clone_path: string
}

export type GitHubProjectConfig = z.infer<typeof githubProjectSchema> & {
  key: string
  clone_path: string
}

export type ProjectConfig = GitLabProjectConfig | GitHubProjectConfig

const improvementsAgentSchema = z.preprocess(
  (value) => value ?? {},
  z.object({
    harness: z.enum(['pi', 'codex']).default('codex'),
    model: z.string().min(1).default('gpt-5.5'),
    thinking_level: z.enum(['off', 'minimal', 'low', 'medium', 'high']).default('low'),
    timeout_ms: z.number().int().positive().default(120_000),
  }),
)

const improvementsSchema = z.preprocess(
  (value) => value ?? {},
  z.object({
    enabled: z.boolean().default(false),
    interval_days: z.number().int().positive().default(7),
    agent: improvementsAgentSchema,
  }),
)

export type ImprovementsConfig = z.infer<typeof improvementsSchema>

const projectsFileSchema = z.object({
  projects: z.record(z.string(), projectSchema),
  improvements: improvementsSchema,
})

export type ProjectsFileConfig = z.infer<typeof projectsFileSchema>

export interface AppConfig {
  env: EnvConfig
  projects: Map<string, ProjectConfig>
  improvements: ImprovementsConfig
}

const resolveEnvRefs = (value: string): string =>
  value.replace(/\$\{([^}]+)}/g, (_match, varName: string) => {
    const resolved = process.env[varName]
    if (resolved === undefined) {
      throw new Error(`Environment variable "${varName}" referenced in config but not set`)
    }
    return resolved
  })

const resolveEnvRefsDeep = (obj: unknown): unknown => {
  if (typeof obj === 'string') {
    return resolveEnvRefs(obj)
  }
  if (Array.isArray(obj)) {
    return obj.map(resolveEnvRefsDeep)
  }
  if (obj !== null && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, resolveEnvRefsDeep(v)]),
    )
  }
  return obj
}

let _config: AppConfig | null = null

export const parseProjectsFileConfig = (parsed: unknown): ProjectsFileConfig =>
  projectsFileSchema.parse(resolveEnvRefsDeep(parsed))

export const parseProjectsFileConfigOrExplain = (
  configPath: string,
  parsed: unknown,
): ProjectsFileConfig => {
  try {
    return parseProjectsFileConfig(parsed)
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(`Invalid ${configPath}:\n${z.prettifyError(error)}`, { cause: error })
    }
    throw error
  }
}

const REMOVED_REVIEW_SETTINGS: Record<string, string> = {
  fix: 'the fix loop was removed; Mend only reviews',
  triage: '@mend triage commands were removed',
  intent: 'the intent classifier was removed',
  template: 'review templates were removed',
}

const REMOVED_REVIEW_FLAGS: Record<string, string> = {
  prompt_templates_v2: 'review templates were removed',
  schema_v2: 'schema v2 is always used',
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

export const findRemovedSettings = (parsed: unknown): string[] =>
  Object.entries(asRecord(asRecord(parsed)?.projects) ?? {}).flatMap(([key, project]) => {
    const review = asRecord(asRecord(project)?.review) ?? {}
    const flags = asRecord(review.flags) ?? {}
    const removed = (
      settings: Record<string, string>,
      present: Record<string, unknown>,
      prefix: string,
    ): string[] =>
      Object.entries(settings)
        .filter(([setting]) => setting in present)
        .map(
          ([setting, reason]) =>
            `projects.${key}.${prefix}${setting} is no longer used and is ignored (${reason}); remove it from your config`,
        )
    return [
      ...removed(REMOVED_REVIEW_SETTINGS, review, 'review.'),
      ...removed(REMOVED_REVIEW_FLAGS, flags, 'review.flags.'),
    ]
  })

export const withoutRemovedSettings = (parsed: unknown): unknown => {
  const projects = asRecord(asRecord(parsed)?.projects)
  if (!projects) {
    return parsed
  }
  return {
    ...asRecord(parsed),
    projects: Object.fromEntries(
      Object.entries(projects).map(([key, project]) => {
        const review = asRecord(asRecord(project)?.review)
        if (!review) {
          return [key, project]
        }
        const keptReview = Object.fromEntries(
          Object.entries(review).filter(([setting]) => !(setting in REMOVED_REVIEW_SETTINGS)),
        )
        const flags = asRecord(review.flags)
        if (flags) {
          keptReview.flags = Object.fromEntries(
            Object.entries(flags).filter(([flag]) => !(flag in REMOVED_REVIEW_FLAGS)),
          )
        }
        return [key, { ...asRecord(project), review: keptReview }]
      }),
    ),
  }
}

export const loadConfig = (): AppConfig => {
  if (_config) {
    return _config
  }

  const env = envSchema.parse(process.env)

  const parsed: unknown = parseYaml(readFileSync(env.PROJECTS_CONFIG, 'utf-8'))
  const validated = parseProjectsFileConfigOrExplain(
    env.PROJECTS_CONFIG,
    withoutRemovedSettings(parsed),
  )
  for (const warning of findRemovedSettings(parsed)) {
    console.warn(`[config] ${env.PROJECTS_CONFIG}: ${warning}`)
  }

  const projects = new Map<string, ProjectConfig>()
  for (const [key, project] of Object.entries(validated.projects)) {
    projects.set(key, {
      ...project,
      key,
      clone_path: resolve(WORKSPACES_DIR, key),
    })
  }

  _config = { env, projects, improvements: validated.improvements }
  return _config
}

export const getConfig = (): AppConfig => {
  if (!_config) {
    throw new Error('Config not loaded. Call loadConfig() first.')
  }
  return _config
}

export const getProject = (key: string): ProjectConfig => {
  const project = getConfig().projects.get(key)
  if (!project) {
    throw new Error(`Unknown project: ${key}`)
  }
  return project
}
