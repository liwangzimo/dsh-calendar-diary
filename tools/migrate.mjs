/**
 * One-time migration + verification: an original DesktopCal `.xls` (BIFF8)
 * into the `.xlsx` this plugin reads and writes.
 *
 * Why `.xlsx` at all: writing the same 1849 rows back as `.xls` silently
 * truncates every cell longer than 255 characters (5 rows in the file this was
 * first run against, e.g. a URL became `http:/`). `.xlsx` round-trips with zero
 * value, format and text differences.
 *
 * The source file is only ever read. Nothing in here writes to it.
 *
 * Usage:
 *   node tools/migrate.mjs --src <file.xls> --out <file.xlsx>     migrate, then verify
 *   node tools/migrate.mjs --src <file.xls> --verify <file.xlsx>  verify only
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'

import { DATE_FORMAT, SHEET_NAME, parseImportMatrix, toSheetRows } from '../diary-store.js'

const require = createRequire(import.meta.url)
const XLSX = require('xlsx')

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

/** Read every cell of `range` into a plain matrix, keeping empty rows. */
function readMatrix(file) {
  const workbook = XLSX.read(readFileSync(file), { type: 'buffer', cellDates: false, cellNF: true })
  const sheetName = workbook.SheetNames.includes(SHEET_NAME) ? SHEET_NAME : workbook.SheetNames[0]
  const sheet = workbook.Sheets[sheetName]
  if (!sheet || !sheet['!ref']) throw new Error(`${file}: no readable sheet`)
  const range = XLSX.utils.decode_range(sheet['!ref'])
  const matrix = []
  for (let row = range.s.r; row <= range.e.r; row += 1) {
    const line = []
    for (let column = range.s.c; column <= range.e.c; column += 1) {
      const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })]
      line.push(cell ? (cell.v ?? null) : null)
    }
    matrix.push(line)
  }
  return { workbook, sheetName, sheet, matrix, range }
}

/** Write entries as the DesktopCal two-column sheet: serial + text, descending. */
function writeDiary(outFile, entries) {
  const rows = toSheetRows(entries)
  const sheet = XLSX.utils.aoa_to_sheet(rows)
  rows.forEach((_, index) => {
    const address = `A${index + 1}`
    const cell = sheet[address]
    if (cell) {
      cell.t = 'n'
      cell.z = DATE_FORMAT
    }
  })
  sheet['!ref'] = `A1:B${rows.length}`
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, sheet, SHEET_NAME)
  mkdirSync(dirname(outFile), { recursive: true })
  XLSX.writeFile(workbook, outFile, { bookType: 'xlsx', compression: true })
  return rows
}

/** Compare two entry lists cell by cell; returns a list of human-readable problems. */
function compareEntries(sourceEntries, targetEntries) {
  const problems = []
  if (sourceEntries.length !== targetEntries.length) {
    problems.push(`row count ${sourceEntries.length} -> ${targetEntries.length}`)
  }
  const sourceByDate = new Map(sourceEntries.map((entry) => [entry.date, entry]))
  const targetByDate = new Map(targetEntries.map((entry) => [entry.date, entry]))
  if (sourceByDate.size !== targetByDate.size) {
    problems.push(`distinct dates ${sourceByDate.size} -> ${targetByDate.size}`)
  }
  for (const [date, source] of sourceByDate) {
    const target = targetByDate.get(date)
    if (!target) {
      problems.push(`missing date ${date}`)
      continue
    }
    if (target.text !== source.text) {
      problems.push(`text differs on ${date}: ${JSON.stringify(source.text).slice(0, 60)} -> ${JSON.stringify(target.text).slice(0, 60)}`)
    }
    if (target.serial !== source.serial) problems.push(`serial differs on ${date}`)
  }
  for (const date of targetByDate.keys()) {
    if (!sourceByDate.has(date)) problems.push(`extra date ${date}`)
  }
  return problems
}

/** Verify ordering is strictly date-descending, as the original file is. */
function checkOrder(entries) {
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1].serial <= entries[index].serial) {
      return [`order broken at row ${index + 1} (${entries[index - 1].date} then ${entries[index].date})`]
    }
  }
  return []
}

/** Verify every A cell carries the original number format. */
function checkDateFormat(file) {
  const { sheet, range } = readMatrix(file)
  const problems = []
  for (let row = range.s.r; row <= range.e.r; row += 1) {
    const cell = sheet[XLSX.utils.encode_cell({ r: row, c: 0 })]
    const format = cell?.z
    if (format !== DATE_FORMAT) {
      problems.push(`A${row + 1} format ${JSON.stringify(format)} != ${JSON.stringify(DATE_FORMAT)}`)
      if (problems.length > 5) break
    }
  }
  return problems
}

function parseArgs(argv) {
  const args = { src: null, out: null, verify: null }
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (key === '--src') args.src = argv[(index += 1)]
    else if (key === '--out') args.out = argv[(index += 1)]
    else if (key === '--verify') args.verify = argv[(index += 1)]
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
if (!args.src) {
  console.error('usage: node tools/migrate.mjs --src <file.xls> [--out <file.xlsx> | --verify <file.xlsx>]')
  process.exit(2)
}

const sourcePath = resolve(args.src)
if (!existsSync(sourcePath)) {
  console.error(`source not found: ${sourcePath}`)
  process.exit(2)
}

const sourceBytes = readFileSync(sourcePath)
const sourceHash = sha256(sourceBytes)
const sourceMtime = statSync(sourcePath).mtimeMs
const source = readMatrix(sourcePath)
const parsed = parseImportMatrix(source.matrix)

console.log(`source      : ${sourcePath}`)
console.log(`  sha256    : ${sourceHash}`)
console.log(`  bytes     : ${sourceBytes.length}`)
console.log(`  sheet     : ${source.sheetName}  ref=${source.sheet['!ref']}`)
console.log(`  parsed    : ${parsed.entries.length} entries, detection=${JSON.stringify(parsed.detection)}`)
if (parsed.issues.length > 0) {
  console.log(`  issues    : ${parsed.issues.length} (${parsed.issues.slice(0, 3).map((issue) => issue.code).join(', ')}…)`)
}

const targetPath = args.verify ? resolve(args.verify) : args.out ? resolve(args.out) : null
if (!targetPath) {
  console.error('nothing to do: pass --out (migrate) or --verify (verify only)')
  process.exit(2)
}

if (!args.verify) {
  const rows = writeDiary(targetPath, parsed.entries)
  console.log(`written     : ${targetPath}`)
  console.log(`  rows      : ${rows.length}`)
  console.log(`  bytes     : ${statSync(targetPath).size}`)
}

const target = readMatrix(targetPath)
const targetParsed = parseImportMatrix(target.matrix)
const problems = [
  ...compareEntries(parsed.entries, targetParsed.entries),
  ...checkOrder(targetParsed.entries),
  ...checkDateFormat(targetPath),
]

const sourceAfter = readFileSync(sourcePath)
if (sha256(sourceAfter) !== sourceHash || statSync(sourcePath).mtimeMs !== sourceMtime) {
  problems.push('the source .xls changed during the run (it must stay read-only)')
}

console.log(`verify      : ${targetPath}`)
console.log(`  sheet     : ${target.sheetName}  ref=${target.sheet['!ref']}`)
console.log(`  entries   : ${targetParsed.entries.length}`)
console.log(`  issues    : ${targetParsed.issues.length}`)
if (problems.length > 0) {
  console.error(`\nFAIL — ${problems.length} problem(s):`)
  for (const problem of problems.slice(0, 25)) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log('\nOK — 0 value, 0 format, 0 text, 0 order differences; source untouched')
