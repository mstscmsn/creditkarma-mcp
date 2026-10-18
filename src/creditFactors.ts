/**
 * Credit-score factors derived from a parsed `getCreditReport` body.
 *
 * No extra Credit Karma operation: the grades Credit Karma shows on its
 * factors page are not in this payload, so `ck_grade` is always null.
 * `rating` is an approximation from the thresholds in {@link FACTOR_THRESHOLDS},
 * which are commonly cited consumer bands, not Credit Karma's grades and not
 * a VantageScore formula.
 *
 * Impact weights are the published VantageScore 3.0 influence percentages
 * (they sum to 100). Age and account mix share the 21% "age and type" bucket,
 * so those two weights are not additive. Collections and public records have
 * no separate published weight; they sit inside payment history.
 */
import type {
  CreditInquiry,
  CreditReportDetails,
  ReportAccount,
  ReportAccountCategory,
} from './creditReport.js'

export type FactorRating = 'excellent' | 'good' | 'fair' | 'poor'

/** Published VantageScore 3.0 influence. Percents, summing to 100. */
export const VANTAGE_SCORE_30_WEIGHTS = {
  payment_history: 40,
  age_and_type_of_credit: 21,
  credit_utilization: 20,
  balances: 11,
  recent_credit: 5,
  available_credit: 3,
} as const

/**
 * Bands behind `rating`. Approximations, not Credit Karma's own grades.
 * Utilization matches the commonly cited revolving-utilization bands
 * (under 10% excellent, 10–29% good, 30–49% fair, 50%+ poor).
 */
export const FACTOR_THRESHOLDS = {
  utilization: {
    rated_on: 'overall revolving utilization of open credit cards that have a limit',
    excellent: 'under 10%',
    good: '10% to under 30%',
    fair: '30% to under 50%',
    poor: '50% or more',
  },
  payment_history: {
    rated_on: 'share of payment-history months classified as on time',
    excellent: '100%',
    good: '99% to under 100%',
    fair: '90% to under 99%',
    poor: 'under 90%',
    on_time: 'current, ok, c, paid, paid as agreed, pays as agreed, satisfactory, never late, on time',
    late: 'late, past due, delinquent, collection, charge-off, or a 30/60/90/120/150/180 code',
    ignored: 'any other status, including blank and "no data"',
  },
  credit_age: {
    rated_on: 'average age of open accounts, as of the report date',
    excellent: '9 years or more',
    good: '7 years to under 9',
    fair: '3 years to under 7',
    poor: 'under 3 years',
  },
  account_mix: {
    rated_on: 'open revolving (credit cards) versus open installment (loans) tradelines',
    excellent: 'not used',
    good: 'at least one open revolving account and one open installment account',
    fair: 'only one of those types is open',
    poor: 'neither type is open',
  },
  hard_inquiries: {
    rated_on: 'hard inquiries in the 12 months before the report date',
    excellent: '0',
    good: '1 or 2',
    fair: '3 or 4',
    poor: '5 or more',
    counted_as_hard: 'type "hard", or no type — the report inquiry list is the hard-inquiry section',
    not_counted: 'type "soft", or any other explicit type',
  },
  derogatory_marks: {
    rated_on: 'collections plus public records on this report',
    excellent: '0',
    good: 'not used',
    fair: 'not used',
    poor: '1 or more',
  },
} as const

export const RATING_NOTE =
  'Ratings use commonly cited thresholds and are approximations, not Credit Karma grades and not a VantageScore formula. ck_grade stays null until Credit Karma\'s own factor grades are available.'

const AGE_AND_TYPE_NOTE =
  'VantageScore 3.0 assigns 21% to age and type of credit together. The same weight is shown on credit age and on account mix; it is one bucket, not 42%.'

export interface RatedFactor {
  rating: FactorRating | null
  /** Credit Karma's own grade. Always null until a factors operation exists. */
  ck_grade: null
  /** Published VantageScore 3.0 influence for this factor, in percent. */
  impact_weight: number | null
  /** Name of that published factor. Null when VantageScore has no separate weight. */
  impact_factor: string | null
  impact_note: string | null
}

export interface CardUtilization {
  institution: string | null
  /** Negative when money is owed. */
  balance: number | null
  credit_limit: number | null
  /** Percent, one decimal. Null without a positive limit or a balance. */
  utilization: number | null
}

