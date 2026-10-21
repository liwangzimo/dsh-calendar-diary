/**
 * dsh-calendar-diary — the data layer.
 *
 * Pure functions only: no filesystem, no network, no clock, no randomness. The
 * Host half, the CLI tools and the tests all run exactly this code, so the
 * on-disk contract has one implementation.
 *
 * The on-disk shape is the DesktopCal layout (measured against a real
 * DesktopCal export):
 *   - one sheet named `DesktopCal` (`SHEET_NAME`)
 *   - column A: an integer Excel date serial (1900 system) carrying the number
 *     format `m/d/yy` (`DATE_FORMAT`) — never a Date object, because reading
 *     serials through `cellDates:true` is off by one day
 *   - column B: free text, multi-line (`\r\n`) allowed, time written inside it
 *   - rows ordered date-descending, at most one row per date
 */

/** The single sheet name used by the data file. */
export const SHEET_NAME = 'DesktopCal'

/** Column A number format, copied from the original file so it keeps looking the same. */
export const DATE_FORMAT = 'm/d/yy'

/** Conflict resolutions accepted by `planImport`. */
export const CONFLICT_POLICIES = ['keep', 'overwrite', 'concat', 'skip']

/** Largest serial accepted (9999-12-31 in the Excel 1900 system). */
const MAX_SERIAL = 2958465

/** Day in milliseconds; all date arithmetic here is UTC so no zone can shift a day. */
const DAY_MS = 86400000

/** Excel 1900-system epoch used for serials >= 61 (1900-03-01 and later). */
const EPOCH_FOR_MODERN = Date.UTC(1899, 11, 30)

/** Excel 1900-system epoch used for serials 1..59 (1900-01-01 .. 1900-02-28). */
const EPOCH_FOR_EARLY = Date.UTC(1899, 11, 31)

/** 1900-03-01, the first date after Excel's non-existent leap day. */
const FIRST_DAY_AFTER_LEAP_BUG = Date.UTC(1900, 2, 1)

const ISO_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/
const YMD_SLASH_RE = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/
const MDY_SLASH_RE = /^(\d{1,2})[/.](\d{1,2})[/.](\d{2}|\d{4})$/
const CN_RE = /^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日$/
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

const pad2 = (value) => String(value).padStart(2, '0')

/** True for a Gregorian leap year. */
export function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

/** Real calendar day count for a month, February included. */
export function daysInMonth(year, month) {
  if (month === 2 && isLeapYear(year)) return 29
  return DAYS_IN_MONTH[month - 1] ?? 0
}

/** True when `year-month-day` is a real calendar date. */
export function isValidYmd(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false
  if (year < 1900 || year > 9999) return false
  if (month < 1 || month > 12) return false
  return day >= 1 && day <= daysInMonth(year, month)
}

/** `2026-11-25` from its parts. */
export function isoFromYmd(year, month, day) {
  return `${year}-${pad2(month)}-${pad2(day)}`
}

/**
 * Parse an ISO calendar date.
 * @returns {{year:number,month:number,day:number}|null} parts, or null when invalid.
 */
export function ymdFromIso(iso) {
  if (typeof iso !== 'string') return null
  const match = ISO_RE.exec(iso.trim())
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  return isValidYmd(year, month, day) ? { year, month, day } : null
}

/**
 * Convert an Excel 1900-system date serial to `YYYY-MM-DD`.
 * @param {number} serial - Integer serial as stored in column A.
 * @returns {string|null} ISO date, or null when the serial is not a real date.
 */
export function isoFromSerial(serial) {
  if (typeof serial !== 'number' || !Number.isFinite(serial)) return null
  const value = Math.round(serial)
  if (value < 1 || value > MAX_SERIAL) return null
  // Excel's 1900 system contains a non-existent 1900-02-29 at serial 60.
  if (value === 60) return null
  const ms = (value < 60 ? EPOCH_FOR_EARLY : EPOCH_FOR_MODERN) + value * DAY_MS
  const date = new Date(ms)
  return isoFromYmd(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())
}

