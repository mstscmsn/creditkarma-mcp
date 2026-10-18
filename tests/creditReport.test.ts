import { describe, it, expect } from 'vitest'
import {
  newestReportDate, parseCreditReport, parseCreditReportDetails, parseCreditScore, parseReportHistory,
  scoreChange, BUREAU_CODE,
} from '../src/creditReport.js'
import { reportHistory, tradeline, creditReport } from './fixtures/balances.js'

describe('BUREAU_CODE', () => {
  it('maps bureau names to the numeric codes CK expects', () => {
    expect(BUREAU_CODE).toEqual({ transunion: 1, equifax: 2 })
  })
})

describe('newestReportDate', () => {
  it('returns the newest TransUnion date regardless of order', () => {
    const json = reportHistory(['2024-01-03T10:00:00Z', '2024-02-03T10:00:00Z', '2023-12-03T10:00:00Z'])
    expect(newestReportDate(json, 'transunion')).toBe('2024-02-03T10:00:00Z')
  })

  it('reads the Equifax history when asked', () => {
    const json = reportHistory(['2024-02-03T10:00:00Z'], ['2024-01-20T09:00:00Z'])
    expect(newestReportDate(json, 'equifax')).toBe('2024-01-20T09:00:00Z')
  })

  it('throws when the bureau has no reports', () => {
    expect(() => newestReportDate(reportHistory([]), 'transunion')).toThrow(/no transunion credit reports/i)
  })

  it('throws on a GraphQL error payload', () => {
    expect(() => newestReportDate({ errors: [{ message: 'An error occurred.' }] }, 'transunion'))
      .toThrow(/An error occurred/)
  })

  it('throws on an unexpected shape', () => {
    expect(() => newestReportDate({ data: {} }, 'transunion')).toThrow(/no transunion credit reports/i)
  })
})

describe('parseCreditReport', () => {
  it('maps a credit card to a negative balance with a positive limit', () => {
    const json = creditReport({
      creditCards: [tradeline({ hash: 'aaa111', institution: 'Example Card Co', balance: '1234.56', limit: '5000.00', dateReported: '2024-01-28' })],
    })
    expect(parseCreditReport(json, 'transunion')).toEqual([{
      key: 'cr:transunion:aaa111',
      institution: 'Example Card Co',
      type: 'Credit Card',
      category: 'credit_card',
      currentBalance: -1234.56,
      creditLimit: 5000,
      asOf: '2024-01-28',
    }])
  })

  it('maps loans across categories with no credit limit', () => {
    const json = creditReport({
      autoLoans: [tradeline({ hash: 'auto1', accountType: 'Auto Loan', balance: '8000.00', limit: '20000.00' })],
      realEstateLoans: [tradeline({ hash: 'home1', accountType: 'Mortgage', balance: '250000.00', limit: null })],
      studentLoans: [tradeline({ hash: 'stu1', accountType: 'Student Loan', balance: '0.00' })],
      otherLoans: [tradeline({ hash: 'oth1', accountType: 'Personal Loan', balance: '10.50' })],
    })
    const rows = parseCreditReport(json, 'transunion')
    expect(rows.map(r => [r.category, r.currentBalance, r.creditLimit])).toEqual([
      ['auto_loan', -8000, null],
      ['other_loan', -10.5, null],
      ['real_estate_loan', -250000, null],
      ['student_loan', 0, null],
    ])
  })

  it('drops closed accounts', () => {
    const json = creditReport({
      creditCards: [
        tradeline({ hash: 'open1', balance: '10.00', limit: '100.00' }),
        tradeline({ hash: 'closed1', balance: '0.00', limit: '100.00', isOpen: false }),
      ],
    })
    expect(parseCreditReport(json, 'transunion').map(r => r.key)).toEqual(['cr:transunion:open1'])
  })

  it('treats a zero limit as none — charge cards report 0.00', () => {
    const json = creditReport({ creditCards: [tradeline({ hash: 'c0', balance: '10.00', limit: '0.00' })] })
    expect(parseCreditReport(json, 'transunion')[0].creditLimit).toBeNull()
  })

  it('leaves the limit null when a card reports none or an unparseable one', () => {
    const json = creditReport({
      creditCards: [
        tradeline({ hash: 'c1', balance: '10.00', limit: null }),
        tradeline({ hash: 'c2', balance: '10.00', limit: 'n/a' }),
      ],
    })
    expect(parseCreditReport(json, 'transunion').map(r => r.creditLimit)).toEqual([null, null])
  })

  it('keeps an account whose institution is missing', () => {
    const json = creditReport({ creditCards: [tradeline({ hash: 'x1', institution: null, balance: '1.00' })] })
    expect(parseCreditReport(json, 'transunion')[0].institution).toBeNull()
  })

  it('skips a tradeline whose balance is not a number rather than storing garbage', () => {
    const json = creditReport({ creditCards: [tradeline({ hash: 'bad', balance: 'abc' }), tradeline({ hash: 'ok', balance: '2.00' })] })
    expect(parseCreditReport(json, 'transunion').map(r => r.key)).toEqual(['cr:transunion:ok'])
  })

  it('skips a tradeline without an account number — there is nothing stable to key it by', () => {
    const json = creditReport({ creditCards: [tradeline({ hash: '', balance: '2.00' })] })
    expect(parseCreditReport(json, 'transunion')).toEqual([])
  })

  it('falls back to the category when the type is missing, and to a null as-of when the date is', () => {
    const t = { ...tradeline({ hash: 'bare', balance: '3.00' }) } as Record<string, unknown>
    delete t.accountType
    delete t.dateReported
    const [row] = parseCreditReport(creditReport({ creditCards: [t as ReturnType<typeof tradeline>] }), 'transunion')
    expect(row).toMatchObject({ type: 'credit_card', asOf: null })
  })

  it('tolerates a missing tradeline group', () => {
    const json = creditReport({ creditCards: [tradeline({ hash: 'c', balance: '1.00' })] })
    delete (json.data.creditReportsV2.creditReport.tradelines as Record<string, unknown>).studentLoans
    expect(parseCreditReport(json, 'transunion')).toHaveLength(1)
  })

  it('reports a GraphQL error that carries no message', () => {
    expect(() => parseCreditReport({ errors: [{}] }, 'transunion')).toThrow('getCreditReport failed: GraphQL error')
  })

  it('throws on a GraphQL error payload', () => {
    const json = { errors: [{ message: 'An error occurred.' }], data: { creditReportsV2: { creditReport: null } } }
    expect(() => parseCreditReport(json, 'transunion')).toThrow(/An error occurred/)
  })

  it('throws when the report is missing', () => {
    expect(() => parseCreditReport({ data: { creditReportsV2: { creditReport: null } } }, 'transunion'))
      .toThrow(/missing/i)
  })
})

