import { describe, expect, test } from 'bun:test'
import type { ImprovementProposalRecord } from '@/db/improvement-proposals'
import { renderImprovementsDashboardPage } from '@/server/improvements-dashboard-render'

const makeProposal = (
  overrides: Partial<ImprovementProposalRecord> = {},
): ImprovementProposalRecord => ({
  id: 'proposal-1',
  projectKey: 'demo',
  clusterSlug: 'raw-error-surface',
  title: 'Raw provider errors surfaced to UI',
  proposalType: 'tooling',
  body: 'Add a scripts/review.ts regex guard',
  evidence: [{ findingId: 'f1', path: 'src/a.ts', excerpt: 'Leaked raw error.' }],
  occurrenceCount: 3,
  status: 'proposed',
  lastDigestAt: new Date('2026-07-07T00:00:00Z'),
  createdAt: new Date('2026-07-07T00:00:00Z'),
  updatedAt: new Date('2026-07-07T00:00:00Z'),
  ...overrides,
})

describe('renderImprovementsDashboardPage', () => {
  test('renders empty state when no proposals', () => {
    const html = renderImprovementsDashboardPage({ proposals: [] })
    expect(html).toContain('No improvement proposals yet.')
  })

  test('renders status chip, type, occurrence, title, body and evidence', () => {
    const html = renderImprovementsDashboardPage({ proposals: [makeProposal()] })
    expect(html).toContain('status-proposed')
    expect(html).toContain('>tooling</span>')
    expect(html).toContain('occurrences:</strong> 3')
    expect(html).toContain('Raw provider errors surfaced to UI')
    expect(html).toContain('Add a scripts/review.ts regex guard')
    expect(html).toContain('src/a.ts')
    expect(html).toContain('Leaked raw error.')
  })

  test('groups proposals by project', () => {
    const html = renderImprovementsDashboardPage({
      proposals: [
        makeProposal({ id: 'p1', projectKey: 'alpha' }),
        makeProposal({ id: 'p2', projectKey: 'beta' }),
      ],
    })
    const alphaIndex = html.indexOf('>alpha</code>')
    const betaIndex = html.indexOf('>beta</code>')
    expect(alphaIndex).toBeGreaterThan(-1)
    expect(betaIndex).toBeGreaterThan(-1)
    expect(alphaIndex).toBeLessThan(betaIndex)
  })

  test('escapes html in proposal fields', () => {
    const html = renderImprovementsDashboardPage({
      proposals: [makeProposal({ title: '<script>alert(1)</script>' })],
    })
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })
})