export interface CreditFactors {
  bureau: CreditReportDetails['bureau']
  report_date: string | null
  score: number | null
  utilization: RatedFactor & {
    /** abs(total balance) / total limit, in percent, one decimal. */
    overall_percent: number | null
    highest_card_percent: number | null
    highest_card: string | null
    /** Negative when money is owed. Cards without a balance or a limit are omitted. */
    total_balance: number | null
    total_limit: number | null
    cards: CardUtilization[]
  }
  payment_history: RatedFactor & {
    on_time_percent: number | null
    months_on_time: number
    months_late: number
    days_30: number | null
    days_60: number | null
    days_90: number | null
  }
  credit_age: RatedFactor & {
    average_open_months: number | null
    oldest_open_months: number | null
    newest_open_months: number | null
    average_open_years: number | null
    oldest_open_years: number | null
    newest_open_years: number | null
  }
  accounts: RatedFactor & {
    total: number
    open: number
    closed: number
    unknown_open: number
    revolving_open: number
    revolving_total: number
    installment_open: number
    installment_total: number
  }
  inquiries: RatedFactor & {
    last_6_months: number | null
    last_12_months: number | null
    last_24_months: number | null
    /** Latest dated hard inquiry on the report, whether or not it is inside 24 months. */
    newest_date: string | null
    /** Hard inquiries with no parseable date. They are not inside a window. */
    undated: number
  }
  derogatory_marks: RatedFactor & {
    count: number
    collections: number
    public_records: number
  }
}

function rated(
  rating: FactorRating | null,
  impactWeight: number | null,
  impactFactor: string | null,
  impactNote: string | null,
): RatedFactor {
  return { rating, ck_grade: null, impact_weight: impactWeight, impact_factor: impactFactor, impact_note: impactNote }
}

function percent(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null
  return Math.round((numerator / denominator) * 1000) / 10
}

function years(months: number | null): number | null {
  if (months === null) return null
  return Math.round((months / 12) * 10) / 10
}

/** `YYYY-MM-DD`, or the date prefix of a timestamp. Invalid calendar days are rejected. */
function parseDay(value: string | null | undefined): Date | null {
  if (!value) return null
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim())
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return date
}

function addMonths(date: Date, delta: number): Date {
  const monthIndex = date.getUTCMonth() + delta
  const year = date.getUTCFullYear()
  const day = date.getUTCDate()
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate()
  return new Date(Date.UTC(year, monthIndex, Math.min(day, lastDay)))
}

/** Whole months from `opened` to `asOf`. The partial month in progress is not counted. */
function ageMonths(opened: Date, asOf: Date): number | null {
  if (opened.getTime() > asOf.getTime()) return null
  let months = (asOf.getUTCFullYear() - opened.getUTCFullYear()) * 12 + (asOf.getUTCMonth() - opened.getUTCMonth())
  if (asOf.getUTCDate() < opened.getUTCDate()) months -= 1
  return months
}

function isRevolving(category: ReportAccountCategory): boolean {
  return category === 'credit_card'
}

/** No type counts as hard: that list on the report is the hard-inquiry section. */
function isHard(type: string | null): boolean {
  const normalized = type?.trim().toLowerCase() ?? ''
  return normalized === '' || normalized === 'hard'
}

/**
 * On time, late, or skip. Unknown statuses are skipped so they neither
 * help nor hurt the percentage.
 */
function classifyMonth(status: string): 'on_time' | 'late' | 'skip' {
  const text = status.trim().toLowerCase()
  if (!text) return 'skip'
  if (/^(ok|c|current|paid|satisfactory|as agreed|paid as agreed|pays as agreed|never late|on time)$/.test(text)) {
    return 'on_time'
  }
  if (/late|past due|delinq|collection|charge|derog|repos|foreclos|bankrupt/.test(text)) return 'late'
  if (/^(30|60|90|120|150|180)(\s*days?)?$/.test(text)) return 'late'
  return 'skip'
}

function historyMonths(history: string): Array<'on_time' | 'late' | 'skip'> {
  const out: Array<'on_time' | 'late' | 'skip'> = []
  for (const part of history.split(',')) {
    const token = part.trim()
    if (!token) continue
    const dated = /^(\d{4}-\d{2}):(.*)$/.exec(token)
    out.push(classifyMonth(dated ? dated[2] : token))
  }
  return out
}

