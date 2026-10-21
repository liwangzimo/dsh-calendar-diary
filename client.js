/**
 * DSH plugin `dsh-calendar-diary` — browser half.
 *
 * A plain notebook. It renders a GLOBAL month panel (`sidebar.panellist` row +
 * `main` page) with a day editor, and an always-visible "today" bar above the
 * composer (`conversation.composer.dock`). It owns no data and knows no Sessions:
 * every read and every write is one same-origin `fetch` against the HTTP routes the
 * Host half (`index.js`) registers under `/dsh-calendar-diary/`.
 *
 * Route contract (frozen; the Host half is written to exactly this). Interface table
 * and rationale in `.docs/plan-dsh-calendar-diary.md` §5 (:95-107) and §4 (:59-74).
 * The complete list of URLs this file fetches, and nothing else:
 *   GET  /dsh-calendar-diary/state
 *   GET  /dsh-calendar-diary/entries?month=YYYY-MM
 *   POST /dsh-calendar-diary/entries                 { date, text }
 *   POST /dsh-calendar-diary/entries/remove          { date }
 *   POST /dsh-calendar-diary/path                    { dataPath }
 *   POST /dsh-calendar-diary/pick-dir                { title? }
 *   POST /dsh-calendar-diary/list-files              { dir }
 *   POST /dsh-calendar-diary/import/scan             { sourcePath, policy? }
 *   POST /dsh-calendar-diary/import/apply            { sourcePath, policy, decisions? }
 *   POST /dsh-calendar-diary/export                  { scope, value?, outPath }
 * All POSTs send JSON and answer JSON; a failure is HTTP 4xx/5xx with
 * `{ ok:false, error }`, and a successful `import/scan` may answer
 * `{ ok:false, error }` with HTTP 200, so both shapes are handled below.
 *
 * Why plain `fetch` with no Session lookup: the month page is a global panel, so no
 * Session is current while it is open. The previous plugin
 * (`packages/dsh-schedule-calendar/client.js:41-65`) needed a five-rung Session
 * ladder for exactly that reason (`.docs/plan-dsh-calendar-diary.md` :59-61); none of
 * it exists here. The desktop transport sends these requests with NO `Origin` and no
 * `sec-fetch-site`, so this file neither adds nor requires either header and
 * deliberately does not copy the rule-manager client's own-origin header check
 * (`.docs/plan-dsh-calendar-diary.md` :74). No `remote.*`, no Host command channel,
 * no sessions service.
 *
 * Evidence for every API used here (file:line):
 * - `window.__ModuleLoader__.load({ id, factory(require) })` with `id` equal to the
 *   package name: `packages/dsh-schedule-calendar/client.js:107-116` (whose header
 *   cites templates/decoration/client.js:1-22). Format copied exactly.
 * - `require('react')` is the only import, and `React.createElement` plus hooks are
 *   read from it: `packages/dsh-schedule-calendar/client.js:109-113`.
 * - `ctx.locale.register(ns, 'zh'|'en', dict)` in the untyped third-party form, once
 *   per language, each returned from `ctx.effect(fn, label)`, then
 *   `ctx.locale.bind(ns)`: `packages/dsh-schedule-calendar/client.js:1935-1943`.
 * - `ctx.effect(fn, label)` also owns the stylesheet install/dispose:
 *   `packages/dsh-schedule-calendar/client.js:1957`, and the disposer shape at
 *   :805-813.
 * - `ctx.slots.inject(ownerKey, () => ctx.slots.register(options, Component))`:
 *   `packages/dsh-schedule-calendar/client.js:2288-2339`.
 * - `sidebar.panellist` options `{ name, id, order, label }` with a `label` thunk
 *   over the bound translator; the owner renders the component with
 *   `{ size, active }`: `packages/dsh-schedule-calendar/client.js:2288-2298`
 *   (`.docs/api-spec.md` §2.3 :245-271, click behaviour :267).
 * - `main` options `{ name, key, inject: () => ({...}) }` (root scope), and the
 *   panellist `id` must equal this `key`: `packages/dsh-schedule-calendar/client.js:2302-2317`
 *   (`.docs/api-spec.md` §2.2 :228-241, §2.5 :330-337).
 * - `conversation.composer.dock` options `{ name, id, order, label, inject:
 *   (sessionId) => ({...}) }` — session scope, so `inject` receives the Session id:
 *   `packages/dsh-schedule-calendar/client.js:2322-2339` (`.docs/api-spec.md` §2.4-§2.5
 *   :273-309, :330-337).
 * - Theme tokens are `--dsw-alias-*`. Every token named in the sheet below is copied
 *   from the previous client's proven sheet
 *   (`packages/dsh-schedule-calendar/client.js:745-801`, whose header cites
 *   .docs/_asar/.../dsh-client-ui-theme/lib/client.js). Each `var()` here carries a
 *   translucent fallback, so a token that is missing in some theme still yields a
 *   readable surface in BOTH light and dark (no hardcoded light-only background with
 *   dark text).
 */

