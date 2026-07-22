export const reviewIntents = [
  'style_refactor',
  'feature',
  'bugfix',
  'security_sensitive',
  'mixed',
] as const

export type ReviewIntent = (typeof reviewIntents)[number]

export const reviewTemplateIds = reviewIntents

export type ReviewTemplateId = (typeof reviewTemplateIds)[number]
