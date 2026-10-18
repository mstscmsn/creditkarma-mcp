/**
 * Read-only credit score and credit report tools.
 *
 * Both sit on the persisted operations the balance refresh already calls
 * (`getCreditReportHistory`, `getCreditReport` — see OPERATIONS in
 * src/client.ts). A live report body carries a top-level `score` /
 * `scoreLabel` plus inquiries, collections, public records and buy-now-pay-later
 * accounts; the balance parser only reads open tradelines. Score history is
 * the score on each dated pull: the history payload when it includes one,
 * otherwise that pull read back. No separate score-history operation is
 * registered here — a hash that isn't in the credit-health safelist 400s as
 * "No query found", and these two calls are the ones CK's own report page uses.
 */
import { z } from 'zod'
import { minifiedResult } from '@chrischall/mcp-utils'
import type { McpServer } from '@modelcontextprotocol/server'
import type { AppContext } from '../index.js'
import { OPERATIONS, type OperationSpec } from '../client.js'
import { isCkAuthError } from '../authError.js'
import {
  BUREAU_CODE,
  newestReportDate,
  parseCreditReportDetails,
  parseCreditScore,
  parseReportHistory,
  scoreChange,
  type Bureau,
  type CreditReportDetails,
  type CreditScoreFields,
  type ReportAccount,
} from '../creditReport.js'
import { ensureAuthenticated, refreshOrThrow } from './sync.js'

/** Current plus the previous pull — enough to show the change, short of a long walk. */
export const DEFAULT_HISTORY_LIMIT = 2

/** Monthly pulls for about three years. Past this the caller is paging a novel. */
export const MAX_HISTORY_LIMIT = 36

const BUREAUS: Bureau[] = ['transunion', 'equifax']

export function selectedBureaus(bureau: Bureau | 'both' | undefined): Bureau[] {
  return bureau === 'transunion' || bureau === 'equifax' ? [bureau] : BUREAUS
}

export function clampHistoryLimit(n: number | undefined): number {
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) return DEFAULT_HISTORY_LIMIT
  return Math.min(n, MAX_HISTORY_LIMIT)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Auth failures are the caller's problem, not one bureau's. */
function rethrowAuth(err: unknown): void {
  if (isCkAuthError(err)) throw err
  if (err instanceof Error && (err.message === 'TOKEN_EXPIRED' || err.message.startsWith('NO_REFRESH_TOKEN'))) {
    throw err
  }
}

/**
 * One operation, with the same single reactive refresh the sync loop uses.
 * CK's expired-token signal is often a 200 body, which `runOperation` already
 * maps to TOKEN_EXPIRED; a refresh the access token's `exp` still calls live
 * has to be forced (`tokenKnownDead`).
 */
async function runOp(ctx: AppContext, op: OperationSpec, variables: Record<string, unknown>): Promise<unknown> {
  try {
    return await ctx.client.runOperation(op, variables)
  } catch (err) {
    if (!(err instanceof Error) || err.message !== 'TOKEN_EXPIRED') throw err
    await refreshOrThrow(ctx, true)
    return ctx.client.runOperation(op, variables)
  }
}

export interface BureauFailure {
  ok: false
  bureau: Bureau
  error: string
}

export interface BureauScore {
  ok: true
  bureau: Bureau
  score: number | null
  label: string | null
  model: string | null
  report_date: string | null
  /** Newest first. `date` is the report's own pull timestamp when CK sends one. */
  history: Array<{ date: string | null; score: number | null }>
  change: { since_previous: number | null; since_oldest: number | null }
  /** Dated pulls CK has, including ones past `history_limit`. */
  reports_available: number
  /** Set when an older pull failed after the current score was read. */
  history_error?: string
}

export interface CreditScoresResult {
  scores: Array<BureauScore | BureauFailure>
}

export interface CreditScoresArgs {
  bureau?: Bureau | 'both'
  history_limit?: number
}

export async function handleGetCreditScores(args: CreditScoresArgs, ctx: AppContext): Promise<CreditScoresResult> {
  await ensureAuthenticated(ctx)
  const limit = clampHistoryLimit(args.history_limit)
  const scores: Array<BureauScore | BureauFailure> = []
  for (const bureau of selectedBureaus(args.bureau)) {
    scores.push(await scoresForBureau(ctx, bureau, limit))
  }
  return { scores }
}

