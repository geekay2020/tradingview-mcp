/**
 * Tool-call audit log.
 *
 * This MCP drives a live TradingView session — it changes symbols, adds and
 * removes studies, writes and saves Pine, and creates alerts. Until now none of
 * that left a record, so after the fact there was no way to answer "what did
 * that session actually do to my charts?".
 *
 * Writes one JSON object per line to TV_AUDIT_LOG. Disabled when unset.
 *
 * Deliberate limits:
 *   - ARGUMENTS are recorded, truncated. RESULTS are not. A result can be a
 *     200KB Pine source or a screenshot payload; the audit answers what was
 *     ASKED for, not what came back.
 *   - Never writes to stdout. That channel is the MCP protocol itself.
 *   - Never throws. A failed audit write must not break a tool call, so every
 *     path here is wrapped and failures are dropped silently.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_STRING = 200;   // per-string cap inside recorded args
const MAX_DEPTH = 4;      // nested structures below this are elided
const MAX_PARSE = 4096;   // only parse a result payload this small to read `success`

export function auditPath() {
  const raw = (process.env.TV_AUDIT_LOG || '').trim();
  if (!raw) return null;
  const homeRelative = raw === '~' || raw.slice(0, 2) === '~/' || raw.slice(0, 2) === `~${path.sep}`;
  if (homeRelative) {
    return path.join(os.homedir(), raw.slice(1));
  }
  return raw;
}

/**
 * Shrink a value to something safe to write on every call: strings are capped
 * with an honest note of what was dropped, deep structures are elided rather
 * than walked forever.
 */
export function truncate(value, depth = 0) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') {
    return value.length > MAX_STRING
      ? `${value.slice(0, MAX_STRING)}…(${value.length} chars)`
      : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= MAX_DEPTH) return '[deep]';
  if (Array.isArray(value)) {
    const head = value.slice(0, 20).map(v => truncate(v, depth + 1));
    return value.length > 20 ? [...head, `…(${value.length} items)`] : head;
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = truncate(v, depth + 1);
    return out;
  }
  return String(value);
}

/**
 * Read the tool's own success flag out of an MCP response.
 *
 * Tools signal failure two different ways: jsonResult(obj, true) sets isError,
 * but a core function returning {success:false} wrapped in a bare jsonResult()
 * does not. Checking isError alone would log those as fine, so we also parse
 * the payload — but only when it is small, to avoid re-parsing large results on
 * every call.
 */
export function outcomeOf(result) {
  if (!result || typeof result !== 'object') return { ok: true };
  if (result.isError) return { ok: false };
  const text = result.content?.[0]?.text;
  if (typeof text === 'string' && text.length <= MAX_PARSE) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && parsed.success === false) {
        return { ok: false, error: parsed.error };
      }
    } catch { /* not JSON — nothing to learn, treat as ok */ }
  }
  return { ok: true };
}

export function record(entry, file = auditPath()) {
  if (!file) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
    return true;
  } catch {
    return false;   // auditing must never break the call it is auditing
  }
}

/**
 * Decorate an McpServer so every tool registered afterwards is audited.
 *
 * Done once here rather than per tool: there are 84 registrations across 14
 * files, and a wrapper each would be 84 places to forget.
 */
export function withAudit(server) {
  if (!auditPath()) return server;

  const original = server.tool.bind(server);
  server.tool = (...args) => {
    const name = args[0];
    const handlerIndex = args.length - 1;
    const handler = args[handlerIndex];
    if (typeof handler !== 'function') return original(...args);

    args[handlerIndex] = async (...handlerArgs) => {
      const started = Date.now();
      try {
        const result = await handler(...handlerArgs);
        const { ok, error } = outcomeOf(result);
        record({
          ts: new Date().toISOString(),
          tool: name,
          args: truncate(handlerArgs[0] ?? null),
          ok,
          ...(error && { error: truncate(error) }),
          ms: Date.now() - started,
        });
        return result;
      } catch (err) {
        record({
          ts: new Date().toISOString(),
          tool: name,
          args: truncate(handlerArgs[0] ?? null),
          ok: false,
          error: truncate(err?.message ?? String(err)),
          ms: Date.now() - started,
        });
        throw err;
      }
    };
    return original(...args);
  };
  return server;
}