function utilizationOf(accounts: ReportAccount[]): CreditFactors['utilization'] {
  const cards: CardUtilization[] = []
  let totalBalance = 0
  let totalLimit = 0
  let included = 0
  let highest: number | null = null
  let highestCard: string | null = null
  for (const account of accounts) {
    if (account.category !== 'credit_card' || account.is_open !== true) continue
    const utilization = account.balance === null || !account.credit_limit
      ? null
      : percent(Math.abs(account.balance), account.credit_limit)
    cards.push({
      institution: account.institution,
      balance: account.balance,
      credit_limit: account.credit_limit,
      utilization,
    })
    if (utilization === null) continue
    if (highest === null || utilization > highest) {
      highest = utilization
      highestCard = account.institution
    }
    totalBalance += account.balance as number
    totalLimit += account.credit_limit as number
    included += 1
  }
  const overall = included === 0 ? null : percent(Math.abs(totalBalance), totalLimit)
  return {
    ...rated(
      rateUtilization(overall),
      VANTAGE_SCORE_30_WEIGHTS.credit_utilization,
      'Credit utilization',
      'The 20% weight is credit utilization. VantageScore 3.0 also publishes balances (11%) and available credit (3%), which this factor does not score separately.',
    ),
    overall_percent: overall,
    highest_card_percent: highest,
    highest_card: highestCard,
    total_balance: included === 0 ? null : totalBalance,
    total_limit: included === 0 ? null : totalLimit,
    cards,
  }
}

function rateUtilization(value: number | null): FactorRating | null {
  if (value === null) return null
  if (value < 10) return 'excellent'
  if (value < 30) return 'good'
  if (value < 50) return 'fair'
  return 'poor'
}

function paymentHistoryOf(accounts: ReportAccount[]): CreditFactors['payment_history'] {
  let onTime = 0
  let late = 0
  let sawLates = false
  let days30 = 0
  let days60 = 0
  let days90 = 0
  for (const account of accounts) {
    if (account.payment_history) {
      for (const month of historyMonths(account.payment_history)) {
        if (month === 'on_time') onTime += 1
        else if (month === 'late') late += 1
      }
    }
    if (!account.late_payments) continue
    sawLates = true
    days30 += account.late_payments.days_30 ?? 0
    days60 += account.late_payments.days_60 ?? 0
    days90 += account.late_payments.days_90 ?? 0
  }
  const onTimePercent = onTime + late === 0 ? null : percent(onTime, onTime + late)
  return {
    ...rated(rateOnTime(onTimePercent), VANTAGE_SCORE_30_WEIGHTS.payment_history, 'Payment history', null),
    on_time_percent: onTimePercent,
    months_on_time: onTime,
    months_late: late,
    days_30: sawLates ? days30 : null,
    days_60: sawLates ? days60 : null,
    days_90: sawLates ? days90 : null,
  }
}

function rateOnTime(value: number | null): FactorRating | null {
  if (value === null) return null
  if (value >= 100) return 'excellent'
  if (value >= 99) return 'good'
  if (value >= 90) return 'fair'
  return 'poor'
}

function creditAgeOf(accounts: ReportAccount[], asOf: Date | null): CreditFactors['credit_age'] {
  const ages: number[] = []
  if (asOf) {
    for (const account of accounts) {
      if (account.is_open !== true) continue
      const opened = parseDay(account.opened_date)
      if (!opened) continue
      const age = ageMonths(opened, asOf)
      if (age === null) continue
      ages.push(age)
    }
  }
  const average = ages.length === 0 ? null : Math.round((ages.reduce((sum, n) => sum + n, 0) / ages.length) * 10) / 10
  const oldest = ages.length === 0 ? null : Math.max(...ages)
  const newest = ages.length === 0 ? null : Math.min(...ages)
  return {
    ...rated(
      rateCreditAge(average),
      VANTAGE_SCORE_30_WEIGHTS.age_and_type_of_credit,
      'Age and type of credit',
      AGE_AND_TYPE_NOTE,
    ),
    average_open_months: average,
    oldest_open_months: oldest,
    newest_open_months: newest,
    average_open_years: years(average),
    oldest_open_years: years(oldest),
    newest_open_years: years(newest),
  }
}

