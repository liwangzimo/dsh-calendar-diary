/**
 * dsh-calendar-diary — Host half.
 *
 * Owns this plugin's own HTTP routes under `/dsh-calendar-diary/` and every read
 * and write of the diary `.xlsx`. It registers no command, touches no Session and
 * never talks to the Schedule service: the browser half reaches it with plain
 * same-origin `fetch`, which is why the month page works as a global panel.
 *
 * Evidence for every API used here (file:line), all first-party in the installed
 * desktop profile unless stated otherwise:
 * - Host plugin shape `export const name` / `export const inject` / `apply(ctx)`
 *   with `ctx.inject([service], host => host.effect(...))`:
 *   node_modules/dsh-rule-manager/lib/index.js:12-14 and its `ctx.inject` call.
 * - `host.webServer.register({ kind:'exact', path, handler })` wrapped in
 *   `host.effect(() => …, 'label')`, `handler(request, response)` over node:http,
 *   `sendJson(response, status, payload)`:
 *   node_modules/dsh-rule-manager/lib/index.js:23-29, 383-386.
 * - `register(route: WebRoute)`: duplicate `(kind, path)` throws, so every path
 *   below is unique and prefixed with this plugin's own name:
 *   dsh-plugin-factory/docs/ref/web-server.md:20-27.
 * - Deliberately NO `sameOrigin()` guard: this app's transport sends plugin-route
 *   requests with no `Origin` and no `sec-fetch-site` (measured), and that guard is
 *   exactly why rule-manager's POST paths answer 403. These routes only ever listen
 *   on loopback; that is the real boundary. See dsh-rule-manager/lib/index.js:31-40
 *   for the same conclusion, patched locally by its author.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import {
  applyImport,
  exportDiary,
  fileFacts,
  inspectDataFile,
  listCandidateFiles,
  readDiary,
  scanImport,
  validateDataPath,
  writeDiary,
} from './diary-io.js'
import {
  entriesInMonth,
  isoFromYmd,
  monthsWithEntries,
  parseDateCell,
  removeEntry,
  upsertEntry,
} from './diary-store.js'

export const name = 'dsh-calendar-diary'

/** The Web carrier is the only service this plugin requires. */
export const inject = ['webServer']

/** Every route lives under this prefix; it is this plugin's namespaced seat. */
const ROUTE_PREFIX = '/dsh-calendar-diary'

/** JSON request bodies are small (paths, flags, one day's text). */
const MAX_BODY_BYTES = 256 * 1024

/** Spreadsheet ceiling for one cell. */
const MAX_TEXT_LENGTH = 32767

/** Plugin home: config plus the default data file. */
const HOME_DIR = join(homedir(), '.dsh', 'dsh-calendar-diary')
const CONFIG_PATH = join(HOME_DIR, 'config.json')
const DEFAULT_DATA_PATH = join(HOME_DIR, 'diary.xlsx')

const BAD_REQUEST_CODES = new Set(['invalid-json', 'body-too-large'])

function sendJson(response, status, payload, headers) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    ...(headers ?? {}),
  })
  response.end(JSON.stringify(payload))
}

/** Read a bounded JSON body; `{}` for an empty body. */
function readJsonBody(request) {
  return new Promise((settle, fail) => {
    const chunks = []
    let size = 0
    let stopped = false
    request.on('data', (chunk) => {
      if (stopped) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        stopped = true
        fail(Object.assign(new Error('request body is too large'), { code: 'body-too-large' }))
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (stopped) return
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw === '') {
        settle({})
        return
      }
      try {
        const parsed = JSON.parse(raw)
        settle(parsed && typeof parsed === 'object' ? parsed : {})
      } catch {
        fail(Object.assign(new Error('request body is not valid JSON'), { code: 'invalid-json' }))
      }
    })
    request.on('error', (error) => {
      if (!stopped) fail(error)
    })
  })
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Local calendar date, never a UTC one: a diary day is the user's day. */
function todayIso(now = new Date()) {
  return isoFromYmd(now.getFullYear(), now.getMonth() + 1, now.getDate())
}

/**
 * Build the handler set. Every handler answers JSON and never throws out: an
 * unexpected failure becomes a 500 with a readable message instead of a hang.
 *
 * `options.configPath` / `options.defaultDataPath` let a verification run drive
 * these exact handlers against a temp directory instead of the user's home, so
 * the route logic is testable without starting the app.
 *
 * @param {object} host - context owning `webServer` (and, optionally, `directoryPicker`).
 * @param {{configPath?:string, defaultDataPath?:string}} [options]
 */
