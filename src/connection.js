import CDP from 'chrome-remote-interface';

let client = null;
let targetInfo = null;
// Overridable via TV_CDP_HOST/TV_CDP_PORT (or CDP_HOST/CDP_PORT) env vars.
// Default is 127.0.0.1, not localhost: on some Windows machines localhost
// resolves to ::1 first, and Electron's --remote-debugging-port only listens on IPv4.
export const CDP_HOST = process.env.TV_CDP_HOST || process.env.CDP_HOST || '127.0.0.1';
export const CDP_PORT = Number(process.env.TV_CDP_PORT || process.env.CDP_PORT) || 9222;
const MAX_RETRIES = 5;
const BASE_DELAY = 500;

// Known direct API paths discovered via live probing (see PROBE_RESULTS.md)
const KNOWN_PATHS = {
  chartApi: 'window.TradingViewApi._activeChartWidgetWV.value()',
  chartWidgetCollection: 'window.TradingViewApi._chartWidgetCollection',
  bottomWidgetBar: 'window.TradingView.bottomWidgetBar',
  replayApi: 'window.TradingViewApi._replayApi',
  alertService: 'window.TradingViewApi._alertService',
  chartApiInstance: 'window.ChartApiInstance',
  mainSeriesBars: 'window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars()',
  // Phase 1: Strategy data — model().dataSources() → find strategy → .performance().value(), .ordersData(), .reportData()
  strategyStudy: 'chart._chartWidget.model().model().dataSources()',
  // Phase 2: Layouts — getSavedCharts(cb), loadChartFromServer(id)
  layoutManager: 'window.TradingViewApi.getSavedCharts',
  // Phase 5: Symbol search — searchSymbols(query) returns Promise
  symbolSearchApi: 'window.TradingViewApi.searchSymbols',
  // Phase 6: Pine scripts — REST API at pine-facade.tradingview.com/pine-facade/list/?filter=saved
  pineFacadeApi: 'https://pine-facade.tradingview.com/pine-facade',
};

export { KNOWN_PATHS };

/**
 * Sanitize a string for safe interpolation into JavaScript code evaluated via CDP.
 * Uses JSON.stringify to produce a properly escaped JS string literal (with quotes).
 * Prevents injection via quotes, backticks, template literals, or control chars.
 */
export function safeString(str) {
  return JSON.stringify(String(str));
}

/**
 * Validate that a value is a finite number. Throws if NaN, Infinity, or non-numeric.
 * Prevents corrupt values from reaching TradingView APIs that persist to cloud state.
 */
export function requireFinite(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a finite number, got: ${value}`);
  return n;
}

export async function getClient() {
  if (client) {
    try {
      // Quick liveness check
      await client.Runtime.evaluate({ expression: '1', returnByValue: true });
      return client;
    } catch {
      client = null;
      targetInfo = null;
    }
  }
  return connect();
}

/**
 * Mark an error as "do not retry". A denied target is a decision, not a
 * transient fault — spinning through the backoff just delays the message.
 */
function fatal(err) {
  err.fatal = true;
  return err;
}

export async function connect(targetId = null) {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const target = targetId ? await findTargetById(targetId) : await findChartTarget();
      if (!target) {
        throw new Error(targetId
          ? `CDP target ${targetId} not found — is the tab still open?`
          : 'No TradingView chart target found. Is TradingView open with a chart?');
      }
      targetInfo = target;
      client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: target.id });

      // Enable required domains
      await client.Runtime.enable();
      await client.Page.enable();
      await client.DOM.enable();

      return client;
    } catch (err) {
      lastError = err;
      if (err.fatal) throw err;
      const delay = Math.min(BASE_DELAY * Math.pow(2, attempt), 30000);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error(`CDP connection failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
}

/**
 * Re-attach the cached CDP client to a specific target id.
 * Used by tab_switch so subsequent reads (chart_get_state, data_get_*,
 * quote_get, screenshots) follow the activated tab instead of staying
 * glued to the target picked at first connect.
 */
export async function reconnectTo(targetId) {
  if (client) {
    try { await client.close(); } catch { /* already gone */ }
    client = null;
    targetInfo = null;
  }
  return connect(targetId);
}

/**
 * URL marker that identifies a tab as belonging to this MCP. Open a chart with
 * `?tvmcp=1` appended and the MCP will prefer it over every other TradingView
 * tab, leaving the operator's own charts alone.
 */