function rateCreditAge(months: number | null): FactorRating | null {
  if (months === null) return null
  if (months >= 9 * 12) return 'excellent'
  if (months >= 7 * 12) return 'good'
  if (months >= 3 * 12) return 'fair'
  return 'poor'
}

function accountsOf(accounts: ReportAccount[]): CreditFactors['accounts'] {
  let open = 0
  let closed = 0
  let unknown = 0
  let revolvingOpen = 0
  let revolvingTotal = 0
  let installmentOpen = 0
  let installmentTotal = 0
  for (const account of accounts) {
    const revolving = isRevolving(account.category)
    if (revolving) revolvingTotal += 1
    else installmentTotal += 1
    if (account.is_open === true) {
      open += 1
      if (revolving) revolvingOpen += 1
      else installmentOpen += 1
    } else if (account.is_open === false) {
      closed += 1
    } else {
      unknown += 1
    }
  }
  return {
    ...rated(
      rateAccountMix(revolvingOpen, installmentOpen),
      VANTAGE_SCORE_30_WEIGHTS.age_and_type_of_credit,
      'Age and type of credit',
      AGE_AND_TYPE_NOTE,
    ),
    total: accounts.length,
    open,
    closed,
    unknown_open: unknown,
    revolving_open: revolvingOpen,
    revolving_total: revolvingTotal,
    installment_open: installmentOpen,
    installment_total: installmentTotal,
  }
}

function rateAccountMix(revolvingOpen: number, installmentOpen: number): FactorRating {
  if (revolvingOpen > 0 && installmentOpen > 0) return 'good'
  if (revolvingOpen > 0 || installmentOpen > 0) return 'fair'
  return 'poor'
}

function inquiriesOf(inquiries: CreditInquiry[], asOf: Date | null): CreditFactors['inquiries'] {
  let last6 = 0
  let last12 = 0
  let last24 = 0
  let undated = 0
  let newest: { time: number; date: string } | null = null
  for (const inquiry of inquiries) {
    if (!isHard(inquiry.type)) continue
    const raw = inquiry.date
    const day = parseDay(raw)
    if (!raw || !day) {
      undated += 1
      continue
    }
    if (!newest || day.getTime() > newest.time) newest = { time: day.getTime(), date: raw.trim() }
    if (!asOf) continue
    if (day.getTime() >= addMonths(asOf, -6).getTime()) last6 += 1
    if (day.getTime() >= addMonths(asOf, -12).getTime()) last12 += 1
    if (day.getTime() >= addMonths(asOf, -24).getTime()) last24 += 1
  }
  return {
    ...rated(
      asOf ? rateInquiries(last12) : null,
      VANTAGE_SCORE_30_WEIGHTS.recent_credit,
      'Recent credit',
      null,
    ),
    last_6_months: asOf ? last6 : null,
    last_12_months: asOf ? last12 : null,
    last_24_months: asOf ? last24 : null,
    newest_date: newest ? newest.date : null,
    undated,
  }
}

function rateInquiries(last12: number): FactorRating {
  if (last12 <= 0) return 'excellent'
  if (last12 <= 2) return 'good'
  if (last12 <= 4) return 'fair'
  return 'poor'
}

function derogatoryOf(details: CreditReportDetails): CreditFactors['derogatory_marks'] {
  const collections = details.collections.length
  const publicRecords = details.public_records.length
  const count = collections + publicRecords
  return {
    ...rated(
      count === 0 ? 'excellent' : 'poor',
      null,
      null,
      'VantageScore 3.0 does not publish a separate weight for collections and public records. They fall under payment history (40%).',
    ),
    count,
    collections,
    public_records: publicRecords,
  }
}

/** Factors for one bureau's already-parsed report. Closed tradelines stay in the counts and the payment history. */
export function deriveCreditFactors(details: CreditReportDetails): CreditFactors {
  const asOf = parseDay(details.report_date)
  return {
    bureau: details.bureau,
    report_date: details.report_date,
    score: details.score,
    utilization: utilizationOf(details.accounts),
    payment_history: paymentHistoryOf(details.accounts),
    credit_age: creditAgeOf(details.accounts, asOf),
    accounts: accountsOf(details.accounts),
    inquiries: inquiriesOf(details.inquiries, asOf),
    derogatory_marks: derogatoryOf(details),
  }
}
