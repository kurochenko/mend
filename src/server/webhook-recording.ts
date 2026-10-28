import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const FIXTURES_DIR = resolve('fixtures', 'webhooks')
const RECORDING_CONCURRENCY = 2
const MAX_PENDING_RECORDINGS = 200

interface QueuedRecording {
  projectKey: string
  eventKind: string
  payload: unknown
}

const recordingQueue: QueuedRecording[] = []
let recordingWorkers = 0

const writeRecordedPayload = async ({
  projectKey,
  eventKind,
  payload,
}: QueuedRecording): Promise<void> => {
  await mkdir(FIXTURES_DIR, { recursive: true })
  const filename = `${projectKey}-${eventKind}-${Date.now()}-${crypto.randomUUID()}.json`
  await writeFile(resolve(FIXTURES_DIR, filename), JSON.stringify(payload, null, 2))
  console.log(`[webhook] recorded payload to fixtures/webhooks/${filename}`)
}

const drainRecordingQueue = (): void => {
  while (recordingWorkers < RECORDING_CONCURRENCY && recordingQueue.length > 0) {
    const next = recordingQueue.shift()
    if (!next) {
      return
    }

    recordingWorkers++
    void writeRecordedPayload(next)
      .catch((error) => {
        console.error(`[webhook] failed to record payload for ${next.projectKey}:`, error)
      })
      .finally(() => {
        recordingWorkers--
        drainRecordingQueue()
      })
  }
}

export const recordWebhookPayload = (recording: QueuedRecording): void => {
  if (recordingQueue.length >= MAX_PENDING_RECORDINGS) {
    console.warn(
      `[webhook] skipping payload recording for ${recording.projectKey}: queue is full (${recordingQueue.length})`,
    )
    return
  }

  recordingQueue.push(recording)
  drainRecordingQueue()
}
