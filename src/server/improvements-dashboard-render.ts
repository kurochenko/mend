import type { ImprovementProposalRecord } from '@/db/improvement-proposals'

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')

const formatDate = (value: Date | string | null): string => {
  if (!value) {
    return '-'
  }
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    return '-'
  }
  return date.toISOString().replace('T', ' ').replace('Z', ' UTC')
}

interface EvidenceEntry {
  findingId: string
  path: string | null
  excerpt: string
}

const asEvidence = (value: unknown): EvidenceEntry[] => {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') {
      return []
    }
    const record = item as Record<string, unknown>
    const findingId = typeof record.findingId === 'string' ? record.findingId : ''
    const path = typeof record.path === 'string' ? record.path : null
    const excerpt = typeof record.excerpt === 'string' ? record.excerpt : ''
    if (!findingId) {
      return []
    }
    return [{ findingId, path, excerpt }]
  })
}

const renderEvidence = (value: unknown): string => {
  const entries = asEvidence(value)
  if (entries.length === 0) {
    return '<div class="muted">No evidence</div>'
  }
  const lines = entries.map(
    (entry) =>
      `<li><code>${escapeHtml(entry.path ?? '(project)')}</code> ${escapeHtml(entry.excerpt || '-')}</li>`,
  )
  return `<details><summary>${entries.length} evidence entries</summary><ul>${lines.join('')}</ul></details>`
}

const renderProposalRow = (proposal: ImprovementProposalRecord): string => {
  const statusClass = `status-${proposal.status}`
  return `
    <tr>
      <td>
        <div><span class="status ${statusClass}">${escapeHtml(proposal.status)}</span> <span class="pill">${escapeHtml(proposal.proposalType)}</span></div>
        <div><strong>occurrences:</strong> ${proposal.occurrenceCount}</div>
        <div><strong>slug:</strong> <code>${escapeHtml(proposal.clusterSlug)}</code></div>
        <div><strong>id:</strong> <code>${escapeHtml(proposal.id)}</code></div>
        <div><strong>last digest:</strong> ${escapeHtml(formatDate(proposal.lastDigestAt))}</div>
      </td>
      <td>
        <div><strong>${escapeHtml(proposal.title)}</strong></div>
        <details><summary>proposed change</summary><pre>${escapeHtml(proposal.body)}</pre></details>
        ${renderEvidence(proposal.evidence)}
      </td>
    </tr>
  `
}

const renderProjectSection = (
  projectKey: string,
  proposals: ImprovementProposalRecord[],
): string => {
  const rows = proposals.map(renderProposalRow).join('')
  return `
    <section class="project-block">
      <h2>Project: <code>${escapeHtml(projectKey)}</code> <span class="muted">(${proposals.length} proposals)</span></h2>
      <table>
        <thead>
          <tr>
            <th>Proposal</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </section>
  `
}

export const renderImprovementsDashboardPage = (params: {
  proposals: ImprovementProposalRecord[]
}): string => {
  const byProject = new Map<string, ImprovementProposalRecord[]>()
  for (const proposal of params.proposals) {
    const current = byProject.get(proposal.projectKey)
    if (current) {
      current.push(proposal)
    } else {
      byProject.set(proposal.projectKey, [proposal])
    }
  }

  const projectKeys = [...byProject.keys()].sort((a, b) => a.localeCompare(b))
  const projectSections =
    projectKeys.length > 0
      ? projectKeys
          .map((projectKey) => renderProjectSection(projectKey, byProject.get(projectKey) ?? []))
          .join('')
      : '<p>No improvement proposals yet.</p>'

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Mend Improvement Proposals</title>
    <style>
      :root { color-scheme: light; }
      body { margin: 0; font-family: Menlo, Monaco, Consolas, "Liberation Mono", monospace; background: #f4f6f8; color: #0f172a; }
      main { padding: 20px; }
      h1, h2, h3 { margin: 0 0 10px; }
      h1 { font-size: 24px; }
      h2 { margin-top: 28px; font-size: 20px; }
      table { width: 100%; border-collapse: collapse; table-layout: fixed; background: #fff; border: 1px solid #d5dbe3; }
      th, td { border: 1px solid #d5dbe3; vertical-align: top; text-align: left; padding: 8px; font-size: 12px; line-height: 1.35; }
      th { background: #eef2f7; }
      td > div { margin-bottom: 4px; }
      .muted { color: #64748b; }
      .status { display: inline-block; padding: 2px 6px; border-radius: 999px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.03em; }
      .status-proposed { background: #dbeafe; color: #1e3a8a; }
      .status-accepted { background: #dcfce7; color: #166534; }
      .status-dismissed { background: #fee2e2; color: #991b1b; }
      .status-shipped { background: #ede9fe; color: #5b21b6; }
      .pill { display: inline-block; padding: 1px 6px; border-radius: 999px; background: #e2e8f0; margin-right: 4px; }
      .project-block { margin-bottom: 30px; }
      summary { cursor: pointer; }
      ul { margin: 6px 0 0 18px; padding: 0; }
      li { margin-bottom: 4px; }
      pre { white-space: pre-wrap; word-break: break-word; background: #0b1220; color: #dbeafe; padding: 8px; border-radius: 6px; max-height: 240px; overflow: auto; }
      @media (max-width: 1100px) {
        table, thead, tbody, th, td, tr { display: block; }
        thead { display: none; }
        tr { margin-bottom: 14px; border: 1px solid #d5dbe3; }
        td { border: 0; border-bottom: 1px solid #e2e8f0; }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Mend Improvement Proposals</h1>
      <div class="muted">Read-only. Accept or dismiss proposals with <code>bun run improvements</code>.</div>
      ${projectSections}
    </main>
  </body>
</html>`
}
