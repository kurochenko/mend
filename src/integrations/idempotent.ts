import { toErrorMessage } from '@/lib/errors'

const rethrowWithReconciliationContext = (
  action: string,
  originalError: unknown,
  reconciliationError: unknown,
): never => {
  throw new Error(
    `${action} failed: ${toErrorMessage(originalError)} (reconciliation also failed: ${toErrorMessage(reconciliationError)})`,
  )
}

export const createWithReconciliation = async <T, Listed>(params: {
  action: string
  create: () => Promise<T>
  list: () => Promise<Listed[]>
  match: (items: Listed[]) => T | Promise<T | undefined> | undefined
  attempts?: number
  retryDelayMs?: number
}): Promise<{ value: T; reconciled: boolean }> => {
  const attempts = params.attempts ?? 1
  for (let attempt = 1; ; attempt++) {
    try {
      return { value: await params.create(), reconciled: false }
    } catch (error) {
      let existing: T | undefined
      try {
        existing = await params.match(await params.list())
      } catch (reconciliationError) {
        rethrowWithReconciliationContext(params.action, error, reconciliationError)
      }
      if (existing !== undefined) {
        return { value: existing, reconciled: true }
      }
      if (attempt >= attempts) {
        throw error
      }
      await Bun.sleep((params.retryDelayMs ?? 1_000) * attempt)
    }
  }
}
