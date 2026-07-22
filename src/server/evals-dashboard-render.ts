import type { ReviewRunRecord } from '@/db/review-runs'
import { asRecord } from '@/lib/json'

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')

const shortSha = (sha: string | null | undefined): string => {
  if (!sha) {
    return '-'
  }
  return sha.slice(0, 8)
}

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

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

const getString = (record: Record<string, unknown>, key: string): string => {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

const getNumber = (record: Record<string, unknown>, key: string): number | null => {
  const value = record[key]
  return typeof value === 'number' ? value : null
}

const getStringArray = (record: Record<string, unknown>, key: string): string[] =>
  asArray(record[key]).filter((item): item is string => typeof item === 'string')

const getNumberLike = (record: Record<string, unknown>, key: string): number | null => {
  const direct = getNumber(record, key)
  if (direct !== null) {
    return direct
  }
  const value = record[key]
  if (typeof value !== 'string') {
    return null
  }
  const normalized = value.trim()
  if (!/^\d+$/.test(normalized)) {
    return null
  }
  const parsed = Number(normalized)
  return parsed
}

const getFirstNumber = (record: Record<string, unknown>, keys: string[]): number | null => {
  for (const key of keys) {
    const value = getNumber(record, key)
    if (value !== null) {
      return value
    }
  }
  return null
}

const reviewModeLabel = (mode: string): string => (mode === 'update' ? 'consecutive' : 'initial')

const renderFindings = (result: Record<string, unknown>): string => {
  const findings = asArray(result.findings)
  if (findings.length === 0) {
    return '<div class="muted">No findings</div>'
  }

  const lines = findings.map((item) => {
    const finding = asRecord(item)
    const id = escapeHtml(getString(finding, 'id'))
    const category = escapeHtml(getString(finding, 'category'))
    const severity = escapeHtml(getString(finding, 'severity'))
    const title = escapeHtml(getString(finding, 'title'))
    return `<li><code>${id || '-'}</code> <span class="pill">${category || '-'}</span> <span class="pill">${severity || '-'}</span> ${title || '-'}</li>`
  })

  return `<details><summary>${findings.length} findings</summary><ul>${lines.join('')}</ul></details>`
}

const renderInlineComments = (result: Record<string, unknown>): string => {
  const comments = asArray(result.inlineComments)
  if (comments.length === 0) {
    return '<div class="muted">No inline comments</div>'
  }

  const lines = comments.map((item) => {
    const comment = asRecord(item)
    const file = escapeHtml(getString(comment, 'file'))
    const line = getNumber(comment, 'line')
    const severity = escapeHtml(getString(comment, 'severity'))
    const body = escapeHtml(getString(comment, 'body'))
    return `<li><code>${file || '-'}</code>:${line ?? '-'} <span class="pill">${severity || '-'}</span> ${body || '-'}</li>`
  })

  return `<details><summary>${comments.length} inline comments</summary><ul>${lines.join('')}</ul></details>`
}

const formatSeconds = (value: number | null): string => {
  if (value === null) {
    return '-'
  }
  return `${Math.round(value / 1000)}s`
}

const formatPercent = (value: number | null): string => {
  if (value === null) {
    return '-'
  }
  return `${(value * 100).toFixed(1)}%`
}

const getOverlapStats = (
  left: Set<string>,
  right: Set<string>,
): {
  overlap: number
  overlapPercent: number | null
} => {
  let overlap = 0
  for (const value of left) {
    if (right.has(value)) {
      overlap += 1
    }
  }
  const unionCount = left.size + right.size - overlap
  if (unionCount === 0) {
    return {
      overlap,
      overlapPercent: null,
    }
  }
  return {
    overlap,
    overlapPercent: overlap / unionCount,
  }
}

const getFindingFiles = (finding: Record<string, unknown>): string[] => {
  const files = new Set<string>()
  for (const file of getStringArray(finding, 'files')) {
    if (file) {
      files.add(file)
    }
  }
  const evidence = asArray(finding.evidence)
  for (const item of evidence) {
    const record = asRecord(item)
    if (getString(record, 'type') !== 'file_line') {
      continue
    }
    const file = getString(record, 'file')
    if (file) {
      files.add(file)
    }
  }
  if (files.size === 0) {
    return ['-']
  }
  return [...files]
}

const getFindingCategoryFilePairs = (review: Record<string, unknown>): Set<string> => {
  const findings = asArray(review.findings)
  const pairs = new Set<string>()
  for (const item of findings) {
    const finding = asRecord(item)
    const category = getString(finding, 'category') || '-'
    for (const file of getFindingFiles(finding)) {
      pairs.add(`${category}\u0000${file}`)
    }
  }
  return pairs
}

const getInlineFileLinePairs = (review: Record<string, unknown>): Set<string> => {
  const comments = asArray(review.inlineComments)
  const pairs = new Set<string>()
  for (const item of comments) {
    const comment = asRecord(item)
    const file = getString(comment, 'file') || '-'
    const line = getNumberLike(comment, 'line')
    pairs.add(`${file}\u0000${line === null ? '-' : String(line)}`)
  }
  return pairs
}

const getCoverage = (value: unknown): number | null => {
  const result = asRecord(value)
  const diagnostics = asRecord(result.reviewDiagnostics)
  const inspection = asRecord(diagnostics.inspection)
  return getNumber(inspection, 'changedFileCoverage')
}

const getComparisonCoverage = (comparison: Record<string, unknown>): number | null => {
  const inspection = asRecord(comparison.inspection)
  const direct = getNumber(inspection, 'changedFileCoverage')
  if (direct !== null) {
    return direct
  }
  const wrapped = asRecord(inspection.changedFileCoverage)
  return getNumber(wrapped, 'value')
}

const renderTokenUsage = (comparison: Record<string, unknown>): string => {
  const tokenUsage = asRecord(comparison.tokenUsage)
  const entries: Array<{ key: string; value: number }> = []
  const pushIfPresent = (key: string, value: number | null): void => {
    if (value === null) {
      return
    }
    entries.push({ key, value })
  }

  pushIfPresent('input', getFirstNumber(tokenUsage, ['input', 'inputTokens', 'promptTokens']))
  pushIfPresent(
    'output',
    getFirstNumber(tokenUsage, ['output', 'outputTokens', 'completionTokens']),
  )
  pushIfPresent('cacheRead', getFirstNumber(tokenUsage, ['cacheRead', 'cacheReadTokens']))
  pushIfPresent('cacheWrite', getFirstNumber(tokenUsage, ['cacheWrite', 'cacheWriteTokens']))
  pushIfPresent('total', getFirstNumber(tokenUsage, ['total', 'totalTokens']))

  const cost = getFirstNumber(tokenUsage, ['cost', 'costUsd'])
  if (cost !== null) {
    entries.push({ key: 'cost', value: cost })
  } else {
    const costRecord = asRecord(tokenUsage.cost)
    const nestedCost = getFirstNumber(costRecord, ['total', 'usd'])
    pushIfPresent('cost', nestedCost)
  }

  if (entries.length === 0) {
    return '<div class="muted">token/cost: -</div>'
  }

  const content = entries
    .map(
      (entry) =>
        `${escapeHtml(entry.key)}=${entry.key === 'cost' ? `$${entry.value.toFixed(4)}` : entry.value}`,
    )
    .join(' ')
  return `<div><strong>token/cost:</strong> ${content}</div>`
}

const renderComparisonSummary = (run: ReviewRunRecord, result: Record<string, unknown>): string => {
  const comparison = asRecord(run.comparisonResult)
  const status = getString(comparison, 'status')
  const harness = getString(comparison, 'harness') || '-'
  const duration = getNumber(comparison, 'durationMs')
  if (!status) {
    return '<div><strong>comparison:</strong> <span class="muted">none</span></div>'
  }
  if (status === 'failed') {
    return `<div><strong>comparison:</strong> <span class="comparison-failed">failed</span> (${escapeHtml(harness)})</div>`
  }
  if (status !== 'success') {
    return `<div><strong>comparison:</strong> <span class="muted">unsupported status</span> (${escapeHtml(harness)})</div>`
  }

  const review = asRecord(comparison.review)
  const primaryAssessment = getString(result, 'assessment')
  const comparisonAssessment = getString(review, 'assessment')
  if (!comparisonAssessment) {
    return `<div><strong>comparison:</strong> <span class="muted">partial</span> (${escapeHtml(harness)}, ${escapeHtml(formatSeconds(duration))})</div>`
  }
  const match =
    primaryAssessment && comparisonAssessment && primaryAssessment === comparisonAssessment
  const verdict = match ? 'match' : 'mismatch'

  return `<div><strong>comparison:</strong> <span class="comparison-${verdict}">${verdict}</span> (${escapeHtml(harness)}, ${escapeHtml(formatSeconds(duration))})</div>`
}

const renderComparison = (run: ReviewRunRecord, result: Record<string, unknown>): string => {
  const comparison = asRecord(run.comparisonResult)
  const status = getString(comparison, 'status')
  const harness = getString(comparison, 'harness') || '-'
  const comparisonDuration = getNumber(comparison, 'durationMs')

  if (!status) {
    return '<div class="comparison"><div class="muted">No comparison result</div></div>'
  }

  if (status === 'failed') {
    const error = getString(comparison, 'error') || '-'
    return `<div class="comparison"><div><strong>comparison:</strong> <span class="comparison-failed">failed</span></div><div><strong>harness:</strong> <code>${escapeHtml(harness)}</code></div><div><strong>duration:</strong> ${comparisonDuration ?? '-'} ms</div><div class="error"><strong>error:</strong> ${escapeHtml(error)}</div></div>`
  }

  if (status !== 'success') {
    return `<div class="comparison"><div><strong>comparison:</strong> <span class="muted">unsupported status</span></div><div><strong>harness:</strong> <code>${escapeHtml(harness)}</code></div><div><strong>duration:</strong> ${comparisonDuration ?? '-'} ms</div></div>`
  }

  const comparisonReview = asRecord(comparison.review)
  const comparisonAssessment = getString(comparisonReview, 'assessment')
  if (!comparisonAssessment) {
    return `<div class="comparison"><div><strong>comparison:</strong> <span class="muted">partial</span></div><div><strong>harness:</strong> <code>${escapeHtml(harness)}</code></div><div><strong>duration:</strong> ${comparisonDuration ?? '-'} ms</div><div class="muted">No review payload in comparison result</div></div>`
  }

  const primaryAssessment = getString(result, 'assessment')
  const assessmentsMatch = primaryAssessment && primaryAssessment === comparisonAssessment
  const primaryFindings = asArray(result.findings)
  const comparisonFindings = asArray(comparisonReview.findings)
  const primaryInlineComments = asArray(result.inlineComments)
  const comparisonInlineComments = asArray(comparisonReview.inlineComments)
  const findingOverlap = getOverlapStats(
    getFindingCategoryFilePairs(result),
    getFindingCategoryFilePairs(comparisonReview),
  )
  const inlineOverlap = getOverlapStats(
    getInlineFileLinePairs(result),
    getInlineFileLinePairs(comparisonReview),
  )
  const primaryCoverage = getCoverage(result)
  const comparisonCoverage = getComparisonCoverage(comparison)

  return `<div class="comparison"><div><strong>comparison:</strong> <span class="comparison-${assessmentsMatch ? 'match' : 'mismatch'}">${assessmentsMatch ? 'match' : 'mismatch'}</span> <span class="muted">(${escapeHtml(harness)})</span></div><div><strong>assessment:</strong> <code>${escapeHtml(primaryAssessment || '-')}</code> vs <code>${escapeHtml(comparisonAssessment || '-')}</code></div><div><strong>findings count:</strong> ${primaryFindings.length} vs ${comparisonFindings.length}</div><div><strong>findings overlap (category,file):</strong> ${findingOverlap.overlap} (${formatPercent(findingOverlap.overlapPercent)})</div><div><strong>inline comments count:</strong> ${primaryInlineComments.length} vs ${comparisonInlineComments.length}</div><div><strong>inline overlap (file:line):</strong> ${inlineOverlap.overlap} (${formatPercent(inlineOverlap.overlapPercent)})</div><div><strong>duration:</strong> ${run.durationMs ?? '-'} ms vs ${comparisonDuration ?? '-'} ms</div><div><strong>file coverage:</strong> ${formatPercent(primaryCoverage)} vs ${formatPercent(comparisonCoverage)}</div>${renderTokenUsage(comparison)}</div>`
}

const renderRunRow = (run: ReviewRunRecord): string => {
  const input = asRecord(run.input)
  const result = asRecord(run.result)
  const diagnostics = asRecord(result.reviewDiagnostics)

  const mode = getString(result, 'reviewMode') || getString(input, 'reviewMode')
  const modeDisplay = reviewModeLabel(mode)
  const previousReviewedSha =
    getString(result, 'previousReviewedSha') || getString(input, 'previousReviewedSha')

  const intent = getString(result, 'reviewIntent')
  const template = getString(result, 'reviewTemplateId')
  const templateSource = getString(result, 'reviewTemplateSource')
  const confidence = getNumber(result, 'reviewIntentConfidence')
  const assessment = getString(result, 'assessment')
  const summary = getString(result, 'summary')
  const labels = getStringArray(input, 'labels')
  const title = getString(input, 'title')
  const sourceBranch = getString(input, 'sourceBranch')
  const targetBranch = getString(input, 'targetBranch')
  const changedFileCount = getNumber(diagnostics, 'changedFileCount')
  const diffBaseRef = getString(diagnostics, 'diffBaseRef')
  const warnings = getStringArray(diagnostics, 'templateWarnings')
  const posted = getNumber(result, 'posted')
  const skipped = getNumber(result, 'skipped')
  const durationMs = run.durationMs
  const statusClass = `status-${run.status}`

  const warningsHtml =
    warnings.length > 0
      ? `<details><summary>${warnings.length} warnings</summary><ul>${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}</ul></details>`
      : '<div class="muted">No warnings</div>'

  const failureHtml =
    run.status === 'failed'
      ? `<div class="error"><strong>Error:</strong> ${escapeHtml(run.error ?? 'Unknown error')}</div>`
      : ''

  const rawInputJson = escapeHtml(JSON.stringify(run.input, null, 2))
  const rawResultJson = escapeHtml(JSON.stringify(run.result, null, 2))
  const rawComparisonJson = escapeHtml(JSON.stringify(run.comparisonResult, null, 2))

  return `
    <tr>
      <td>
        <div><strong>intent:</strong> <code>${escapeHtml(intent || '-')}</code></div>
        <div><strong>template:</strong> <code>${escapeHtml(template || '-')}</code> <span class="muted">(${escapeHtml(templateSource || '-')})</span></div>
        <div><strong>confidence:</strong> ${confidence === null ? '-' : confidence.toFixed(2)}</div>
        <div><strong>diff base:</strong> <code>${escapeHtml(diffBaseRef || '-')}</code></div>
        <div><strong>changed files:</strong> ${changedFileCount ?? '-'}</div>
        ${warningsHtml}
      </td>
      <td>
        <div><span class="status ${statusClass}">${escapeHtml(run.status)}</span> <strong>${escapeHtml(modeDisplay)}</strong></div>
        <div><strong>sha:</strong> <code>${escapeHtml(shortSha(run.commitSha))}</code></div>
        <div><strong>source:</strong> <code>${escapeHtml(run.source)}</code></div>
        <div><strong>created:</strong> ${escapeHtml(formatDate(run.createdAt))}</div>
        <div><strong>duration:</strong> ${durationMs ?? '-'} ms</div>
        ${renderComparisonSummary(run, result)}
        <div><strong>prev sha:</strong> <code>${escapeHtml(shortSha(previousReviewedSha || null))}</code></div>
        <div><strong>run id:</strong> <code>${escapeHtml(run.id)}</code></div>
      </td>
      <td>
        <div><strong>title:</strong> ${escapeHtml(title || '-')}</div>
        <div><strong>branches:</strong> <code>${escapeHtml(sourceBranch || '-')}</code> -> <code>${escapeHtml(targetBranch || '-')}</code></div>
        <div><strong>labels:</strong> ${labels.length > 0 ? labels.map((label) => `<code>${escapeHtml(label)}</code>`).join(' ') : '<span class="muted">none</span>'}</div>
        <details><summary>raw input</summary><pre>${rawInputJson}</pre></details>
      </td>
      <td>
        <div><strong>assessment:</strong> <code>${escapeHtml(assessment || '-')}</code></div>
        <div><strong>summary:</strong> ${escapeHtml(summary || '-')}</div>
        <div><strong>posted/skipped:</strong> ${posted ?? '-'} / ${skipped ?? '-'}</div>
        ${renderComparison(run, result)}
        ${renderFindings(result)}
        ${renderInlineComments(result)}
        ${failureHtml}
        <details><summary>raw comparison</summary><pre>${rawComparisonJson}</pre></details>
        <details><summary>raw result</summary><pre>${rawResultJson}</pre></details>
      </td>
    </tr>
  `
}

const sortRunsDesc = (a: ReviewRunRecord, b: ReviewRunRecord): number =>
  b.createdAt.getTime() - a.createdAt.getTime()

const renderProjectSection = (projectKey: string, runs: ReviewRunRecord[]): string => {
  const byMr = new Map<number, ReviewRunRecord[]>()
  for (const run of runs) {
    const current = byMr.get(run.mrIid)
    if (current) {
      current.push(run)
    } else {
      byMr.set(run.mrIid, [run])
    }
  }

  const mrIids = [...byMr.keys()].sort((a, b) => b - a)
  const mrSections = mrIids.map((mrIid) => {
    const mrRuns = (byMr.get(mrIid) ?? []).slice().sort(sortRunsDesc)
    const latest = mrRuns[0]
    const latestInput = asRecord(latest?.input)
    const mrUrl = getString(latestInput, 'url')
    const header = mrUrl
      ? `<a href="${escapeHtml(mrUrl)}" target="_blank" rel="noreferrer">MR !${mrIid}</a>`
      : `MR !${mrIid}`

    const rows = mrRuns.map(renderRunRow).join('')

    return `
      <section class="mr-block">
        <h3>${header} <span class="muted">(${mrRuns.length} runs)</span></h3>
        <table>
          <thead>
            <tr>
              <th>Decision Making</th>
              <th>Run</th>
              <th>Input</th>
              <th>Final Output</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </section>
    `
  })

  return `
    <section class="project-block">
      <h2>Project: <code>${escapeHtml(projectKey)}</code> <span class="muted">(${runs.length} runs)</span></h2>
      ${mrSections.join('')}
    </section>
  `
}

export const renderEvalsDashboardPage = (params: {
  runs: ReviewRunRecord[]
  projectFilter: string | null
  knownProjects: string[]
  limit: number
  maxLimit: number
}): string => {
  const runsByProject = new Map<string, ReviewRunRecord[]>()
  for (const run of params.runs) {
    const current = runsByProject.get(run.projectKey)
    if (current) {
      current.push(run)
    } else {
      runsByProject.set(run.projectKey, [run])
    }
  }

  const projectKeys = [...runsByProject.keys()].sort((a, b) => a.localeCompare(b))
  const projectSections =
    projectKeys.length > 0
      ? projectKeys
          .map((projectKey) =>
            renderProjectSection(projectKey, runsByProject.get(projectKey) ?? []),
          )
          .join('')
      : '<p>No runs found for current filter.</p>'

  const filterOptions = [
    '<option value="">all projects</option>',
    ...params.knownProjects.map((project) => {
      const selected = params.projectFilter === project ? ' selected' : ''
      return `<option value="${escapeHtml(project)}"${selected}>${escapeHtml(project)}</option>`
    }),
  ].join('')

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Mend Eval Runs</title>
    <style>
      :root { color-scheme: light; }
      body { margin: 0; font-family: Menlo, Monaco, Consolas, "Liberation Mono", monospace; background: #f4f6f8; color: #0f172a; }
      main { padding: 20px; }
      h1, h2, h3 { margin: 0 0 10px; }
      h1 { font-size: 24px; }
      h2 { margin-top: 28px; font-size: 20px; }
      h3 { margin-top: 20px; font-size: 16px; }
      .controls { display: flex; gap: 12px; align-items: center; margin: 14px 0 18px; flex-wrap: wrap; }
      select, input, button { font: inherit; padding: 6px 8px; }
      table { width: 100%; border-collapse: collapse; table-layout: fixed; background: #fff; border: 1px solid #d5dbe3; }
      th, td { border: 1px solid #d5dbe3; vertical-align: top; text-align: left; padding: 8px; font-size: 12px; line-height: 1.35; }
      th { background: #eef2f7; }
      td > div { margin-bottom: 4px; }
      .muted { color: #64748b; }
      .status { display: inline-block; padding: 2px 6px; border-radius: 999px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.03em; }
      .status-success { background: #dcfce7; color: #166534; }
      .status-failed { background: #fee2e2; color: #991b1b; }
      .status-running { background: #dbeafe; color: #1e3a8a; }
      .pill { display: inline-block; padding: 1px 6px; border-radius: 999px; background: #e2e8f0; margin-right: 4px; }
      .project-block { margin-bottom: 30px; }
      .mr-block { margin-bottom: 22px; }
      summary { cursor: pointer; }
      ul { margin: 6px 0 0 18px; padding: 0; }
      li { margin-bottom: 4px; }
      pre { white-space: pre-wrap; word-break: break-word; background: #0b1220; color: #dbeafe; padding: 8px; border-radius: 6px; max-height: 240px; overflow: auto; }
      .error { background: #fff1f2; border: 1px solid #fecdd3; padding: 6px 8px; margin-top: 6px; }
      .comparison { border: 1px solid #d5dbe3; background: #f8fafc; border-radius: 6px; padding: 6px 8px; margin: 6px 0; }
      .comparison-match { color: #166534; font-weight: 700; }
      .comparison-mismatch, .comparison-failed { color: #991b1b; font-weight: 700; }
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
      <h1>Mend Eval Runs</h1>
      <div class="muted">Showing up to ${params.limit} latest runs.</div>
      <form method="get" class="controls">
        <label>Project
          <select name="project">${filterOptions}</select>
        </label>
        <label>Limit
          <input type="number" min="1" max="${params.maxLimit}" name="limit" value="${params.limit}" />
        </label>
        <button type="submit">Apply</button>
      </form>
      ${projectSections}
    </main>
  </body>
</html>`
}
