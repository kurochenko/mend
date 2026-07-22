import { getLatestSuccessfulReviewRun, hasSuccessfulReviewRunForSha } from '@/db/review-runs'

export const hasSuccessfulRunForSha = async (
  projectKey: string,
  mrIid: number,
  sha: string,
): Promise<boolean> => {
  return await hasSuccessfulReviewRunForSha({
    projectKey,
    mrIid,
    sha,
  })
}

export const getLatestSuccessfulRun = async (projectKey: string, mrIid: number) => {
  return await getLatestSuccessfulReviewRun({
    projectKey,
    mrIid,
  })
}