export function createRoutes(host, options = {}) {
  const configPath = options.configPath ?? CONFIG_PATH
  const defaultDataPath = options.defaultDataPath ?? DEFAULT_DATA_PATH

  const readConfig = () => {
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf8'))
      return raw && typeof raw === 'object' ? raw : {}
    } catch {
      return {}
    }
  }

  const writeConfig = (config) => {
    mkdirSync(dirname(configPath), { recursive: true })
    const temporary = `${configPath}.tmp-${process.pid}`
    writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
    renameSync(temporary, configPath)
  }

  const dataPath = () => {
    const configured = readConfig().dataPath
    // A relative path in a hand-edited config resolves against the plugin home,
    // not the host process's working directory — otherwise the same config would
    // point at different files depending on how the app was started.
    if (typeof configured === 'string' && configured.trim() !== '') return resolve(HOME_DIR, configured.trim())
    return defaultDataPath
  }

  const statePayload = () => {
    const path = dataPath()
    const facts = fileFacts(path)
    const read = facts.exists ? readDiary(path) : { entries: [], issues: [], sheets: [], sheetName: null }
    return {
      ok: true,
      dataPath: path,
      exists: facts.exists,
      writable: facts.writable,
      bytes: facts.bytes,
      mtime: facts.mtime,
      totalRows: read.entries.length,
      months: monthsWithEntries(read.entries),
      sheetName: read.sheetName ?? null,
      issues: read.issues.slice(0, 20),
      today: todayIso(),
      defaultDataPath,
      maxTextLength: MAX_TEXT_LENGTH,
    }
  }

  /**
   * Best-effort folder picker. The app ships a `directoryPicker` service whose
   * exact capability shape is not verified in this profile, so every access is
   * guarded: when the service or a usable method is missing the UI falls back to
   * typing a path instead of breaking. Nothing here invents a failed success.
   */
  const pickDirectory = async (title) => {
    let service = null
    try {
      service = (host && host.directoryPicker) || null
    } catch {
      service = null
    }
    if (!service) return { ok: false, error: 'picker-unavailable' }
    try {
      const capability = typeof service.capability === 'function' ? service.capability() : null
      const pick =
        typeof capability?.pick === 'function'
          ? capability.pick.bind(capability)
          : typeof capability?.select === 'function'
            ? capability.select.bind(capability)
            : typeof service.pick === 'function'
              ? service.pick.bind(service)
              : null
      if (!pick) return { ok: false, error: 'picker-unsupported' }
      const result = await pick({ title: typeof title === 'string' && title !== '' ? title : '选择文件夹' })
      const dir =
        typeof result === 'string'
          ? result
          : result?.path ?? result?.directory ?? result?.dir ?? result?.folder ?? null
      if (!dir) return { ok: false, error: 'picker-cancelled' }
      return { ok: true, dir }
    } catch (error) {
      return { ok: false, error: 'picker-failed', detail: messageOf(error) }
    }
  }

  const flat = [
    {
      path: `${ROUTE_PREFIX}/state`,
      method: 'GET',
      handle: async (_request, response) => {
        sendJson(response, 200, statePayload())
      },
    },
    {
      path: `${ROUTE_PREFIX}/entries`,
      method: 'GET',
      handle: async (_request, response, url) => {
        const month = url.searchParams.get('month') ?? todayIso().slice(0, 7)
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
          sendJson(response, 400, { ok: false, error: 'invalid-month' })
          return
        }
        const path = dataPath()
        const read = existsSync(path) ? readDiary(path) : { exists: false, entries: [] }
        sendJson(response, 200, {
          ok: true,
          month,
          exists: read.exists,
          entries: entriesInMonth(read.entries, month),
          totalRows: read.entries.length,
        })
      },
    },
    {
      path: `${ROUTE_PREFIX}/entries`,
      method: 'POST',
      handle: async (request, response) => {
        const body = await readJsonBody(request)
        const parsed = parseDateCell(body.date)
        if (!parsed) {
          sendJson(response, 400, { ok: false, error: 'invalid-date' })
          return
        }
        if (typeof body.text !== 'string') {
          sendJson(response, 400, { ok: false, error: 'text-must-be-a-string' })
          return
        }
        if (body.text.length > MAX_TEXT_LENGTH) {
          sendJson(response, 400, { ok: false, error: 'text-too-long', limit: MAX_TEXT_LENGTH })
          return
        }
        const path = dataPath()
        const current = existsSync(path) ? readDiary(path).entries : []
        const next = upsertEntry(current, { date: parsed.iso, text: body.text })
        const written = writeDiary(path, next)
        sendJson(response, 200, {
          ok: true,
          entry: next.find((entry) => entry.date === parsed.iso) ?? null,
          totalRows: written.rows,
          backupPath: written.backupPath,
        })
      },
    },
    {
      path: `${ROUTE_PREFIX}/entries/remove`,
      method: 'POST',
      handle: async (request, response) => {
        const body = await readJsonBody(request)
        const parsed = parseDateCell(body.date)
        if (!parsed) {
          sendJson(response, 400, { ok: false, error: 'invalid-date' })
          return
        }
        const path = dataPath()
        const current = existsSync(path) ? readDiary(path).entries : []
        if (!current.some((entry) => entry.date === parsed.iso)) {
          sendJson(response, 200, { ok: true, removed: false, totalRows: current.length })
          return
        }
        const written = writeDiary(path, removeEntry(current, parsed.iso))
        sendJson(response, 200, {
          ok: true,
          removed: true,
          totalRows: written.rows,
          backupPath: written.backupPath,
        })
      },
    },
    {
      path: `${ROUTE_PREFIX}/path`,
      method: 'POST',
      handle: async (request, response) => {
        const body = await readJsonBody(request)
        const validation = validateDataPath(body.dataPath, HOME_DIR)
        if (!validation.ok) {
          sendJson(response, 400, { ok: false, error: validation.error, detail: validation.detail })
          return
        }
        const inspected = inspectDataFile(validation.path)
        if (!inspected.ok) {
          sendJson(response, 400, { ok: false, error: inspected.error, detail: inspected.detail })
          return
        }
        writeConfig({ ...readConfig(), dataPath: validation.path })
        sendJson(response, 200, {
          ok: true,
          dataPath: validation.path,
          exists: inspected.facts.exists,
          writable: inspected.facts.writable,
          totalRows: inspected.entries.length,
        })
      },
    },
    {
      path: `${ROUTE_PREFIX}/pick-dir`,
      method: 'POST',
      handle: async (request, response) => {
        const body = await readJsonBody(request)
        sendJson(response, 200, await pickDirectory(body.title))
      },
    },
    {
      path: `${ROUTE_PREFIX}/list-files`,
      method: 'POST',
      handle: async (request, response) => {
        const body = await readJsonBody(request)
        if (typeof body.dir !== 'string' || body.dir.trim() === '') {
          // Never enumerate a directory the caller did not name — an empty `dir`
          // would otherwise list whatever directory the host process happens in.
          sendJson(response, 400, { ok: false, error: 'dir-required' })
          return
        }
        const listed = listCandidateFiles(body.dir)
        if (!listed.ok) {
          sendJson(response, 400, listed)
          return
        }
        sendJson(response, 200, { ok: true, dir: listed.dir, files: listed.files, total: listed.total })
      },
    },
    {
      path: `${ROUTE_PREFIX}/import/scan`,
      method: 'POST',
      handle: async (request, response) => {
        const body = await readJsonBody(request)
        if (typeof body.sourcePath !== 'string' || body.sourcePath.trim() === '') {
          sendJson(response, 400, { ok: false, error: 'source-path-required' })
          return
        }
        const path = dataPath()
        const current = existsSync(path) ? readDiary(path).entries : []
        const preview = scanImport({
          sourcePath: body.sourcePath.trim(),
          current,
          policy: body.policy,
        })
        if (!preview.ok) {
          sendJson(response, 400, preview)
          return
        }
        sendJson(response, 200, { ...preview, dataPath: path, currentRows: current.length })
      },
    },
    {
      path: `${ROUTE_PREFIX}/import/apply`,
      method: 'POST',
      handle: async (request, response) => {
        const body = await readJsonBody(request)
        if (typeof body.sourcePath !== 'string' || body.sourcePath.trim() === '') {
          sendJson(response, 400, { ok: false, error: 'source-path-required' })
          return
        }
        if (body.decisions && Object.keys(body.decisions).length > 0) {
          // Per-day overrides are not implemented; say so instead of ignoring them.
          sendJson(response, 400, { ok: false, error: 'per-day-decisions-not-supported' })
          return
        }
        const path = dataPath()
        const current = existsSync(path) ? readDiary(path).entries : []
        const applied = applyImport({
          sourcePath: body.sourcePath.trim(),
          targetPath: path,
          current,
          policy: body.policy,
        })
        if (!applied.ok) {
          sendJson(response, 400, applied)
          return
        }
        sendJson(response, 200, { ...applied, dataPath: path })
      },
    },
    {
      path: `${ROUTE_PREFIX}/export`,
      method: 'POST',
      handle: async (request, response) => {
        const body = await readJsonBody(request)
        if (typeof body.outPath !== 'string' || body.outPath.trim() === '') {
          sendJson(response, 400, { ok: false, error: 'out-path-required' })
          return
        }
        const path = dataPath()
        const entries = existsSync(path) ? readDiary(path).entries : []
        // Scope and value are validated in exportDiary so that every caller — not
        // just this route — is protected from a silent "export everything".
        const exported = exportDiary({
          entries,
          outPath: body.outPath.trim(),
          scope: body.scope ?? 'all',
          value: body.value,
          dataPath: path,
          baseDir: HOME_DIR,
        })
        if (!exported.ok) {
          sendJson(response, 400, exported)
          return
        }
        sendJson(response, 200, { ...exported, dataPath: path })
      },
    },
  ]

  return groupRoutes(flat)
}

