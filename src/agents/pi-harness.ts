import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from '@mariozechner/pi-coding-agent'
import type { AgentSession, ToolDefinition } from '@mariozechner/pi-coding-agent'
import { Type } from '@sinclair/typebox'
import { z } from 'zod'
import { lookupContext7 } from '@/integrations/context7'
import { toErrorMessage } from '@/lib/errors'

export interface PiReviewConfig {
  cwd: string
  sessionDir: string
  model: string
  thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high'
  instructions: string
  prompt: string
  timeoutMs?: number
  context7ApiKey?: string | null
  toolMode?: 'full' | 'none'
  signal?: AbortSignal
}

export interface PiReviewResult {
  success: boolean
  output: string
  sessionFile: string | undefined
  error?: string
}

const DEFAULT_TIMEOUT_MS = 1_200_000

const context7LookupParameters = Type.Object({
  query: Type.String({ minLength: 1 }),
  library: Type.Optional(Type.String({ minLength: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
})

const context7LookupInputSchema = z.object({
  query: z.string().min(1),
  library: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(20).optional(),
})

const createContext7Tool = (apiKey: string): ToolDefinition => ({
  name: 'context7_lookup',
  label: 'Context7 Lookup',
  description: 'Lookup library/framework documentation and best practices from Context7',
  parameters: context7LookupParameters,
  execute: async (_toolCallId, rawParams, signal) => {
    const params = context7LookupInputSchema.parse(rawParams)

    const result = await lookupContext7({
      query: params.query,
      library: params.library,
      limit: params.limit,
      apiKey,
      signal,
    })

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      details: {
        query: result.query,
        library: result.library,
        libraryId: result.libraryId,
        count: result.count,
      },
    }
  },
})

const createReviewCustomTools = (context7ApiKey: string | null | undefined): ToolDefinition[] => {
  if (!context7ApiKey) {
    return []
  }

  return [createContext7Tool(context7ApiKey)]
}

const parseModelString = (model: string): { provider: string; modelId: string } => {
  const slashIndex = model.indexOf('/')
  if (slashIndex === -1) {
    throw new Error(
      `Invalid model string "${model}". Expected "provider/modelId" (e.g. "anthropic/claude-sonnet-4-20250514")`,
    )
  }
  return {
    provider: model.slice(0, slashIndex),
    modelId: model.slice(slashIndex + 1),
  }
}

const withTimeout = <T>(
  promise: Promise<T>,
  ms: number,
  message: string,
  signal?: AbortSignal,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>
  let abortListener: (() => void) | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  const abortPromise = new Promise<never>((_, reject) => {
    abortListener = () => reject(new Error('Pi review aborted'))
    signal?.addEventListener('abort', abortListener, { once: true })
  })
  return Promise.race([promise, timeoutPromise, abortPromise]).finally(() => {
    clearTimeout(timer)
    if (abortListener) {
      signal?.removeEventListener('abort', abortListener)
    }
  })
}

export const invokePiReview = async (config: PiReviewConfig): Promise<PiReviewResult> => {
  if (config.signal?.aborted) {
    return {
      success: false,
      output: '',
      sessionFile: undefined,
      error: 'Pi review aborted before start',
    }
  }

  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const toolMode = config.toolMode ?? 'full'

  const authStorage = AuthStorage.create()
  const modelRegistry = ModelRegistry.create(authStorage)
  const agentDir = getAgentDir()

  const { provider, modelId } = parseModelString(config.model)
  const model = modelRegistry.find(provider, modelId)
  if (!model) {
    return {
      success: false,
      output: '',
      sessionFile: undefined,
      error: `Model not found: ${config.model}`,
    }
  }

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
  })

  const resourceLoader = new DefaultResourceLoader({
    cwd: config.cwd,
    agentDir,
    settingsManager,
    agentsFilesOverride: (discovered) => ({
      agentsFiles: [
        ...discovered.agentsFiles,
        { path: 'review-instructions', content: config.instructions },
      ],
    }),
  })
  await resourceLoader.reload()

  const sessionManager = SessionManager.create(config.cwd, config.sessionDir)

  let session: AgentSession | undefined
  let output = ''
  let abortSession: (() => void) | undefined

  try {
    const result = await createAgentSession({
      cwd: config.cwd,
      model,
      thinkingLevel: config.thinkingLevel ?? 'medium',
      noTools: toolMode === 'none' ? 'all' : undefined,
      customTools: toolMode === 'none' ? [] : createReviewCustomTools(config.context7ApiKey),
      sessionManager,
      settingsManager,
      resourceLoader,
      authStorage,
      modelRegistry,
    })
    session = result.session
    abortSession = () => {
      void session?.abort().catch(() => {})
    }
    config.signal?.addEventListener('abort', abortSession, { once: true })

    session.subscribe((event) => {
      if (event.type === 'message_start') {
        output = ''
      } else if (
        event.type === 'message_update' &&
        event.assistantMessageEvent.type === 'text_delta'
      ) {
        output += event.assistantMessageEvent.delta
      }
    })

    await withTimeout(
      session.prompt(config.prompt),
      timeoutMs,
      `Pi review timed out after ${timeoutMs}ms`,
      config.signal,
    )

    return {
      success: true,
      output,
      sessionFile: session.sessionFile,
    }
  } catch (err) {
    if (session?.isStreaming) {
      await session.abort().catch(() => {})
    }

    return {
      success: false,
      output,
      sessionFile: session?.sessionFile,
      error: toErrorMessage(err),
    }
  } finally {
    if (abortSession) {
      config.signal?.removeEventListener('abort', abortSession)
    }
    session?.dispose()
  }
}
