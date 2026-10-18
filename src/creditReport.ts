/**
 * Credit-report reading: `getCreditReportHistory` → `getCreditReport`.
 *
 * Typed tradelines with numeric balances, limits and a `dateReported` for
 * cards and loans — but only as of the bureau's last report, typically 2–5
 * weeks old, and keyed by an opaque per-bureau `accountNumber` hash (CK's
 * `accountId` is literally the string "id" for every tradeline). Linked,
 * live balances come from the Intuit vault instead (`src/vault.ts`); a
 * credit-report row that is the same account as a linked one is marked
 * matched (`src/matching.ts`) rather than listed twice.
 *
 * The same `getCreditReport` payload carries the bureau score and the rest
 * of the report (inquiries, collections, public records, buy-now-pay-later).
 * There is no separate score operation in this client: a guessed persisted
 * hash would 400 as "No query found", and the report CK already returns is
 * the one its credit-report page renders, score included. History is the
 * score on each dated pull.
 *
 * Pure: the client fetches, these interpret.
 */
export type Bureau = 'transunion' | 'equifax'

/** The `bureau` variable CK's credit-report operations take. */
export const BUREAU_CODE: Record<Bureau, number> = { transunion: 1, equifax: 2 }

import { obj, str, throwOnGraphqlErrors, type Json } from './json.js'

// ---------------------------------------------------------------------------
// Credit report
// ---------------------------------------------------------------------------

/**
 * Keys CK has used for one bureau's pull list. Matched case-insensitively:
 * a live `transUnionReportHistory` (capital U) is the same field as the
 * `transunionReportHistory` the balance fixtures were captured with, and
 * missing it made `newestReportDate` report "no transunion credit reports"
 * while `reportDates` was sitting on the response.
 */
const BUREAU_HISTORY_KEYS: Record<Bureau, readonly string[]> = {
  transunion: ['transunionreporthistory', 'tureporthistory'],
  equifax: ['equifaxreporthistory', 'efxreporthistory'],
}

/** Used only when the response has no bureau-specific history object. */
const GENERIC_HISTORY_KEYS = ['creditreporthistory', 'reporthistory']

export interface DatedScore {
  /** Exact timestamp to pass back to `getCreditReport`. */
  date: string
  score: number | null
}

export interface ReportHistory {
  /** Newest first. Empty when this bureau has nothing to open. */
  dates: string[]
  /**
   * Newest first, same dates, when the history payload itself carried a
   * score. Null when the dates are all we got — the caller then reads each
   * report to learn the score.
   */
  scores: DatedScore[] | null
}

/**
 * Pull dates (and scores, when the history payload includes them) for one
 * bureau. `getCreditReport` only accepts one of these exact timestamps —
 * "now" or a bare date is rejected — so the date has to be read from here.
 */
export function parseReportHistory(json: unknown, bureau: Bureau): ReportHistory {
  throwOnGraphqlErrors(json, 'getCreditReportHistory')
  const reports = obj(obj(obj(json)?.['data'])?.['creditReportsV2'])
  const points = dedupeNewest(seriesFrom(reports ? pickHistory(reports, bureau) : undefined))
  const dates = points.map(p => p.date)
  return { dates, scores: points.some(p => p.score !== null) ? points : null }
}

/**
 * The newest report pull for `bureau`. Thin wrapper over
 * {@link parseReportHistory} so the balance refresh keeps its error text.
 */
export function newestReportDate(json: unknown, bureau: Bureau): string {
  const { dates } = parseReportHistory(json, bureau)
  if (dates.length === 0) throw new Error(`Credit Karma has no ${bureau} credit reports for this account.`)
  return dates[0]
}

