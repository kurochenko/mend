import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'

const WORKSPACES_DIR = resolve('workspaces')

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3147),
  DATABASE_URL: z.string().default('postgres://mend:mend@localhost:5434/mend'),
  PROJECTS_CONFIG: z.string().default('mend.yml'),
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

const fixerAgentSchema = z.preprocess(
  (value) => value ?? {},
  z.object({
    harness: z.literal('codex').default('codex'),
    model: z.string().min(1).optional(),
    thinking_level: z.enum(['off', 'minimal', 'low', 'medium', 'high']).optional(),
    timeout_ms: z.number().int().positive().optional(),
  }),
)

const reviewMemorySchema = z.preprocess(
  (value) => value ?? {},
  z.object({
    project_scope_usernames: z.array(z.string().min(1)).default([]),
  }),
)

const reviewTriageSchema = z.preprocess(
  (value) => value ?? {},
  z.object({
    trusted_usernames: z.array(z.string().min(1)).default([]),
  }),
)

const scalarConfigValueSchema = z.union([z.string(), z.number(), z.boolean()])
const workspaceEnvNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'workspace env name must be a valid shell variable name')

const workspaceEnvValueSchema = z.union([
  scalarConfigValueSchema,
  z.object({ value: scalarConfigValueSchema }),
  z.object({ from_env: z.string().min(1) }),
])

const unsafeMountSources = new Set(['/', '/var/run/docker.sock'])

const isSafeWorkspaceMountSource = (value: string): boolean => {
  const source = resolve(value)
  const home = process.env.HOME ? resolve(process.env.HOME) : null

  if (unsafeMountSources.has(source)) {
    return false
  }

  if (home && (source === home || source.startsWith(`${home}/`))) {
    return false
  }

  return true
}

const workspaceMountSchema = z
  .object({
    source: z.string().min(1),
    target: z
      .string()
      .min(1)
      .refine((value) => value.startsWith('/'), 'mount target must be an absolute container path'),
    read_only: z.boolean().default(true),
  })
  .refine((mount) => isSafeWorkspaceMountSource(mount.source), {
    message: 'mount source must not be a host home directory, root, or Docker socket',
    path: ['source'],
  })

const dockerFixWorkspaceSchema = z.object({
  provider: z.literal('docker'),
  image: z.string().min(1),
  network: z.string().min(1).default('none'),
  env: z.record(workspaceEnvNameSchema, workspaceEnvValueSchema).default({}),
  mounts: z.array(workspaceMountSchema).default([]),
  setup: z.array(z.string().min(1)).default([]),
  checks: z.array(z.string().min(1)).default([]),
})

const reviewFixSchema = z.preprocess(
  (value) => value ?? {},
  z
    .object({
      enabled: z.boolean().default(false),
      automatic: z.boolean().default(false),
      agent: fixerAgentSchema.optional(),
      max_loops: z.number().int().positive().default(3),
      workspace: dockerFixWorkspaceSchema.optional(),
    })
    .superRefine((fix, ctx) => {
      if ((fix.enabled || fix.automatic) && !fix.workspace) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'review.fix.workspace is required when the fix loop is enabled',
          path: ['workspace'],
        })
      }
    }),
)

const reviewSchema = z.object({
  llm: z.object({
    model: z.string().min(1),
    thinking_level: z.enum(['off', 'minimal', 'low', 'medium', 'high']).default('medium'),
  }),
  agent: reviewAgentSchema,
  template: z
    .object({
      prompt: z
        .enum(['auto', 'style_refactor', 'feature', 'bugfix', 'security_sensitive', 'mixed'])
        .default('auto'),
      label_prefix: z.string().default('ai-review:'),
    })
    .default({}),
  flags: z
    .object({
      prompt_templates_v2: z.boolean().default(true),
      schema_v2: z.boolean().default(true),
      structured_findings_post: z.boolean().default(true),
      structural_signals: z.boolean().default(true),
      bug_history: z.boolean().default(true),
      dry_run: z.boolean().default(false),
    })
    .default({}),
  intent: z
    .object({
      harness: z.enum(['pi', 'codex']).default('pi'),
      model: z.string().default('anthropic/claude-sonnet-4-20250514'),
      thinking_level: z.enum(['off', 'minimal', 'low', 'medium', 'high']).default('minimal'),
      timeout_ms: z.number().int().positive().default(45_000),
      failure_policy: z.enum(['mixed', 'fail']).default('mixed'),
    })
    .default({}),
  comparison: comparisonSchema,
  memory: reviewMemorySchema,
  triage: reviewTriageSchema,
  fix: reviewFixSchema,
})

const sharedProjectSchema = z.object({
  url: z.string().url(),
  token: z.string().min(1),
  webhook_secret: z.string().min(1),
  repo_url: z.string().min(1),
  default_branch: z.string().default('main'),
  trigger: triggerSchema.default({ mode: 'ready' }),
  review: reviewSchema,
  tools: toolsSchema,
})

const gitlabProjectSchema = sharedProjectSchema.extend({
  platform: z.literal('gitlab'),
  project_id: z.union([z.number().int().positive(), z.string().min(1)]),
})

const githubProjectSchema = sharedProjectSchema.extend({
  platform: z.literal('github'),
  url: z.string().url().default('https://github.com'),
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'repo must match owner/name'),
})

const projectSchema = z.discriminatedUnion('platform', [gitlabProjectSchema, githubProjectSchema])

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

export const loadConfig = (): AppConfig => {
  if (_config) {
    return _config
  }

  const env = envSchema.parse(process.env)

  const raw = readFileSync(env.PROJECTS_CONFIG, 'utf-8')
  const parsed = parseYaml(raw)
  const validated = parseProjectsFileConfig(parsed)

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
