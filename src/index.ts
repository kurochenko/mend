import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { MastraServer } from '@mastra/hono'
import { loadConfig } from '@/config'
import { closeDb, initDb } from '@/db/client'
import { recoverOrphanedRuns } from '@/db/review-runs'
import { getServiceRuntimeMode, setServiceRuntimeMode } from '@/db/service-runtime'
import { createMastra } from '@/mastra/index'
import { getLatestDigestAt } from '@/db/improvement-proposals'
import { runImprovementDigest } from '@/mastra/improvements/miner'
import { createEvalsDashboardRoute } from '@/server/evals-dashboard'
import { recoverInterruptedFixBatches, resumeRunnableFixBatches } from '@/server/fix-batch-runner'
import { createImprovementsDashboardRoute } from '@/server/improvements-dashboard'
import { createGitlabWebhookRoute } from '@/server/gitlab-webhook'
import {
  enqueueMrReview,
  recoverPersistedReviewQueue,
  resumePersistedReviewQueue,
} from '@/server/mr-review-queue'
import { createShutdownHandler } from '@/server/shutdown'

const QUEUE_RECONCILE_INTERVAL_MS = 2_000
const IMPROVEMENTS_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000
const IMPROVEMENTS_BOOT_DELAY_MS = 5 * 60 * 1_000
const MS_PER_DAY = 24 * 60 * 60 * 1_000

const startQueueReconciler = (
  config: ReturnType<typeof loadConfig>,
  mastra: ReturnType<typeof createMastra>,
): ReturnType<typeof setInterval> => {
  let running = false

  const tick = async (): Promise<void> => {
    if (running) {
      return
    }

    running = true
    try {
      if ((await getServiceRuntimeMode()) !== 'running') {
        return
      }

      await resumePersistedReviewQueue(config, mastra)
      await resumeRunnableFixBatches(config, mastra, { enqueueMrReview })
    } catch (error) {
      console.error('[queue] reconcile failed:', error)
    } finally {
      running = false
    }
  }

  const timer = setInterval(() => {
    void tick()
  }, QUEUE_RECONCILE_INTERVAL_MS)
  timer.unref?.()
  return timer
}

interface ImprovementsSchedulerHandle {
  bootTimer: ReturnType<typeof setTimeout>
  intervalTimer: ReturnType<typeof setInterval>
}

const startImprovementsScheduler = (
  config: ReturnType<typeof loadConfig>,
): ImprovementsSchedulerHandle | null => {
  if (!config.improvements.enabled) {
    return null
  }

  let running = false

  const tick = async (): Promise<void> => {
    if (running) {
      return
    }

    running = true
    try {
      if ((await getServiceRuntimeMode()) !== 'running') {
        return
      }

      const latestDigestAt = await getLatestDigestAt()
      const thresholdMs = config.improvements.interval_days * MS_PER_DAY
      if (latestDigestAt && Date.now() - latestDigestAt.getTime() < thresholdMs) {
        return
      }

      const summaries = await runImprovementDigest(config)
      for (const summary of summaries) {
        console.log(
          `[improvements] ${summary.projectKey}: examined ${summary.findingsExamined} findings, created ${summary.clustersCreated}, extended ${summary.clustersExtended}`,
        )
      }
    } catch (error) {
      console.error('[improvements] digest failed:', error)
    } finally {
      running = false
    }
  }

  const bootTimer = setTimeout(() => {
    void tick()
  }, IMPROVEMENTS_BOOT_DELAY_MS)
  bootTimer.unref?.()

  const intervalTimer = setInterval(() => {
    void tick()
  }, IMPROVEMENTS_CHECK_INTERVAL_MS)
  intervalTimer.unref?.()

  return { bootTimer, intervalTimer }
}

const main = async () => {
  const config = loadConfig()
  await initDb(config.env.DATABASE_URL)
  const mastra = createMastra(config)

  const orphanCount = await recoverOrphanedRuns()
  if (orphanCount > 0) {
    console.log(`[startup] recovered ${orphanCount} orphaned review run(s)`)
  }

  const recoveredQueueCount = await recoverPersistedReviewQueue()
  if (recoveredQueueCount > 0) {
    console.log(
      `[startup] re-queued ${recoveredQueueCount} interrupted review queue entr${recoveredQueueCount === 1 ? 'y' : 'ies'}`,
    )
  }

  const recoveredFixBatchCount = await recoverInterruptedFixBatches()
  if (recoveredFixBatchCount > 0) {
    console.log(
      `[startup] re-queued ${recoveredFixBatchCount} interrupted fix batch entr${recoveredFixBatchCount === 1 ? 'y' : 'ies'}`,
    )
  }

  const initialMode = await getServiceRuntimeMode()
  if (initialMode === 'draining') {
    await setServiceRuntimeMode('running')
    console.log('[startup] service mode reset from draining to running')
  }

  const app = new Hono()
  app.use('*', cors())

  app.get('/health', (c) => c.json({ status: 'ok' }))
  app.route('/evals', createEvalsDashboardRoute(config))
  app.route('/improvements', createImprovementsDashboardRoute())
  app.route('/webhooks/gitlab', createGitlabWebhookRoute(config, mastra))

  const server = new MastraServer({ app, mastra })
  await server.init()

  console.log(`Mend starting on port ${config.env.PORT}`)
  console.log(`Projects loaded: ${[...config.projects.keys()].join(', ')}`)

  const bunServer = Bun.serve({
    fetch: app.fetch,
    port: config.env.PORT,
  })

  console.log(`Mend listening on http://localhost:${config.env.PORT}`)

  const resumedQueueCount = await resumePersistedReviewQueue(config, mastra)
  if (resumedQueueCount > 0) {
    console.log(
      `[startup] resumed ${resumedQueueCount} persisted review queue entr${resumedQueueCount === 1 ? 'y' : 'ies'}`,
    )
  }

  const resumedFixBatchCount = await resumeRunnableFixBatches(config, mastra, { enqueueMrReview })
  if (resumedFixBatchCount > 0) {
    console.log(
      `[startup] resumed ${resumedFixBatchCount} fix batch entr${resumedFixBatchCount === 1 ? 'y' : 'ies'}`,
    )
  }

  const queueReconcilerTimer = startQueueReconciler(config, mastra)
  const improvementsScheduler = startImprovementsScheduler(config)
  if (improvementsScheduler) {
    console.log(
      `[startup] improvements digest scheduler enabled (every ${config.improvements.interval_days} day(s))`,
    )
  }
  const shutdownHandler = createShutdownHandler({
    setServiceRuntimeMode,
    stopServer: async () => {
      await bunServer.stop(false)
    },
    clearTimers: () => {
      clearInterval(queueReconcilerTimer)
      if (improvementsScheduler) {
        clearTimeout(improvementsScheduler.bootTimer)
        clearInterval(improvementsScheduler.intervalTimer)
      }
    },
    closeDb,
    exit: (code) => process.exit(code),
    log: (message) => console.log(message),
    error: (message, error) => {
      if (error === undefined) {
        console.error(message)
        return
      }

      console.error(message, error)
    },
  })

  process.on('SIGTERM', shutdownHandler)
  process.on('SIGINT', shutdownHandler)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