function pickHistory(reports: Json, bureau: Bureau): unknown {
  const keys = Object.keys(reports)
  const find = (aliases: readonly string[]) => keys.find(k => aliases.includes(k.toLowerCase()))
  const specific = find(BUREAU_HISTORY_KEYS[bureau])
  // A present-but-empty bureau node means "this bureau has no file". Do not
  // fall through to the other bureau's dates, or to a generic list that may
  // be the other bureau.
  if (specific !== undefined) return reports[specific]
  const generic = find(GENERIC_HISTORY_KEYS)
  return generic !== undefined ? reports[generic] : undefined
}

/** The object that actually holds `reportDates` / `scoreHistory`, or undefined. */
function nodeWithDates(root: Json): Json | undefined {
  if ('reportDates' in root || 'scoreHistory' in root) return root
  for (const v of Object.values(root)) {
    const inner = obj(v)
    if (inner && ('reportDates' in inner || 'scoreHistory' in inner)) return inner
  }
  return undefined
}

function seriesFrom(node: unknown): DatedScore[] {
  const root = obj(node)
  if (!root) return []
  const source = nodeWithDates(root)
  if (!source) return []

  let points = readDateList(source['reportDates'])
  points = applyParallelScores(points, source['scores'])

  const hist = readDateList(source['scoreHistory']).filter(p => p.score !== null)
  if (hist.length === 0) return points

  const byDate = new Map(hist.map(h => [h.date, h.score]))
  const seen = new Set(points.map(p => p.date))
  const merged = points.map(p => {
    const score = byDate.get(p.date)
    return score === undefined ? p : { date: p.date, score }
  })
  for (const h of hist) if (!seen.has(h.date)) merged.push(h)
  return merged
}

function applyParallelScores(points: DatedScore[], scores: unknown): DatedScore[] {
  if (!Array.isArray(scores)) return points
  return points.map((p, i) => (p.score !== null ? p : { date: p.date, score: readScore(scores[i]) }))
}

function readDateList(value: unknown): DatedScore[] {
  const out: DatedScore[] = []
  for (const item of dateItems(value)) {
    if (typeof item === 'string') {
      const date = item.trim()
      if (date) out.push({ date, score: null })
      continue
    }
    const row = obj(item)
    if (!row) continue
    const date = firstString(row, ['date', 'reportDate', 'value', 'pulledAt'])
    if (!date) continue
    out.push({ date, score: readScore(row['score']) })
  }
  return out
}

/** A date list, a single date string, or `{ someArray: [...] }`. */
function dateItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') return [value]
  const wrapped = obj(value)
  if (!wrapped) return []
  for (const v of Object.values(wrapped)) {
    if (Array.isArray(v)) return v
  }
  return []
}

function dedupeNewest(points: DatedScore[]): DatedScore[] {
  const sorted = [...points].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  const seen = new Set<string>()
  const out: DatedScore[] = []
  for (const p of sorted) {
    if (seen.has(p.date)) continue
    seen.add(p.date)
    out.push(p)
  }
  return out
}

/** Current score minus the previous one, and minus the oldest in the window. */
export function scoreChange(
  series: Array<{ score: number | null }>,
): { since_previous: number | null; since_oldest: number | null } {
  const current = series[0]?.score ?? null
  if (current === null) return { since_previous: null, since_oldest: null }
  const previous = series[1]?.score
  const since_previous = typeof previous === 'number' ? current - previous : null
  let oldest: number | null = null
  for (let i = series.length - 1; i >= 1; i--) {
    if (typeof series[i].score === 'number') {
      oldest = series[i].score as number
      break
    }
  }
  return { since_previous, since_oldest: oldest === null ? null : current - oldest }
}

export type TradelineCategory = 'credit_card' | 'auto_loan' | 'other_loan' | 'real_estate_loan' | 'student_loan'

const TRADELINE_GROUPS: Array<[string, TradelineCategory]> = [
  ['creditCards', 'credit_card'],
  ['autoLoans', 'auto_loan'],
  ['otherLoans', 'other_loan'],
  ['realEstateLoans', 'real_estate_loan'],
  ['studentLoans', 'student_loan'],
]