/**
 * Convert `YYYY-MM-DD` to an Excel 1900-system date serial.
 * @returns {number|null} the serial as an integer, or null when not a real date.
 */
export function serialFromIso(iso) {
  const parts = ymdFromIso(iso)
  return parts ? serialFromYmd(parts.year, parts.month, parts.day) : null
}

/** Serial for calendar parts, honouring Excel's 1900 leap-year bug. */
export function serialFromYmd(year, month, day) {
  if (!isValidYmd(year, month, day)) return null
  const ms = Date.UTC(year, month - 1, day)
  let serial = Math.round((ms - EPOCH_FOR_MODERN) / DAY_MS)
  if (ms < FIRST_DAY_AFTER_LEAP_BUG) serial -= 1
  return serial >= 1 ? serial : null
}

/**
 * Read a date out of a raw cell value, whichever shape the source file used.
 * Accepts: a numeric serial, `YYYY-MM-DD`, `YYYY/M/D`, `YYYY.M.D`, `M/D/YY(YY)`
 * (the display form of this very data file), `YYYY年M月D日`, and a bare 5-digit
 * serial written as text.
 * @returns {{serial:number,iso:string}|null} normalized date, or null.
 */
export function parseDateCell(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const serial = Math.round(value)
    const iso = isoFromSerial(serial)
    return iso ? { serial, iso } : null
  }
  if (typeof value === 'string') {
    const raw = value.trim()
    if (raw === '') return null

    const fromParts = (year, month, day) => {
      const serial = serialFromYmd(year, month, day)
      return serial === null ? null : { serial, iso: isoFromYmd(year, month, day) }
    }

    const iso = ISO_RE.exec(raw)
    if (iso) return fromParts(Number(iso[1]), Number(iso[2]), Number(iso[3]))

    const ymd = YMD_SLASH_RE.exec(raw)
    if (ymd) return fromParts(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]))

    const cn = CN_RE.exec(raw)
    if (cn) return fromParts(Number(cn[1]), Number(cn[2]), Number(cn[3]))

    const mdy = MDY_SLASH_RE.exec(raw)
    if (mdy) {
      const year = mdy[3].length === 2 ? 2000 + Number(mdy[3]) : Number(mdy[3])
      return fromParts(year, Number(mdy[1]), Number(mdy[2]))
    }

    if (/^\d{4,5}$/.test(raw)) {
      const numeric = Number(raw)
      const isoFromNumber = isoFromSerial(numeric)
      if (isoFromNumber) return { serial: numeric, iso: isoFromNumber }
    }
  }
  return null
}

/** Normalize the text cell: null/undefined become '', everything else a string. */
export function textFromCell(value) {
  if (value === null || value === undefined) return ''
  return typeof value === 'string' ? value : String(value)
}

/** One entry: `{ serial, date, text }`, sorted date-descending. */
function makeEntry(serial, date, text) {
  return { serial, date, text: textFromCell(text) }
}

/** Copy of `entries` ordered date-descending (stable for distinct dates). */
export function sortDesc(entries) {
  return [...entries].sort((left, right) => right.serial - left.serial)
}

/**
 * Turn raw two-cell rows into entries.
 * @param {Array<{a:*,b:*}>|Array<Array<*>>} rows - rows as `{a,b}` or `[a,b]`.
 * @returns {{entries:Array<object>, issues:Array<{row:number,code:string,detail?:string}>}}
 *   entries date-descending; issues never throw, they are reported.
 */
export function normalizeEntries(rows) {
  const issues = []
  const byIso = new Map()
  rows.forEach((row, index) => {
    const a = Array.isArray(row) ? row[0] : row?.a
    const b = Array.isArray(row) ? row[1] : row?.b
    const parsed = parseDateCell(a)
    if (!parsed) {
      issues.push({ row: index, code: 'invalid-date', detail: String(a ?? '') })
      return
    }
    if (byIso.has(parsed.iso)) {
      issues.push({ row: index, code: 'duplicate-date', detail: parsed.iso })
      return
    }
    byIso.set(parsed.iso, makeEntry(parsed.serial, parsed.iso, b))
  })
  return { entries: sortDesc([...byIso.values()]), issues }
}

