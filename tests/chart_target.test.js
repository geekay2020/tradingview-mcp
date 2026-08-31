/**
 * Tests for selectChartTarget() — which live chart the MCP is allowed to drive.
 *
 * Background: findChartTarget() used to be first-wins over every page whose URL
 * contained "tradingview.com/chart". With several layouts open at once that
 * selection is effectively arbitrary, so an MCP call could land on a chart the
 * operator is actually trading from and start changing symbols, timeframes or
 * studies underneath them.
 *
 * Two guards fix that, both no-ops until configured:
 *   - a URL marker (TV_TAB_MARKER, default "tvmcp=1") the MCP prefers
 *   - a deny list (TV_DENY_LAYOUTS) the MCP refuses to attach to at all
 *
 * The deny list must FAIL CLOSED: a denied target is dropped and never
 * reconsidered, even if that leaves nothing to connect to. Falling through to
 * "some other tab" is precisely the behaviour being prevented.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { selectChartTarget } from '../src/connection.js';

const page = (id, url) => ({ id, url, type: 'page' });

const LIVE = page('live', 'https://www.tradingview.com/chart/z5PmbOrC/');
const SCRATCH = page('scratch', 'https://www.tradingview.com/chart/Ab12Cd34/?tvmcp=1');
const OTHER = page('other', 'https://www.tradingview.com/chart/Hr2pKd9p/');
const NEWS = page('news', 'https://www.tradingview.com/news/');

describe('selectChartTarget — default behaviour', () => {
  it('picks the first chart page when nothing is configured', () => {
    const { target, marked, blocked } = selectChartTarget([LIVE, OTHER]);
    assert.equal(target.id, 'live');
    assert.equal(marked, false);
    assert.deepEqual(blocked, []);
  });

  it('ignores non-page targets and non-TradingView pages', () => {
    const noise = [
      { id: 'sw', url: 'https://www.tradingview.com/chart/x/', type: 'service_worker' },
      page('google', 'https://www.google.com/'),
      OTHER,
    ];
    assert.equal(selectChartTarget(noise).target.id, 'other');
  });

  it('falls back to a non-chart TradingView page when no chart is open', () => {
    assert.equal(selectChartTarget([NEWS]).target.id, 'news');
  });

  it('returns a null target rather than throwing when nothing matches', () => {
    const { target, blocked } = selectChartTarget([page('g', 'https://example.com/')]);
    assert.equal(target, null);
    assert.deepEqual(blocked, []);
  });

  it('tolerates junk entries from /json/list', () => {
    const { target } = selectChartTarget([null, {}, { type: 'page' }, OTHER]);
    assert.equal(target.id, 'other');
  });
});

describe('selectChartTarget — marker preference', () => {
  it('prefers the marked tab over a live chart listed first', () => {
    const { target, marked } = selectChartTarget([LIVE, SCRATCH, OTHER], { marker: 'tvmcp=1' });
    assert.equal(target.id, 'scratch', 'the marked tab wins regardless of ordering');
    assert.equal(marked, true);
  });

  it('prefers a marked non-chart page over an unmarked chart', () => {
    // Operator intent outranks our URL heuristics.
    const markedNews = page('mnews', 'https://www.tradingview.com/news/?tvmcp=1');
    const { target } = selectChartTarget([LIVE, markedNews], { marker: 'tvmcp=1' });
    assert.equal(target.id, 'mnews');
  });

  it('falls back to normal selection when no tab carries the marker', () => {
    const { target, marked } = selectChartTarget([LIVE, OTHER], { marker: 'tvmcp=1' });
    assert.equal(target.id, 'live');
    assert.equal(marked, false);
  });
});

describe('selectChartTarget — deny list fails closed', () => {
  it('refuses the denied layout and reports it as blocked', () => {
    const { target, blocked } = selectChartTarget([LIVE], { deny: ['z5PmbOrC'] });
    assert.equal(target, null, 'must NOT fall through to anything else');
    assert.deepEqual(blocked.map(t => t.id), ['live']);
  });

  it('still connects to a permitted chart alongside a denied one', () => {
    const { target, blocked } = selectChartTarget([LIVE, OTHER], { deny: ['z5PmbOrC'] });
    assert.equal(target.id, 'other');
    assert.deepEqual(blocked.map(t => t.id), ['live']);
  });

  it('never lets the marker override the deny list', () => {
    const markedLive = page('live', 'https://www.tradingview.com/chart/z5PmbOrC/?tvmcp=1');
    const { target, blocked } = selectChartTarget([markedLive], {
      marker: 'tvmcp=1',
      deny: ['z5PmbOrC'],
    });
    assert.equal(target, null, 'deny outranks the marker');
    assert.deepEqual(blocked.map(t => t.id), ['live']);
  });

  it('applies every pattern in a multi-entry deny list', () => {
    const { target, blocked } = selectChartTarget([LIVE, OTHER], {
      deny: ['z5PmbOrC', 'Hr2pKd9p'],
    });
    assert.equal(target, null);
    assert.equal(blocked.length, 2);
  });

  it('leaves selection untouched when the deny list is empty', () => {
    assert.equal(selectChartTarget([LIVE, OTHER], { deny: [] }).target.id, 'live');
  });
});
