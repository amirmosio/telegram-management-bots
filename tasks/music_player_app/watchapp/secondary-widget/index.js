// Secondary-widget — the swipe-card-on-watchface variant of our shortcut.
// Same UI as app-widget/index.js but wrapped in SecondaryWidget() (the
// AppWidget wrapper does not dispatch clicks correctly in this context).
import { createWidget, deleteWidget, widget, align, text_style } from '@zos/ui';
import { getDeviceInfo } from '@zos/device';
import { push } from '@zos/router';

const { width: W, height: H } = getDeviceInfo();
const CW = W || 240;
const CH = H || 240;

function _openApp() {
  try { push({ url: 'page/lyrics/index.page' }); } catch (_) {}
}

SecondaryWidget({
  state: {
    rendered: [],
  },

  onInit() {},

  build()    { this._render(); },
  onResume() { this._unmount(); this._render(); },
  onDestroy(){ this._unmount(); },

  _push(w) { if (w) this.state.rendered.push(w); return w; },

  _unmount() {
    for (const w of this.state.rendered) { try { deleteWidget(w); } catch (_) {} }
    this.state.rendered = [];
  },

  _render() {
    // Tap target — full card. Created FIRST so it sits at the bottom of
    // the z-order and the text widgets render on top of it.
    this._push(createWidget(widget.BUTTON, {
      x: 0, y: 0, w: CW, h: CH,
      text: '',
      normal_color: 0x000000,
      press_color: 0x222222,
      click_func: _openApp,
    }));

    this._push(createWidget(widget.TEXT, {
      x: 0, y: Math.max(20, Math.floor(CH / 2 - 50)),
      w: CW, h: 56,
      color: 0xffffff, text_size: 48,
      align_h: align.CENTER_H, align_v: align.CENTER_V,
      text: '♫',
    }));
    this._push(createWidget(widget.TEXT, {
      x: 12, y: Math.max(80, Math.floor(CH / 2 + 10)),
      w: CW - 24, h: 28,
      color: 0xffffff, text_size: 18,
      align_h: align.CENTER_H, align_v: align.CENTER_V,
      text_style: text_style.ELLIPSIS,
      text: 'Music Lyrics',
    }));
    this._push(createWidget(widget.TEXT, {
      x: 12, y: Math.max(110, Math.floor(CH / 2 + 42)),
      w: CW - 24, h: 22,
      color: 0x808080, text_size: 12,
      align_h: align.CENTER_H, align_v: align.CENTER_V,
      text_style: text_style.ELLIPSIS,
      text: 'Tap to open',
    }));
  },
});
