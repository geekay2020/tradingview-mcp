/**
 * Tests for the tool-call audit log.
 *
 * This MCP changes symbols, adds and removes studies, writes and saves Pine,
 * and creates alerts on a live chart. The audit log is the only record of what
 * a session did, so the properties that matter are:
 *
 *   - it is OFF unless TV_AUDIT_LOG is set (no surprise files, no surprise I/O)
 *   - it never breaks the call it is auditing, even when the write fails
 *   - it records failures as failures, including the {success:false} shape that
 *     does not set isError
 *   - it caps what it writes, so a 200KB Pine source does not land in the log
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { truncate, outcomeOf, record, withAudit, auditPath } from '../src/audit.js';

const jsonResult = (obj, isError = false) => ({
  content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }],
  ...(isError && { isError: true }),
});

let tmpdir, logfile, prevEnv;

beforeEach(() => {
  prevEnv = process.env.TV_AUDIT_LOG;
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvaudit-'));
  logfile = path.join(tmpdir, 'nested', 'calls.jsonl');
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.TV_AUDIT_LOG;
  else process.env.TV_AUDIT_LOG = prevEnv;
  fs.rmSync(tmpdir, { recursive: true, force: true });
});

const readLines = () =>
  fs.readFileSync(logfile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

/** Minimal stand-in for McpServer: records registrations, exposes the handler. */
function fakeServer() {
  const registered = new Map();
  return {
    registered,
    tool(name, ...rest) { registered.set(name, rest[rest.length - 1]); },
  };
}

describe('auditPath', () => {
  it('is null when TV_AUDIT_LOG is unset — auditing is opt-in', () => {
    delete process.env.TV_AUDIT_LOG;
    assert.equal(auditPath(), null);
  });

  it('treats whitespace-only as unset', () => {
    process.env.TV_AUDIT_LOG = '   ';
    assert.equal(auditPath(), null);
  });

  it('expands a leading ~ to the home directory', () => {
    process.env.TV_AUDIT_LOG = '~/tv-audit.jsonl';
    assert.equal(auditPath(), path.join(os.homedir(), '/tv-audit.jsonl'));
  });
});

describe('truncate', () => {
  it('caps a long string and says how much was dropped', () => {
    const out = truncate('x'.repeat(5000));
    assert.ok(out.length < 300, 'a 200KB Pine source must not land in the log');
    assert.match(out, /\(5000 chars\)$/);
  });

  it('leaves short values alone', () => {
    assert.deepEqual(
      truncate({ symbol: 'NSE:NIFTY', count: 20, live: true }),
      { symbol: 'NSE:NIFTY', count: 20, live: true }
    );
  });

  it('caps long arrays', () => {
    const out = truncate(Array.from({ length: 100 }, (_, i) => i));
    assert.equal(out.length, 21);
    assert.equal(out[20], '…(100 items)');
  });

  it('elides beyond the depth limit instead of recursing forever', () => {
    const deep = { a: { b: { c: { d: { e: 'too far' } } } } };
    assert.equal(truncate(deep).a.b.c.d, '[deep]');
  });

  it('survives a self-referencing object', () => {
    const cyclic = { name: 'loop' };
    cyclic.self = cyclic;
    const out = truncate(cyclic);
    // The cycle is broken at the depth limit, so the result is finite and the
    // JSON.stringify inside record() cannot throw on it.
    assert.equal(out.self.self.self.self, '[deep]');
    assert.doesNotThrow(() => JSON.stringify(out));
  });
});

describe('outcomeOf', () => {
  it('reads isError as failure', () => {
    assert.deepEqual(outcomeOf(jsonResult({ error: 'nope' }, true)), { ok: false });
  });

  it('catches {success:false} that did NOT set isError', () => {
    // jsonResult(await core.fn()) with a core function returning success:false.
    const r = outcomeOf(jsonResult({ success: false, error: 'no chart target' }));
    assert.equal(r.ok, false);
    assert.equal(r.error, 'no chart target');
  });

  it('treats a successful payload as ok', () => {
    assert.deepEqual(outcomeOf(jsonResult({ success: true, symbol: 'NSE:NIFTY' })), { ok: true });
  });

  it('does not parse oversized payloads, defaulting to ok', () => {
    const huge = jsonResult({ success: false, blob: 'y'.repeat(9000) });
    assert.deepEqual(outcomeOf(huge), { ok: true }, 'large results are not re-parsed on every call');
  });

  it('tolerates non-JSON content', () => {
    assert.deepEqual(outcomeOf({ content: [{ type: 'text', text: 'plain text' }] }), { ok: true });
  });
});

