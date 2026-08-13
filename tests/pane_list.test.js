/**
 * Tests for pane list() — the DISPLAYED vs RETAINED distinction.
 *
 * Regression (observed 2026-08-13 against the live VC1 layout): collapsing the
 * grid to "s" does not remove chart widgets, it only stops rendering them. So
 * `inlineChartsCount` (1) and `getAll()` (4) legitimately disagree. The old
 * shape reported the former as `chart_count` right beside the latter as
 * `panes`, which reads as a contradiction — "1 chart" next to a 4-entry list —
 * and is why the operator notes say "pane_list can DISAGREE with CDP, trust
 * TradingViewApi.chart(i)".
 *
 * These tests run the REAL in-page expression in a vm sandbox against a fake
 * TradingViewApi, so they cover the browser-side logic rather than only the
 * post-processing.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { list } from '../src/core/pane.js';

/**
 * Fake TradingView page: the collection RETAINS every entry in `retained`, of
 * which only the first `displayed` are rendered by the current grid. That
 * prefix rule mirrors how TradingView collapses a grid.
 */
function fakePage({ layoutType, displayed, retained, exposeWidgetIdentity = true }) {
  const widgets = retained.map((r) => ({
    model: () => ({
      mainSeries: () => ({ symbol: () => r.symbol, interval: () => r.resolution }),
    }),
  }));
  const window = {
    TradingViewApi: {
      _chartWidgetCollection: {
        _layoutType: layoutType,
        inlineChartsCount: displayed,
        getAll: () => widgets,
      },
      // Only DISPLAYED charts are reachable here. This is the authority the
      // operator notes tell you to trust over pane_list.
      chart: (i) =>
        i < displayed
          ? (exposeWidgetIdentity ? { _chartWidget: widgets[i] } : {})
          : null,
      _activeChartWidgetWV: { value: () => ({ _chartWidget: widgets[0] }) },
    },
  };
  // The real evaluate() crosses CDP with returnByValue, i.e. the result comes
  // back as plain JSON in the host realm. Round-trip through JSON so the fake
  // matches that contract (and so vm's cross-realm prototypes don't leak out).
  return {
    evaluate: async (expr) => JSON.parse(JSON.stringify(vm.runInNewContext(expr, { window }))),
  };
}

const VC1_RETAINED = [
  { symbol: 'NSE:NIFTY', resolution: '10S' },
  { symbol: 'NSE:NIFTY1!', resolution: '10S' },
  { symbol: 'NSE:NIFTY260818C24450', resolution: '10S' },
  { symbol: 'NSE:NIFTY260818P24400', resolution: '10S' },
];

describe('pane list() — collapsed grid retaining hidden charts', () => {
  it('reports displayed and retained counts separately instead of contradicting itself', async () => {
    const _deps = fakePage({ layoutType: 's', displayed: 1, retained: VC1_RETAINED });
    const r = await list({ _deps });

    assert.equal(r.success, true);
    assert.equal(r.layout, 's');
    assert.equal(r.layout_name, '1 chart');

    // The two sets are now named for what they actually are.
    assert.equal(r.displayed_count, 1, 'grid "s" renders exactly one chart');
    assert.equal(r.retained_count, 4, 'the layout still holds all four charts');
    assert.equal(r.panes.length, 4, 'every retained chart is still listed');
  });

  it('marks exactly the rendered pane as displayed', async () => {
    const _deps = fakePage({ layoutType: 's', displayed: 1, retained: VC1_RETAINED });
    const r = await list({ _deps });

    assert.deepEqual(
      r.panes.map((p) => p.displayed),
      [true, false, false, false]
    );
    // The hidden panes keep their identity — they are hidden, not lost.
    assert.equal(r.panes[0].symbol, 'NSE:NIFTY');
    assert.equal(r.panes[3].symbol, 'NSE:NIFTY260818P24400');
  });

  it('keeps chart_count as a back-compat alias of displayed_count', async () => {
    const _deps = fakePage({ layoutType: 's', displayed: 1, retained: VC1_RETAINED });
    const r = await list({ _deps });
    // chart_count has always meant inlineChartsCount (= displayed). Callers
    // such as setLayout() and any external MCP consumer keep their meaning.
    assert.equal(r.chart_count, r.displayed_count);
    assert.equal(r.chart_count, 1);
  });

  it('falls back to grid ordering when widget identity is unavailable', async () => {
    // Some TradingView bundles do not expose `_chartWidget`; the displayed flag
    // must still be right rather than silently marking everything hidden.
    const _deps = fakePage({
      layoutType: 's', displayed: 1, retained: VC1_RETAINED, exposeWidgetIdentity: false,
    });
    const r = await list({ _deps });
    assert.equal(r.displayed_count, 1);
    assert.deepEqual(r.panes.map((p) => p.displayed), [true, false, false, false]);
  });
});

describe('pane list() — fully displayed grid', () => {
  it('reports displayed == retained when the grid shows every chart', async () => {
    const _deps = fakePage({ layoutType: '4', displayed: 4, retained: VC1_RETAINED });
    const r = await list({ _deps });

    assert.equal(r.layout, '4');
    assert.equal(r.layout_name, '2x2 grid');
    assert.equal(r.displayed_count, 4);
    assert.equal(r.retained_count, 4);
    assert.deepEqual(r.panes.map((p) => p.displayed), [true, true, true, true]);
  });

  it('still resolves the active pane index', async () => {
    const _deps = fakePage({ layoutType: '4', displayed: 4, retained: VC1_RETAINED });
    const r = await list({ _deps });
    assert.equal(r.active_index, 0);
  });

  it('carries symbol and resolution through unchanged', async () => {
    const _deps = fakePage({ layoutType: '4', displayed: 4, retained: VC1_RETAINED });
    const r = await list({ _deps });
    assert.deepEqual(r.panes.map((p) => p.symbol), VC1_RETAINED.map((v) => v.symbol));
    assert.ok(r.panes.every((p) => p.resolution === '10S'));
  });
});
