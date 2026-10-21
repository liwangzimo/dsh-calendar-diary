/**
 * Unit tests for the data layer. Pure functions, no I/O — so this runs anywhere.
 *
 * The anchors 46351 / 41535 are not invented: they were read out of a real
 * DesktopCal export (sheet DesktopCal, A1 = 46351 displayed as 11/25/26; the
 * last row A1849 = 41535 = 2013-09-18).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DATE_FORMAT,
  SHEET_NAME,
  detectColumns,
  entriesInMonth,
  filterByScope,
  isoFromSerial,
  isValidYmd,
  monthsWithEntries,
  normalizeEntries,
  parseDateCell,
  parseImportMatrix,
  planImport,
  removeEntry,
  serialFromIso,
  serialFromYmd,
  sortDesc,
  toSheetRows,
  upsertEntry,
  ymdFromIso,
} from '../diary-store.js'

test('format constants match the original file', () => {
  assert.equal(SHEET_NAME, 'DesktopCal')
  assert.equal(DATE_FORMAT, 'm/d/yy')
})

test('serials read out of the real file convert to the right dates', () => {
  assert.equal(isoFromSerial(46351), '2026-11-25')
  assert.equal(isoFromSerial(41535), '2013-09-18')
  assert.equal(isoFromSerial(46344), '2026-11-18')
})

test('serial -> ISO -> serial round-trips over the file\'s whole span', () => {
  for (let serial = 41535; serial <= 46351; serial += 7) {
    const iso = isoFromSerial(serial)
    assert.ok(iso, `serial ${serial} should convert`)
    assert.equal(serialFromIso(iso), serial, `round trip for ${iso}`)
  }
})

test('ISO -> serial matches the measurement for both anchors', () => {
  assert.equal(serialFromIso('2026-11-25'), 46351)
  assert.equal(serialFromIso('2013-09-18'), 41535)
  assert.equal(serialFromIso('2026-10-21'), serialFromYmd(2026, 10, 21))
})

test('impossible serials and dates are refused instead of guessed', () => {
  assert.equal(isoFromSerial(0), null)
  assert.equal(isoFromSerial(60), null) // Excel's non-existent 1900-02-29
  assert.equal(isoFromSerial(3000000), null)
  assert.equal(isoFromSerial('46351'), null)
  assert.equal(isoFromSerial(Number.NaN), null)
  assert.equal(serialFromIso('2026-02-30'), null)
  assert.equal(serialFromIso('not a date'), null)
  assert.equal(serialFromIso(''), null)
  assert.deepEqual(ymdFromIso('2026-2-3'), { year: 2026, month: 2, day: 3 }) // permissive on purpose
  assert.equal(ymdFromIso('2026-13-01'), null)
  assert.equal(ymdFromIso('2026-11-31'), null)
  assert.equal(isValidYmd(2024, 2, 29), true)
  assert.equal(isValidYmd(2023, 2, 29), false)
})

test('every date notation the import may meet is understood', () => {
  assert.deepEqual(parseDateCell(46351), { serial: 46351, iso: '2026-11-25' })
  assert.deepEqual(parseDateCell('2026-11-25'), { serial: 46351, iso: '2026-11-25' })
  assert.deepEqual(parseDateCell('2026/11/25'), { serial: 46351, iso: '2026-11-25' })
  assert.deepEqual(parseDateCell('2026.11.25'), { serial: 46351, iso: '2026-11-25' })
  assert.equal(parseDateCell('11/25/26')?.iso, '2026-11-25') // the file's own display form
  assert.equal(parseDateCell('11/25/2026')?.iso, '2026-11-25')
  assert.equal(parseDateCell('2026年11月25日')?.iso, '2026-11-25')
  assert.equal(parseDateCell(' 2026-11-25 ')?.iso, '2026-11-25')
  assert.equal(parseDateCell('46351')?.iso, '2026-11-25')
  assert.equal(parseDateCell('下午三点，开例会'), null)
  assert.equal(parseDateCell(''), null)
  assert.equal(parseDateCell(null), null)
})

test('normalizeEntries sorts descending, reports damage and keeps empty text', () => {
  const { entries, issues } = normalizeEntries([
    { a: 41535, b: '最旧' },
    { a: 46351, b: '最新' },
    { a: '没有日期', b: 'x' },
    { a: 46351, b: '重复的一天' },
    { a: 46344, b: '' },
  ])
  assert.deepEqual(
    entries.map((entry) => entry.date),
    ['2026-11-25', '2026-11-18', '2013-09-18'],
  )
  assert.equal(entries[0].text, '最新') // first wins on a duplicate
  assert.equal(entries[1].text, '') // empty text is still a row
  assert.deepEqual(
    issues.map((issue) => issue.code).sort(),
    ['duplicate-date', 'invalid-date'],
  )
})

test('upsert inserts in order, replaces in place, and clears with empty text', () => {
  const base = normalizeEntries([
    { a: 46351, b: 'A' },
    { a: 46344, b: 'B' },
  ]).entries

  const inserted = upsertEntry(base, { date: '2026-11-20', text: '中间' })
  assert.deepEqual(
    inserted.map((entry) => entry.date),
    ['2026-11-25', '2026-11-20', '2026-11-18'],
  )

  const replaced = upsertEntry(base, { date: '2026-11-18', text: 'B2' })
  assert.equal(replaced.length, 2)
  assert.equal(replaced.find((entry) => entry.date === '2026-11-18').text, 'B2')

  const cleared = upsertEntry(base, { date: '2026-11-18', text: '' })
  assert.equal(cleared.find((entry) => entry.date === '2026-11-18').text, '')
  assert.equal(cleared.length, 2) // clearing keeps the row

  assert.throws(() => upsertEntry(base, { date: '2026-02-30', text: 'x' }))
})

test('remove deletes the row; month helpers and scope filters behave', () => {
  const { entries } = normalizeEntries([
    { a: 46351, b: 'A' },
    { a: 46344, b: 'B' },
    { a: 46200, b: 'C' },
  ])
  const left = removeEntry(entries, '2026-11-25')
  assert.deepEqual(
    left.map((entry) => entry.date).sort(),
    ['2026-11-18', isoFromSerial(46200)].sort(),
  )

  assert.deepEqual(entriesInMonth(entries, '2026-11').map((entry) => entry.date), [
    '2026-11-25',
    '2026-11-18',
  ])
  assert.deepEqual(entriesInMonth(entries, '2026-11-xx'), [])
  assert.deepEqual(monthsWithEntries(entries), ['2026-11', isoFromSerial(46200).slice(0, 7)].sort().reverse())
  assert.equal(filterByScope(entries, 'all').length, 3)
  assert.equal(filterByScope(entries, 'year', 2026).length, 3)
  assert.equal(filterByScope(entries, 'month', '2026-11').length, 2)
})

test('rows written back are serial + text, date-descending', () => {
  const { entries } = normalizeEntries([
    { a: 41535, b: 'old' },
    { a: 46351, b: '新\r\n第二行' },
  ])
  assert.deepEqual(toSheetRows(entries), [
    [46351, '新\r\n第二行'],
    [41535, 'old'],
  ])
  assert.equal(sortDesc(entries)[0].serial, 46351)
})

test('column detection copes with both orders and refuses a dateless sheet', () => {
  const forward = detectColumns([
    ['日期', '内容'],
    [46351, 'A'],
    [46344, 'B'],
  ])
  assert.deepEqual(forward, { dateCol: 0, textCol: 1, hasHeader: true, dateRatio: 1 })

  const swapped = detectColumns([
    ['A', 46351],
    ['B', 46344],
  ])
  assert.equal(swapped.dateCol, 1)
  assert.equal(swapped.textCol, 0)
  assert.equal(swapped.hasHeader, false)

  const textDates = detectColumns([
    ['2026/11/25', 'A'],
    ['2026/11/18', 'B'],
  ])
  assert.equal(textDates.dateCol, 0)

  assert.equal(detectColumns([['只有', '文字'], ['还是', '文字']]), null)
  assert.equal(detectColumns([]), null)
})

test('parseImportMatrix skips a header and refuses an unrecognizable sheet', () => {
  const good = parseImportMatrix([
    ['日期', '内容'],
    [46351, 'A'],
    [46344, 'B'],
  ])
  assert.equal(good.detection.hasHeader, true)
  assert.deepEqual(good.entries.map((entry) => entry.date), ['2026-11-25', '2026-11-18'])

  const bad = parseImportMatrix([['只有', '文字']])
  assert.equal(bad.detection, null)
  assert.equal(bad.entries.length, 0)
  assert.equal(bad.issues[0].code, 'no-date-column')
})

test('import conflicts follow the chosen policy', () => {
  const current = normalizeEntries([
    { a: 46351, b: '原文本' },
    { a: 46344, b: '只有我有' },
  ]).entries
  const incoming = normalizeEntries([
    { a: 46351, b: '新文本' },
    { a: 46300, b: '只有导入有' },
  ]).entries

  const kept = planImport({ current, incoming, policy: 'keep' })
  assert.deepEqual(kept.report.conflicts.map((item) => item.resolution), ['keep'])
  assert.equal(kept.entries.find((entry) => entry.date === '2026-11-25').text, '原文本')
  assert.equal(kept.report.added.length, 1)

  const overwritten = planImport({ current, incoming, policy: 'overwrite' })
  assert.equal(overwritten.entries.find((entry) => entry.date === '2026-11-25').text, '新文本')

  const concatenated = planImport({ current, incoming, policy: 'concat' })
  assert.equal(
    concatenated.entries.find((entry) => entry.date === '2026-11-25').text,
    '新文本\r\n原文本',
  )

  const skipped = planImport({ current, incoming, policy: 'skip' })
  assert.deepEqual(skipped.report.skipped, ['2026-11-25'])
  assert.equal(skipped.entries.find((entry) => entry.date === '2026-11-25').text, '原文本')

  const unknown = planImport({ current, incoming, policy: 'nonsense' })
  assert.equal(unknown.report.policy, 'keep')
  assert.equal(unknown.entries.length, 3) // nothing is ever lost
})

test('importing what this diary exports changes nothing (idempotent)', () => {
  const current = normalizeEntries([
    { a: 46351, b: 'A' },
    { a: 46344, b: 'B' },
    { a: 41535, b: '' },
  ]).entries
  const incoming = normalizeEntries(toSheetRows(current)).entries
  const { entries, report } = planImport({ current, incoming, policy: 'keep' })
  assert.deepEqual(report.added, [])
  assert.deepEqual(report.conflicts, [])
  assert.equal(report.unchanged, 3)
  assert.deepEqual(toSheetRows(entries), toSheetRows(current))
})
