/**
 * Core pane/layout management logic.
 * Controls multi-chart layouts (split panes) in TradingView.
 */
import { evaluate as _evaluate, evaluateAsync as _evaluateAsync, getClient, safeString } from '../connection.js';

const CWC = 'window.TradingViewApi._chartWidgetCollection';

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    evaluateAsync: deps?.evaluateAsync || _evaluateAsync,
  };
}

/**
 * In-page helper: which of the RETAINED widgets the grid currently renders.
 *
 * Collapsing a grid hides charts without removing them, so `getAll()` (retained)
 * can be longer than what is on screen. `TradingViewApi.chart(i)` enumerates only
 * rendered charts, which makes it the authority on what is displayed.
 *
 * Expects `all` (the getAll() array) to already be in scope. Defines
 * `displayedCount` and `isDisplayed(widget, index)`. Shared by list() and focus()
 * so the two can never disagree about what "displayed" means.
 */
const DISPLAYED_PROBE_JS = `
  var displayedWidgets = [];
  for (var d = 0; d < all.length; d++) {
    var ch = null;
    try { ch = window.TradingViewApi.chart(d); } catch(e) { break; }
    if (!ch) break;
    try { displayedWidgets.push(ch._chartWidget || null); } catch(e) { displayedWidgets.push(null); }
  }
  var displayedCount = displayedWidgets.length;
  // Some bundles do not expose _chartWidget; fall back to the grid's prefix
  // ordering rather than treating every pane as hidden.
  var haveIdentity = false;
  for (var h = 0; h < displayedWidgets.length; h++) if (displayedWidgets[h]) { haveIdentity = true; break; }
  function isDisplayed(widget, i) {
    return haveIdentity ? (displayedWidgets.indexOf(widget) !== -1) : (i < displayedCount);
  }
`;

const LAYOUT_NAMES = {
  's': '1 chart',
  '2h': '2 horizontal',
  '2v': '2 vertical',
  '2-1': '2 top, 1 bottom',
  '1-2': '1 top, 2 bottom',
  '3h': '3 horizontal',
  '3v': '3 vertical',
  '3s': '3 custom',
  '4': '2x2 grid',
  '4h': '4 horizontal',
  '4v': '4 vertical',
  '4s': '4 custom',
  '6': '6 charts',
  '8': '8 charts',
  '10': '10 charts',
  '12': '12 charts',
  '14': '14 charts',
  '16': '16 charts',
};

/**
 * List all panes in the current layout with their symbols and index.
 *
 * DISPLAYED vs RETAINED: collapsing the grid (e.g. to "s") does NOT remove chart
 * widgets, it only stops rendering them. So `inlineChartsCount` and `getAll()`
 * legitimately disagree, and reporting the first as a bare "chart_count" beside
 * the second as "panes" reads as a contradiction — "1 chart" next to four of
 * them. Both numbers are reported, each named for what it actually counts, and
 * every pane carries a `displayed` flag.
 */
