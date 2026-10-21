/**
 * dsh-calendar-diary — the I/O layer.
 *
 * Everything that touches the filesystem or the spreadsheet format lives here,
 * so that:
 *   - `index.js` (the Host half) only wires HTTP routes to these functions, and
 *   - the same functions can be exercised by plain Node in verification runs,
 *     without the app being involved at all.
 *
 * Rules this file enforces:
 *   - the diary file is written as `.xlsx` (`.xls` cannot hold this data: writing
 *     it back silently truncates every cell over 255 characters),
 *   - column A keeps the integer serial AND the `m/d/yy` number format,
 *   - every write is atomic (temp file + rename) and is preceded by exactly one
 *     timestamped backup per process lifetime,
 *   - the source of an import is only ever read.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  accessSync,
  constants as fsConstants,
} from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, extname, join, resolve } from 'node:path'

import {
  DATE_FORMAT,
  SHEET_NAME,
  normalizeEntries,
  parseImportMatrix,
  planImport,
  filterByScope,
  toSheetRows,
} from './diary-store.js'

const require = createRequire(import.meta.url)
const XLSX = require('xlsx')

/** Extensions this plugin will read as an import source. */
export const IMPORT_EXTENSIONS = ['.xlsx', '.xls']

/** Status codes used in `{ ok:false, error }` responses; the client may translate them. */
export const IO_ERRORS = {
  missingSource: 'source-not-found',
  unrecognized: 'unrecognized-source',
  xlsNotWritable: 'xls-not-supported-as-data-file',
  notADiary: 'not-a-diary-file',
  badRequest: 'bad-request',
}

/** Data-file paths already backed up in this process (backup once per session). */
const backedUpThisSession = new Set()

/** Forget the session backup memory. Verification runs call this between cases. */
export function resetBackupSession() {
  backedUpThisSession.clear()
}

/** Local `yyyyMMdd-HHmmss`, the suffix used for backups. */
export function backupStamp(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  )
}

/** Facts about a data file the UI needs to render: existence, writability, size. */
export function fileFacts(path) {
  const facts = {
    dataPath: path,
    exists: false,
    writable: false,
    bytes: 0,
    mtime: null,
    directory: dirname(path),
    directoryExists: existsSync(dirname(path)),
  }
  try {
    const stats = statSync(path)
    if (stats.isFile()) {
      facts.exists = true
      facts.bytes = stats.size
      facts.mtime = stats.mtimeMs
    }
  } catch {
    facts.exists = false
  }
  try {
    if (facts.exists) accessSync(path, fsConstants.W_OK)
    else {
      let probe = facts.directory
      while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe)
      accessSync(probe, fsConstants.W_OK)
    }
    facts.writable = true
  } catch {
    facts.writable = false
  }
  return facts
}

/**
 * A data file must be `.xlsx`: it has to be writable, and `.xls` loses long text.
 * @param {string} candidate - the path the user gave.
 * @param {string} [baseDir] - what a relative path is resolved against; the
 *   process's working directory is a surprising answer for a GUI, so callers pass
 *   the plugin home instead.
 * @returns {{ok:true, path:string}|{ok:false, error:string, detail?:string}}
 */
export function validateDataPath(candidate, baseDir) {
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    return { ok: false, error: IO_ERRORS.badRequest, detail: 'empty path' }
  }
  const path = resolve(baseDir ?? process.cwd(), candidate.trim().replace(/^"|"$/g, ''))
  if (existsSync(path) && statSync(path).isDirectory()) {
    return { ok: false, error: IO_ERRORS.badRequest, detail: 'path is a directory' }
  }
  const extension = extname(path).toLowerCase()
  if (extension === '.xls') {
    return { ok: false, error: IO_ERRORS.xlsNotWritable, detail: path }
  }
  if (extension !== '.xlsx') {
    return { ok: false, error: IO_ERRORS.badRequest, detail: `unsupported extension ${extension || '(none)'}` }
  }
  return { ok: true, path }
}

/**
 * Read every cell of the used range into a plain matrix.
 * `cellCount` tells "an empty book" apart from "a book with a range but no cells",
 * which is what a freshly created empty diary looks like.
 */