describe('record', () => {
  it('creates missing parent directories and appends one line per call', () => {
    record({ tool: 'a' }, logfile);
    record({ tool: 'b' }, logfile);
    assert.deepEqual(readLines().map((e) => e.tool), ['a', 'b']);
  });

  it('returns false instead of throwing when the path is unwritable', () => {
    fs.mkdirSync(path.join(tmpdir, 'blocker'));
    // a directory where a file is expected — the write cannot succeed
    assert.equal(record({ tool: 'x' }, path.join(tmpdir, 'blocker')), false);
  });

  it('is a no-op when no path is configured', () => {
    delete process.env.TV_AUDIT_LOG;
    assert.equal(record({ tool: 'x' }), false);
  });
});

describe('withAudit', () => {
  it('leaves server.tool untouched when auditing is off', () => {
    delete process.env.TV_AUDIT_LOG;
    const server = fakeServer();
    const before = server.tool;
    withAudit(server);
    assert.equal(server.tool, before, 'no wrapper, no overhead, when unconfigured');
  });

  it('logs a successful call with its args and duration', async () => {
    process.env.TV_AUDIT_LOG = logfile;
    const server = withAudit(fakeServer());
    server.tool('chart_set_symbol', 'desc', {}, async () => jsonResult({ success: true }));

    const out = await server.registered.get('chart_set_symbol')({ symbol: 'NSE:NIFTY' });
    assert.deepEqual(out, jsonResult({ success: true }), 'the response is passed through unchanged');

    const [entry] = readLines();
    assert.equal(entry.tool, 'chart_set_symbol');
    assert.deepEqual(entry.args, { symbol: 'NSE:NIFTY' });
    assert.equal(entry.ok, true);
    assert.equal(typeof entry.ms, 'number');
    assert.ok(entry.ts, 'entries are timestamped');
  });

  it('records the arguments but NOT the result payload', async () => {
    process.env.TV_AUDIT_LOG = logfile;
    const server = withAudit(fakeServer());
    server.tool('pine_get_source', 'desc', {}, async () => jsonResult({ source: 'z'.repeat(50000) }));

    await server.registered.get('pine_get_source')({});
    const raw = fs.readFileSync(logfile, 'utf8');
    assert.ok(raw.length < 1000, `audit line should stay small, got ${raw.length} bytes`);
    assert.ok(!raw.includes('zzzzzzzzzz'), 'result bodies must never be written to the log');
  });

  it('truncates a huge Pine source passed as an argument', async () => {
    process.env.TV_AUDIT_LOG = logfile;
    const server = withAudit(fakeServer());
    server.tool('pine_set_source', 'desc', {}, async () => jsonResult({ success: true }));

    await server.registered.get('pine_set_source')({ source: 'q'.repeat(200000) });
    const [entry] = readLines();
    assert.match(entry.args.source, /\(200000 chars\)$/);
  });

  it('records a thrown error and still rethrows it', async () => {
    process.env.TV_AUDIT_LOG = logfile;
    const server = withAudit(fakeServer());
    server.tool('alert_create', 'desc', {}, async () => { throw new Error('CDP gone'); });

    await assert.rejects(
      () => server.registered.get('alert_create')({ price: 24500 }),
      /CDP gone/,
      'the caller must still see the failure'
    );
    const [entry] = readLines();
    assert.equal(entry.ok, false);
    assert.equal(entry.error, 'CDP gone');
  });

  it('records a {success:false} response as a failure', async () => {
    process.env.TV_AUDIT_LOG = logfile;
    const server = withAudit(fakeServer());
    server.tool('pine_save', 'desc', {}, async () => jsonResult({ success: false, error: 'no editor' }));

    await server.registered.get('pine_save')({});
    const [entry] = readLines();
    assert.equal(entry.ok, false);
    assert.equal(entry.error, 'no editor');
  });

  it('never breaks a tool call when the log cannot be written', async () => {
    fs.mkdirSync(path.join(tmpdir, 'blocker'));
    process.env.TV_AUDIT_LOG = path.join(tmpdir, 'blocker');   // a directory
    const server = withAudit(fakeServer());
    server.tool('quote_get', 'desc', {}, async () => jsonResult({ success: true, last: 24500 }));

    const out = await server.registered.get('quote_get')({});
    assert.deepEqual(out, jsonResult({ success: true, last: 24500 }));
  });

  it('passes registrations through untouched when the last arg is not a handler', () => {
    process.env.TV_AUDIT_LOG = logfile;
    const server = withAudit(fakeServer());
    server.tool('odd_registration', 'desc', {});
    assert.deepEqual(server.registered.get('odd_registration'), {});
  });
});