describe('parseReportHistory', () => {
  const history = (node: unknown, bureau: 'transunion' | 'equifax' = 'transunion') => {
    const key = bureau === 'transunion' ? 'transunionReportHistory' : 'equifaxReportHistory'
    return { data: { creditReportsV2: { [key]: node } } }
  }

  it('sorts string dates newest first and trims them', () => {
    const parsed = parseReportHistory(history({
      reportDates: [' 2024-01-03T00:00:00Z ', '', '2024-03-01T00:00:00Z', 1, null, '2024-02-01T00:00:00Z'],
    }), 'transunion')
    expect(parsed.dates).toEqual(['2024-03-01T00:00:00Z', '2024-02-01T00:00:00Z', '2024-01-03T00:00:00Z'])
    expect(parsed.scores).toBeNull()
  })

  it('reads a single date string and a wrapped date list', () => {
    expect(parseReportHistory(history({ reportDates: '2024-04-01T00:00:00Z' }), 'transunion').dates)
      .toEqual(['2024-04-01T00:00:00Z'])
    expect(parseReportHistory(history({ reportDates: { values: ['2024-05-01T00:00:00Z'] } }), 'transunion').dates)
      .toEqual(['2024-05-01T00:00:00Z'])
  })

  it('reads scores on date objects, fills the rest from a parallel scores array, and lets scoreHistory win', () => {
    const parsed = parseReportHistory(history({
      reportDates: [
        { date: '2024-03-01T00:00:00Z', score: 1 },
        { date: '2024-02-01T00:00:00Z' },
        { nope: true },
      ],
      scores: [9, 8],
      scoreHistory: [
        { date: '2024-03-01T00:00:00Z', score: 700 },
        { reportDate: '2024-01-01T00:00:00Z', score: '650' },
      ],
    }), 'transunion')
    expect(parsed.scores).toEqual([
      { date: '2024-03-01T00:00:00Z', score: 700 },
      { date: '2024-02-01T00:00:00Z', score: 8 },
      { date: '2024-01-01T00:00:00Z', score: 650 },
    ])
  })

  it('keeps the first of two identical dates', () => {
    const parsed = parseReportHistory(history({
      reportDates: ['2024-02-01T00:00:00Z', '2024-02-01T00:00:00Z'],
      scores: [1, 2],
    }), 'transunion')
    expect(parsed.scores).toEqual([{ date: '2024-02-01T00:00:00Z', score: 1 }])
  })

  it('reads a nested scoreHistory when the outer object has no dates of its own', () => {
    expect(parseReportHistory(history({
      note: { plain: true },
      nested: { scoreHistory: [{ date: '2024-07-02T00:00:00Z', score: 701 }] },
    }), 'transunion').scores).toEqual([{ date: '2024-07-02T00:00:00Z', score: 701 }])
  })

  it('reads dates nested one level down, and a scoreHistory with no reportDates', () => {
    expect(parseReportHistory(history({
      count: 1,
      history: { reportDates: ['2024-06-01T00:00:00Z'] },
    }), 'transunion').dates).toEqual(['2024-06-01T00:00:00Z'])

    expect(parseReportHistory(history({
      scoreHistory: [{ value: '2024-07-01T00:00:00Z', score: { value: 711 } }],
    }), 'transunion').scores).toEqual([{ date: '2024-07-01T00:00:00Z', score: 711 }])
  })

  it('does not look inside a history whose reportDates key is present but empty', () => {
    expect(parseReportHistory(history({
      reportDates: [],
      history: { reportDates: ['2024-01-01T00:00:00Z'] },
    }), 'transunion').dates).toEqual([])
  })

  it('matches the bureau key case-insensitively and accepts the short aliases', () => {
    const tu = { data: { creditReportsV2: { other: 1, transUnionReportHistory: { reportDates: ['2024-08-01T00:00:00Z'] } } } }
    expect(parseReportHistory(tu, 'transunion').dates).toEqual(['2024-08-01T00:00:00Z'])
    const alias = { data: { creditReportsV2: { tuReportHistory: { reportDates: ['2024-08-02T00:00:00Z'] } } } }
    expect(parseReportHistory(alias, 'transunion').dates).toEqual(['2024-08-02T00:00:00Z'])
    const efx = { data: { creditReportsV2: { efxReportHistory: { reportDates: ['2024-08-03T00:00:00Z'] } } } }
    expect(parseReportHistory(efx, 'equifax').dates).toEqual(['2024-08-03T00:00:00Z'])
  })

  it('uses a generic history only when the bureau key is absent', () => {
    const generic = { data: { creditReportsV2: { creditReportHistory: { reportDates: ['2024-09-01T00:00:00Z'] } } } }
    expect(parseReportHistory(generic, 'transunion').dates).toEqual(['2024-09-01T00:00:00Z'])
    const emptyTu = {
      data: { creditReportsV2: {
        transunionReportHistory: { reportDates: [] },
        equifaxReportHistory: { reportDates: ['2024-09-02T00:00:00Z'] },
        creditReportHistory: { reportDates: ['2024-09-03T00:00:00Z'] },
      } },
    }
    expect(parseReportHistory(emptyTu, 'transunion').dates).toEqual([])
  })

  it('returns no dates for a null history, a history with no date fields, or a missing reports object', () => {
    expect(parseReportHistory(history(null), 'transunion').dates).toEqual([])
    expect(parseReportHistory(history({ __typename: 'X', count: 1 }), 'transunion').dates).toEqual([])
    expect(parseReportHistory({ data: { creditReportsV2: { other: 1 } } }, 'equifax').dates).toEqual([])
    expect(parseReportHistory({ data: { creditReportsV2: 1 } }, 'transunion').dates).toEqual([])
  })

  it('ignores a date wrapper that holds no array', () => {
    expect(parseReportHistory(history({ reportDates: { year: 2024 } }), 'transunion').dates).toEqual([])
  })
})

