# markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/putriwindiasty22/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/putriwindiasty22/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast, dependency-free, marked-compatible Markdown renderer — an entry for the [make.fun bounty markdown-render-speed-02](https://make.fun/bounty/markdown-render-speed-02).

Referral code: `xch7gh1j`

## What it is

`parse.js` is a single-scan, dependency-free ES module whose `parse(markdown)` returns, for every string, exactly the HTML that marked 18.1.3's `marked.parse(markdown)` returns with marked's default options (GFM on, breaks off, pedantic off, async off). `main.ts` is the driver the harness runs: it reads every case from `/input/cases.json`, renders each with `parse`, and writes `/output/html.json`.

The goal is a drop-in replacement for marked that is faster, not a different renderer: where marked departs from the CommonMark or GFM spec, marked's HTML is the expected output, never the spec's.

## Layout

```
.
├── parse.js        # the renderer: single-scan parser, no dependencies
├── main.ts         # driver / benchmark harness entrypoint
├── LICENSE         # MIT
└── README.md       # this file
```

- `parse.js` — the whole parser in one module. It is the only code that decides what HTML a document becomes.
- `main.ts` — reads `/input/cases.json` (an array of `{"id", "markdown"}`), calls `parse` once per case, in order, and writes the 720 HTML strings to `/output/html.json`.
- No build step, no `npm install`, no WebAssembly, no native addons. Only Node's built-in modules and the source committed here are available at run time (Node 22, which strips TypeScript types natively).

## Usage

```js
import { parse } from "./parse.js";

parse("# Hello\n\nSome **bold** text.");
// => "<h1>Hello</h1>\n<p>Some <strong>bold</strong> text.</p>\n"
```

`parse` takes a Markdown string and returns the HTML string, with the same output marked 18.1.3 produces for that input under its default options. It is synchronous and pure: it reads nothing from disk and keeps no state between calls.

## Renderer design

The parser is built around a single scan of the input:

- **One pass over the document.** Block structure (headings, lists, block quotes, fenced and indented code, tables, thematic breaks, raw HTML blocks, link reference definitions) and inline structure (emphasis, strong emphasis, strikethrough, code spans, inline / reference / image links, autolinks and extended autolinks, entities, backslash escapes, inline HTML, hard line breaks) are recognised while scanning forward, instead of running a separate tokenizer pass per construct the way marked does.
- **No per-construct regex storms.** Hot paths avoid re-scanning the same text with many regular expressions; matching is done with direct character checks and bounded scans, so work stays proportional to the input length.
- **Deterministic output.** `parse` keeps nothing from an earlier call — no memo, no cache of blocks or lines — so each case renders exactly as it would on its own. The two executions the grader runs on the same set therefore produce byte-identical output.
- **Exact marked compatibility as the contract.** The scorer compares every output string with marked's exactly, code unit for code unit: no whitespace, line-end, entity or attribute-order normalisation. Passing means all 720 cases identical, so the design favours fidelity first and speed second — a fast renderer that diverges on one case is unranked.

## Correctness

The scored set holds 720 cases:

- 680 spec examples, the same in every set: every example of the CommonMark Spec 0.31.2 (cm-001 to cm-652) plus the 28 examples the GitHub Flavored Markdown Spec 0.29 adds for its extensions (gfm-198 to gfm-657: tables, task list items, strikethrough, extended autolinks and disallowed raw HTML), as marked's own test suite holds them.
- 40 generated documents (doc-01 to doc-40), each a README of at least 20,000 characters: ATX and setext headings, badges, paragraphs with emphasis, strong emphasis, strikethrough, code spans, inline, reference and image links, autolinks and extended autolinks, entities, backslash escapes, inline HTML and hard line breaks, nested bullet, ordered and task lists, tables with alignments, fenced and indented code, block quotes, raw HTML blocks (details and summary, comments, centred logos, pre, style), thematic breaks, link reference definitions, and spec examples set between the blocks; some with CRLF line ends, tabs or no final line end.

Local grading uses the kit's practice set (`node cli/makefun.mjs grade-local --kit . --bot <repository> --driver docker`) and the pre-submit checks (`node cli/makefun.mjs check --kit . --repo <repository>`). Only an entry that passes every case can be timed and ranked on CPU time.

## Speed

Speed is measured as CPU time on the scored set, net of the null-entry control, in a fresh one-CPU container per run. The design choices that make this entry faster than running marked itself are the single-scan structure, the avoidance of repeated regex passes over the same text, and keeping allocation low on the long generated documents (the 20,000–100,000 character READMEs dominate the set's cost). No benchmark numbers are claimed here: the authoritative timing is the one the make.fun grader publishes on the leaderboard.

## Bounty

- Competition: [markdown-render-speed-02 on make.fun](https://make.fun/bounty/markdown-render-speed-02)
- Prizes: $250 total in USDC on Solana (1st $50, 2nd $35, 3rd $25, then $10 / $7 places down to 20th). A prize goes only to a contender that passes every case and is faster than the house baseline (marked itself) in the final heat at 95% confidence.
- Referral code: `xch7gh1j`

## License

MIT — see `LICENSE`.