export async function list({ _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const result = await evaluate(`
    (function() {
      var cwc = ${CWC};
      var layoutType = cwc._layoutType;
      if (typeof layoutType === 'object' && layoutType && typeof layoutType.value === 'function') layoutType = layoutType.value();
      var count = cwc.inlineChartsCount;
      if (typeof count === 'object' && count && typeof count.value === 'function') count = count.value();

      var all = cwc.getAll();
      ${DISPLAYED_PROBE_JS}

      var panes = [];
      for (var i = 0; i < all.length; i++) {
        try {
          var c = all[i];
          var model = c.model ? c.model() : null;
          var mainSeries = model ? model.mainSeries() : null;
          var sym = mainSeries ? mainSeries.symbol() : 'unknown';
          var res = mainSeries ? mainSeries.interval() : null;
          panes.push({ index: i, symbol: sym, resolution: res || null, displayed: isDisplayed(c, i) });
        } catch(e) { panes.push({ index: i, error: e.message, displayed: i < displayedCount }); }
      }

      // Check which pane is active
      var activeChart = window.TradingViewApi._activeChartWidgetWV.value();
      var activeIndex = null;
      for (var j = 0; j < all.length; j++) {
        try {
          if (all[j].model && activeChart._chartWidget && all[j] === activeChart._chartWidget) { activeIndex = j; break; }
        } catch(e) {}
      }

      return {
        layout: layoutType,
        displayed_count: displayedCount,
        retained_count: all.length,
        inline_charts_count: count,
        active_index: activeIndex,
        panes: panes,
      };
    })()
  `);

  return {
    success: true,
    layout: result.layout,
    layout_name: LAYOUT_NAMES[result.layout] || result.layout,
    displayed_count: result.displayed_count,
    retained_count: result.retained_count,
    // Back-compat: chart_count has always meant "charts the grid shows", which
    // is displayed_count. Kept so existing callers keep their exact meaning.
    chart_count: result.displayed_count,
    active_index: result.active_index,
    panes: result.panes,
  };
}

/**
 * Set the chart layout grid.
 * @param {string} layout - Layout code: s, 2h, 2v, 2-1, 1-2, 3h, 3v, 4, 6, 8, etc.
 */
export async function setLayout({ layout, _deps }) {
  const { evaluateAsync } = _resolve(_deps);
  const code = layout.toLowerCase().replace(/\s+/g, '');

  // Map friendly names to codes
  const aliases = {
    'single': 's', '1': 's', '1x1': 's',
    '2x1': '2h', '1x2': '2v',
    '2x2': '4', 'grid': '4', 'quad': '4',
    '3x1': '3h', '1x3': '3v',
  };
  const resolved = aliases[code] || code;

  if (!LAYOUT_NAMES[resolved]) {
    const available = Object.entries(LAYOUT_NAMES).map(([k, v]) => `  ${k} — ${v}`).join('\n');
    throw new Error(`Unknown layout "${layout}". Available layouts:\n${available}`);
  }

  await evaluateAsync(`${CWC}.setLayout(${safeString(resolved)})`);
  await new Promise(r => setTimeout(r, 500));

  const state = await list({ _deps });
  return {
    success: true,
    layout: resolved,
    layout_name: LAYOUT_NAMES[resolved],
    displayed_count: state.displayed_count,
    retained_count: state.retained_count,
    chart_count: state.chart_count,
    panes: state.panes,
  };
}

/**
 * Focus a specific pane by index.
 *
 * Only a DISPLAYED pane can be focused: a retained-but-hidden chart has no
 * rendered _mainDiv to click, so the old code's click was a no-op that still
 * reported success. That silent failure was dangerous through setSymbol(),
 * which focuses and then writes to whatever chart is currently active — so a
 * write aimed at a hidden pane landed on the wrong one. Refuse instead, and
 * report whether the focus actually took.
 */
export async function focus({ index, _deps }) {
  const { evaluate } = _resolve(_deps);
  const idx = Number(index);
  const result = await evaluate(`
    (function() {
      var cwc = ${CWC};
      var all = cwc.getAll();
      ${DISPLAYED_PROBE_JS}
      var idx = ${idx};
      if (!(idx >= 0) || idx >= all.length) return { error: 'out_of_range', retained: all.length, displayed: displayedCount };
      var chart = all[idx];
      if (!isDisplayed(chart, idx)) return { error: 'not_displayed', retained: all.length, displayed: displayedCount };
      // A displayed pane must have a rendered div to click; if it does not, say
      // so rather than returning a success the caller cannot rely on.
      if (!chart._mainDiv) return { error: 'not_clickable', retained: all.length, displayed: displayedCount };
      chart._mainDiv.click();

      // Read back which pane actually became active, so the caller can trust it.
      var active = window.TradingViewApi._activeChartWidgetWV.value();
      var activeIndex = null;
      for (var j = 0; j < all.length; j++) {
        try {
          if (active && active._chartWidget && all[j] === active._chartWidget) { activeIndex = j; break; }
        } catch(e) {}
      }
      return { focused: idx, active_index: activeIndex, retained: all.length, displayed: displayedCount };
    })()
  `);

  if (result?.error === 'out_of_range') {
    throw new Error(`Pane index ${idx} out of range — the layout retains ${result.retained} chart(s)`);
  }
  if (result?.error === 'not_displayed') {
    throw new Error(
      `Pane index ${idx} is retained but NOT displayed — the current grid renders only ${result.displayed} of ${result.retained} chart(s), ` +
      `so it cannot be focused. Reveal it first with pane_set_layout (e.g. "4"), then focus.`
    );
  }
  if (result?.error === 'not_clickable') {
    throw new Error(`Pane index ${idx} reports as displayed but has no clickable element — cannot focus it`);
  }
  if (result?.error) throw new Error(result.error);

  return {
    success: true,
    focused_index: result.focused,
    active_index: result.active_index,
    // False means the click did not move focus — callers that are about to
    // WRITE to the active chart must not proceed on a false here.
    focus_confirmed: result.active_index === result.focused,
    displayed_count: result.displayed,
    retained_count: result.retained,
  };
}

/**
 * Set the symbol on a specific pane by index.
 * Works by focusing the pane, then using the active chart's setSymbol.
 */
export async function setSymbol({ index, symbol, _deps }) {
  const { evaluateAsync } = _resolve(_deps);
  const idx = Number(index);

  // Focus the target pane first. focus() throws for a hidden or out-of-range
  // pane, which is what stops this write from landing on the wrong chart.
  const focused = await focus({ index: idx, _deps });
  if (!focused.focus_confirmed) {
    throw new Error(
      `Refusing to set symbol on pane ${idx}: focus did not take (active pane is ${focused.active_index}). ` +
      `Writing now would change the wrong pane.`
    );
  }
  await new Promise(r => setTimeout(r, 300));

  // Now set symbol on the now-active chart
  await evaluateAsync(`
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      return new Promise(function(resolve) {
        chart.setSymbol(${safeString(symbol)}, {});
        setTimeout(resolve, 500);
      });
    })()
  `);

  return { success: true, index: idx, symbol };
}
