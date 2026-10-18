import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  clampHistoryLimit, DEFAULT_HISTORY_LIMIT, handleGetCreditReport, handleGetCreditScores,
  MAX_HISTORY_LIMIT, registerCreditTools, selectedBureaus,
} from '../../src/tools/credit.js'
import { CreditKarmaClient, type OperationSpec } from '../../src/client.js'
import { initDb } from '../../src/db.js'
import { CkAuthError } from '../../src/authError.js'
import type { AppContext } from '../../src/index.js'
import { fakeServer, makeJwt } from '../helpers.js'
import { creditReport, reportHistory, tradeline } from '../fixtures/balances.js'

type Handler = (variables: Record<string, unknown>) => unknown

function stubCk(ctx: AppContext, handlers: Partial<Record<string, Handler>>) {
  return vi.spyOn(ctx.client, 'runOperation').mockImplementation(async (op: OperationSpec, variables) => {
    const h = handlers[op.operationName]
    if (!h) throw new Error(`unexpected operation ${op.operationName}`)
    return h(variables)
  })
}

function scored(score: number | null, extra: Record<string, unknown> = {}) {
  const json = creditReport({
    creditCards: [tradeline({ hash: 'c1', institution: 'Example Card', balance: '10.00', limit: '100.00' })],
  })
  Object.assign(json.data.creditReportsV2.creditReport, {
    ...(score === null ? {} : { score }),
    scoreLabel: 'Your Equifax score on Feb 1, 2024:',
    scoreModel: 'VantageScore 3.0',
    dateReportPulled: '2024-02-01T00:00:00.000Z',
    ...extra,
  })
  return json
}

describe('bureau and history-limit selectors', () => {
  it('defaults to both bureaus and clamps the history window', () => {
    expect(selectedBureaus(undefined)).toEqual(['transunion', 'equifax'])
    expect(selectedBureaus('both')).toEqual(['transunion', 'equifax'])
    expect(selectedBureaus('equifax')).toEqual(['equifax'])
    expect(selectedBureaus('transunion')).toEqual(['transunion'])

    expect(clampHistoryLimit(undefined)).toBe(DEFAULT_HISTORY_LIMIT)
    expect(clampHistoryLimit(1.5)).toBe(DEFAULT_HISTORY_LIMIT)
    expect(clampHistoryLimit(0)).toBe(DEFAULT_HISTORY_LIMIT)
    expect(clampHistoryLimit(5)).toBe(5)
    expect(clampHistoryLimit(100)).toBe(MAX_HISTORY_LIMIT)
  })
})

