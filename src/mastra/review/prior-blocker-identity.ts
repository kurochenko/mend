export type PriorBlockerIdentity = `finding:${string}` | `inline:${string}`

export const buildPriorBlockerIdentity = (
  kind: 'finding' | 'inline',
  providerThreadId: string,
): PriorBlockerIdentity => `${kind}:${providerThreadId}`