function readMatrixWithWorkbook(file) {
  const workbook = XLSX.read(readFileSync(file), { type: 'buffer', cellDates: false, cellNF: true })
  const sheetName = workbook.SheetNames.includes(SHEET_NAME) ? SHEET_NAME : workbook.SheetNames[0]
  const sheet = sheetName ? workbook.Sheets[sheetName] : null
  if (!sheet || !sheet['!ref']) {
    return { workbook, sheetName, sheet: sheet ?? null, matrix: [], ref: null, cellCount: 0 }
  }
  const range = XLSX.utils.decode_range(sheet['!ref'])
  const matrix = []
  for (let row = range.s.r; row <= range.e.r; row += 1) {
    const line = []
    for (let column = range.s.c; column <= range.e.c; column += 1) {
      const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })]
      line.push(cell ? cell.v ?? null : null)
    }
    matrix.push(line)
  }
  const cellCount = Object.keys(sheet).filter((key) => !key.startsWith('!')).length
  return { workbook, sheetName, sheet, matrix, ref: sheet['!ref'], cellCount }
}

/**
 * Read the diary file.
 * Fully empty rows are ignored (they carry no day and no text), and an empty
 * sheet is simply an empty diary — not a problem to report.
 * @returns {{exists:boolean, entries:Array<object>, issues:Array<object>, sheets:string[],
 *   sheetName:string|null, ref:string|null, rowCount:number, looksLikeDiary:boolean}}
 */
export function readDiary(path) {
  if (!existsSync(path)) {
    return {
      exists: false,
      entries: [],
      issues: [],
      sheets: [],
      sheetName: null,
      ref: null,
      rowCount: 0,
      looksLikeDiary: false,
    }
  }
  const { workbook, sheetName, matrix, ref, cellCount } = readMatrixWithWorkbook(path)
  if (matrix.length === 0 || cellCount === 0) {
    return {
      exists: true,
      entries: [],
      issues: [],
      sheets: workbook.SheetNames,
      sheetName: sheetName ?? null,
      ref,
      rowCount: 0,
      looksLikeDiary: sheetName === SHEET_NAME,
    }
  }
  const pairs = matrix.map((line) => [line[0] ?? null, line[1] ?? null])
  // Keep each surviving row's real sheet position, so an issue can name the line
  // the user will actually see in Excel rather than an index into a filtered list.
  const kept = []
  const sheetRowOf = []
  pairs.forEach((pair, index) => {
    if (pair[0] === null && pair[1] === null) return
    kept.push(pair)
    sheetRowOf.push(index + 1)
  })
  const parsed = normalizeEntries(kept)
  const issues = parsed.issues.map((issue) => ({ ...issue, row: sheetRowOf[issue.row] ?? issue.row + 1 }))
  const looksLikeDiary =
    sheetName === SHEET_NAME ||
    (kept.length > 0 && parsed.entries.length / kept.length >= 0.9 && parsed.entries.length > 0)
  return {
    exists: true,
    entries: parsed.entries,
    issues,
    sheets: workbook.SheetNames,
    sheetName: sheetName ?? null,
    ref,
    rowCount: kept.length,
    looksLikeDiary,
  }
}

/** Copy the file aside, at most once per process, before the first modification. */
function backupOnce(path) {
  if (!existsSync(path)) return null
  if (backedUpThisSession.has(path)) return null
  const target = `${path}.bak-${backupStamp()}`
  copyFileSync(path, target)
  backedUpThisSession.add(path)
  return target
}

/**
 * Write entries as the DesktopCal sheet: serial + text, date-descending.
 * Atomic: the workbook goes to a temp file first and is then renamed over the
 * target, so a crash can never leave a half-written diary.
 * @returns {{rows:number, bytes:number, backupPath:string|null, path:string}}
 */