window.__ModuleLoader__.load({
  id: 'dsh-calendar-diary',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    // ---------------------------------------------------------------------
    // Identity, routes, constants
    // ---------------------------------------------------------------------

    /** Locale namespace for every visible string; registered in apply(). */
    const NS = 'dsh-calendar-diary';
    /** One id links the sidebar panel row to its `main` panel (`key`). */
    const PANEL_ID = 'calendar-diary';
    /** Composer-dock entry id (the "today" bar). */
    const TODAY_ID = 'calendar-diary-today';
    /** Prefix shared by every route the Host half registers. */
    const ROUTE_BASE = '/dsh-calendar-diary';
    /** Scoped CSS prefix: every class in the sheet below starts with this. */
    const PREFIX = 'dcd';
    /** The grid is Monday-first. */
    const WEEKDAY_KEYS = [
      'week.mon',
      'week.tue',
      'week.wed',
      'week.thu',
      'week.fri',
      'week.sat',
      'week.sun',
    ];
    /**
     * Ten week-rows always fill the month grid (70 cells), Monday-first. Paging is
     * still BY MONTH: the window starts at the Monday of the week containing the
     * 1st, so with ten rows it runs ~2.3 months forward and consecutive months
     * overlap heavily.
     */
    const GRID_DAYS = 70;
    /** Week-rows in the grid, derived so the stylesheet row template cannot drift. */
    const GRID_ROWS = GRID_DAYS / 7;
    /**
     * Floor for one row: the date line plus one full 16px text line. A taller panel
     * grows all {@link GRID_ROWS} rows equally (`minmax(min, 1fr)`); a genuinely
     * short panel scrolls the whole grid rather than clipping a row away.
     */
    const CELL_MIN_HEIGHT = 38;
    /** Flattened report rows rendered before truncating. */
    const MAX_FLATTEN_ROWS = 40;

    // ---------------------------------------------------------------------
    // Generic helpers
    // ---------------------------------------------------------------------

    /**
     * Safe dictionary lookup.
     * @param t - translator bound to {@link NS}; may be undefined in odd hosts.
     * @param key - dictionary key.
     * @param params - `{name}` interpolation values.
     * @returns translated text, or the key when no translator is present.
     */
    function text(t, key, params) {
      if (typeof t !== 'function') return key;
      const value = t(key, params);
      return typeof value === 'string' && value.length > 0 ? value : key;
    }

    /** Zero-pad to two digits. */
    function pad2(value) {
      return String(value).padStart(2, '0');
    }

    /** Local `YYYY-MM-DD` of a Date. */
    function dateKeyOf(date) {
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
    }

    /** Local `YYYY-MM-DD` for now. */
    function todayKey() {
      return dateKeyOf(new Date());
    }

    /** Midday Date of a `YYYY-MM-DD` key (midday avoids DST edges entirely). */
    function fromKey(dateKey) {
      const parts = String(dateKey).split('-');
      return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), 12);
    }

    /** Monday-first weekday index (0 = Monday) of a `YYYY-MM-DD` key. */
    function weekdayIndex(dateKey) {
      return (fromKey(dateKey).getDay() + 6) % 7;
    }

    /** `YYYY-MM` shifted by whole months. */
    function shiftMonth(month, delta) {
      const parts = String(month).split('-');
      const date = new Date(Number(parts[0]), Number(parts[1]) - 1 + delta, 1, 12);
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
    }

    /**
     * The 70 cells (ten Monday-first week-rows) of a month grid, anchored on the
     * Monday of the week containing the 1st, including leading/trailing days.
     */
    function monthCells(month) {
      const parts = String(month).split('-');
      const year = Number(parts[0]);
      const monthIndex = Number(parts[1]) - 1;
      const offset = (new Date(year, monthIndex, 1, 12).getDay() + 6) % 7;
      const cells = [];
      for (let index = 0; index < GRID_DAYS; index += 1) {
        const date = new Date(year, monthIndex, 1 - offset + index, 12);
        cells.push({
          date: dateKeyOf(date),
          inMonth: date.getMonth() === monthIndex,
          day: date.getDate(),
        });
      }
      return cells;
    }

    /**
     * The distinct `YYYY-MM` months the given cells overlap, in order. A ten-row
     * window spans THREE OR FOUR calendar months (70 days, anchored up to 6 days
     * before the 1st and running to at most the 1st + 63 days), so entries must be
     * fetched for every month the grid shows — otherwise the trailing rows render
     * empty on days that do have content.
     */
    function monthsOfCells(cells) {
      const months = [];
      cells.forEach((cell) => {
        const key = cell.date.slice(0, 7);
        if (months.indexOf(key) < 0) months.push(key);
      });
      return months;
    }

    /** Last path segment of a file path (either separator). */
    function dirName(filePath) {
      const value = typeof filePath === 'string' ? filePath : '';
      const cut = Math.max(value.lastIndexOf('\\'), value.lastIndexOf('/'));
      return cut <= 0 ? '' : value.slice(0, cut);
    }

    /** Join a folder and a file name using the separator the folder already uses. */
    function joinPath(dir, name) {
      const folder = typeof dir === 'string' ? dir : '';
      if (folder === '') return String(name);
      const sep = folder.includes('\\') || !folder.includes('/') ? '\\' : '/';
      return folder.endsWith(sep) ? `${folder}${name}` : `${folder}${sep}${name}`;
    }

    /** Default export file name: `diary-YYYYMMDD.xlsx` (plan §5.1 :126). */
    function defaultExportName() {
      return `diary-${todayKey().replace(/-/g, '')}.xlsx`;
    }

    /** Human byte size; '' when the host sent nothing usable. */
    function formatBytes(value) {
      const size = Number(value);
      if (!Number.isFinite(size) || size < 0) return '';
      if (size < 1024) return `${size} B`;
      if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
      return `${(size / (1024 * 1024)).toFixed(1)} MB`;
    }

    /** Render a possibly-missing scalar as text. */
    function dash(value) {
      return value === undefined || value === null || value === '' ? '—' : String(value);
    }

    // ---------------------------------------------------------------------
    // Route client (same-origin fetch; the whole transport of this plugin)
    // ---------------------------------------------------------------------

    /** Build an Error carrying the host's `error` code/message. */
    function routeError(detail) {
      const message =
        typeof detail === 'string' && detail !== ''
          ? detail
          : typeof detail === 'object' && detail !== null && typeof detail.message === 'string'
            ? detail.message
            : 'unknown';
      const error = new Error(message);
      error.code = message;
      return error;
    }

    /**
     * One request to the Host half. Never sends `Origin`/`sec-fetch-site`
     * (.docs/plan-dsh-calendar-diary.md :74) and always bypasses the HTTP cache.
     * Throws an Error whose `message` is the host code when the host says no.
     */
    async function request(method, path, body) {
      const init = { method, cache: 'no-store' };
      if (body !== undefined) {
        init.headers = { 'content-type': 'application/json' };
        init.body = JSON.stringify(body);
      }
      let response;
      try {
        response = await fetch(`${ROUTE_BASE}${path}`, init);
      } catch (cause) {
        const error = new Error('network');
        error.code = 'network';
        error.cause = cause;
        throw error;
      }
      let raw = '';
      try {
        raw = await response.text();
      } catch {
        raw = '';
      }
      let payload;
      if (raw !== '') {
        try {
          payload = JSON.parse(raw);
        } catch {
          payload = undefined;
        }
      }
      if (payload !== undefined && payload !== null && payload.ok === false) {
        throw routeError(payload.error);
      }
      if (!response.ok) {
        throw routeError(
          payload !== undefined && payload !== null && payload.error !== undefined
            ? payload.error
            : `HTTP ${response.status}`,
        );
      }
      if (raw !== '' && payload === undefined) throw routeError('badResponse');
      return payload;
    }

    /** Localized, non-swallowing rendering of a thrown route error. */
    function messageOf(t, error) {
      const detail =
        error !== undefined && error !== null && typeof error.message === 'string' && error.message !== ''
          ? error.message
          : 'unknown';
      if (detail === 'network') return text(t, 'error.network');
      if (detail === 'badResponse') return text(t, 'error.badResponse');
      return text(t, 'error.route', { detail });
    }

    /** Compose "<label>: <detail>" through the dictionary. */
    function prefixed(t, label, detail) {
      return text(t, 'error.prefixed', { label, detail });
    }

    /** Flatten a report value into scalar rows for display. */
    function flattenPairs(value, prefix, out, depth) {
      const rows = out;
      if (rows.length >= MAX_FLATTEN_ROWS || depth > 2) return rows;
      if (value === undefined || value === null) return rows;
      if (Array.isArray(value)) {
        const scalar = value.every(
          (item) => item === null || item === undefined || typeof item !== 'object',
        );
        if (scalar) {
          rows.push({ key: prefix, value: value.map((item) => String(item)).join(', ') });
          return rows;
        }
        value.slice(0, 10).forEach((item, index) => {
          flattenPairs(item, `${prefix}[${index}]`, rows, depth + 1);
        });
        if (value.length > 10) rows.push({ key: prefix, value: `… +${value.length - 10}` });
        return rows;
      }
      if (typeof value === 'object') {
        Object.keys(value).forEach((key) => {
          flattenPairs(value[key], prefix === '' ? key : `${prefix}.${key}`, rows, depth + 1);
        });
        return rows;
      }
      rows.push({ key: prefix, value: String(value) });
      return rows;
    }

    /** Every route this client may call; the only network surface of the plugin. */
    function createApi() {
      return {
        state: () => request('GET', '/state'),
        entries: (month) => request('GET', `/entries?month=${encodeURIComponent(month)}`),
        saveEntry: (date, entryText) => request('POST', '/entries', { date, text: entryText }),
        removeEntry: (date) => request('POST', '/entries/remove', { date }),
        setPath: (dataPath) => request('POST', '/path', { dataPath }),
        pickDir: (title) =>
          request('POST', '/pick-dir', typeof title === 'string' && title !== '' ? { title } : {}),
        listFiles: (dir) => request('POST', '/list-files', { dir }),
        importScan: (sourcePath, policy) => request('POST', '/import/scan', { sourcePath, policy }),
        importApply: (sourcePath, policy) => request('POST', '/import/apply', { sourcePath, policy }),
        exportEntries: (scope, value, outPath) =>
          request('POST', '/export', value === undefined ? { scope, outPath } : { scope, value, outPath }),
      };
    }

    // ---------------------------------------------------------------------
    // Stylesheet (scoped, token-driven, one <style> per activation)
    // ---------------------------------------------------------------------

    const CSS = `
.${PREFIX}-root{display:flex;flex-direction:column;gap:8px;height:100%;min-height:0;padding:10px 12px;box-sizing:border-box;color:var(--dsw-alias-label-primary,inherit);font-size:13px;line-height:20px}
.${PREFIX}-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.${PREFIX}-titles{display:flex;flex-direction:column;gap:2px;min-width:0}
.${PREFIX}-title{margin:0;font-size:15px;line-height:22px;font-weight:600}
.${PREFIX}-actions{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.${PREFIX}-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.35));background:var(--dsw-alias-button-elevated-fill,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,inherit);font:inherit;cursor:pointer;white-space:nowrap}
.${PREFIX}-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.18))}
.${PREFIX}-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#3d7bfd);outline-offset:1px}
.${PREFIX}-btn[disabled]{opacity:.5;cursor:default}
.${PREFIX}-btnPrimary{background:var(--dsw-alias-button-primary-fill,#3d7bfd);border-color:transparent;color:var(--dsw-alias-label-primary-inverted,#fff)}
.${PREFIX}-btnPrimary:hover{background:var(--dsw-alias-button-primary-hover,#356ee6)}
.${PREFIX}-btnGhost{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary,rgba(127,127,127,.95))}
.${PREFIX}-btnGhost:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.18));color:var(--dsw-alias-label-primary,inherit)}
.${PREFIX}-btnDanger{border-color:var(--dsw-alias-state-error-primary,#d9534f);color:var(--dsw-alias-state-error-primary,#d9534f);background:transparent}
.${PREFIX}-notice{border-radius:8px;padding:7px 10px;font-size:12px;line-height:18px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));color:var(--dsw-alias-label-secondary,inherit);overflow-wrap:anywhere}
.${PREFIX}-noticeError{border-color:var(--dsw-alias-state-error-primary,#d9534f);color:var(--dsw-alias-state-error-primary,#d9534f)}
.${PREFIX}-noticeOk{border-color:var(--dsw-alias-state-business-primary,#3d7bfd);color:var(--dsw-alias-label-primary,inherit)}
.${PREFIX}-file{border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));border-radius:10px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.05));padding:8px 10px;display:flex;flex-direction:column;gap:6px}
.${PREFIX}-fileTop{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.${PREFIX}-fileLabel{color:var(--dsw-alias-label-secondary,rgba(127,127,127,.95));font-size:12px}
.${PREFIX}-badge{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:999px;padding:0 7px;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.85))}
.${PREFIX}-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary,inherit)}
.${PREFIX}-spacer{flex:1 1 auto}
.${PREFIX}-body{display:flex;gap:10px;min-height:0;flex:1 1 auto;flex-wrap:wrap;align-items:stretch}
.${PREFIX}-cal{flex:1 1 420px;min-width:300px;display:flex;flex-direction:column;gap:4px;min-height:0}
.${PREFIX}-calHead{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.${PREFIX}-calTitle{font-size:14px;line-height:20px;font-weight:600;min-width:104px}
.${PREFIX}-calBody{display:flex;flex-direction:column;gap:3px;flex:1 1 auto;min-height:0;overflow:auto;padding-right:2px}
.${PREFIX}-weekdays{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:4px}
.${PREFIX}-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));grid-template-rows:repeat(${GRID_ROWS},minmax(${CELL_MIN_HEIGHT}px,1fr));gap:3px;flex:1 1 auto;min-height:0}
.${PREFIX}-weekday{text-align:center;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.85));font-size:12px;line-height:16px}
.${PREFIX}-cell{position:relative;min-height:${CELL_MIN_HEIGHT}px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.05));color:var(--dsw-alias-label-primary,inherit);font:inherit;padding:2px 4px;display:flex;flex-direction:column;align-items:flex-start;gap:1px;cursor:pointer;text-align:left;overflow:hidden;min-width:0}
.${PREFIX}-cell:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.18))}
.${PREFIX}-cell:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#3d7bfd);outline-offset:-2px}
.${PREFIX}-cellOutside{opacity:.45}
.${PREFIX}-cellSelected{border-color:var(--dsw-alias-brand-primary,#3d7bfd)}
.${PREFIX}-cellToday{border-color:var(--dsw-alias-state-business-primary,#3d7bfd);background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12))}
.${PREFIX}-cellMarked{font-weight:600}
.${PREFIX}-cellTop{display:flex;align-items:center;gap:3px;width:100%;min-width:0}
.${PREFIX}-dayNumber{font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary,rgba(127,127,127,.95))}
.${PREFIX}-cellText{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-clamp:2;overflow:hidden;overflow-wrap:anywhere;word-break:break-word;width:100%;max-width:100%;line-height:16px}
.${PREFIX}-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-brand-primary,#3d7bfd);display:block;flex:0 0 auto}
.${PREFIX}-editor{flex:0 1 380px;min-width:280px;display:flex;flex-direction:column;gap:6px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));border-radius:10px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.05));padding:10px}
.${PREFIX}-editorHead{display:flex;align-items:baseline;justify-content:space-between;gap:8px;flex-wrap:wrap}
.${PREFIX}-editorTitle{font-size:13px;font-weight:600}
.${PREFIX}-dirty{color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.85));font-size:12px}
.${PREFIX}-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.${PREFIX}-label{font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary,rgba(127,127,127,.95))}
.${PREFIX}-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.85))}
.${PREFIX}-input,.${PREFIX}-select{height:30px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));color:var(--dsw-alias-label-primary,inherit);padding:0 8px;font:inherit;box-sizing:border-box;min-width:0}
.${PREFIX}-textarea{min-height:150px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));color:var(--dsw-alias-label-primary,inherit);padding:7px 8px;font:inherit;resize:vertical;box-sizing:border-box;width:100%;line-height:20px}
.${PREFIX}-input:focus-visible,.${PREFIX}-select:focus-visible,.${PREFIX}-textarea:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#3d7bfd);outline-offset:1px}
.${PREFIX}-pathRow{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.${PREFIX}-pathRow .${PREFIX}-input{flex:1 1 220px}
.${PREFIX}-fileRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));border-radius:8px;padding:5px 8px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08))}
.${PREFIX}-fileName{font-weight:600;overflow-wrap:anywhere}
.${PREFIX}-fileMeta{color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.85));font-size:11px}
.${PREFIX}-overlay{position:fixed;inset:0;background:var(--dsw-alias-bg-mask-2,rgba(0,0,0,.42));display:flex;align-items:center;justify-content:center;padding:24px;z-index:60}
.${PREFIX}-dialog{width:min(640px,100%);max-height:86vh;overflow:auto;background:var(--dsw-alias-bg-overlay,#fff);border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:10px;color:var(--dsw-alias-label-primary,inherit);box-shadow:0 8px 28px var(--dsw-alias-bg-mask-drop,rgba(0,0,0,.25));box-sizing:border-box}
.${PREFIX}-dialogHead{display:flex;align-items:center;justify-content:space-between;gap:10px}
.${PREFIX}-dialogTitle{margin:0;font-size:15px;line-height:22px;font-weight:600}
.${PREFIX}-section{display:flex;flex-direction:column;gap:6px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));padding-top:8px}
.${PREFIX}-sectionTitle{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,rgba(127,127,127,.95))}
.${PREFIX}-kv{display:flex;flex-direction:column;gap:2px}
.${PREFIX}-kvRow{display:flex;gap:8px;align-items:baseline}
.${PREFIX}-kvKey{flex:0 0 132px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.85));font-size:12px;overflow-wrap:anywhere}
.${PREFIX}-kvVal{flex:1 1 auto;overflow-wrap:anywhere;font-size:12px}
.${PREFIX}-policy{display:flex;flex-direction:column;gap:4px}
.${PREFIX}-radio{display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer}
.${PREFIX}-conflicts{display:flex;flex-direction:column;gap:6px;max-height:260px;overflow:auto}
.${PREFIX}-conflict{border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));border-radius:8px;padding:6px 8px;display:flex;flex-direction:column;gap:3px}
.${PREFIX}-conflictDate{font-weight:600;font-size:12px}
.${PREFIX}-side{display:flex;gap:6px;align-items:flex-start}
.${PREFIX}-sideLabel{flex:0 0 44px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.85));font-size:11px}
.${PREFIX}-pre{margin:0;flex:1 1 auto;white-space:pre-wrap;overflow-wrap:anywhere;font-family:inherit;font-size:12px;line-height:17px;color:var(--dsw-alias-label-primary,inherit)}
.${PREFIX}-details{border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));padding-top:6px}
.${PREFIX}-summary{cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary,rgba(127,127,127,.95))}
.${PREFIX}-dialogActions{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap}
.${PREFIX}-bar{display:flex;flex-direction:column;gap:4px;padding:6px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.05));color:var(--dsw-alias-label-primary,inherit);font-size:12px;line-height:18px}
.${PREFIX}-barTop{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.${PREFIX}-barTitle{font-weight:600}
.${PREFIX}-barInput{flex:1 1 240px;height:26px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));color:var(--dsw-alias-label-primary,inherit);padding:0 8px;font:inherit;box-sizing:border-box;min-width:0}
.${PREFIX}-barInput:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#3d7bfd);outline-offset:1px}
.${PREFIX}-barExisting{display:flex;gap:6px;align-items:baseline;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.85))}
.${PREFIX}-barText{white-space:pre-wrap;overflow-wrap:anywhere;max-height:52px;overflow:auto;color:var(--dsw-alias-label-secondary,rgba(127,127,127,.95))}
.${PREFIX}-barMsg{font-size:11px;line-height:16px}
`;

    /** Install the plugin stylesheet; returns its disposer (old client.js:805-813). */
    function installStyles() {
      const tag = document.createElement('style');
      tag.dataset.plugin = NS;
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return () => {
        if (tag.parentNode !== null) tag.parentNode.removeChild(tag);
      };
    }

    // ---------------------------------------------------------------------
    // Small controls written from tokens (no Harness Client package imports)
    // ---------------------------------------------------------------------

    function Button({ variant, className, children, ...rest }) {
      const extra =
        variant === 'primary'
          ? ` ${PREFIX}-btnPrimary`
          : variant === 'ghost'
            ? ` ${PREFIX}-btnGhost`
            : variant === 'danger'
              ? ` ${PREFIX}-btnDanger`
              : '';
      return h(
        'button',
        {
          type: 'button',
          className: `${PREFIX}-btn${extra}${className ? ` ${className}` : ''}`,
          ...rest,
        },
        children,
      );
    }

    function Notice({ tone, children }) {
      const extra =
        tone === 'error' ? ` ${PREFIX}-noticeError` : tone === 'ok' ? ` ${PREFIX}-noticeOk` : '';
      return h('div', { className: `${PREFIX}-notice${extra}`, role: 'status' }, children);
    }

    function Field({ label, hint, children }) {
      return h(
        'div',
        { className: `${PREFIX}-field` },
        label === undefined ? null : h('span', { className: `${PREFIX}-label` }, label),
        children,
        hint === undefined ? null : h('span', { className: `${PREFIX}-hint` }, hint),
      );
    }

    function PathRow({ label, value, placeholder, onChange, children }) {
      return h(
        'div',
        { className: `${PREFIX}-field` },
        h('span', { className: `${PREFIX}-label` }, label),
        h(
          'div',
          { className: `${PREFIX}-pathRow` },
          h('input', {
            className: `${PREFIX}-input`,
            value,
            placeholder,
            onChange: (event) => onChange(event.target.value),
          }),
          children,
        ),
      );
    }

    function KvList({ pairs }) {
      if (!Array.isArray(pairs) || pairs.length === 0) return null;
      return h(
        'div',
        { className: `${PREFIX}-kv` },
        pairs.map((pair, index) =>
          h(
            'div',
            { className: `${PREFIX}-kvRow`, key: `${pair.key}-${index}` },
            h('span', { className: `${PREFIX}-kvKey` }, pair.key),
            h('span', { className: `${PREFIX}-kvVal` }, pair.value),
          ),
        ),
      );
    }

    function ConfirmDialog({ t, title, message, confirmLabel, pending, onConfirm, onCancel }) {
      return h(
        'div',
        { className: `${PREFIX}-overlay` },
        h(
          'div',
          {
            className: `${PREFIX}-dialog`,
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': title,
          },
          h('h2', { className: `${PREFIX}-dialogTitle` }, title),
          h('div', { className: `${PREFIX}-pre` }, message),
          h(
            'div',
            { className: `${PREFIX}-dialogActions` },
            h(Button, { onClick: onCancel, disabled: pending === true }, text(t, 'action.cancel')),
            h(
              Button,
              { variant: 'danger', onClick: onConfirm, disabled: pending === true },
              confirmLabel === undefined ? text(t, 'confirm.ok') : confirmLabel,
            ),
          ),
        ),
      );
    }

    // ---------------------------------------------------------------------
    // Folder browser: the "输入/粘贴路径 + 列目录点选" fallback that must always
    // work, with pick-dir as the optional nicety (plan §5.1 :128-132, §10 :213).
    // ---------------------------------------------------------------------

    function FolderBrowser({ api, t, browseLabel, newFileName, onPickFile, onPickFolder }) {
      const [state, setState] = useState({ status: 'idle' });

      const browse = async () => {
        setState({ status: 'loading' });
        let picked;
        try {
          picked = await api.pickDir(undefined);
        } catch (error) {
          setState({ status: 'error', error: messageOf(t, error) });
          return;
        }
        const dir = picked !== undefined && picked !== null && typeof picked.dir === 'string' ? picked.dir : '';
        if (dir === '') {
          setState({ status: 'error', error: text(t, 'file.pickerFailed') });
          return;
        }
        // The folder is usable even when listing it fails; degrade, do not break.
        let files = [];
        let listError;
        try {
          const listing = await api.listFiles(dir);
          files = listing !== undefined && listing !== null && Array.isArray(listing.files) ? listing.files : [];
        } catch (error) {
          listError = messageOf(t, error);
        }
        setState({ status: 'ready', dir, files, listError });
        if (typeof onPickFolder === 'function') onPickFolder(dir);
      };

      const rows = [];
      if (state.status === 'loading') {
        rows.push(h('span', { className: `${PREFIX}-hint`, key: 'busy' }, text(t, 'status.loading')));
      }
      if (state.status === 'error') {
        rows.push(
          h(Notice, { tone: 'error', key: 'err' }, `${text(t, 'file.pickerFailed')} (${state.error})`),
        );
      }
      if (state.status === 'ready') {
        if (state.listError !== undefined) {
          rows.push(
            h(
              Notice,
              { tone: 'error', key: 'listErr' },
              text(t, 'file.listFailed', { detail: state.listError }),
            ),
          );
        }
        if (typeof state.dir === 'string' && state.dir !== '') {
          rows.push(
            h('span', { className: `${PREFIX}-hint`, key: 'dir' }, text(t, 'file.filesIn', { dir: state.dir })),
          );
        }
        if (state.files.length === 0) {
          rows.push(h('span', { className: `${PREFIX}-hint`, key: 'none' }, text(t, 'file.noFiles')));
        } else {
          state.files.forEach((file, index) => {
            const name = file !== null && file !== undefined ? String(file.name) : '';
            const path = file !== null && file !== undefined ? String(file.path) : '';
            const size = formatBytes(file === null || file === undefined ? undefined : file.size);
            const mtime = file === null || file === undefined ? '' : String(file.mtime ?? '');
            rows.push(
              h(
                'div',
                { className: `${PREFIX}-fileRow`, key: `${name}-${index}` },
                h('span', { className: `${PREFIX}-fileName` }, name),
                h(
                  'span',
                  { className: `${PREFIX}-fileMeta` },
                  [size, mtime].filter((part) => part !== '').join(' · '),
                ),
                h('span', { className: `${PREFIX}-spacer` }),
                h(
                  Button,
                  { variant: 'ghost', onClick: () => onPickFile(path) },
                  text(t, 'action.use'),
                ),
              ),
            );
          });
        }
        if (typeof newFileName === 'string' && newFileName !== '' && typeof onPickFile === 'function') {
          rows.push(
            h(
              Button,
              {
                variant: 'ghost',
                key: 'newHere',
                onClick: () => onPickFile(joinPath(state.dir, newFileName)),
              },
              text(t, 'file.newHere', { name: newFileName }),
            ),
          );
        }
      }

      return h(
        'div',
        { className: `${PREFIX}-field` },
        h(Button, { onClick: () => void browse(), disabled: state.status === 'loading' }, browseLabel),
        rows.length === 0 ? null : h('div', { className: `${PREFIX}-field` }, rows),
      );
    }

    // ---------------------------------------------------------------------
    // Data-file row: path, health, change path, create when missing
    // ---------------------------------------------------------------------

    function DataFileRow({ api, t, file, onChanged }) {
      const [open, setOpen] = useState(false);
      const [draftPath, setDraftPath] = useState('');
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState(undefined);

      const current = typeof file.dataPath === 'string' ? file.dataPath : '';

      useEffect(() => {
        setDraftPath(current);
      }, [current]);

      const applyPath = async (nextPath) => {
        const target = typeof nextPath === 'string' ? nextPath.trim() : '';
        if (target === '') {
          setNotice({ tone: 'error', text: text(t, 'file.missingPath') });
          return;
        }
        setBusy(true);
        setNotice(undefined);
        try {
          const payload = await api.setPath(target);
          setNotice({
            tone: 'ok',
            text: `${text(t, 'file.ready')} ${text(t, 'status.totalRows', { count: dash(payload === undefined || payload === null ? undefined : payload.totalRows) })}`,
          });
          setOpen(false);
          if (typeof onChanged === 'function') onChanged(payload);
        } catch (error) {
          setNotice({
            tone: 'error',
            text: prefixed(t, text(t, 'error.loadState'), messageOf(t, error)),
          });
        } finally {
          setBusy(false);
        }
      };

      const badges = [];
      if (file.exists === true) badges.push(text(t, 'file.exists'));
      badges.push(file.writable === true ? text(t, 'file.writable') : text(t, 'file.readOnly'));
      badges.push(text(t, 'status.totalRows', { count: dash(file.totalRows) }));
      badges.push(text(t, 'status.months', { count: dash(Array.isArray(file.months) ? file.months.length : undefined) }));

      return h(
        'div',
        { className: `${PREFIX}-file` },
        h(
          'div',
          { className: `${PREFIX}-fileTop` },
          h('span', { className: `${PREFIX}-fileLabel` }, text(t, 'file.title')),
          h('span', { className: `${PREFIX}-code` }, current === '' ? '—' : current),
          h('span', { className: `${PREFIX}-spacer` }),
          badges.map((badge, index) => h('span', { className: `${PREFIX}-badge`, key: `${badge}-${index}` }, badge)),
          h(
            Button,
            { variant: 'ghost', onClick: () => setOpen((value) => !value) },
            text(t, 'action.change'),
          ),
        ),
        file.exists === false
          ? h(
              'div',
              { className: `${PREFIX}-field` },
              h(Notice, null, text(t, 'file.missing')),
              h('span', { className: `${PREFIX}-hint` }, text(t, 'file.createHint')),
              h(
                'div',
                { className: `${PREFIX}-dialogActions` },
                h(
                  Button,
                  { variant: 'primary', onClick: () => void applyPath(current), disabled: busy || current === '' },
                  text(t, 'file.create'),
                ),
              ),
            )
          : null,
        open
          ? h(
              'div',
              { className: `${PREFIX}-field` },
              h(PathRow, {
                label: text(t, 'file.pathLabel'),
                value: draftPath,
                placeholder: text(t, 'file.pathPlaceholder'),
                onChange: setDraftPath,
                children: [
                  h(
                    Button,
                    {
                      key: 'use',
                      variant: 'primary',
                      disabled: busy,
                      onClick: () => void applyPath(draftPath),
                    },
                    text(t, 'file.usePath'),
                  ),
                ],
              }),
              h(FolderBrowser, {
                api,
                t,
                browseLabel: text(t, 'action.browse'),
                newFileName: 'diary.xlsx',
                onPickFile: (filePath) => void applyPath(filePath),
              }),
            )
          : null,
        notice === undefined ? null : h(Notice, { tone: notice.tone }, notice.text),
      );
    }

    // ---------------------------------------------------------------------
    // Month page (main slot)
    // ---------------------------------------------------------------------

    function CalendarDiaryPage(props) {
      const api = props.api;
      const t = props.t;

      const [file, setFile] = useState({ status: 'loading' });
      const [month, setMonth] = useState(() => todayKey().slice(0, 7));
      const [selectedDate, setSelectedDate] = useState(() => todayKey());
      const [entries, setEntries] = useState({ status: 'loading', byDate: {} });
      const [reloadToken, setReloadToken] = useState(0);
      const [draftDate, setDraftDate] = useState(undefined);
      const [draft, setDraft] = useState('');
      const [dayStatus, setDayStatus] = useState(undefined);
      const [busyDay, setBusyDay] = useState(false);
      const [confirmDelete, setConfirmDelete] = useState(false);
      const [dialog, setDialog] = useState(undefined);

      const loadFile = useCallback(async () => {
        try {
          const payload = await api.state();
          setFile({
            status: 'ready',
            dataPath:
              payload !== undefined && payload !== null && typeof payload.dataPath === 'string'
                ? payload.dataPath
                : '',
            exists: payload !== undefined && payload !== null && payload.exists === true,
            writable: payload !== undefined && payload !== null && payload.writable === true,
            totalRows:
              payload !== undefined && payload !== null && Number.isFinite(Number(payload.totalRows))
                ? Number(payload.totalRows)
                : 0,
            months:
              payload !== undefined && payload !== null && Array.isArray(payload.months)
                ? payload.months
                : [],
          });
        } catch (error) {
          setFile({ status: 'error', error: messageOf(t, error) });
        }
      }, [api, t]);

      useEffect(() => {
        void loadFile();
      }, [loadFile]);

      const cells = useMemo(() => monthCells(month), [month]);
      /**
       * Every month the ten-row window overlaps (three or four of them); one cheap
       * fetch each, because a single `?month=` would leave the trailing rows empty.
       */
      const windowMonths = useMemo(() => monthsOfCells(cells), [cells]);
      const windowKey = windowMonths.join(',');
      /**
       * Latest-wins guard: a slow response for a window the user already paged away
       * from must never paint its text into the cells of the current window.
       */
      const windowRef = useRef(windowKey);
      windowRef.current = windowKey;

      useEffect(() => {
        let alive = true;
        setEntries({ status: 'loading', byDate: {} });
        Promise.all(windowMonths.map((item) => api.entries(item))).then(
          (payloads) => {
            if (!alive || windowRef.current !== windowKey) return;
            const map = {};
            payloads.forEach((payload) => {
              const list =
                payload !== undefined && payload !== null && Array.isArray(payload.entries)
                  ? payload.entries
                  : [];
              list.forEach((item) => {
                if (item !== null && item !== undefined && typeof item.date === 'string') map[item.date] = item;
              });
            });
            setEntries({ status: 'ready', byDate: map, months: windowMonths });
          },
          (error) => {
            if (!alive || windowRef.current !== windowKey) return;
            setEntries({ status: 'error', byDate: {}, error: messageOf(t, error) });
          },
        );
        return () => {
          alive = false;
        };
      }, [api, reloadToken, t, windowKey]);

      const storedEntry = entries.byDate[selectedDate];
      const storedText =
        storedEntry !== undefined && storedEntry !== null && typeof storedEntry.text === 'string'
          ? storedEntry.text
          : '';
      /** Verbatim text: untouched days re-send the stored bytes (line breaks kept). */
      const editorText = draftDate === selectedDate ? draft : storedText;
      const dirty = draftDate === selectedDate && draft !== storedText;

      const afterWrite = () => {
        setReloadToken((value) => value + 1);
        void loadFile();
      };

      const selectDay = (date) => {
        setSelectedDate(date);
        setDraftDate(undefined);
        setDraft('');
        setDayStatus(undefined);
        if (date.slice(0, 7) !== month) setMonth(date.slice(0, 7));
      };

      const saveDay = async () => {
        if (busyDay) return;
        setBusyDay(true);
        setDayStatus({ tone: 'info', text: text(t, 'day.saving') });
        const value = editorText;
        try {
          const payload = await api.saveEntry(selectedDate, value);
          const entry =
            payload !== undefined && payload !== null && payload.entry !== undefined && payload.entry !== null
              ? payload.entry
              : { date: selectedDate, text: value };
          setEntries((previous) => ({
            ...previous,
            byDate: { ...previous.byDate, [entry.date]: entry },
          }));
          setDraftDate(undefined);
          setDraft('');
          setDayStatus({
            tone: 'ok',
            text: value === '' ? text(t, 'day.cleared') : text(t, 'day.saved'),
          });
          afterWrite();
        } catch (error) {
          setDayStatus({
            tone: 'error',
            text: prefixed(t, text(t, 'error.save'), messageOf(t, error)),
          });
        } finally {
          setBusyDay(false);
        }
      };

      const removeDay = async () => {
        setConfirmDelete(false);
        setBusyDay(true);
        setDayStatus({ tone: 'info', text: text(t, 'day.saving') });
        const date = selectedDate;
        try {
          await api.removeEntry(date);
          setEntries((previous) => {
            const byDate = { ...previous.byDate };
            delete byDate[date];
            return { ...previous, byDate };
          });
          setDraftDate(undefined);
          setDraft('');
          setDayStatus({ tone: 'ok', text: text(t, 'day.deleted') });
          afterWrite();
        } catch (error) {
          setDayStatus({
            tone: 'error',
            text: prefixed(t, text(t, 'error.remove'), messageOf(t, error)),
          });
        } finally {
          setBusyDay(false);
        }
      };

      const markedCount = Object.keys(entries.byDate).filter((key) => {
        const item = entries.byDate[key];
        return item !== undefined && item !== null && typeof item.text === 'string' && item.text !== '';
      }).length;

      const fileStateReady = file.status === 'ready';

      return h(
        'div',
        { className: `${PREFIX}-root` },
        h(
          'div',
          { className: `${PREFIX}-head` },
          h(
            'div',
            { className: `${PREFIX}-titles` },
            h('h2', { className: `${PREFIX}-title` }, text(t, 'title')),
          ),
          h(
            'div',
            { className: `${PREFIX}-actions` },
            h(Button, { onClick: () => setDialog('import') }, text(t, 'action.import')),
            h(Button, { onClick: () => setDialog('export') }, text(t, 'action.export')),
            h(Button, { variant: 'ghost', onClick: () => void loadFile() }, text(t, 'action.reload')),
          ),
        ),
        file.status === 'loading' ? h(Notice, null, text(t, 'status.loading')) : null,
        file.status === 'error'
          ? h(
              'div',
              { className: `${PREFIX}-field` },
              h(Notice, { tone: 'error' }, prefixed(t, text(t, 'error.loadState'), file.error)),
              h(
                'div',
                { className: `${PREFIX}-dialogActions` },
                h(Button, { onClick: () => void loadFile() }, text(t, 'action.retry')),
              ),
            )
          : null,
        fileStateReady
          ? h(DataFileRow, {
              api,
              t,
              file,
              onChanged: () => afterWrite(),
            })
          : null,
        h(
          'div',
          { className: `${PREFIX}-body` },
          h(
            'div',
            { className: `${PREFIX}-cal` },
            h(
              'div',
              { className: `${PREFIX}-calHead` },
              h(
                Button,
                {
                  'aria-label': text(t, 'action.prevMonth'),
                  onClick: () => setMonth((value) => shiftMonth(value, -1)),
                },
                '‹',
              ),
              h(
                'span',
                { className: `${PREFIX}-calTitle` },
                text(t, 'month.title', {
                  year: String(month.split('-')[0]),
                  month: String(Number(month.split('-')[1])),
                }),
              ),
              h(
                Button,
                {
                  'aria-label': text(t, 'action.nextMonth'),
                  onClick: () => setMonth((value) => shiftMonth(value, 1)),
                },
                '›',
              ),
              h(
                Button,
                { variant: 'ghost', onClick: () => selectDay(todayKey()) },
                text(t, 'action.today'),
              ),
              h('span', { className: `${PREFIX}-spacer` }),
              entries.status === 'ready'
                ? h(
                    'span',
                    { className: `${PREFIX}-hint` },
                    markedCount === 0 ? text(t, 'month.empty') : text(t, 'status.totalRows', { count: markedCount }),
                  )
                : null,
            ),
            h(
              'div',
              { className: `${PREFIX}-calBody` },
              h(
                'div',
                { className: `${PREFIX}-weekdays`, role: 'row' },
                WEEKDAY_KEYS.map((key) => h('span', { className: `${PREFIX}-weekday`, key }, text(t, key))),
              ),
              entries.status === 'error'
                ? h(Notice, { tone: 'error' }, prefixed(t, text(t, 'error.loadEntries'), entries.error))
                : null,
              entries.status === 'loading'
                ? h('span', { className: `${PREFIX}-hint` }, text(t, 'status.loading'))
                : null,
              h(
                'div',
                { className: `${PREFIX}-grid`, role: 'grid', 'aria-label': text(t, 'a11y.grid', { month }) },
                cells.map((cell) => {
                  const item = entries.byDate[cell.date];
                  const marked =
                    item !== undefined && item !== null && typeof item.text === 'string' && item.text !== '';
                  /** Preview cast from the month data; runs of whitespace collapse to single spaces. */
                  const preview = marked ? item.text.split(/\s+/).join(' ').trim() : '';
                  const isToday = cell.date === todayKey();
                  const classes = [
                    `${PREFIX}-cell`,
                    cell.inMonth ? '' : `${PREFIX}-cellOutside`,
                    cell.date === selectedDate ? `${PREFIX}-cellSelected` : '',
                    isToday ? `${PREFIX}-cellToday` : '',
                    marked ? `${PREFIX}-cellMarked` : '',
                  ]
                    .filter((part) => part !== '')
                    .join(' ');
                  return h(
                    'button',
                    {
                      type: 'button',
                      key: cell.date,
                      className: classes,
                      'aria-pressed': cell.date === selectedDate,
                      'aria-label': marked ? `${cell.date} · ${text(t, 'a11y.marked')}` : cell.date,
                      /** Hover fallback: the FULL untruncated day text, newlines included. */
                      title: marked ? item.text : undefined,
                      onClick: () => selectDay(cell.date),
                    },
                    h(
                      'span',
                      { className: `${PREFIX}-cellTop` },
                      h('span', { className: `${PREFIX}-dayNumber` }, String(cell.day)),
                      marked ? h('span', { className: `${PREFIX}-dot`, 'aria-hidden': true }) : null,
                    ),
                    preview === '' ? null : h('span', { className: `${PREFIX}-cellText` }, preview),
                  );
                }),
              ),
            ),
          ),
          h(
            'div',
            { className: `${PREFIX}-editor` },
            h(
              'div',
              { className: `${PREFIX}-editorHead` },
              h(
                'span',
                { className: `${PREFIX}-editorTitle` },
                text(t, 'day.heading', {
                  date: selectedDate,
                  week: text(t, WEEKDAY_KEYS[weekdayIndex(selectedDate)]),
                }),
              ),
              dirty ? h('span', { className: `${PREFIX}-dirty` }, text(t, 'day.unsaved')) : null,
            ),
            h('textarea', {
              className: `${PREFIX}-textarea`,
              value: editorText,
              placeholder: text(t, 'day.placeholder'),
              spellCheck: false,
              onChange: (event) => {
                setDraftDate(selectedDate);
                setDraft(event.target.value);
              },
              onKeyDown: (event) => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  void saveDay();
                }
              },
            }),
            h(
              'div',
              { className: `${PREFIX}-dialogActions` },
              h(
                Button,
                { variant: 'primary', disabled: busyDay, onClick: () => void saveDay() },
                text(t, 'action.save'),
              ),
              h(
                Button,
                {
                  variant: 'danger',
                  disabled: busyDay,
                  onClick: () => setConfirmDelete(true),
                },
                text(t, 'action.delete'),
              ),
            ),
            dayStatus === undefined ? null : h(Notice, { tone: dayStatus.tone }, dayStatus.text),
          ),
        ),
        confirmDelete
          ? h(ConfirmDialog, {
              t,
              title: text(t, 'confirm.title'),
              message: text(t, 'day.deleteConfirm', { date: selectedDate }),
              confirmLabel: text(t, 'action.delete'),
              pending: busyDay,
              onConfirm: () => void removeDay(),
              onCancel: () => setConfirmDelete(false),
            })
          : null,
        dialog === 'import'
          ? h(ImportDialog, {
              api,
              t,
              defaultDir: dirName(file.dataPath),
              onClose: () => setDialog(undefined),
              onImported: () => afterWrite(),
            })
          : null,
        dialog === 'export'
          ? h(ExportDialog, {
              api,
              t,
              defaultDir: dirName(file.dataPath),
              onClose: () => setDialog(undefined),
            })
          : null,
      );
    }

    // ---------------------------------------------------------------------
    // Import: pick a source file, scan (mandatory), choose policy, apply
    // ---------------------------------------------------------------------

    function ImportDialog({ api, t, defaultDir, onClose, onImported }) {
      const [sourcePath, setSourcePath] = useState('');
      const [policy, setPolicy] = useState('keep');
      const [scan, setScan] = useState({ status: 'idle' });
      const [applyState, setApplyState] = useState({ status: 'idle' });

      const runScan = useCallback(
        async (nextPolicy, nextSource) => {
          const source = typeof nextSource === 'string' ? nextSource.trim() : '';
          if (source === '') {
            setScan({ status: 'error', error: text(t, 'error.needSource') });
            return;
          }
          setScan({ status: 'loading' });
          try {
            const payload = await api.importScan(source, nextPolicy);
            setScan({ status: 'ready', result: payload, source, policy: nextPolicy });
          } catch (error) {
            setScan({ status: 'error', error: messageOf(t, error) });
          }
        },
        [api, t],
      );

      const scanned = scan.status === 'ready' ? scan.result : undefined;
      /** Apply is impossible until this exact source+policy has been previewed. */
      const canApply =
        scanned !== undefined &&
        scan.source === sourcePath.trim() &&
        scan.policy === policy &&
        applyState.status !== 'busy';

      const changeSource = (next) => {
        setSourcePath(next);
        setScan({ status: 'idle' });
        setApplyState({ status: 'idle' });
      };

      const changePolicy = (next) => {
        setPolicy(next);
        setApplyState({ status: 'idle' });
        if (scan.status === 'ready' || scan.status === 'error') void runScan(next, sourcePath);
      };

      const runApply = async () => {
        if (!canApply) return;
        setApplyState({ status: 'busy' });
        try {
          const payload = await api.importApply(sourcePath.trim(), policy);
          setApplyState({ status: 'ready', result: payload });
          if (typeof onImported === 'function') onImported();
        } catch (error) {
          setApplyState({ status: 'error', error: messageOf(t, error) });
        }
      };

      const conflicts =
        scanned !== undefined && scanned !== null && Array.isArray(scanned.conflicts) ? scanned.conflicts : [];
      const range =
        scanned !== undefined && scanned !== null && scanned.dateRange !== undefined && scanned.dateRange !== null
          ? `${dash(scanned.dateRange.from)} → ${dash(scanned.dateRange.to)}`
          : '—';
      const scanPairs =
        scanned === undefined
          ? []
          : [
              { key: text(t, 'import.source'), value: dash(scanned.source) },
              { key: text(t, 'import.rows'), value: dash(scanned.rows) },
              { key: text(t, 'import.range'), value: range },
              { key: text(t, 'import.added'), value: dash(scanned.added) },
              { key: text(t, 'import.conflicts'), value: String(conflicts.length) },
              { key: text(t, 'import.unchanged'), value: dash(scanned.unchanged) },
              { key: text(t, 'import.skipped'), value: dash(scanned.skipped) },
            ].concat(
              flattenPairs(scanned.detection, text(t, 'import.detection'), [], 0),
            );
      const applyResult = applyState.status === 'ready' ? applyState.result : undefined;
      const policyOptions = [
        { value: 'keep', label: text(t, 'import.policy.keep') },
        { value: 'overwrite', label: text(t, 'import.policy.overwrite') },
        { value: 'concat', label: text(t, 'import.policy.concat') },
        { value: 'skip', label: text(t, 'import.policy.skip') },
      ];

      return h(
        'div',
        { className: `${PREFIX}-overlay` },
        h(
          'div',
          {
            className: `${PREFIX}-dialog`,
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': text(t, 'import.title'),
          },
          h(
            'div',
            { className: `${PREFIX}-dialogHead` },
            h('h2', { className: `${PREFIX}-dialogTitle` }, text(t, 'import.title')),
            h(Button, { variant: 'ghost', onClick: onClose }, text(t, 'action.close')),
          ),
          h(
            'div',
            { className: `${PREFIX}-section` },
            h('span', { className: `${PREFIX}-sectionTitle` }, text(t, 'import.step1')),
            h(PathRow, {
              label: text(t, 'import.sourceLabel'),
              value: sourcePath,
              placeholder: text(t, 'import.sourcePlaceholder'),
              onChange: changeSource,
            }),
            h(FolderBrowser, {
              api,
              t,
              browseLabel: text(t, 'action.browse'),
              onPickFile: (filePath) => changeSource(filePath),
            }),
            defaultDir === '' ? null : h('span', { className: `${PREFIX}-hint` }, defaultDir),
          ),
          h(
            'div',
            { className: `${PREFIX}-section` },
            h('span', { className: `${PREFIX}-sectionTitle` }, text(t, 'import.step2')),
            h(
              'div',
              { className: `${PREFIX}-dialogActions` },
              h(
                Button,
                {
                  variant: 'primary',
                  disabled: scan.status === 'loading',
                  onClick: () => void runScan(policy, sourcePath),
                },
                text(t, 'action.preview'),
              ),
            ),
            scan.status === 'loading' ? h(Notice, null, text(t, 'import.scanning')) : null,
            scan.status === 'error' ? h(Notice, { tone: 'error' }, scan.error) : null,
            scanned === undefined ? null : h(KvList, { pairs: scanPairs }),
            scanned === undefined
              ? null
              : h(
                  'details',
                  { className: `${PREFIX}-details` },
                  h(
                    'summary',
                    { className: `${PREFIX}-summary` },
                    `${text(t, 'import.conflictList')} (${conflicts.length})`,
                  ),
                  h(
                    'div',
                    { className: `${PREFIX}-conflicts` },
                    conflicts.length === 0
                      ? h('span', { className: `${PREFIX}-hint` }, text(t, 'import.noConflicts'))
                      : conflicts.map((conflict, index) =>
                          h(
                            'div',
                            { className: `${PREFIX}-conflict`, key: `${dash(conflict.date)}-${index}` },
                            h('span', { className: `${PREFIX}-conflictDate` }, dash(conflict.date)),
                            h(
                              'div',
                              { className: `${PREFIX}-side` },
                              h('span', { className: `${PREFIX}-sideLabel` }, text(t, 'import.conflictExisting')),
                              h('pre', { className: `${PREFIX}-pre` }, dash(conflict.existing)),
                            ),
                            h(
                              'div',
                              { className: `${PREFIX}-side` },
                              h('span', { className: `${PREFIX}-sideLabel` }, text(t, 'import.conflictIncoming')),
                              h('pre', { className: `${PREFIX}-pre` }, dash(conflict.incoming)),
                            ),
                          ),
                        ),
                  ),
                ),
          ),
          h(
            'div',
            { className: `${PREFIX}-section` },
            h('span', { className: `${PREFIX}-sectionTitle` }, text(t, 'import.step3')),
            h(
              'div',
              { className: `${PREFIX}-policy` },
              policyOptions.map((option) =>
                h(
                  'label',
                  { className: `${PREFIX}-radio`, key: option.value },
                  h('input', {
                    type: 'radio',
                    name: 'dcd-import-policy',
                    checked: policy === option.value,
                    onChange: () => changePolicy(option.value),
                  }),
                  h('span', null, option.label),
                ),
              ),
            ),
            canApply
              ? h(
                  'div',
                  { className: `${PREFIX}-dialogActions` },
                  h(
                    Button,
                    { variant: 'primary', disabled: applyState.status === 'busy', onClick: () => void runApply() },
                    applyState.status === 'busy' ? text(t, 'import.applying') : text(t, 'import.apply'),
                  ),
                )
              : h('span', { className: `${PREFIX}-hint` }, text(t, 'import.confirmHint')),
            applyState.status === 'error' ? h(Notice, { tone: 'error' }, applyState.error) : null,
          ),
          applyResult === undefined
            ? null
            : h(
                'div',
                { className: `${PREFIX}-section` },
                h('span', { className: `${PREFIX}-sectionTitle` }, text(t, 'import.done')),
                h(KvList, {
                  pairs: [
                    {
                      key: text(t, 'import.totalRowsLabel'),
                      value: text(t, 'status.totalRows', { count: dash(applyResult.totalRows) }),
                    },
                    {
                      key: text(t, 'import.backupLabel'),
                      value: dash(applyResult.backupPath),
                    },
                  ].concat(flattenPairs(applyResult.report, text(t, 'import.report'), [], 0)),
                }),
                h(
                  'details',
                  { className: `${PREFIX}-details` },
                  h('summary', { className: `${PREFIX}-summary` }, text(t, 'import.raw')),
                  h('pre', { className: `${PREFIX}-pre` }, JSON.stringify(applyResult, null, 2)),
                ),
              ),
        ),
      );
    }

    // ---------------------------------------------------------------------
    // Export: scope + target path, then show outPath / rows / bytes
    // ---------------------------------------------------------------------

    function ExportDialog({ api, t, defaultDir, onClose }) {
      const [scope, setScope] = useState('all');
      const [year, setYear] = useState(() => String(new Date().getFullYear()));
      const [month, setMonth] = useState(() => todayKey().slice(0, 7));
      const [outPath, setOutPath] = useState(() =>
        defaultDir === '' ? defaultExportName() : joinPath(defaultDir, defaultExportName()),
      );
      const [result, setResult] = useState({ status: 'idle' });

      const run = async () => {
        let value;
        if (scope === 'year') {
          if (!/^\d{4}$/.test(year.trim())) {
            setResult({ status: 'error', error: text(t, 'error.needValue') });
            return;
          }
          value = year.trim();
        } else if (scope === 'month') {
          if (!/^\d{4}-\d{2}$/.test(month.trim())) {
            setResult({ status: 'error', error: text(t, 'error.needValue') });
            return;
          }
          value = month.trim();
        }
        const target = outPath.trim();
        if (target === '') {
          setResult({ status: 'error', error: text(t, 'error.needPath') });
          return;
        }
        setResult({ status: 'busy' });
        try {
          const payload = await api.exportEntries(scope, value, target);
          setResult({ status: 'ready', result: payload });
        } catch (error) {
          setResult({ status: 'error', error: messageOf(t, error) });
        }
      };

      const exported = result.status === 'ready' ? result.result : undefined;
      const scopeOptions = [
        { value: 'all', label: text(t, 'export.scope.all') },
        { value: 'year', label: text(t, 'export.scope.year') },
        { value: 'month', label: text(t, 'export.scope.month') },
      ];

      return h(
        'div',
        { className: `${PREFIX}-overlay` },
        h(
          'div',
          {
            className: `${PREFIX}-dialog`,
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': text(t, 'export.title'),
          },
          h(
            'div',
            { className: `${PREFIX}-dialogHead` },
            h('h2', { className: `${PREFIX}-dialogTitle` }, text(t, 'export.title')),
            h(Button, { variant: 'ghost', onClick: onClose }, text(t, 'action.close')),
          ),
          h(
            'div',
            { className: `${PREFIX}-section` },
            h('span', { className: `${PREFIX}-sectionTitle` }, text(t, 'export.scope')),
            h(
              'div',
              { className: `${PREFIX}-policy` },
              scopeOptions.map((option) =>
                h(
                  'label',
                  { className: `${PREFIX}-radio`, key: option.value },
                  h('input', {
                    type: 'radio',
                    name: 'dcd-export-scope',
                    checked: scope === option.value,
                    onChange: () => setScope(option.value),
                  }),
                  h('span', null, option.label),
                ),
              ),
            ),
            scope === 'year'
              ? h(Field, { label: text(t, 'export.yearLabel') }, [
                  h('input', {
                    key: 'year',
                    className: `${PREFIX}-input`,
                    value: year,
                    inputMode: 'numeric',
                    onChange: (event) => setYear(event.target.value),
                  }),
                ])
              : null,
            scope === 'month'
              ? h(Field, { label: text(t, 'export.monthLabel') }, [
                  h('input', {
                    key: 'month',
                    className: `${PREFIX}-input`,
                    type: 'month',
                    value: month,
                    onChange: (event) => setMonth(event.target.value),
                  }),
                ])
              : null,
          ),
          h(
            'div',
            { className: `${PREFIX}-section` },
            h(PathRow, {
              label: text(t, 'export.outLabel'),
              value: outPath,
              placeholder: text(t, 'export.outPlaceholder'),
              onChange: setOutPath,
            }),
            h(FolderBrowser, {
              api,
              t,
              browseLabel: text(t, 'action.browse'),
              onPickFolder: (dir) => setOutPath(joinPath(dir, defaultExportName())),
            }),
          ),
          h(
            'div',
            { className: `${PREFIX}-dialogActions` },
            h(
              Button,
              { variant: 'primary', disabled: result.status === 'busy', onClick: () => void run() },
              result.status === 'busy' ? text(t, 'export.running') : text(t, 'action.export'),
            ),
          ),
          result.status === 'error' ? h(Notice, { tone: 'error' }, result.error) : null,
          exported === undefined
            ? null
            : h(
                'div',
                { className: `${PREFIX}-section` },
                h(
                  Notice,
                  { tone: 'ok' },
                  text(t, 'export.done', { rows: dash(exported.rows), bytes: dash(exported.bytes) }),
                ),
                h('span', { className: `${PREFIX}-hint` }, text(t, 'export.outPath', { path: dash(exported.outPath) })),
              ),
        ),
      );
    }

    // ---------------------------------------------------------------------
    // "Today" bar (conversation.composer.dock)
    // ---------------------------------------------------------------------

    function TodayBar(props) {
      const api = props.api;
      const t = props.t;
      const date = todayKey();
      const [value, setValue] = useState('');
      const [todayText, setTodayText] = useState(undefined);
      const [loadError, setLoadError] = useState(undefined);
      const [status, setStatus] = useState(undefined);
      const [busy, setBusy] = useState(false);
      const [confirming, setConfirming] = useState(false);

      useEffect(() => {
        let alive = true;
        api.entries(date.slice(0, 7)).then(
          (payload) => {
            if (!alive) return;
            const list =
              payload !== undefined && payload !== null && Array.isArray(payload.entries)
                ? payload.entries
                : [];
            const found = list.find((item) => item !== null && item !== undefined && item.date === date);
            setTodayText(
              found !== undefined && found !== null && typeof found.text === 'string' ? found.text : '',
            );
            setLoadError(undefined);
          },
          (error) => {
            if (!alive) return;
            setLoadError(messageOf(t, error));
          },
        );
        return () => {
          alive = false;
        };
      }, [api, date, t]);

      const write = async (next) => {
        setConfirming(false);
        setBusy(true);
        setStatus({ tone: 'info', text: text(t, 'day.saving') });
        try {
          await api.saveEntry(date, next);
          setTodayText(next);
          setValue('');
          setStatus({ tone: 'ok', text: text(t, 'today.saved', { date }) });
        } catch (error) {
          setStatus({ tone: 'error', text: prefixed(t, text(t, 'error.save'), messageOf(t, error)) });
        } finally {
          setBusy(false);
        }
      };

      const save = () => {
        if (busy) return;
        if (value.trim() === '') {
          setStatus({ tone: 'error', text: text(t, 'today.empty') });
          return;
        }
        if (typeof todayText === 'string' && todayText !== '' && todayText !== value) {
          setConfirming(true);
          return;
        }
        void write(value);
      };

      return h(
        'div',
        { className: `${PREFIX}-bar` },
        h(
          'div',
          { className: `${PREFIX}-barTop` },
          h('span', { className: `${PREFIX}-barTitle` }, text(t, 'today.title')),
          h('span', { className: `${PREFIX}-hint` }, date),
          h('input', {
            className: `${PREFIX}-barInput`,
            value,
            placeholder: text(t, 'today.placeholder'),
            'aria-label': text(t, 'today.title'),
            onChange: (event) => setValue(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                save();
              }
            },
          }),
          h(
            Button,
            { variant: 'primary', disabled: busy, onClick: save },
            text(t, 'today.save'),
          ),
        ),
        loadError === undefined
          ? null
          : h('span', { className: `${PREFIX}-barMsg` }, text(t, 'today.loadFailed', { detail: loadError })),
        typeof todayText === 'string' && todayText !== ''
          ? h(
              'div',
              { className: `${PREFIX}-barExisting` },
              h('span', null, text(t, 'today.existing')),
              h('span', { className: `${PREFIX}-barText` }, todayText),
            )
          : null,
        status === undefined ? null : h('span', { className: `${PREFIX}-barMsg` }, status.text),
        confirming
          ? h(ConfirmDialog, {
              t,
              title: text(t, 'confirm.title'),
              message: text(t, 'today.overwrite'),
              confirmLabel: text(t, 'confirm.ok'),
              pending: busy,
              onConfirm: () => void write(value),
              onCancel: () => setConfirming(false),
            })
          : null,
      );
    }

    // ---------------------------------------------------------------------
    // Sidebar glyph (decorative; the sidebar owns the accessible row label)
    // ---------------------------------------------------------------------

    function CalendarDiaryIcon({ size = 16 }) {
      const edge = Number.isFinite(size) ? size : 16;
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: edge,
          height: edge,
          'aria-hidden': true,
          style: { display: 'block', color: 'currentColor' },
        },
        h('rect', {
          x: 1.5,
          y: 3,
          width: 13,
          height: 11.5,
          rx: 1.5,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.2,
        }),
        h('path', { d: 'M1.5 6.2h13', stroke: 'currentColor', strokeWidth: 1.2 }),
        h('path', { d: 'M4.6 1.6v3M11.4 1.6v3', stroke: 'currentColor', strokeWidth: 1.2 }),
        h('circle', { cx: 4.9, cy: 9.2, r: 1.1, fill: 'currentColor' }),
        h('circle', { cx: 8, cy: 9.2, r: 1.1, fill: 'currentColor' }),
        h('path', {
          d: 'M8.6 11.5h4',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
        }),
      );
    }

    // ---------------------------------------------------------------------
    // Dictionaries (declared before the returned plugin object; building them is
    // side-effect free, which the lazy factory requires). These are byte-identical
    // in key set and value with locale/zh.json and locale/en.json, which ship as
    // the inspectable copies; client.js cannot require JSON, so it carries them
    // inline (the same choice the previous client made at :1732-1909).
    // ---------------------------------------------------------------------

    /** Simplified Chinese dictionary (key-set source of truth is locale/zh.json). */
    const ZH_DICTIONARY = {
      panel: '日历日记',
      title: '日历日记',
      'action.today': '今天',
      'action.prevMonth': '上一月',
      'action.nextMonth': '下一月',
      'action.save': '保存',
      'action.cancel': '取消',
      'action.close': '关闭',
      'action.retry': '重试',
      'action.reload': '刷新',
      'action.change': '更改…',
      'action.browse': '浏览…',
      'action.use': '使用',
      'action.preview': '预览',
      'action.delete': '删除这条',
      'action.import': '导入',
      'action.export': '导出',
      'week.mon': '一',
      'week.tue': '二',
      'week.wed': '三',
      'week.thu': '四',
      'week.fri': '五',
      'week.sat': '六',
      'week.sun': '日',
      'month.title': '{year}年{month}月',
      'month.empty': '这个月还没有记录。',
      'day.heading': '{date}（星期{week}）',
      'day.placeholder': '这一天还没有记录。',
      'day.unsaved': '有未保存的改动',
      'day.saving': '正在保存…',
      'day.saved': '已保存',
      'day.cleared': '已清空这一天的文本（行保留）',
      'day.deleted': '已删除这一行',
      'day.deleteConfirm': '删除 {date} 这一行？该行会从数据文件里移除，且不可撤销。',
      'a11y.grid': '{month} 的月历',
      'a11y.marked': '有记录',
      'status.loading': '正在读取…',
      'status.empty': '还没有任何记录。',
      'status.totalRows': '共 {count} 行',
      'status.months': '有记录的月份 {count} 个',
      'error.network': '没能连接到宿主路由（应用传输层没有响应）。',
      'error.badResponse': '宿主返回了无法解析的响应。',
      'error.route': '请求失败：{detail}',
      'error.prefixed': '{label}：{detail}',
      'error.loadState': '读取数据文件状态失败',
      'error.loadEntries': '读取本月记录失败',
      'error.save': '保存失败',
      'error.remove': '删除失败',
      'error.needSource': '请先选择导入来源文件。',
      'error.needPath': '请先填写导出文件路径。',
      'error.needValue': '请先选择要导出的年份或月份。',
      'file.title': '数据文件',
      'file.exists': '存在',
      'file.missing': '文件还不存在。',
      'file.missingPath': '还没有指定数据文件路径。',
      'file.createHint':
        '可以按这个路径新建一个空的 .xlsx：表名 DesktopCal、A 列整数日期序列号（m/d/yy）、B 列文本。',
      'file.create': '新建数据文件',
      'file.ready': '数据文件已就绪。',
      'file.pathLabel': '路径',
      'file.pathPlaceholder': 'C:\\Users\\<user>\\.dsh\\dsh-calendar-diary\\diary.xlsx',
      'file.usePath': '使用此路径',
      'file.newHere': '在此文件夹新建 {name}',
      'file.filesIn': '{dir} 里的候选文件',
      'file.noFiles': '这个文件夹里没有 .xlsx / .xls 文件。',
      'file.listFailed': '列目录失败：{detail}',
      'file.pickerFailed': '原生文件夹对话框不可用，请直接粘贴完整路径。',
      'file.writable': '可写',
      'file.readOnly': '只读',
      'import.title': '导入',
      'import.step1': '第 1 步 · 选择来源文件',
      'import.step2': '第 2 步 · 预览（只扫描，不写盘）',
      'import.step3': '第 3 步 · 冲突策略',
      'import.sourceLabel': '来源文件路径（.xlsx / .xls）',
      'import.sourcePlaceholder': 'C:\\Users\\<user>\\Documents\\old-calendar.xls',
      'import.scanning': '正在扫描…',
      'import.source': '来源',
      'import.rows': '行数',
      'import.range': '日期范围',
      'import.added': '新增',
      'import.conflicts': '冲突',
      'import.unchanged': '未变',
      'import.skipped': '跳过',
      'import.detection': '识别结果',
      'import.conflictList': '冲突明细',
      'import.conflictExisting': '现有',
      'import.conflictIncoming': '导入',
      'import.noConflicts': '没有冲突。',
      'import.policy.keep': '保留现有（默认）',
      'import.policy.overwrite': '用导入的覆盖',
      'import.policy.concat': '拼接为多行',
      'import.policy.skip': '跳过冲突',
      'import.confirmHint': '必须先完成第 2 步预览，才能确认导入。',
      'import.apply': '确认导入',
      'import.applying': '正在导入…',
      'import.done': '导入完成',
      'import.totalRows': '导入后共 {count} 行',
      'import.totalRowsLabel': '导入后行数',
      'import.backup': '备份文件：{path}',
      'import.backupLabel': '备份文件',
      'import.report': '报告',
      'import.raw': '宿主原始返回',
      'import.stale': '来源或策略已改变，请重新预览。',
      'export.title': '导出',
      'export.scope': '范围',
      'export.scope.all': '全部',
      'export.scope.year': '某一年',
      'export.scope.month': '某月',
      'export.yearLabel': '年份',
      'export.monthLabel': '月份',
      'export.outLabel': '保存到（.xlsx，只写新文件）',
      'export.outPlaceholder': 'C:\\Users\\<user>\\Documents\\diary-export.xlsx',
      'export.running': '正在导出…',
      'export.done': '已导出 {rows} 行，{bytes} 字节',
      'export.outPath': '文件：{path}',
      'today.title': '今日',
      'today.placeholder': '记一笔今天…',
      'today.save': '保存',
      'today.saved': '已写入 {date}',
      'today.existing': '今日已有：',
      'today.overwrite': '今天已经有内容了，用输入框里的文字覆盖它？',
      'today.empty': '请先输入内容。',
      'today.loadFailed': '读取今日内容失败：{detail}',
      'confirm.title': '确认',
      'confirm.ok': '确定',
    };

    /** English dictionary (same key set as locale/en.json). */
    const EN_DICTIONARY = {
      panel: 'Calendar diary',
      title: 'Calendar diary',
      'action.today': 'Today',
      'action.prevMonth': 'Previous month',
      'action.nextMonth': 'Next month',
      'action.save': 'Save',
      'action.cancel': 'Cancel',
      'action.close': 'Close',
      'action.retry': 'Retry',
      'action.reload': 'Refresh',
      'action.change': 'Change…',
      'action.browse': 'Browse…',
      'action.use': 'Use',
      'action.preview': 'Preview',
      'action.delete': 'Delete this row',
      'action.import': 'Import',
      'action.export': 'Export',
      'week.mon': 'Mon',
      'week.tue': 'Tue',
      'week.wed': 'Wed',
      'week.thu': 'Thu',
      'week.fri': 'Fri',
      'week.sat': 'Sat',
      'week.sun': 'Sun',
      'month.title': '{month}/{year}',
      'month.empty': 'No entries this month.',
      'day.heading': '{date} ({week})',
      'day.placeholder': 'Nothing recorded for this day.',
      'day.unsaved': 'Unsaved changes',
      'day.saving': 'Saving…',
      'day.saved': 'Saved',
      'day.cleared': "Cleared this day's text (the row is kept)",
      'day.deleted': 'Row deleted',
      'day.deleteConfirm': 'Delete the row for {date}? It will be removed from the data file and cannot be undone.',
      'a11y.grid': 'Calendar for {month}',
      'a11y.marked': 'has entries',
      'status.loading': 'Loading…',
      'status.empty': 'No entries yet.',
      'status.totalRows': '{count} rows',
      'status.months': '{count} months with entries',
      'error.network': 'Cannot reach the host route (the app transport did not respond).',
      'error.badResponse': 'The host returned an unparseable response.',
      'error.route': 'Request failed: {detail}',
      'error.prefixed': '{label}: {detail}',
      'error.loadState': 'Could not read the data file state',
      'error.loadEntries': 'Could not load this month',
      'error.save': 'Save failed',
      'error.remove': 'Delete failed',
      'error.needSource': 'Choose a source file first.',
      'error.needPath': 'Enter an export file path first.',
      'error.needValue': 'Choose a year or a month to export first.',
      'file.title': 'Data file',
      'file.exists': 'exists',
      'file.missing': 'The file does not exist yet.',
      'file.missingPath': 'No data file path has been set.',
      'file.createHint':
        'Create an empty .xlsx at this path: sheet DesktopCal, column A integer date serial (m/d/yy), column B text.',
      'file.create': 'Create data file',
      'file.ready': 'The data file is ready.',
      'file.pathLabel': 'Path',
      'file.pathPlaceholder': 'C:\\Users\\<user>\\.dsh\\dsh-calendar-diary\\diary.xlsx',
      'file.usePath': 'Use this path',
      'file.newHere': 'Create {name} in this folder',
      'file.filesIn': 'Candidate files in {dir}',
      'file.noFiles': 'No .xlsx / .xls files in this folder.',
      'file.listFailed': 'Cannot list the folder: {detail}',
      'file.pickerFailed': 'The native folder dialog is unavailable; paste the full path instead.',
      'file.writable': 'writable',
      'file.readOnly': 'read-only',
      'import.title': 'Import',
      'import.step1': 'Step 1 · Choose a source file',
      'import.step2': 'Step 2 · Preview (scan only, nothing is written)',
      'import.step3': 'Step 3 · Conflict policy',
      'import.sourceLabel': 'Source file path (.xlsx / .xls)',
      'import.sourcePlaceholder': 'C:\\Users\\<user>\\Documents\\old-calendar.xls',
      'import.scanning': 'Scanning…',
      'import.source': 'Source',
      'import.rows': 'Rows',
      'import.range': 'Date range',
      'import.added': 'New',
      'import.conflicts': 'Conflicts',
      'import.unchanged': 'Unchanged',
      'import.skipped': 'Skipped',
      'import.detection': 'Detected layout',
      'import.conflictList': 'Conflict details',
      'import.conflictExisting': 'existing',
      'import.conflictIncoming': 'incoming',
      'import.noConflicts': 'No conflicts.',
      'import.policy.keep': 'Keep existing (default)',
      'import.policy.overwrite': 'Overwrite with incoming',
      'import.policy.concat': 'Concatenate as multiple lines',
      'import.policy.skip': 'Skip conflicts',
      'import.confirmHint': 'Preview in step 2 first — import cannot run without it.',
      'import.apply': 'Confirm import',
      'import.applying': 'Importing…',
      'import.done': 'Import complete',
      'import.totalRows': '{count} rows after import',
      'import.totalRowsLabel': 'Rows after import',
      'import.backup': 'Backup: {path}',
      'import.backupLabel': 'Backup file',
      'import.report': 'Report',
      'import.raw': 'Raw response from the host',
      'import.stale': 'Source or policy changed — preview again.',
      'export.title': 'Export',
      'export.scope': 'Scope',
      'export.scope.all': 'All',
      'export.scope.year': 'One year',
      'export.scope.month': 'One month',
      'export.yearLabel': 'Year',
      'export.monthLabel': 'Month',
      'export.outLabel': 'Save to (.xlsx, writes a new file only)',
      'export.outPlaceholder': 'C:\\Users\\<user>\\Documents\\diary-export.xlsx',
      'export.running': 'Exporting…',
      'export.done': 'Exported {rows} rows, {bytes} bytes',
      'export.outPath': 'File: {path}',
      'today.title': 'Today',
      'today.placeholder': 'Add a note for today…',
      'today.save': 'Save',
      'today.saved': 'Written to {date}',
      'today.existing': 'Today already has:',
      'today.overwrite': 'Today already has text. Overwrite it with what you typed?',
      'today.empty': 'Type something first.',
      'today.loadFailed': "Could not read today's text: {detail}",
      'confirm.title': 'Confirm',
      'confirm.ok': 'OK',
    };

    // ---------------------------------------------------------------------
    // apply
    // ---------------------------------------------------------------------

    return {
      name: 'dsh-calendar-diary',
      // The only services this half needs: the slot registry and the locale
      // service, both declared in package.json `dsh.client.inject`. No `remote`,
      // no Remote Schedule face, no `sessions`, no `layout`.
      inject: ['slots', 'locale'],
      apply(ctx) {
        // A third-party namespace is not merged into LocaleNamespaceMap, so the
        // untyped `register(ns, locale, dict)` form is required, one language per
        // call (old client.js:1935-1942).
        ctx.effect(
          () => ctx.locale.register(NS, 'zh', ZH_DICTIONARY),
          'dsh-calendar-diary: locale zh',
        );
        ctx.effect(
          () => ctx.locale.register(NS, 'en', EN_DICTIONARY),
          'dsh-calendar-diary: locale en',
        );
        const t = ctx.locale.bind(NS);

        ctx.effect(() => installStyles(), 'dsh-calendar-diary: stylesheet');

        const api = createApi();

        // Sidebar row. `id` must equal the `main` key below, and clicking the row
        // runs ctx.layout.selectPanel(id) — the layout owner's job, not ours.
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 12,
              label: () => text(t, 'panel'),
            },
            CalendarDiaryIcon,
          ),
        );

        // Root-scoped month page. No Session is current while it is open, which is
        // exactly why every read/write here is a plain same-origin fetch.
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
              inject: () => ({ api, t }),
            },
            CalendarDiaryPage,
          ),
        );

        // Ambient "today" row above the composer. `inject` receives this Session's
        // id, but this plugin never uses it: the diary is global, not per-session.
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: TODAY_ID,
              order: 8,
              label: () => text(t, 'today.title'),
              inject: (sessionId) => ({ api, t, sessionId }),
            },
            TodayBar,
          ),
        );
      },
    };
  },
});