export interface CreditReportAccount {
  /** `cr:<bureau>:<accountNumber hash>` — stable across reports, NOT across bureaus. */
  key: string
  institution: string | null
  type: string
  category: TradelineCategory
  /** Negative: everything on a credit report is money owed. */
  currentBalance: number
  /** Cards only; positive. */
  creditLimit: number | null
  /** The tradeline's `dateReported` (YYYY-MM-DD); null when CK omits it. */
  asOf: string | null
}

function amountOf(v: unknown): number | null {
  const amount = obj(v)?.['amount']
  if (typeof amount !== 'string' || amount.trim() === '') return null
  const n = Number(amount)
  return Number.isFinite(n) ? n : null
}

/** Charge cards report a `0.00` limit, meaning "no preset limit", not zero. */
function positiveOrNull(n: number | null): number | null {
  return n !== null && n > 0 ? n : null
}

/** Open tradelines from a `getCreditReport` response. Closed ones are dropped. */
export function parseCreditReport(json: unknown, bureau: Bureau): CreditReportAccount[] {
  throwOnGraphqlErrors(json, 'getCreditReport')
  const report = obj(obj(obj(obj(json)?.['data'])?.['creditReportsV2'])?.['creditReport'])
  const tradelines = obj(report?.['tradelines'])
  if (!tradelines) throw new Error('getCreditReport response is missing `creditReport.tradelines`.')

  const accounts: CreditReportAccount[] = []
  for (const [group, category] of TRADELINE_GROUPS) {
    const list = tradelines[group]
    if (!Array.isArray(list)) continue
    for (const raw of list) {
      const t = obj(raw)
      if (!t || t['isOpen'] !== true) continue
      const hash = t['accountNumber']
      const balance = amountOf(t['currentBalance'])
      if (typeof hash !== 'string' || hash === '' || balance === null) continue
      const institution = obj(t['institution'])?.['name']
      accounts.push({
        key: `cr:${bureau}:${hash}`,
        institution: typeof institution === 'string' ? institution : null,
        type: typeof t['accountType'] === 'string' ? t['accountType'] : category,
        category,
        currentBalance: balance === 0 ? 0 : -balance,
        creditLimit: category === 'credit_card' ? positiveOrNull(amountOf(t['limit'])) : null,
        asOf: typeof t['dateReported'] === 'string' && t['dateReported'] !== '' ? t['dateReported'] : null,
      })
    }
  }
  return accounts
}

// ---------------------------------------------------------------------------
// Score and the rest of the report
// ---------------------------------------------------------------------------

export interface CreditScoreFields {
  score: number | null
  label: string | null
  /** From the report when CK names one. Null when the payload doesn't. */
  model: string | null
  /** `dateReportPulled` when present, otherwise the history timestamp we asked for. */
  report_date: string | null
}

export type ReportAccountCategory = TradelineCategory | 'buy_now_pay_later'

export interface LatePayments {
  days_30: number | null
  days_60: number | null
  days_90: number | null
}

export interface ReportAccount {
  institution: string | null
  account_type: string | null
  category: ReportAccountCategory
  is_open: boolean | null
  account_status: string | null
  payment_status: string | null
  /** Negative when money is owed, matching transactions and account balances. */
  balance: number | null
  credit_limit: number | null
  /** `abs(balance) / limit`, in percent, one decimal. Null without a positive limit. */
  utilization: number | null
  opened_date: string | null
  closed_date: string | null
  reported_date: string | null
  late_payments: LatePayments | null
  payment_history: string | null
}

export interface CreditInquiry {
  name: string | null
  date: string | null
  /** `hard` / `soft` when the section or the row says which. */
  type: string | null
}

export interface CollectionItem {
  agency: string | null
  original_creditor: string | null
  status: string | null
  /** Negative when money is owed. */
  balance: number | null
  opened_date: string | null
  reported_date: string | null
}