describe('scoreChange', () => {
  it('is null without a current score', () => {
    expect(scoreChange([])).toEqual({ since_previous: null, since_oldest: null })
    expect(scoreChange([{ score: null }])).toEqual({ since_previous: null, since_oldest: null })
  })

  it('subtracts the previous score and the oldest numeric score in the window', () => {
    expect(scoreChange([{ score: 700 }])).toEqual({ since_previous: null, since_oldest: null })
    expect(scoreChange([{ score: 700 }, { score: null }, { score: 680 }]))
      .toEqual({ since_previous: null, since_oldest: 20 })
    expect(scoreChange([{ score: 736 }, { score: 720 }, { score: 700 }]))
      .toEqual({ since_previous: 16, since_oldest: 36 })
    expect(scoreChange([{ score: 700 }, { score: null }])).toEqual({ since_previous: null, since_oldest: null })
  })
})

describe('parseCreditScore', () => {
  const report = (creditReport: Record<string, unknown>) => ({
    data: { creditReportsV2: { creditReport } },
  })

  it('reads a numeric score, label, model and pull date', () => {
    expect(parseCreditScore(report({
      score: 736,
      scoreLabel: 'Your Equifax score on Oct 14, 2026:',
      scoreModel: 'VantageScore 3.0',
      dateReportPulled: '2026-10-14T00:00:00.000Z',
    }), null)).toEqual({
      score: 736,
      label: 'Your Equifax score on Oct 14, 2026:',
      model: 'VantageScore 3.0',
      report_date: '2026-10-14T00:00:00.000Z',
    })
  })

  it('reads a score object and falls back to the date that was requested', () => {
    expect(parseCreditScore(report({
      score: { value: ' 720 ', model: 'VantageScore 3.0' },
      scoreText: 'label',
    }), '2024-02-01T00:00:00Z')).toMatchObject({ score: 720, label: 'label', model: 'VantageScore 3.0', report_date: '2024-02-01T00:00:00Z' })

    expect(parseCreditScore(report({
      score: { value: 'nope', score: 5 },
      reportDate: '2024-03-01T00:00:00Z',
    }), 'ignored')).toMatchObject({ score: 5, report_date: '2024-03-01T00:00:00Z', label: null, model: null })
  })

  it('accepts a currency-shaped score and a numeric string, and drops non-numbers', () => {
    expect(parseCreditScore(report({ score: { amount: '710' } }), '  ')).toMatchObject({ score: 710, report_date: null })
    expect(parseCreditScore(report({ score: ' 700 ' }), null)).toMatchObject({ score: 700, report_date: null })
    expect(parseCreditScore(report({ score: 'nope' }), null).score).toBeNull()
    expect(parseCreditScore(report({ score: Number.NaN }), null).score).toBeNull()
    expect(parseCreditScore(report({ score: { nope: true } }), null).score).toBeNull()
  })

  it('prefers the report model over the one nested on the score', () => {
    expect(parseCreditScore(report({
      score: { value: 1, model: 'nested' },
      model: 'outer',
    }), null).model).toBe('outer')
  })

  it('throws when the report object is missing', () => {
    expect(() => parseCreditScore({ data: { creditReportsV2: { creditReport: null } } }, null)).toThrow(/missing `creditReport`/)
    expect(() => parseCreditScore({ errors: [{ message: 'An error occurred.' }] }, null)).toThrow(/An error occurred/)
  })
})