/**
 * Insert or replace one day's text.
 * @param {Array<object>} entries - current entries.
 * @param {{date?:string,serial?:number,text:string}} change - day to write.
 * @returns {Array<object>} a new, date-descending array.
 */
export function upsertEntry(entries, change) {
  const parsed = change?.date
    ? parseDateCell(change.date)
    : parseDateCell(change?.serial)
  if (!parsed) throw new Error('upsertEntry: a valid date or serial is required')
  const text = textFromCell(change.text)
  const next = entries.filter((entry) => entry.date !== parsed.iso)
  next.push(makeEntry(parsed.serial, parsed.iso, text))
  return sortDesc(next)
}

/** Remove one day entirely (the row disappears from the file). */
export function removeEntry(entries, date) {
  const parsed = parseDateCell(date)
  if (!parsed) return [...entries]
  return entries.filter((entry) => entry.date !== parsed.iso)
}

/** Entries of one month (`YYYY-MM`), date-descending. */
export function entriesInMonth(entries, month) {
  if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) return []
  return sortDesc(entries.filter((entry) => entry.date.startsWith(`${month}-`)))
}

/** Distinct months that hold entries, newest first. */
export function monthsWithEntries(entries) {
  const months = new Set(entries.map((entry) => entry.date.slice(0, 7)))
  return [...months].sort().reverse()
}

/**
 * Entries limited to an export scope.
 *
 * TYPE CONTRACT — the fallback is not a filter: only `('year', integer)` and
 * `('month', 'YYYY-MM' string)` narrow anything. Any other scope, or a value of
 * the wrong type, returns the WHOLE list. Callers must validate their own input
 * first (see `exportDiary` in diary-io.js); never rely on this to reject a typo.
 */
export function filterByScope(entries, scope = 'all', value) {
  if (scope === 'year' && Number.isInteger(value)) {
    return entries.filter((entry) => entry.date.startsWith(`${value}-`))
  }
  if (scope === 'month' && typeof value === 'string') {
    return entriesInMonth(entries, value)
  }
  return [...entries]
}

/**
 * Sheet rows ready to be written: `[[serial, text], ...]`, date-descending.
 * Serial stays an integer and the text keeps its own line breaks.
 */
export function toSheetRows(entries) {
  return sortDesc(entries).map((entry) => [entry.serial, entry.text])
}

/** Words that mark a header row. Matched by equality or prefix — never with `\b`,
 *  which does not treat CJK characters as word characters. */
const HEADER_WORDS = [
  '日期', '时间', '内容', '备注', '记录', '说明', '事项', '事情', '日程', '日记',
  'date', 'day', 'content', 'note', 'text', 'entry', 'diary', 'event', 'title',
]

/** True when a cell reads like a column label rather than a value. */
function isHeaderWord(value) {
  const text = String(value ?? '').trim().toLowerCase()
  if (text === '' || text.length > 12) return false
  return HEADER_WORDS.some((word) => text === word || text.startsWith(word))
}

/**
 * Work out which column holds dates in an arbitrary import matrix.
 *
 * The ratio is reported over the data rows only, so a header row cannot make a
 * clean sheet look unreliable.
 *
 * @param {Array<Array<*>>} matrix - rows of raw cell values.
 * @returns {{dateCol:number,textCol:number,hasHeader:boolean,dateRatio:number}|null}
 *   null when no column looks like dates at all (the caller must refuse, not guess).
 */
