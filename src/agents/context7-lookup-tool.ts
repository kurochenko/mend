import { Type } from '@sinclair/typebox'
import { z } from 'zod'
import { lookupContext7 } from '@/integrations/context7'
import type { Context7LookupResult } from '@/integrations/context7'

export const CONTEXT7_LOOKUP_TOOL_NAME = 'context7_lookup'

export const CONTEXT7_LOOKUP_DESCRIPTION =
  'Lookup library/framework documentation and best practices from Context7'

export const context7LookupParameters = Type.Object({
  query: Type.String({ minLength: 1 }),
  library: Type.Optional(Type.String({ minLength: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
})

const context7LookupInputSchema = z.object({
  query: z.string().min(1),
  library: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(20).optional(),
})

export const runContext7Lookup = async (
  rawParams: unknown,
  apiKey: string | undefined,
  signal?: AbortSignal,
): Promise<Context7LookupResult> => {
  const params = context7LookupInputSchema.parse(rawParams)
  return await lookupContext7({
    query: params.query,
    library: params.library,
    limit: params.limit,
    apiKey,
    signal,
  })
}