export interface PublicRecordItem {
  type: string | null
  status: string | null
  filed_date: string | null
  /** Negative when money is owed. */
  amount: number | null
  court: string | null
}

export interface CreditReportDetails {
  bureau: Bureau
  score: number | null
  score_label: string | null
  score_model: string | null
  report_date: string | null
  accounts: ReportAccount[]
  inquiries: CreditInquiry[]
  collections: CollectionItem[]
  public_records: PublicRecordItem[]
  buy_now_pay_later: ReportAccount[]
}

const BNPL_KEYS = ['buyNowPayLater', 'bnpl', 'bnplAccounts', 'buyNowPayLaterAccounts'] as const

/** Score, label, model and report date from a `getCreditReport` body. */
export function parseCreditScore(json: unknown, requestedDate: string | null): CreditScoreFields {
  const report = requireReport(json)
  const scoreNode = obj(report['score'])
  return {
    score: readScore(report['score']),
    label: firstString(report, ['scoreLabel', 'scoreText']),
    model: firstString(report, ['scoreModel', 'scoringModel', 'model', 'scoreType'])
      ?? (scoreNode ? firstString(scoreNode, ['model', 'scoreModel']) : null),
    report_date: firstString(report, ['dateReportPulled', 'reportDate']) ?? blankToNull(requestedDate),
  }
}

/** Accounts and the other sections of a `getCreditReport` body, plus the score. */
export function parseCreditReportDetails(json: unknown, bureau: Bureau, requestedDate: string | null): CreditReportDetails {
  const report = requireReport(json)
  const score = parseCreditScore(json, requestedDate)
  const tradelines = obj(report['tradelines'])
  return {
    bureau,
    score: score.score,
    score_label: score.label,
    score_model: score.model,
    report_date: score.report_date,
    accounts: tradelines ? accountsFrom(tradelines, TRADELINE_GROUPS) : [],
    inquiries: parseInquiries(report),
    collections: firstSection(report, ['collections', 'collectionAccounts']).flatMap(raw => {
      const row = parseCollection(raw)
      return row ? [row] : []
    }),
    public_records: firstSection(report, ['publicRecords', 'publicRecord']).flatMap(raw => {
      const row = parsePublicRecord(raw)
      return row ? [row] : []
    }),
    buy_now_pay_later: bnplAccounts(report, tradelines),
  }
}

function requireReport(json: unknown): Json {
  throwOnGraphqlErrors(json, 'getCreditReport')
  const report = obj(obj(obj(obj(json)?.['data'])?.['creditReportsV2'])?.['creditReport'])
  if (!report) throw new Error('getCreditReport response is missing `creditReport`.')
  return report
}

function bnplAccounts(report: Json, tradelines: Json | undefined): ReportAccount[] {
  const fromGroups = tradelines
    ? accountsFrom(tradelines, BNPL_KEYS.map(k => [k, 'buy_now_pay_later'] as const))
    : []
  const fromTop = BNPL_KEYS
    .filter(k => !(tradelines && k in tradelines))
    .flatMap(k => (report[k] != null ? accountsFromList(report[k], 'buy_now_pay_later') : []))
  return [...fromGroups, ...fromTop]
}

function accountsFrom(
  groups: Json,
  specs: ReadonlyArray<readonly [string, ReportAccountCategory]>,
): ReportAccount[] {
  const out: ReportAccount[] = []
  for (const [key, category] of specs) {
    const list = groups[key]
    if (!Array.isArray(list)) continue
    for (const raw of list) {
      const row = parseAccount(raw, category)
      if (row) out.push(row)
    }
  }
  return out
}

function accountsFromList(node: unknown, category: ReportAccountCategory): ReportAccount[] {
  return recordList(node).flatMap(raw => {
    const row = parseAccount(raw, category)
    return row ? [row] : []
  })
}

