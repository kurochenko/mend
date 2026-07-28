import type { GitHubProjectConfig } from '@/config'
import { githubGraphqlBase, githubRequest } from '@/integrations/github/transport'

interface GitHubGraphqlResponse<T> {
  data?: T
  errors?: Array<{ message: string }>
}

export const githubGraphql = async <T>(
  project: GitHubProjectConfig,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> => {
  const res = await githubRequest({
    project,
    url: githubGraphqlBase(project),
    label: 'GraphQL',
    init: {
      method: 'POST',
      body: JSON.stringify({ query, variables }),
    },
  })

  const json = (await res.json()) as GitHubGraphqlResponse<T>
  if (json.errors && json.errors.length > 0) {
    throw new Error(
      `GitHub GraphQL errors: ${json.errors.map((error) => error.message).join('; ')}`,
    )
  }
  if (!json.data) {
    throw new Error('GitHub GraphQL response missing data')
  }

  return json.data
}