/**
 * Fold the flat route list into ONE registration per path.
 *
 * The Web carrier keys routes by `(kind, path)` and throws on a duplicate
 * (docs/ref/web-server.md:20-27), so two methods on one path — here GET and POST
 * on `/entries` — must share a single registration that dispatches on
 * `request.method`. The shipped rule-manager does exactly this for its
 * `/global-rules` path (node_modules/dsh-rule-manager/lib/index.js:340-380).
 * A wrong method answers 405 with an `allow` header.
 *
 * @param {Array<{path:string, method:string, handle:Function}>} flat
 * @returns {Array<{path:string, methods:string[], allow:string, handler:Function}>}
 */
function groupRoutes(flat) {
  const groups = new Map()
  for (const route of flat) {
    if (!groups.has(route.path)) groups.set(route.path, { path: route.path, methods: new Map() })
    groups.get(route.path).methods.set(route.method, route.handle)
  }
  return [...groups.values()].map((group) => {
    const allow = [...group.methods.keys()].sort().join(', ')
    return {
      path: group.path,
      methods: [...group.methods.keys()].sort(),
      allow,
      handler: async (request, response) => {
        const handle = group.methods.get(request.method)
        if (!handle) {
          // Every error the client can see is JSON, including this one; `allow`
          // rides in both the header and the body.
          sendJson(response, 405, { ok: false, error: 'method-not-allowed', allow }, { allow })
          return
        }
        try {
          const url = new URL(request.url ?? '/', 'http://127.0.0.1')
          await handle(request, response, url)
        } catch (error) {
          const code = error && typeof error === 'object' ? error.code : undefined
          if (BAD_REQUEST_CODES.has(code)) {
            sendJson(response, 400, { ok: false, error: code })
            return
          }
          sendJson(response, 500, { ok: false, error: messageOf(error) })
        }
      },
    }
  })
}

export function apply(ctx) {
  ctx.inject(['webServer'], (host) => {
    try {
      if (!existsSync(CONFIG_PATH)) {
        // On a fresh machine ~/.dsh/dsh-calendar-diary does not exist yet, so the
        // write fails with ENOENT unless the directory is created first.
        mkdirSync(dirname(CONFIG_PATH), { recursive: true })
        writeFileSync(CONFIG_PATH, `${JSON.stringify({ dataPath: DEFAULT_DATA_PATH }, null, 2)}\n`, 'utf8')
      }
    } catch {
      /* A read-only home must not stop the plugin from activating. */
    }

    for (const route of createRoutes(host)) {
      host.effect(
        () =>
          host.webServer.register({
            kind: 'exact',
            path: route.path,
            handler: route.handler,
          }),
        `dsh-calendar-diary: ${route.path} [${route.allow}]`,
      )
    }
  })
}