function parseAccount(raw: unknown, category: ReportAccountCategory): ReportAccount | null {
  const t = obj(raw)
  if (!t) return null
  const balance = liabilityAmount(t['currentBalance'] ?? t['balance'])
  const credit_limit = limitAmount(t['limit'] ?? t['creditLimit'] ?? t['creditMaximumAmount'])
  const row: ReportAccount = {
    institution: partyName(t['institution']) ?? partyName(t['creditor'])
      ?? firstString(t, ['institutionName', 'creditorName', 'subscriberName', 'lenderName']),
    account_type: firstString(t, ['accountType', 'accountTypeDescription']),
    category,
    is_open: typeof t['isOpen'] === 'boolean' ? t['isOpen'] : null,
    account_status: firstString(t, ['accountStatus', 'status']),
    payment_status: firstString(t, ['paymentStatus', 'payStatus', 'accountCondition']),
    balance,
    credit_limit,
    utilization: utilization(balance, credit_limit),
    opened_date: firstString(t, ['dateOpened', 'openedDate', 'openDate']),
    closed_date: firstString(t, ['dateClosed', 'closedDate']),
    reported_date: firstString(t, ['dateReported', 'reportedDate']),
    late_payments: latePayments(t),
    payment_history: paymentHistory(t['paymentHistory'] ?? t['paymentPattern']),
  }
  const empty = row.institution === null && row.account_type === null && row.balance === null
    && row.opened_date === null && row.account_status === null && row.is_open === null
    && row.credit_limit === null && row.reported_date === null && row.payment_status === null
    && row.closed_date === null && row.late_payments === null && row.payment_history === null
  return empty ? null : row
}

function latePayments(t: Json): LatePayments | null {
  const days_30 = readCount(t, ['times30DaysLate', 'late30Days', 'pastDue30'])
  const days_60 = readCount(t, ['times60DaysLate', 'late60Days', 'pastDue60'])
  const days_90 = readCount(t, ['times90DaysLate', 'late90Days', 'pastDue90'])
  if (days_30 === null && days_60 === null && days_90 === null) return null
  return { days_30, days_60, days_90 }
}

function readCount(t: Json, keys: string[]): number | null {
  for (const k of keys) {
    const n = readScore(t[k])
    if (n !== null) return n
  }
  return null
}

function paymentHistory(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null
  if (!Array.isArray(v)) return null
  const parts: string[] = []
  for (const item of v) {
    if (typeof item === 'string') {
      if (item.trim()) parts.push(item.trim())
      continue
    }
    const s = firstString(obj(item), ['status', 'code', 'value'])
    if (s) parts.push(s)
  }
  return parts.length ? parts.join(',') : null
}

function parseInquiries(report: Json): CreditInquiry[] {
  const named = ['hardInquiries', 'softInquiries', 'creditInquiries'] as const
  if (named.some(k => report[k] != null)) {
    return [
      ...parseInquiryList(report['hardInquiries'], 'hard'),
      ...parseInquiryList(report['softInquiries'], 'soft'),
      ...parseInquiryList(report['creditInquiries'], null),
    ]
  }
  return parseInquiryList(report['inquiries'], null)
}

function parseInquiryList(node: unknown, defaultType: string | null): CreditInquiry[] {
  if (node == null) return []
  if (Array.isArray(node)) {
    return node.flatMap(item => {
      const row = parseInquiry(item, defaultType)
      return row ? [row] : []
    })
  }
  const grouped = obj(node)
  if (!grouped) return []
  const arrays = Object.entries(grouped).filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
  if (arrays.length > 0) {
    return arrays.flatMap(([k, v]) => {
      const type = /soft/i.test(k) ? 'soft' : /hard/i.test(k) ? 'hard' : defaultType
      return parseInquiryList(v, type)
    })
  }
  const one = parseInquiry(grouped, defaultType)
  return one ? [one] : []
}