describe('parseCreditReportDetails', () => {
  it('maps accounts, inquiries, collections, public records and buy-now-pay-later', () => {
    const json = creditReport({
      creditCards: [tradeline({
        hash: 'c1', institution: 'Example Card', balance: '1234.56', limit: '5000.00', dateReported: '2024-01-28',
      })],
      autoLoans: [tradeline({ hash: 'a1', accountType: 'Auto Loan', balance: '0.00' })],
    })
    const report = json.data.creditReportsV2.creditReport as Record<string, unknown>
    const card = (report.tradelines as { creditCards: Record<string, unknown>[] }).creditCards[0]
    Object.assign(card, {
      dateOpened: '2020-01-01',
      paymentStatus: 'Current',
      accountStatus: 'Open',
      times30DaysLate: 1,
      late60Days: '2',
      times90DaysLate: 0,
      paymentHistory: ['OK', { status: '30' }, '', { code: 'C' }, 4],
    })
    const loan = (report.tradelines as { autoLoans: Record<string, unknown>[] }).autoLoans[0]
    Object.assign(loan, { isOpen: false, dateClosed: '2023-01-01', currentBalance: -40, paymentHistory: 'OK' })
    ;(report.tradelines as Record<string, unknown>).studentLoans = null
    Object.assign(report, {
      score: 700,
      scoreLabel: 'score',
      hardInquiries: [
        { institution: { name: 'Example Auto' }, inquiryDate: '2024-01-02', inquiryType: 'Hard' },
        null,
        { type: 'Hard' },
      ],
      softInquiries: [{ name: 'Example Bank', date: '2024-01-03' }],
      collections: {
        items: [{
          agency: { name: 'Example Collections' },
          originalCreditor: 'Example Store',
          status: 'Unpaid',
          currentBalance: { amount: '150.00' },
          dateOpened: '2023-06-01',
        }, null, {}],
      },
      publicRecords: {
        type: 'Bankruptcy',
        status: 'Discharged',
        filedDate: '2019-01-01',
        amount: { amount: '0.00' },
        court: 'Example Court',
      },
      buyNowPayLater: [{ institutionName: 'Example BNPL', accountType: 'Pay in 4', currentBalance: { amount: '20.00' }, isOpen: true, openedDate: '2024-01-01' }],
    })

    const details = parseCreditReportDetails(json, 'equifax', '2024-02-01T00:00:00Z')
    expect(details.bureau).toBe('equifax')
    expect(details.score).toBe(700)
    expect(details.accounts.map(a => [a.institution, a.balance, a.utilization, a.is_open])).toEqual([
      ['Example Card', -1234.56, 24.7, true],
      ['Example Card Co', -40, null, false],
    ])
    expect(details.accounts[0]).toMatchObject({
      account_type: 'Credit Card',
      category: 'credit_card',
      account_status: 'Open',
      payment_status: 'Current',
      credit_limit: 5000,
      opened_date: '2020-01-01',
      reported_date: '2024-01-28',
      late_payments: { days_30: 1, days_60: 2, days_90: 0 },
      payment_history: 'OK,30,C',
    })
    expect(details.accounts[1]).toMatchObject({ balance: -40, closed_date: '2023-01-01', payment_history: 'OK' })
    expect(details.inquiries).toEqual([
      { name: 'Example Auto', date: '2024-01-02', type: 'Hard' },
      { name: 'Example Bank', date: '2024-01-03', type: 'soft' },
    ])
    expect(details.collections).toEqual([{
      agency: 'Example Collections',
      original_creditor: 'Example Store',
      status: 'Unpaid',
      balance: -150,
      opened_date: '2023-06-01',
      reported_date: null,
    }])
    expect(details.public_records).toEqual([{
      type: 'Bankruptcy',
      status: 'Discharged',
      filed_date: '2019-01-01',
      amount: 0,
      court: 'Example Court',
    }])
    expect(details.buy_now_pay_later).toEqual([expect.objectContaining({
      institution: 'Example BNPL', category: 'buy_now_pay_later', balance: -20, is_open: true,
    })])
  })

  it('reads alternate section shapes and skips empty rows', () => {
    const json = creditReport({})
    const report = json.data.creditReportsV2.creditReport as Record<string, unknown>
    delete report.tradelines
    Object.assign(report, {
      inquiries: {
        hard: [{ inquirerName: 'Hard Co', dateOfInquiry: '2024-01-01' }],
        soft: [{ subscriberName: 'Soft Co', inquiredOn: '2024-01-02' }],
        misc: [{ creditorName: 'Other Co', date: '2024-01-03' }],
        note: 'ignore',
      },
      collectionAccounts: [{ collectorName: 'Agency', originalCreditorName: 'Store', amount: 10, reportedDate: '2024-01-04' }],
      publicRecord: [{ recordType: 'Tax lien', courtName: 'Court', balance: '5.00', filingDate: '2024-01-05' }],
      bnplAccounts: { accounts: [{ creditor: { name: 'BNPL Co' }, creditLimit: 100, paymentPattern: [] }] },
      otherLoans: 'not-a-list',
    })
    const details = parseCreditReportDetails(json, 'transunion', null)
    expect(details.accounts).toEqual([])
    expect(details.inquiries.map(i => [i.name, i.type])).toEqual([
      ['Hard Co', 'hard'],
      ['Soft Co', 'soft'],
      ['Other Co', null],
    ])
    expect(details.collections[0]).toMatchObject({ agency: 'Agency', original_creditor: 'Store', balance: -10, reported_date: '2024-01-04' })
    expect(details.public_records[0]).toMatchObject({ type: 'Tax lien', court: 'Court', amount: -5, filed_date: '2024-01-05' })
    expect(details.buy_now_pay_later[0]).toMatchObject({ institution: 'BNPL Co', credit_limit: 100, payment_history: null })
  })

  it('does not list a top-level buy-now-pay-later group that the tradelines already carried', () => {
    const json = creditReport({})
    const tradelines = json.data.creditReportsV2.creditReport.tradelines as Record<string, unknown>
    tradelines.buyNowPayLater = [{ institution: 'Inside', currentBalance: { amount: '1.00' } }]
    const report = json.data.creditReportsV2.creditReport as Record<string, unknown>
    report.buyNowPayLater = [{ institution: 'Outside', currentBalance: { amount: '9.00' } }]
    report.creditInquiries = [{ name: 'One inquiry', date: '2024-01-01' }]
    report.inquiries = [{ name: 'Ignored because creditInquiries is set', date: '2024-01-02' }]
    const details = parseCreditReportDetails(json, 'transunion', null)
    expect(details.buy_now_pay_later.map(a => a.institution)).toEqual(['Inside'])
    expect(details.inquiries).toEqual([{ name: 'One inquiry', date: '2024-01-01', type: null }])
  })

  it('reads a single inquiry object and ignores a non-list inquiries value', () => {
    const json = creditReport({})
    const report = json.data.creditReportsV2.creditReport as Record<string, unknown>
    report.inquiries = { name: 'Solo', date: '2024-01-01' }
    expect(parseCreditReportDetails(json, 'transunion', null).inquiries).toEqual([
      { name: 'Solo', date: '2024-01-01', type: null },
    ])
    report.inquiries = { __typename: 'Empty' }
    expect(parseCreditReportDetails(json, 'transunion', null).inquiries).toEqual([])
    report.inquiries = 'nope'
    expect(parseCreditReportDetails(json, 'transunion', null).inquiries).toEqual([])
    report.hardInquiries = 5
    expect(parseCreditReportDetails(json, 'transunion', null).inquiries).toEqual([])
  })

  it('uses a raw account number balance and a string institution, and drops a blank payment history', () => {
    const json = creditReport({
      creditCards: [tradeline({ hash: 'c', balance: '10.00', limit: '0.00' })],
    })
    const card = (json.data.creditReportsV2.creditReport.tradelines as { creditCards: Record<string, unknown>[] }).creditCards[0]
    card.institution = 'String Lender'
    card.currentBalance = null
    card.balance = 15
    card.paymentHistory = '   '
    card.paymentStatus = ''
    card.payStatus = 'Late'
    const [row] = parseCreditReportDetails(json, 'transunion', null).accounts
    expect(row).toMatchObject({ institution: 'String Lender', balance: -15, credit_limit: null, utilization: null, payment_status: 'Late', payment_history: null })
  })

  it('drops empty account, inquiry and public-record rows and a blank lender name', () => {
    const json = creditReport({
      creditCards: [tradeline({ hash: 'c', balance: '1.00', limit: '10.00' }), null as unknown as ReturnType<typeof tradeline>, {} as ReturnType<typeof tradeline>],
    })
    const card = (json.data.creditReportsV2.creditReport.tradelines as { creditCards: Record<string, unknown>[] }).creditCards[0]
    card.institution = '   '
    const report = json.data.creditReportsV2.creditReport as Record<string, unknown>
    report.score = ''
    report.publicRecords = [null, {}, { publicRecordType: 'Judgment', dateFiled: '2020-01-01' }]
    report.collections = 4
    report.bnplAccounts = [null, { lenderName: 'Later Pay', creditMaximumAmount: 80, openDate: '2024-01-01' }]
    const details = parseCreditReportDetails(json, 'transunion', null)
    expect(details.accounts).toHaveLength(1)
    expect(details.accounts[0].institution).toBeNull()
    expect(details.score).toBeNull()
    expect(details.public_records).toEqual([expect.objectContaining({ type: 'Judgment', filed_date: '2020-01-01' })])
    expect(details.collections).toEqual([])
    expect(details.buy_now_pay_later.map(a => a.institution)).toEqual(['Later Pay'])
    expect(details.buy_now_pay_later[0].credit_limit).toBe(80)
  })

  it('throws on a GraphQL error and on a missing report', () => {
    expect(() => parseCreditReportDetails({ errors: [{}] }, 'transunion', null)).toThrow('getCreditReport failed: GraphQL error')
    expect(() => parseCreditReportDetails({ data: {} }, 'transunion', null)).toThrow(/missing `creditReport`/)
  })
})
