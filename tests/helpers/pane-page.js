/**
 * Shared fake TradingView page for the pane core tests.
 *
 * Models the one thing the pane module keeps getting wrong: a collapsed grid
 * still RETAINS every chart widget, it just stops rendering them. So
 * `getAll()` can be longer than what `TradingViewApi.chart(i)` enumerates, and
 * a widget that is retained-but-hidden has no rendered `_mainDiv` to click.
 */
import vm from 'node:vm';

export const VC1_RETAINED = [
  { symbol: 'NSE:NIFTY', resolution: '10S' },
  { symbol: 'NSE:NIFTY1!', resolution: '10S' },
  { symbol: 'NSE:NIFTY260818C24450', resolution: '10S' },
  { symbol: 'NSE:NIFTY260818P24400', resolution: '10S' },
];

/**
 * @param {object}  opts
 * @param {string}  opts.layoutType            grid code, e.g. 's' or '4'
 * @param {number}  opts.displayed             how many of `retained` the grid renders
 * @param {Array}   opts.retained              [{ symbol, resolution }, ...]
 * @param {boolean} [opts.exposeWidgetIdentity] some bundles omit `_chartWidget`
 */
export function fakePage({ layoutType, displayed, retained, exposeWidgetIdentity = true }) {
  const state = { activeIndex: 0, clicks: [], symbolWrites: [] };

  const widgets = retained.map((r, i) => {
    const w = {
      model: () => ({
        mainSeries: () => ({ symbol: () => r.symbol, interval: () => r.resolution }),
      }),
    };
    // Only RENDERED charts have a live _mainDiv. A hidden widget offers nothing
    // to click, which is exactly why focusing one used to fail silently.
    if (i < displayed) {
      w._mainDiv = { click: () => { state.clicks.push(i); state.activeIndex = i; } };
    }
    return w;
  });

  const window = {
    TradingViewApi: {
      _chartWidgetCollection: {
        _layoutType: layoutType,
        inlineChartsCount: displayed,
        getAll: () => widgets,
      },
      // Only DISPLAYED charts are reachable here — the authority the operator
      // notes point at ("trust TradingViewApi.chart(i)").
      chart: (i) =>
        i < displayed ? (exposeWidgetIdentity ? { _chartWidget: widgets[i] } : {}) : null,
      _activeChartWidgetWV: {
        value: () => ({
          _chartWidget: widgets[state.activeIndex],
          setSymbol: (sym) => { state.symbolWrites.push({ index: state.activeIndex, symbol: sym }); },
        }),
      },
    },
  };

  // The real evaluate() crosses CDP with returnByValue, i.e. results arrive as
  // plain JSON in the host realm. Round-trip so the fake matches that contract
  // (and so vm's cross-realm prototypes don't leak into assertions).
  const run = async (expr) => {
    // setSymbol's in-page snippet defers with setTimeout; fire immediately so
    // tests don't pay the real delay.
    const out = vm.runInNewContext(expr, { window, setTimeout: (fn) => { fn(); return 0; } });
    const settled = out && typeof out.then === 'function' ? await out : out;
    return settled === undefined ? undefined : JSON.parse(JSON.stringify(settled));
  };

  return { _deps: { evaluate: run, evaluateAsync: run }, state };
}