async function scoresForBureau(ctx: AppContext, bureau: Bureau, limit: number): Promise<BureauScore | BureauFailure> {
  let history: ReturnType<typeof parseReportHistory>
  try {
    history = parseReportHistory(
      await runOp(ctx, OPERATIONS.getCreditReportHistory, { bureau: BUREAU_CODE[bureau] }),
      bureau,
    )
  } catch (err) {
    rethrowAuth(err)
    return { ok: false, bureau, error: errorMessage(err) }
  }
  const newest = history.dates[0]
  if (newest === undefined) {
    return { ok: false, bureau, error: `Credit Karma has no ${bureau} credit reports for this account.` }
  }

  const wanted = history.dates.slice(0, limit)
  const embedded = new Map<string, number>()
  if (history.scores) {
    for (const row of history.scores) {
      if (row.score !== null) embedded.set(row.date, row.score)
    }
  }

  let current: CreditScoreFields
  try {
    current = parseCreditScore(
      await runOp(ctx, OPERATIONS.getCreditReport, { bureau: BUREAU_CODE[bureau], date: newest }),
      newest,
    )
  } catch (err) {
    rethrowAuth(err)
    return { ok: false, bureau, error: errorMessage(err) }
  }

  const series: Array<{ date: string | null; score: number | null }> = [
    { date: current.report_date, score: current.score },
  ]
  let historyError: string | undefined
  for (const date of wanted.slice(1)) {
    const known = embedded.get(date)
    if (known !== undefined) {
      series.push({ date, score: known })
      continue
    }
    try {
      const snap = parseCreditScore(
        await runOp(ctx, OPERATIONS.getCreditReport, { bureau: BUREAU_CODE[bureau], date }),
        date,
      )
      series.push({ date: snap.report_date, score: snap.score })
    } catch (err) {
      rethrowAuth(err)
      historyError = errorMessage(err)
      break
    }
  }

  return {
    ok: true,
    bureau,
    score: current.score,
    label: current.label,
    model: current.model,
    report_date: current.report_date,
    history: series,
    change: scoreChange(series),
    reports_available: history.dates.length,
    ...(historyError ? { history_error: historyError } : {}),
  }
}

export interface CreditReportOk extends CreditReportDetails {
  ok: true
}

export interface CreditReportResult {
  reports: Array<CreditReportOk | BureauFailure>
}

export interface CreditReportArgs {
  bureau?: Bureau | 'both'
  /** Exact history timestamp. A calendar day is rejected by Credit Karma. */
  date?: string
  include_closed?: boolean
}

export async function handleGetCreditReport(args: CreditReportArgs, ctx: AppContext): Promise<CreditReportResult> {
  await ensureAuthenticated(ctx)
  const reports: Array<CreditReportOk | BureauFailure> = []
  for (const bureau of selectedBureaus(args.bureau)) {
    reports.push(await reportForBureau(ctx, bureau, args.date, args.include_closed !== false))
  }
  return { reports }
}

function openOnly(rows: ReportAccount[], includeClosed: boolean): ReportAccount[] {
  return includeClosed ? rows : rows.filter(a => a.is_open !== false)
}

async function reportForBureau(
  ctx: AppContext,
  bureau: Bureau,
  date: string | undefined,
  includeClosed: boolean,
): Promise<CreditReportOk | BureauFailure> {
  try {
    const when = date?.trim()
      ? date.trim()
      : newestReportDate(
        await runOp(ctx, OPERATIONS.getCreditReportHistory, { bureau: BUREAU_CODE[bureau] }),
        bureau,
      )
    const details = parseCreditReportDetails(
      await runOp(ctx, OPERATIONS.getCreditReport, { bureau: BUREAU_CODE[bureau], date: when }),
      bureau,
      when,
    )
    return {
      ok: true,
      ...details,
      accounts: openOnly(details.accounts, includeClosed),
      buy_now_pay_later: openOnly(details.buy_now_pay_later, includeClosed),
    }
  } catch (err) {
    rethrowAuth(err)
    return { ok: false, bureau, error: errorMessage(err) }
  }
}

const bureauArg = z.enum(['transunion', 'equifax', 'both']).optional().describe(
  'Which bureau. Default both.',
)

export function registerCreditTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'ck_get_credit_scores',
    {
      description:
        'Current credit score for TransUnion and Equifax (or one bureau): the score, the report date, ' +
        'and the score model when Credit Karma names one. Credit Karma publishes these as VantageScore 3.0. ' +
        'History is newest-first. Scores attached to the report-date list are used as-is; a date without one ' +
        'is filled by reading that report, up to history_limit (default 2, so the change since the previous ' +
        'report is included). `change.since_previous` is the newest score minus the one before it. A bureau ' +
        'with no reports comes back ok:false and does not fail the other. Read-only; nothing is stored.',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: z.object({
        bureau: bureauArg,
        history_limit: z.number().int().min(1).max(MAX_HISTORY_LIMIT).optional().describe(
          `Dated reports to include, newest first. Default ${DEFAULT_HISTORY_LIMIT}; maximum ${MAX_HISTORY_LIMIT}. ` +
            '1 is the current score only.',
        ),
      }),
    },
    async (args) => minifiedResult(await handleGetCreditScores(args, ctx)),
  )

  server.registerTool(
    'ck_get_credit_report',
    {
      description:
        'Credit report for TransUnion and Equifax (or one bureau): open and closed accounts, hard inquiries, ' +
        'collections, public records, and buy-now-pay-later accounts. Each account includes the lender, type, ' +
        'open/closed status, balance (negative when money is owed, same as transactions), credit limit, ' +
        'utilization percent, opened date, payment status, and late-payment counts when the report has them. ' +
        'Pass date to read a specific pull — it must be an exact timestamp from the score history, not a ' +
        'calendar day. Pass include_closed:false to drop closed accounts. A bureau with no report comes back ' +
        'ok:false and does not fail the other. Read-only; nothing is stored.',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: z.object({
        bureau: bureauArg,
        date: z.string().optional().describe(
          'Exact report timestamp from ck_get_credit_scores history. Omit for the newest pull.',
        ),
        include_closed: z.boolean().optional().describe('Include closed accounts. Default true.'),
      }),
    },
    async (args) => minifiedResult(await handleGetCreditReport(args, ctx)),
  )
}