export function writeDiary(path, entries, options = {}) {
  const { backup = true } = options
  mkdirSync(dirname(path), { recursive: true })
  const backupPath = backup ? backupOnce(path) : null

  const rows = toSheetRows(entries)
  const sheet = XLSX.utils.aoa_to_sheet(rows)
  rows.forEach((_, index) => {
    const cell = sheet[`A${index + 1}`]
    if (cell) {
      cell.t = 'n'
      cell.z = DATE_FORMAT
    }
  })
  sheet['!ref'] = `A1:B${Math.max(rows.length, 1)}`

  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, sheet, SHEET_NAME)

  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  try {
    XLSX.writeFile(workbook, temporary, { bookType: 'xlsx', compression: true })
    renameSync(temporary, path)
  } catch (error) {
    // A failed write must not leave a 150 KB temp file behind — and it must not
    // touch the diary, which only the rename ever does.
    try {
      rmSync(temporary, { force: true })
    } catch {
      /* nothing further we can do about the leftover */
    }
    throw error
  }

  return { rows: rows.length, bytes: statSync(path).size, backupPath, path }
}

/** Read any supported source file as a matrix (used by import). */
export function readSourceMatrix(sourcePath) {
  if (!existsSync(sourcePath)) return { ok: false, error: IO_ERRORS.missingSource }
  const extension = extname(sourcePath).toLowerCase()
  if (!IMPORT_EXTENSIONS.includes(extension)) {
    return { ok: false, error: IO_ERRORS.badRequest, detail: `unsupported extension ${extension}` }
  }
  const { matrix, sheetName, workbook } = readMatrixWithWorkbook(sourcePath)
  const parsed = parseImportMatrix(matrix)
  return {
    ok: true,
    sheetName,
    sheets: workbook.SheetNames,
    rows: matrix.length,
    entries: parsed.entries,
    issues: parsed.issues,
    detection: parsed.detection,
  }
}

/**
 * Preview an import: what would be added, what conflicts, what stays.
 * Writes nothing. `entries` are NOT returned over HTTP — the preview report is.
 */
export function scanImport({ sourcePath, current = [], policy = 'keep' }) {
  const source = readSourceMatrix(sourcePath)
  if (!source.ok) return source
  if (!source.detection) {
    return { ok: false, error: IO_ERRORS.unrecognized, detail: sourcePath }
  }
  const { report } = planImport({ current, incoming: source.entries, policy })
  const dates = source.entries.map((entry) => entry.date).sort()
  return {
    ok: true,
    source: basename(sourcePath),
    sourcePath,
    sheetName: source.sheetName,
    rows: source.entries.length,
    dateRange: dates.length > 0 ? { from: dates[0], to: dates[dates.length - 1] } : null,
    detection: source.detection,
    issues: source.issues.slice(0, 50),
    issueCount: source.issues.length,
    added: report.added.length,
    unchanged: report.unchanged,
    conflicts: report.conflicts.map((item) => ({
      date: item.date,
      existing: item.existing,
      incoming: item.incoming,
    })),
    skipped: report.skipped.length,
    kept: report.kept.length,
    policy: report.policy,
    incomingCount: report.incomingCount,
  }
}

/**
 * Apply an import: plan again from the source, back the diary up, write atomically.
 * @returns {{ok:true, report:object, totalRows:number, backupPath:string|null, bytes:number}|{ok:false,error:string}}
 */
export function applyImport({ sourcePath, targetPath, current = [], policy = 'keep' }) {
  const source = readSourceMatrix(sourcePath)
  if (!source.ok) return source
  if (!source.detection) {
    return { ok: false, error: IO_ERRORS.unrecognized, detail: sourcePath }
  }
  const { entries, report } = planImport({ current, incoming: source.entries, policy })
  const written = writeDiary(targetPath, entries, { backup: true })
  return {
    ok: true,
    report: {
      ...report,
      conflicts: report.conflicts.map((item) => ({ date: item.date, resolution: item.resolution })),
    },
    totalRows: written.rows,
    backupPath: written.backupPath,
    bytes: written.bytes,
  }
}

/**
 * Do two paths name the same file on disk?
 *
 * A plain string comparison is not enough: a directory junction (or symlink)
 * alias spells the same file differently, and that was enough to let an export
 * land on the diary itself. So compare identity when both sides exist (dev+inode
 * also catches hard links), then fall back to canonicalised real paths, which
 * resolves a junction through the parent directory even when the target file
 * does not exist yet.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function refersToSameFile(a, b) {
  if (a.toLowerCase() === b.toLowerCase()) return true
  try {
    const left = statSync(a)
    const right = statSync(b)
    if (left.dev === right.dev && Number.isFinite(left.ino) && left.ino !== 0 && left.ino === right.ino) return true
  } catch {
    /* at least one side does not exist yet */
  }
  const left = canonicalPath(a)
  const right = canonicalPath(b)
  return left !== '' && right !== '' && left === right
}

