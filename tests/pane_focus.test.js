/**
 * Tests for pane focus() / setSymbol() against a collapsed grid.
 *
 * focus() resolved its index against cwc.getAll() — every RETAINED chart —
 * while only the RENDERED ones can actually be focused. Asking for a hidden
 * pane therefore reported success while doing nothing, because a hidden widget
 * has no rendered _mainDiv to click.
 *
 * That mattered most through setSymbol(), which focuses a pane and then writes
 * to whatever chart is CURRENTLY ACTIVE. A silent focus failure meant the write
 * silently landed on the wrong pane — on the live VC1 layout, asking to retarget
 * a hidden option pane could have rewritten pane 0, the signal pane.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { focus, setSymbol } from '../src/core/pane.js';
import { fakePage, VC1_RETAINED } from './helpers/pane-page.js';

describe('pane focus() — collapsed grid', () => {
  it('focuses a rendered pane and reports both counts', async () => {
    const { _deps, state } = fakePage({ layoutType: 's', displayed: 1, retained: VC1_RETAINED });
    const r = await focus({ index: 0, _deps });

    assert.equal(r.success, true);
    assert.equal(r.focused_index, 0);
    assert.equal(r.displayed_count, 1);
    assert.equal(r.retained_count, 4);
    assert.deepEqual(state.clicks, [0], 'clicked the rendered pane');
  });

  it('refuses a retained-but-hidden pane instead of claiming success', async () => {
    const { _deps, state } = fakePage({ layoutType: 's', displayed: 1, retained: VC1_RETAINED });

    await assert.rejects(
      () => focus({ index: 2, _deps }),
      (err) => {
        assert.match(err.message, /not displayed|hidden/i, 'says the pane is hidden');
        assert.match(err.message, /pane_set_layout|layout/i, 'says how to reveal it');
        return true;
      }
    );
    assert.deepEqual(state.clicks, [], 'nothing was clicked');
    assert.equal(state.activeIndex, 0, 'active pane unchanged');
  });

  it('still rejects an index beyond the retained set', async () => {
    const { _deps } = fakePage({ layoutType: 's', displayed: 1, retained: VC1_RETAINED });
    await assert.rejects(
      () => focus({ index: 9, _deps }),
      /out of range/i
    );
  });
});

describe('pane focus() — fully displayed grid', () => {
  it('focuses any pane when the grid renders them all', async () => {
    const { _deps, state } = fakePage({ layoutType: '4', displayed: 4, retained: VC1_RETAINED });
    const r = await focus({ index: 3, _deps });

    assert.equal(r.success, true);
    assert.equal(r.focused_index, 3);
    assert.equal(r.displayed_count, 4);
    assert.equal(r.retained_count, 4);
    assert.deepEqual(state.clicks, [3]);
  });
});

describe('pane setSymbol() — must not write to the wrong pane', () => {
  it('refuses to set a hidden pane rather than retargeting the active one', async () => {
    const { _deps, state } = fakePage({ layoutType: 's', displayed: 1, retained: VC1_RETAINED });

    await assert.rejects(
      () => setSymbol({ index: 2, symbol: 'NSE:NIFTY260818C24000', _deps }),
      /not displayed|hidden/i
    );
    // The critical assertion: NOTHING was written. Previously the focus failed
    // silently and this call rewrote whichever pane happened to be active.
    assert.deepEqual(state.symbolWrites, [], 'no symbol written anywhere');
    assert.equal(state.activeIndex, 0, 'signal pane untouched');
  });

  it('writes to the requested pane when it is displayed', async () => {
    const { _deps, state } = fakePage({ layoutType: '4', displayed: 4, retained: VC1_RETAINED });
    const r = await setSymbol({ index: 1, symbol: 'NSE:BANKNIFTY', _deps });

    assert.equal(r.success, true);
    assert.equal(state.symbolWrites.length, 1);
    assert.deepEqual(state.symbolWrites[0], { index: 1, symbol: 'NSE:BANKNIFTY' });
  });
});
