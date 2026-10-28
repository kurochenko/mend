import type { ProjectConfig } from '@/config'

export interface ReviewTriggerChange {
  action: string
  reviewableAction: boolean
  draft: boolean
}

export const findTriggerIgnoreReason = (
  trigger: ProjectConfig['trigger'],
  change: ReviewTriggerChange,
): string | null => {
  if (!change.reviewableAction) {
    return `action ${JSON.stringify(change.action)}`
  }
  if (trigger.mode === 'label') {
    return 'label trigger not yet implemented'
  }
  if (trigger.mode === 'ready' && change.draft) {
    return `action ${JSON.stringify(change.action)}, draft=${change.draft}`
  }
  return null
}