/** The real path, lowercased; falls back to resolving the parent directory. */
function canonicalPath(path) {
  try {
    return realpathSync.native(path).toLowerCase()
  } catch {
    try {
      return join(realpathSync.native(dirname(path)), basename(path)).toLowerCase()
    } catch {
      return ''
    }
  }
}

/**
 * Export entries to a NEW `.xlsx`.
 *
 * Refuses to write onto the diary itself: an export is never backed up, so
 * exporting a range over the live data file would silently destroy every day
 * outside that range. The export dialog opens in the diary's own directory, so
 * this is a one-filename-away accident, not a hypothetical one.
 *
 * @returns {{ok:true, outPath:string, rows:number, bytes:number}
 *   |{ok:false, error:string, detail?:string}}
 */
export function exportDiary({ entries = [], outPath, scope = 'all', value, dataPath, baseDir }) {
  const validation = validateDataPath(outPath, baseDir)
  if (!validation.ok) return validation
  if (typeof dataPath === 'string' && dataPath.trim() !== '') {
    const diaryPath = resolve(baseDir ?? process.cwd(), dataPath.trim())
    if (refersToSameFile(validation.path, diaryPath)) {
      return {
        ok: false,
        error: 'export-would-overwrite-diary',
        detail: '导出的目标就是当前数据文件；请换一个文件名或目录',
      }
    }
  }

  // A scope or value we do not understand must never mean "export everything":
  // filterByScope falls back to the whole list, so an unvalidated typo would
  // quietly write all 1849 days to the target.
  if (scope !== 'all' && scope !== 'year' && scope !== 'month') {
    return { ok: false, error: 'invalid-scope', detail: String(scope) }
  }
  let selected
  if (scope === 'year') {
    const raw = String(value ?? '').trim()
    if (!/^\d{4}$/.test(raw)) return { ok: false, error: 'value-required', detail: 'year' }
    selected = filterByScope(entries, 'year', Number(raw))
  } else if (scope === 'month') {
    const raw = String(value ?? '').trim()
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(raw)) return { ok: false, error: 'value-required', detail: 'month' }
    selected = filterByScope(entries, 'month', raw)
  } else {
    selected = filterByScope(entries, 'all')
  }

  const written = writeDiary(validation.path, selected, { backup: false })
  return { ok: true, scope, outPath: written.path, rows: written.rows, bytes: written.bytes }
}

/** Candidate import sources in one directory, newest first (capped). */
export function listCandidateFiles(directory, limit = 200) {
  const target = resolve(String(directory ?? '').trim().replace(/^"|"$/g, ''))
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    return { ok: false, error: IO_ERRORS.badRequest, detail: 'not a directory' }
  }
  const files = []
  for (const name of readdirSync(target)) {
    const extension = extname(name).toLowerCase()
    if (!IMPORT_EXTENSIONS.includes(extension)) continue
    if (name.includes('.tmp-')) continue
    const path = join(target, name)
    try {
      const stats = statSync(path)
      if (!stats.isFile()) continue
      files.push({ name, path, size: stats.size, mtime: stats.mtimeMs })
    } catch {
      /* unreadable entry: skip it rather than failing the listing */
    }
  }
  files.sort((left, right) => right.mtime - left.mtime)
  return { ok: true, dir: target, files: files.slice(0, limit), total: files.length }
}

/**
 * Distinguish "a usable diary file" from "some spreadsheet".
 * A missing file is fine (it will be created); an existing book with rows but no
 * date column is refused, so a wrong path cannot overwrite unrelated data.
 */
export function inspectDataFile(path) {
  const facts = fileFacts(path)
  if (!facts.exists) return { ok: true, facts, creates: true, entries: [] }
  const read = readDiary(path)
  if (read.entries.length === 0 && read.rowCount === 0) {
    return { ok: true, facts, creates: false, entries: [] }
  }
  if (!read.looksLikeDiary) {
    return { ok: false, error: IO_ERRORS.notADiary, detail: basename(path) }
  }
  return { ok: true, facts, creates: false, entries: read.entries, issues: read.issues }
}