function parseInquiry(raw: unknown, defaultType: string | null): CreditInquiry | null {
  const t = obj(raw)
  if (!t) return null
  const name = partyName(t['institution']) ?? partyName(t['inquirer'])
    ?? firstString(t, ['name', 'inquirerName', 'subscriberName', 'creditorName'])
  const date = firstString(t, ['date', 'inquiryDate', 'inquiredOn', 'dateOfInquiry'])
  const type = firstString(t, ['type', 'inquiryType']) ?? defaultType
  if (name === null && date === null) return null
  return { name, date, type }
}

function parseCollection(raw: unknown): CollectionItem | null {
  const t = obj(raw)
  if (!t) return null
  const row: CollectionItem = {
    agency: partyName(t['agency']) ?? partyName(t['collectionAgency']) ?? partyName(t['institution'])
      ?? firstString(t, ['agencyName', 'collectorName']),
    original_creditor: partyName(t['originalCreditor']) ?? firstString(t, ['originalCreditorName']),
    status: firstString(t, ['status', 'accountStatus', 'paymentStatus']),
    balance: liabilityAmount(t['currentBalance'] ?? t['balance'] ?? t['amount']),
    opened_date: firstString(t, ['dateOpened', 'openedDate', 'openDate']),
    reported_date: firstString(t, ['dateReported', 'reportedDate']),
  }
  const empty = row.agency === null && row.original_creditor === null && row.status === null
    && row.balance === null && row.opened_date === null && row.reported_date === null
  return empty ? null : row
}

function parsePublicRecord(raw: unknown): PublicRecordItem | null {
  const t = obj(raw)
  if (!t) return null
  const row: PublicRecordItem = {
    type: firstString(t, ['type', 'publicRecordType', 'recordType']),
    status: firstString(t, ['status']),
    filed_date: firstString(t, ['filedDate', 'dateFiled', 'filingDate']),
    amount: liabilityAmount(t['amount'] ?? t['balance']),
    court: firstString(t, ['court', 'courtName']),
  }
  const empty = row.type === null && row.status === null && row.filed_date === null
    && row.amount === null && row.court === null
  return empty ? null : row
}

/** First present section, unwrapped when CK nests the array one level down. */
function firstSection(report: Json, keys: readonly string[]): unknown[] {
  for (const k of keys) {
    if (report[k] != null) return recordList(report[k])
  }
  return []
}

function recordList(node: unknown): unknown[] {
  if (Array.isArray(node)) return node
  const o = obj(node)
  if (!o) return []
  for (const v of Object.values(o)) {
    if (Array.isArray(v)) return v
  }
  return [o]
}

function utilization(balance: number | null, limit: number | null): number | null {
  if (balance === null || limit === null || limit <= 0) return null
  return Math.round((Math.abs(balance) / limit) * 1000) / 10
}

/** Money owed: positive bureau amounts become negative; zero stays zero. */
function liabilityAmount(v: unknown): number | null {
  const n = amountOf(v) ?? finiteNumber(v)
  if (n === null) return null
  return n === 0 ? 0 : -Math.abs(n)
}

function limitAmount(v: unknown): number | null {
  return positiveOrNull(amountOf(v) ?? finiteNumber(v))
}

function partyName(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null
  return firstString(obj(v), ['name'])
}

function firstString(o: Json | undefined, keys: readonly string[]): string | null {
  if (!o) return null
  for (const k of keys) {
    const s = str(o[k])
    if (s) return s
  }
  return null
}

function blankToNull(v: string | null): string | null {
  const s = v?.trim() ?? ''
  return s || null
}

function finiteNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  const t = v.trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

/** A score, a numeric string, `{value|score}`, or a currency `{amount}`. */
function readScore(v: unknown): number | null {
  const direct = finiteNumber(v)
  if (direct !== null) return direct
  const o = obj(v)
  if (!o) return null
  for (const k of ['value', 'score'] as const) {
    const n = finiteNumber(o[k])
    if (n !== null) return n
  }
  return amountOf(v)
}