export const TAB_MARKER = process.env.TV_TAB_MARKER || 'tvmcp=1';

/**
 * Comma-separated substrings (layout ids, symbols, whatever appears in the URL)
 * that this MCP must never attach to. Empty by default. A target matching any
 * entry is removed from consideration entirely — we do NOT silently fall
 * through to the next tab, because "connected to something else" is exactly the
 * failure this guard exists to prevent.
 */
export function deniedPatterns() {
  return (process.env.TV_DENY_LAYOUTS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Pick which CDP target to drive, out of everything Chrome reports.
 *
 * Pure and exported so the selection rules can be tested without a browser.
 *
 * Order of preference:
 *   1. drop anything matching a denied pattern (never reconsidered)
 *   2. prefer tabs carrying the MCP marker
 *   3. prefer real chart URLs (tradingview.com/chart) over any tradingview page
 *   4. first remaining match
 *
 * Returns { target, blocked, marked } so the caller can tell "nothing was open"
 * apart from "the only thing open was off limits" — two situations that need
 * very different error messages.
 */
export function selectChartTarget(targets, opts = {}) {
  const marker = opts.marker ?? '';
  const deny = opts.deny ?? [];

  const tv = (targets || []).filter(
    t => t && t.type === 'page' && typeof t.url === 'string' && /tradingview/i.test(t.url)
  );

  const blocked = deny.length
    ? tv.filter(t => deny.some(d => t.url.includes(d)))
    : [];
  const allowed = tv.filter(t => !blocked.includes(t));

  // A marked tab wins even if it is not a /chart/ URL — the operator pointed at
  // it deliberately, and that intent outranks our own URL heuristics.
  const marked = marker ? allowed.filter(t => t.url.includes(marker)) : [];
  const pool = marked.length ? marked : allowed;

  const charts = pool.filter(t => /tradingview\.com\/chart/i.test(t.url));
  const target = (charts.length ? charts : pool)[0] || null;

  return { target, blocked, marked: marked.length > 0 };
}

async function findChartTarget() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  const deny = deniedPatterns();
  const { target, blocked } = selectChartTarget(targets, { marker: TAB_MARKER, deny });

  if (!target && blocked.length) {
    const urls = blocked.map(t => t.url).join(', ');
    throw fatal(new Error(
      `Refusing to attach: the only TradingView target(s) open match TV_DENY_LAYOUTS `
      + `(${deny.join(', ')}). Blocked: ${urls}. `
      + `Open a separate chart tab with ${TAB_MARKER} in its URL.`
    ));
  }
  return target;
}

async function findTargetById(id) {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  return targets.find(t => t.id === id) || null;
}

export async function getTargetInfo() {
  if (!targetInfo) {
    await getClient();
  }
  return targetInfo;
}

export async function evaluate(expression, opts = {}) {
  const c = await getClient();
  const result = await c.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise: opts.awaitPromise ?? false,
    ...opts,
  });
  if (result.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'Unknown evaluation error';
    throw new Error(`JS evaluation error: ${msg}`);
  }
  return result.result?.value;
}

export async function evaluateAsync(expression) {
  return evaluate(expression, { awaitPromise: true });
}

export async function disconnect() {
  if (client) {
    try { await client.close(); } catch {}
    client = null;
    targetInfo = null;
  }
}

// --- Direct API path helpers ---
// Each returns the STRING expression path after verifying it exists.
// Callers use the returned string in their own evaluate() calls.

async function verifyAndReturn(path, name) {
  const exists = await evaluate(`typeof (${path}) !== 'undefined' && (${path}) !== null`);
  if (!exists) {
    throw new Error(`${name} not available at ${path}`);
  }
  return path;
}

export async function getChartApi() {
  return verifyAndReturn(KNOWN_PATHS.chartApi, 'Chart API');
}

export async function getChartCollection() {
  return verifyAndReturn(KNOWN_PATHS.chartWidgetCollection, 'Chart Widget Collection');
}

export async function getBottomBar() {
  return verifyAndReturn(KNOWN_PATHS.bottomWidgetBar, 'Bottom Widget Bar');
}

export async function getReplayApi() {
  return verifyAndReturn(KNOWN_PATHS.replayApi, 'Replay API');
}

export async function getMainSeriesBars() {
  return verifyAndReturn(KNOWN_PATHS.mainSeriesBars, 'Main Series Bars');
}
