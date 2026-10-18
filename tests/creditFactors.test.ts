import { describe, it, expect } from 'vitest'
import { deriveCreditFactors, FACTOR_THRESHOLDS, VANTAGE_SCORE_30_WEIGHTS } from '../src/creditFactors.js'
import type { CreditReportDetails, ReportAccount } from '../src/creditReport.js'

function account(partial: Partial<ReportAccount> & Pick<ReportAccount, 'category'>): ReportAccount {
  return {
    institution: null,
    account_type: null,
    is_open: true,
    account_status: null,
    payment_status: null,
    balance: null,
    credit_limit: null,
    utilization: null,
    opened_date: null,
    closed_date: null,
    reported_date: null,
    late_payments: null,
    payment_history: null,
    ...partial,
  }
}

function report(partial: Partial<CreditReportDetails> = {}): CreditReportDetails {
  return {
    bureau: 'equifax',
    score: 736,
    score_label: null,
    score_model: null,
    report_date: '2024-10-14T00:00:00.000Z',
    accounts: [],
    inquiries: [],
    collections: [],
    public_records: [],
    buy_now_pay_later: [],
    ...partial,
  }
}

describe('deriveCreditFactors', () => {
  it('derives utilization, history, age, mix, inquiries and derogatory marks', () => {
    const factors = deriveCreditFactors(report({
      accounts: [
        account({
          category: 'credit_card', institution: 'Visa', balance: -100, credit_limit: 2000,
          opened_date: '2010-01-14', payment_history: 'Current, OK',
          late_payments: { days_30: 1, days_60: 0, days_90: null },
        }),
        account({
          category: 'credit_card', institution: 'High', balance: -600, credit_limit: 1000,
          opened_date: '2020-01-31', payment_history: '2024-10:Current,2024-09:Late,no data,2024-08:',
        }),
        account({
          category: 'credit_card', institution: 'Also High', balance: -60, credit_limit: 100,
          opened_date: 'nope',
        }),
        account({
          category: 'credit_card', institution: 'No Limit', balance: -20, credit_limit: null,
        }),
        account({
          category: 'credit_card', institution: 'No Balance', balance: null, credit_limit: 500,
        }),
        account({
          category: 'credit_card', institution: 'Negative Limit', balance: -10, credit_limit: -5,
        }),
        account({
          category: 'credit_card', institution: 'Closed Card', balance: -1, credit_limit: 50,
          is_open: false, opened_date: '2001-01-01', payment_history: 'OK,30,C',
        }),
        account({
          category: 'auto_loan', institution: 'Auto', balance: -4000, opened_date: '2022-06-01',
        }),
        account({
          category: 'other_loan', institution: 'Unknown', is_open: null, opened_date: '2000-01-01',
        }),
        account({
          category: 'credit_card', institution: 'Future', opened_date: '2025-01-01', balance: 0, credit_limit: 100,
        }),
      ],
      inquiries: [
        { name: 'In 6', date: '2024-04-14', type: 'hard' },
        { name: 'In 12', date: '2024-04-13', type: null },
        { name: 'In 24', date: '2023-10-13', type: ' HARD ' },
        { name: 'Older', date: '2022-10-13', type: 'hard' },
        { name: 'Soft', date: '2024-09-01', type: 'soft' },
        { name: 'Other', date: '2024-09-01', type: 'review' },
        { name: 'Undated', date: null, type: null },
        { name: 'Blank', date: '   ', type: 'hard' },
        { name: 'Bad day', date: '2024-02-31', type: 'hard' },
      ],
      collections: [{
        agency: 'Agency', original_creditor: null, status: null, balance: -10,
        opened_date: null, reported_date: null,
      }],
      public_records: [{
        type: 'Tax lien', status: null, filed_date: null, amount: null, court: null,
      }],
    }))

    expect(factors.bureau).toBe('equifax')
    expect(factors.score).toBe(736)
    expect(factors.utilization).toMatchObject({
      rating: 'good',
      ck_grade: null,
      impact_weight: 20,
      impact_factor: 'Credit utilization',
      overall_percent: 23.8,
      highest_card_percent: 60,
      highest_card: 'High',
      total_balance: -760,
      total_limit: 3200,
    })
    expect(factors.utilization.cards.map(card => [card.institution, card.utilization])).toEqual([
      ['Visa', 5],
      ['High', 60],
      ['Also High', 60],
      ['No Limit', null],
      ['No Balance', null],
      ['Negative Limit', null],
      ['Future', 0],
    ])
    expect(factors.payment_history).toMatchObject({
      rating: 'poor',
      impact_weight: 40,
      on_time_percent: 71.4,
      months_on_time: 5,
      months_late: 2,
      days_30: 1,
      days_60: 0,
      days_90: 0,
    })
    expect(factors.credit_age).toMatchObject({
      rating: 'good',
      impact_weight: 21,
      impact_factor: 'Age and type of credit',
      average_open_months: 87,
      oldest_open_months: 177,
      newest_open_months: 28,
      average_open_years: 7.3,
      oldest_open_years: 14.8,
      newest_open_years: 2.3,
    })
    expect(factors.accounts).toMatchObject({
      rating: 'good',
      total: 10,
      open: 8,
      closed: 1,
      unknown_open: 1,
      revolving_open: 7,
      revolving_total: 8,
      installment_open: 1,
      installment_total: 2,
    })
    expect(factors.inquiries).toMatchObject({
      rating: 'good',
      impact_weight: 5,
      impact_factor: 'Recent credit',
      last_6_months: 1,
      last_12_months: 2,
      last_24_months: 3,
      newest_date: '2024-04-14',
      undated: 3,
    })
    expect(factors.derogatory_marks).toEqual({
      rating: 'poor',
      ck_grade: null,
      impact_weight: null,
      impact_factor: null,
      impact_note: expect.stringContaining('payment history'),
      count: 2,
      collections: 1,
      public_records: 1,
    })
    expect(factors.utilization.ck_grade).toBeNull()
    expect(factors.accounts.impact_note).toBe(factors.credit_age.impact_note)
  })

  it('rates an empty report, and still names the newest inquiry when the report date is missing', () => {
    const empty = deriveCreditFactors(report({ report_date: null, score: null }))
    expect(empty.utilization).toMatchObject({
      rating: null, overall_percent: null, highest_card_percent: null, highest_card: null,
      total_balance: null, total_limit: null, cards: [],
    })
    expect(empty.payment_history).toMatchObject({
      rating: null, on_time_percent: null, months_on_time: 0, months_late: 0,
      days_30: null, days_60: null, days_90: null,
    })
    expect(empty.credit_age.rating).toBeNull()
    expect(empty.credit_age.average_open_years).toBeNull()
    expect(empty.accounts).toMatchObject({ rating: 'poor', total: 0, revolving_open: 0, installment_open: 0 })
    expect(empty.inquiries).toMatchObject({
      rating: null, last_6_months: null, last_12_months: null, last_24_months: null, newest_date: null, undated: 0,
    })
    expect(empty.derogatory_marks).toMatchObject({ rating: 'excellent', count: 0, impact_weight: null })

    const undatedReport = deriveCreditFactors(report({
      report_date: 'not-a-date',
      inquiries: [{ name: 'Later', date: '2024-05-02', type: 'hard' }, { name: 'Earlier', date: '2020-01-01', type: '' }],
    }))
    expect(undatedReport.inquiries).toMatchObject({
      rating: null, last_12_months: null, newest_date: '2024-05-02', undated: 0,
    })
    expect(deriveCreditFactors(report({ report_date: '2024-02-31' })).credit_age.rating).toBeNull()
  })

  it('applies the documented rating bands', () => {
    const asOf = '2024-10-14'
    const card = (balance: number, limit: number) => deriveCreditFactors(report({
      report_date: asOf,
      accounts: [account({ category: 'credit_card', balance: -balance, credit_limit: limit })],
    })).utilization.rating
    expect(card(9, 100)).toBe('excellent')
    expect(card(10, 100)).toBe('good')
    expect(card(299, 1000)).toBe('good')
    expect(card(30, 100)).toBe('fair')
    expect(card(499, 1000)).toBe('fair')
    expect(card(50, 100)).toBe('poor')

    const history = (months: string) => deriveCreditFactors(report({
      accounts: [account({ category: 'credit_card', payment_history: months })],
    })).payment_history.rating
    expect(history('OK')).toBe('excellent')
    expect(history(`${Array(99).fill('OK').join(',')},30`)).toBe('good')
    expect(history(`${Array(9).fill('C').join(',')},60 days`)).toBe('fair')
    expect(history(`${Array(8).fill('paid').join(',')},180`)).toBe('poor')
    expect(history('no data,X')).toBeNull()

    const age = (opened: string) => deriveCreditFactors(report({
      report_date: asOf,
      accounts: [account({ category: 'student_loan', opened_date: opened })],
    })).credit_age.rating
    expect(age('2015-10-14')).toBe('excellent')
    expect(age('2015-10-15')).toBe('good')
    expect(age('2017-10-14')).toBe('good')
    expect(age('2017-10-15')).toBe('fair')
    expect(age('2021-10-14')).toBe('fair')
    expect(age('2022-10-15')).toBe('poor')

    const mix = (categories: ReportAccount['category'][]) => deriveCreditFactors(report({
      accounts: categories.map(category => account({ category })),
    })).accounts.rating
    expect(mix(['credit_card'])).toBe('fair')
    expect(mix(['real_estate_loan'])).toBe('fair')
    expect(mix([])).toBe('poor')

    const inquiries = (count: number) => deriveCreditFactors(report({
      report_date: asOf,
      inquiries: Array.from({ length: count }, () => ({ name: 'Pull', date: '2024-06-01', type: 'hard' as const })),
    })).inquiries
    expect(inquiries(0)).toMatchObject({ rating: 'excellent', last_6_months: 0, last_12_months: 0, last_24_months: 0 })
    expect(inquiries(1).rating).toBe('good')
    expect(inquiries(2).rating).toBe('good')
    expect(inquiries(3).rating).toBe('fair')
    expect(inquiries(4).rating).toBe('fair')
    expect(inquiries(5).rating).toBe('poor')

    expect(FACTOR_THRESHOLDS.utilization.excellent).toBe('under 10%')
    expect(FACTOR_THRESHOLDS.hard_inquiries.poor).toBe('5 or more')
    expect(FACTOR_THRESHOLDS.derogatory_marks.good).toBe('not used')
    expect(VANTAGE_SCORE_30_WEIGHTS.payment_history
      + VANTAGE_SCORE_30_WEIGHTS.age_and_type_of_credit
      + VANTAGE_SCORE_30_WEIGHTS.credit_utilization
      + VANTAGE_SCORE_30_WEIGHTS.balances
      + VANTAGE_SCORE_30_WEIGHTS.recent_credit
      + VANTAGE_SCORE_30_WEIGHTS.available_credit).toBe(100)
  })

  it('skips blank payment-history tokens and treats a missing late count as zero', () => {
    const factors = deriveCreditFactors(report({
      accounts: [account({
        category: 'credit_card',
        payment_history: 'OK,, ,',
        late_payments: { days_30: null, days_60: null, days_90: 1 },
      })],
    }))
    expect(factors.payment_history).toMatchObject({
      months_on_time: 1,
      months_late: 0,
      on_time_percent: 100,
      days_30: 0,
      days_60: 0,
      days_90: 1,
    })
  })

  it('counts a month-end report date back across a shorter month', () => {
    const factors = deriveCreditFactors(report({
      report_date: '2024-03-31',
      inquiries: [
        { name: 'Inside', date: '2023-09-30', type: 'hard' },
        { name: 'Outside', date: '2023-09-29', type: 'hard' },
      ],
    }))
    expect(factors.inquiries).toMatchObject({ last_6_months: 1, last_12_months: 2, last_24_months: 2 })
  })
})