describe('ck_get_credit_scores', () => {
  let ctx: AppContext

  beforeEach(() => {
    // A live refresh JWT so a TOKEN_EXPIRED retry does not try to re-bootstrap
    // credentials (that path waits on the browser bridge).
    const refresh = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 })
    ctx = { client: new CreditKarmaClient('valid-token', refresh), db: initDb(':memory:') }
  })
  afterEach(() => vi.restoreAllMocks())

  it('returns both bureaus, using embedded history scores and computing the change', async () => {
    const seen: unknown[] = []
    stubCk(ctx, {
      getCreditReportHistory: (v) => {
        seen.push(v)
        return v.bureau === 1
          ? {
            data: { creditReportsV2: { transunionReportHistory: { reportDates: [
              { date: '2024-03-01T00:00:00Z', score: 730 },
              { date: '2024-02-01T00:00:00Z', score: 710 },
              { date: '2024-01-01T00:00:00Z', score: 700 },
            ] } } },
          }
          : reportHistory([], ['2024-02-02T00:00:00Z'])
      },
      getCreditReport: (v) => {
        seen.push(v)
        if (v.date === '2024-02-02T00:00:00Z') return scored(736)
        return scored(730, { dateReportPulled: '2024-03-01T00:00:00.000Z', scoreLabel: 'TU' })
      },
    })

    const result = await handleGetCreditScores({ history_limit: 2 }, ctx)
    expect(seen).toEqual([
      { bureau: 1 },
      { bureau: 1, date: '2024-03-01T00:00:00Z' },
      { bureau: 2 },
      { bureau: 2, date: '2024-02-02T00:00:00Z' },
    ])
    expect(result.scores[0]).toMatchObject({
      ok: true,
      bureau: 'transunion',
      score: 730,
      label: 'TU',
      model: 'VantageScore 3.0',
      report_date: '2024-03-01T00:00:00.000Z',
      reports_available: 3,
      change: { since_previous: 20, since_oldest: 20 },
      history: [
        { date: '2024-03-01T00:00:00.000Z', score: 730 },
        { date: '2024-02-01T00:00:00Z', score: 710 },
      ],
    })
    expect(result.scores[1]).toMatchObject({
      ok: true, bureau: 'equifax', score: 736, reports_available: 1,
      change: { since_previous: null, since_oldest: null },
    })
  })

  it('fetches older reports when the history has dates only, and stops the walk when one fails', async () => {
    const dates = ['2024-03-01T00:00:00Z', '2024-02-01T00:00:00Z', '2024-01-01T00:00:00Z']
    const fetched: string[] = []
    stubCk(ctx, {
      getCreditReportHistory: () => reportHistory(dates),
      getCreditReport: (v) => {
        fetched.push(String(v.date))
        if (v.date === '2024-02-01T00:00:00Z') throw new Error('report unavailable')
        const score = v.date === '2024-03-01T00:00:00Z' ? 700 : null
        const json = scored(score)
        if (score === null) delete (json.data.creditReportsV2.creditReport as { score?: number }).score
        return json
      },
    })

    const result = await handleGetCreditScores({ bureau: 'transunion', history_limit: 3 }, ctx)
    expect(fetched).toEqual(['2024-03-01T00:00:00Z', '2024-02-01T00:00:00Z'])
    expect(result.scores[0]).toMatchObject({
      ok: true,
      score: 700,
      history_error: 'report unavailable',
      history: [{ date: '2024-02-01T00:00:00.000Z', score: 700 }],
      change: { since_previous: null, since_oldest: null },
    })
  })

  it('fills a gap in the embedded series by reading that report', async () => {
    stubCk(ctx, {
      getCreditReportHistory: () => ({
        data: { creditReportsV2: { transunionReportHistory: { reportDates: [
          { date: '2024-03-01T00:00:00Z', score: 700 },
          { date: '2024-02-01T00:00:00Z' },
          { date: '2024-01-01T00:00:00Z', score: 680 },
        ] } } },
      }),
      getCreditReport: (v) => {
        if (v.date === '2024-02-01T00:00:00Z') return scored(null)
        return scored(700, { dateReportPulled: '2024-03-01T00:00:00.000Z' })
      },
    })
    const result = await handleGetCreditScores({ bureau: 'transunion', history_limit: 3 }, ctx)
    expect(result.scores[0]).toMatchObject({
      ok: true,
      history: [
        { date: '2024-03-01T00:00:00.000Z', score: 700 },
        { score: null },
        { date: '2024-01-01T00:00:00Z', score: 680 },
      ],
      change: { since_previous: null, since_oldest: 20 },
    })
  })

  it('reports a bureau with no pulls without failing the other', async () => {
    stubCk(ctx, {
      getCreditReportHistory: (v) => v.bureau === 1
        ? reportHistory([])
        : reportHistory([], ['2024-02-02T00:00:00Z']),
      getCreditReport: () => scored(700),
    })
    const result = await handleGetCreditScores({}, ctx)
    expect(result.scores[0]).toEqual({
      ok: false, bureau: 'transunion', error: 'Credit Karma has no transunion credit reports for this account.',
    })
    expect(result.scores[1]).toMatchObject({ ok: true, bureau: 'equifax', score: 700 })
  })

  it('reports a non-auth failure on the current report, including a thrown non-Error', async () => {
    stubCk(ctx, {
      getCreditReportHistory: () => reportHistory([], ['2024-02-01T00:00:00Z']),
      getCreditReport: () => { throw 'plain string' },
    })
    const result = await handleGetCreditScores({ bureau: 'equifax' }, ctx)
    expect(result.scores).toEqual([{ ok: false, bureau: 'equifax', error: 'plain string' }])
  })

  it('retries once when the access token is rejected, then reads the score', async () => {
    vi.spyOn(ctx.client, 'refreshAccessToken').mockResolvedValue('new-token')
    let calls = 0
    vi.spyOn(ctx.client, 'runOperation').mockImplementation(async (op: OperationSpec) => {
      calls++
      if (calls === 1) throw new Error('TOKEN_EXPIRED')
      if (op.operationName === 'getCreditReportHistory') return reportHistory(['2024-02-01T00:00:00Z'])
      return scored(701)
    })
    const result = await handleGetCreditScores({ bureau: 'transunion', history_limit: 1 }, ctx)
    expect(result.scores[0]).toMatchObject({ ok: true, score: 701 })
    expect(ctx.client.refreshAccessToken).toHaveBeenCalledOnce()
  })

  it('rethrows when the refresh itself fails', async () => {
    vi.spyOn(ctx.client, 'refreshAccessToken').mockRejectedValue(new Error('NO_REFRESH_TOKEN: Call ck_set_session first.'))
    stubCk(ctx, { getCreditReportHistory: () => { throw new Error('TOKEN_EXPIRED') } })
    await expect(handleGetCreditScores({ bureau: 'transunion' }, ctx)).rejects.toThrow(/NO_REFRESH_TOKEN/)
  })

  it('rethrows a rejected session instead of blaming one bureau', async () => {
    stubCk(ctx, {
      getCreditReportHistory: () => { throw new CkAuthError('session_rejected', 'session rejected', 400) },
    })
    await expect(handleGetCreditScores({ bureau: 'transunion' }, ctx)).rejects.toThrow(/session rejected/)
  })

  it('rethrows a token that is still dead after the refresh', async () => {
    vi.spyOn(ctx.client, 'refreshAccessToken').mockResolvedValue('new-token')
    vi.spyOn(ctx.client, 'runOperation').mockRejectedValue(new Error('TOKEN_EXPIRED'))
    await expect(handleGetCreditScores({ bureau: 'transunion' }, ctx)).rejects.toThrow('TOKEN_EXPIRED')
  })

  it('refuses to call Credit Karma before the client has a token', async () => {
    const anon: AppContext = { client: new CreditKarmaClient(), db: ctx.db }
    const prev = process.env.CK_DISABLE_FETCHPROXY
    process.env.CK_DISABLE_FETCHPROXY = '1'
    try {
      await expect(handleGetCreditScores({}, anon)).rejects.toThrow()
    } finally {
      if (prev === undefined) delete process.env.CK_DISABLE_FETCHPROXY
      else process.env.CK_DISABLE_FETCHPROXY = prev
    }
  })
})