export function detectColumns(matrix) {
  const rows = (matrix ?? []).filter((row) => Array.isArray(row))
  if (rows.length === 0) return null
  const columns = Math.min(
    6,
    rows.reduce((widest, row) => Math.max(widest, row.length), 0),
  )
  if (columns === 0) return null

  const scored = []
  for (let column = 0; column < columns; column += 1) {
    let filled = 0
    let dated = 0
    for (const row of rows) {
      const value = row[column]
      if (value === null || value === undefined || value === '') continue
      filled += 1
      if (parseDateCell(value)) dated += 1
    }
    scored.push({ column, filled, dated, ratio: filled === 0 ? 0 : dated / filled })
  }

  const best = scored
    .filter((item) => item.filled > 0 && item.ratio >= 0.5)
    .sort((left, right) => right.ratio - left.ratio || left.column - right.column)[0]
  if (!best) return null

  const others = scored
    .filter((item) => item.column !== best.column && item.filled > 0)
    .sort((left, right) => right.filled - left.filled || left.column - right.column)
  const textCol = others.length > 0 ? others[0].column : best.column === 0 ? 1 : 0

  const first = rows[0] ?? []
  const firstDateLooksDated = Boolean(parseDateCell(first[best.column]))
  const hasHeader =
    !firstDateLooksDated && isHeaderWord(first[best.column]) && isHeaderWord(first[textCol])

  const body = hasHeader ? rows.slice(1) : rows
  let filled = 0
  let dated = 0
  for (const row of body) {
    const value = row[best.column]
    if (value === null || value === undefined || value === '') continue
    filled += 1
    if (parseDateCell(value)) dated += 1
  }
  const dateRatio = filled === 0 ? 0 : dated / filled

  return { dateCol: best.column, textCol, hasHeader, dateRatio }
}

/**
 * Parse an arbitrary sheet matrix into entries.
 * @returns {{entries:Array<object>, issues:Array<object>, detection:object|null}}
 *   `detection === null` means the shape was not recognizable and the caller
 *   must refuse the import rather than write a guess.
 */
export function parseImportMatrix(matrix) {
  const rows = (matrix ?? []).filter((row) => Array.isArray(row))
  const detection = detectColumns(rows)
  if (!detection) {
    return { entries: [], issues: [{ row: 0, code: 'no-date-column' }], detection: null }
  }
  const body = detection.hasHeader ? rows.slice(1) : rows
  const pairs = body.map((row) => [row[detection.dateCol], row[detection.textCol]])
  const { entries, issues } = normalizeEntries(pairs)
  return { entries, issues, detection }
}

/**
 * Merge an incoming diary into the current one.
 *
 * Conflict means: the same date exists on both sides with different text.
 * `keep` keeps what is already in the diary, `overwrite` takes the import,
 * `concat` puts the imported text first and the existing text below it, and
 * `skip` leaves the day untouched while listing it in the report.
 *
 * @param {{current:Array<object>, incoming:Array<object>, policy?:string}} input
 * @returns {{entries:Array<object>, report:object}} the merged entries and a report.
 */
export function planImport({ current = [], incoming = [], policy = 'keep' } = {}) {
  const chosen = CONFLICT_POLICIES.includes(policy) ? policy : 'keep'
  const currentByDate = new Map(current.map((entry) => [entry.date, entry]))
  const added = []
  const unchanged = []
  const conflicts = []

  const result = new Map(current.map((entry) => [entry.date, entry]))

  for (const entry of sortDesc(incoming)) {
    const existing = currentByDate.get(entry.date)
    if (!existing) {
      added.push(entry.date)
      result.set(entry.date, entry)
      continue
    }
    if (existing.text === entry.text) {
      unchanged.push(entry.date)
      continue
    }
    let resolution = chosen
    if (chosen === 'overwrite') {
      result.set(entry.date, entry)
    } else if (chosen === 'concat') {
      result.set(entry.date, makeEntry(existing.serial, existing.date, `${entry.text}\r\n${existing.text}`))
    } else if (chosen === 'skip') {
      resolution = 'skip'
    }
    conflicts.push({
      date: entry.date,
      existing: existing.text,
      incoming: entry.text,
      resolution,
    })
  }

  return {
    entries: sortDesc([...result.values()]),
    report: {
      policy: chosen,
      incomingCount: incoming.length,
      added,
      unchanged: unchanged.length,
      conflicts,
      skipped: conflicts.filter((item) => item.resolution === 'skip').map((item) => item.date),
      overwritten: conflicts.filter((item) => item.resolution === 'overwrite').map((item) => item.date),
      concatenated: conflicts.filter((item) => item.resolution === 'concat').map((item) => item.date),
      kept: conflicts.filter((item) => item.resolution === 'keep').map((item) => item.date),
    },
  }
}
