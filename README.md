# LongChat Perf

**A tiny, local-only rendering patch for keeping long ChatGPT conversations responsive.**

```
No network requests.  No analytics.  No message deletion.
```

📊 **Measured: worst conversation-switch freeze 8.5s → 1.1s (-87%), cumulative blocking -52%** → [full data in "Verifying the effect"](#verifying-the-effect-optional)

~700 lines of core JS. No framework. No build step. No dependencies at runtime.

[中文说明 (README.zh-CN.md)](README.zh-CN.md)

---

## What this extension does NOT do

- No chat export
- No AI features
- No analytics
- No backend
- No account
- No DOM deletion
- No build framework

It is a single-purpose rendering patch: long ChatGPT conversations become
progressively slower as the page keeps every message in the DOM. LongChat Perf
reduces the rendering work for the messages you are not looking at.

## Install

Currently distributed as source only. Two steps:

1. Download this repository as a ZIP (or `git clone`).
2. Open `chrome://extensions` (or `edge://extensions`), enable **Developer mode**,
   click **Load unpacked**, and select the `longchat-perf/` folder.

No build, no package manager, no account required.

## How it works

The content script applies five optional patches; all of them are toggles in the
popup and can be disabled individually (or the whole extension can be turned off).

| Patch | What it does |
|---|---|
| **Off-screen rendering skip** | Applies `content-visibility: auto` with `contain-intrinsic-size` to message and code-block elements. Browsers then skip layout and painting for content outside the viewport (Chromium 85+, Firefox 125+, Safari 18+). |
| **Backdrop-filter disable** | Disables `backdrop-filter` as an optional aggressive performance patch, avoiding per-frame layer compositing of blurred surfaces during scroll. |
| **Progressive old-message folding** | While you scroll down, messages far above the viewport (at least two viewports away) are folded to zero height via CSS and collapsed behind a small expand bar. Scrolling up expands everything again. |
| **Streaming-phase throttle** | While an answer is streaming, animations and transitions in the message area are paused to reduce compositor work on every token. |
| **CodeMirror batch mounting** (v0.2) | When a conversation opens or is switched to, all CodeMirror code editors created in the same task are held detached and mounted in one batch, amortizing N full-page style recalculations into 1 (requires Chrome 111+). |

### How code-block batch mounting behaves

The heaviest DOM in long conversations is code blocks (CodeMirror 6 editors).
Opening or switching a conversation mounts dozens to hundreds of editor
instances at once; each insertion triggers a full-page style recalculation
while connected to the document — the direct cause of "switching chats
freezes the tab for tens of seconds".

The patch exploits CodeMirror's construction order: the editor root is
inserted into the document *before* it gets its class names. The patch holds
those not-yet-initialized roots detached (detached subtrees do not invalidate
page styles) and mounts the whole batch in a single task. Measured on a
147-editor conversation: a 42-second long task drops to ~2–3 s of total busy
 time.

- The patch runs in the page's main world (`content_scripts[].world:
  "MAIN"`, Chrome 111+; on older browsers it simply does not run and the
  other patches are unaffected).
- Anything that does not match the exact structure fingerprint passes through
  natively. If a ChatGPT redesign breaks the fingerprint, the patch **fails
  safe** to pass-through and the popup shows a "patch may be stale" warning.
- If a Tampermonkey userscript variant (`__CHATGPT_CM_PERF_FIX__`) is already
  installed, this patch yields to it to avoid double interception.
- The popup shows live stats: editors intercepted/mounted, batches, last
  batch size and mount time, plus a built-in **local long-task monitor**
  (in-memory only, never transmitted): total/worst >50 ms main-thread
  task time, and the long-task time following each batch.

## Verifying the effect (optional)

The "长任务监视" (long-task monitor) line at the bottom of the popup
quantifies the win directly:

1. With the patch enabled, switch between a few long conversations and
   note the cumulative / worst / per-batch numbers;
2. Disable the "代码块批量挂载" toggle, reload the page, switch the same
   conversations, and compare how much the numbers grow;
3. The difference is the main-thread blocking time the patch saves
   (tasks >50 ms count; counters reset on reload).

**Real-world measurement (2026-08, Chrome, several long conversations,
~624 editors total):**

| Metric | Patch on | Patch off | Improvement |
|---|---|---|---|
| Cumulative long tasks | 20.0s | 41.4s | **-52%** |
| Worst single freeze | 1.1s | 8.5s | **-87%** |
| Interception rate | 624/624 (9 batches) | — | 100% |

A CDP-traced cold switch of a 147-editor conversation measured ~2–3s
of main-thread busy time with the patch versus a single 42.4s long
task without it.

For a gold-standard measurement, record conversation switches with
DevTools → Performance with the patch on and off; `window.__LCP_CM_MOUNT__.state()`
in the page console returns the full stats object.

### How folding behaves

- Folding is **progressive and scroll-driven**: it only happens while you scroll
  down, and it only touches messages far above the viewport. The extension never
  folds content on its own in the background.
- **Scrolling up expands everything immediately**, without moving the content
  you are currently reading.
- After any expand, folding is paused for 8 seconds to avoid fold/expand churn.
- The expand bar at the top of the thread jumps you to the earliest message.

**A note on what folding does and does not do:** it primarily reduces
layout/paint/rendering overhead rather than fully virtualizing or deleting DOM
nodes. It does not remove ChatGPT-managed message nodes; folding is CSS-based
and reversible. Message nodes, React state, and JS memory remain in place.

**Compatibility:** ChatGPT's frontend is closed-source and changes over time.
The script locates messages via stable DOM attributes
(`div[data-message-author-role][data-message-id]`). If ChatGPT changes its
rendering strategy or DOM structure, compatibility may need to be revalidated.

## Development

[![CI](https://github.com/HanzheLee/longchat-perf/actions/workflows/ci.yml/badge.svg)](https://github.com/HanzheLee/longchat-perf/actions/workflows/ci.yml)

```bash
npm install   # installs jsdom (dev dependency only)
npm test      # runs tools/smoke-test.js (49 assertions, jsdom-based)
```

To regenerate the icons (pure standard library, no Pillow):

```bash
python3 tools/gen_icons.py
```

## Privacy

The extension makes no network requests, has no analytics, no backend, and does
not transmit chat content. It stores only your on/off settings via
`chrome.storage.sync`. See [PRIVACY.md](PRIVACY.md).

## License

MIT. See [LICENSE](LICENSE).

## Roadmap (P1 — not implemented yet)

- Before/After data for typing lag, scroll frame times, and memory
  (long-task dimension measured above)
- Chrome Web Store / Edge Store distribution

(GitHub Actions CI shipped with v0.3.0)

## Disclaimer

This project is unofficial and not affiliated with, endorsed by, or sponsored
by OpenAI. "ChatGPT" and related marks are trademarks of their respective
owners; they are mentioned only to describe the compatibility target.

## Acknowledgements

Thanks to the [LINUX DO community](https://linux.do) for the recognition,
feedback, and support that helped shape this project.
