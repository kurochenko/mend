import { Mastra } from '@mastra/core'
import { PostgresStore } from '@mastra/pg'
import type { AppConfig } from '@/config'
import { mrReviewWorkflow } from '@/mastra/workflows/mr-review'

export const createMastra = (config: AppConfig) => {
  const storage = new PostgresStore({
    id: 'mend',
    connectionString: config.env.DATABASE_URL,
  })

  const mastra = new Mastra({
    workflows: {
      'mr-review': mrReviewWorkflow,
    },
    storage,
  })

  return mastra
}
