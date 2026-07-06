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
}): Promise<{ value: T; reconciled: boolean }> => {
  try {
    return { value: await params.create(), reconciled: false }
  } catch (error) {
    try {
      const listed = await params.list()
      const existing = await params.match(listed)
      if (existing !== undefined) {
        return { value: existing, reconciled: true }
      }

      throw error
    } catch (reconciliationError) {
      if (reconciliationError === error) {
        throw error
      }

      rethrowWithReconciliationContext(params.action, error, reconciliationError)
    }
  }

  throw new Error('unreachable')
}
