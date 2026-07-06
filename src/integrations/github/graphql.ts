import type { GitHubProjectConfig } from '@/config'
import { githubGraphqlBase } from '@/integrations/github/transport'

interface GitHubGraphqlResponse<T> {
  data?: T
  errors?: Array<{ message: string }>
}

export const githubGraphql = async <T>(
  project: GitHubProjectConfig,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> => {
  const res = await fetch(githubGraphqlBase(project), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${project.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  })

  if (!res.ok) {
    throw new Error(`GitHub GraphQL ${res.status}: ${await res.text()}`)
  }

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