describe('ck_get_credit_report', () => {
  let ctx: AppContext

  beforeEach(() => {
    ctx = { client: new CreditKarmaClient('valid-token'), db: initDb(':memory:') }
  })
  afterEach(() => vi.restoreAllMocks())

  it('reads the newest report for each bureau and keeps closed accounts', async () => {
    stubCk(ctx, {
      getCreditReportHistory: (v) => v.bureau === 1
        ? reportHistory(['2024-03-01T00:00:00Z'])
        : reportHistory([], ['2024-02-02T00:00:00Z']),
      getCreditReport: (v) => {
        if (v.bureau === 2) return scored(710)
        const json = creditReport({
          creditCards: [
            tradeline({ hash: 'open', balance: '10.00', limit: '100.00' }),
            tradeline({ hash: 'shut', balance: '0.00', isOpen: false }),
          ],
        })
        const tradelines = json.data.creditReportsV2.creditReport.tradelines as Record<string, unknown>
        tradelines.buyNowPayLater = [
          { institution: 'Open BNPL', currentBalance: { amount: '1.00' }, isOpen: true },
          { institution: 'Shut BNPL', currentBalance: { amount: '2.00' }, isOpen: false },
          { institution: 'Unknown BNPL', currentBalance: { amount: '3.00' } },
        ]
        Object.assign(json.data.creditReportsV2.creditReport, {
          score: 710,
          hardInquiries: [{ name: 'Example Lender', date: '2024-01-01' }],
        })
        return json
      },
    })

    const result = await handleGetCreditReport({}, ctx)
    expect(result.reports[0]).toMatchObject({ ok: true, bureau: 'transunion', score: 710 })
    const tu = result.reports[0]
    if (!tu.ok) throw new Error('expected tu')
    expect(tu.accounts.map(a => a.is_open)).toEqual([true, false])
    expect(tu.buy_now_pay_later.map(a => a.institution)).toEqual(['Open BNPL', 'Shut BNPL', 'Unknown BNPL'])
    expect(tu.inquiries).toEqual([{ name: 'Example Lender', date: '2024-01-01', type: 'hard' }])
    expect(result.reports[1]).toMatchObject({ ok: true, bureau: 'equifax' })
  })

  it('drops closed accounts when asked, and uses an explicit report timestamp', async () => {
    const seen: unknown[] = []
    stubCk(ctx, {
      getCreditReportHistory: () => { throw new Error('history should not be called') },
      getCreditReport: (v) => {
        seen.push(v)
        const json = creditReport({
          creditCards: [
            tradeline({ hash: 'open', balance: '10.00', limit: '100.00' }),
            tradeline({ hash: 'shut', balance: '0.00', isOpen: false }),
          ],
        })
        const tradelines = json.data.creditReportsV2.creditReport.tradelines as Record<string, unknown>
        tradelines.bnpl = [
          { institution: 'Shut BNPL', isOpen: false, currentBalance: { amount: '2.00' } },
          { institution: 'Open BNPL', isOpen: true, currentBalance: { amount: '1.00' } },
        ]
        return json
      },
    })

    const result = await handleGetCreditReport({
      bureau: 'equifax',
      date: '  2024-01-15T00:00:00Z  ',
      include_closed: false,
    }, ctx)
    expect(seen).toEqual([{ bureau: 2, date: '2024-01-15T00:00:00Z' }])
    const report = result.reports[0]
    if (!report.ok) throw new Error('expected a report')
    expect(report.accounts.map(a => a.is_open)).toEqual([true])
    expect(report.buy_now_pay_later.map(a => a.institution)).toEqual(['Open BNPL'])
  })

  it('treats a blank date as "newest" and surfaces a bureau error', async () => {
    stubCk(ctx, {
      getCreditReportHistory: () => reportHistory([]),
      getCreditReport: () => scored(1),
    })
    const result = await handleGetCreditReport({ bureau: 'transunion', date: '   ' }, ctx)
    expect(result.reports).toEqual([{
      ok: false, bureau: 'transunion', error: 'Credit Karma has no transunion credit reports for this account.',
    }])
  })

  it('rethrows auth failures from a report read', async () => {
    stubCk(ctx, {
      getCreditReportHistory: () => reportHistory(['2024-02-01T00:00:00Z']),
      getCreditReport: () => { throw new CkAuthError('no_credentials', 'no credentials readable') },
    })
    await expect(handleGetCreditReport({ bureau: 'transunion' }, ctx)).rejects.toThrow(/no credentials readable/)
  })

  it('registers both tools as read-only network calls', async () => {
    const { server, calls } = fakeServer()
    registerCreditTools(server, ctx)
    expect(calls.map(c => c.name)).toEqual(['ck_get_credit_scores', 'ck_get_credit_report'])
    expect(calls[0].opts.annotations).toEqual({ readOnlyHint: true, idempotentHint: true, openWorldHint: true })
    expect(calls[1].opts.annotations).toEqual({ readOnlyHint: true, idempotentHint: true, openWorldHint: true })
    expect(calls[0].opts.inputSchema.shape).toHaveProperty('history_limit')
    expect(calls[1].opts.inputSchema.shape).toHaveProperty('include_closed')

    stubCk(ctx, {
      getCreditReportHistory: () => reportHistory(['2024-02-01T00:00:00Z'], ['2024-02-02T00:00:00Z']),
      getCreditReport: () => scored(700),
    })
    const body = JSON.parse((await calls[0].handler({})).content[0].text) as { scores: unknown[] }
    expect(body.scores).toHaveLength(2)
    const report = JSON.parse((await calls[1].handler({ bureau: 'transunion' })).content[0].text) as { reports: unknown[] }
    expect(report.reports).toHaveLength(1)
  })
})
