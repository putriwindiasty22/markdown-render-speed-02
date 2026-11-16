# markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/putriwindiasty22/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/putriwindiasty22/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast, dependency-free drop-in replacement for marked 18.1.3, built for
make.fun's “Make Markdown rendering faster” bounty ($250 in USDC).
`parse.js` renders exactly the HTML `marked.parse` returns with marked's
default options — same output for every input, only faster.

## Layout

- `parse.js` — the renderer. `parse(markdown)` returns the HTML string.
  A fork of marked 18.1.3 (MIT; see `vendor/marked/LICENSE` and
  `vendor/marked/NOTICE`), re-implemented for the default options only:
  no classes, no options or extension machinery, first-character dispatch
  in both lexers, cheap pre-checks before expensive regular expressions,
  and a fused parser/renderer that writes HTML directly.
- `main.ts` — the entrypoint the harness runs as `node /bot/main.ts`.
  It reads every case from `/input/cases.json`, renders each with
  `parse`, and writes `/output/html.json`.
- `vendor/marked/` — the marked 18.1.3 source the entry is measured
  against, kept for reference under its own licence and notice.

## Run it

```sh
node main.ts
```

Reads every case from `/input/cases.json` and writes `/output/html.json`
(a JSON array of 720 HTML strings, in the cases' order). Outside a
container, `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` stand in for
`/input` and `/output`.

## How it stays fast

- **First-character dispatch.** Both lexers switch on the first character
  of the remaining source (after up to three spaces) and try only the
  tokenizers that could match there, instead of running every grammar
  against every position.
- **Cheap pre-checks.** The two expensive block regexes — GFM tables and
  setext headings — run only after a small scan says they might match.
- **Masked emphasis.** Before the emphasis/delimiter passes run, links,
  code spans and HTML are masked out of a copy of the source, so a
  delimiter inside a link or code span can never close an emphasis run —
  and the closer scan only walks as far as the last possible closer.
- **Inline text scanner.** Plain-text runs are measured with index scans
  instead of the GFM text regex, which is the hottest path on long
  documents.
- **No per-case state.** `parse` keeps nothing between calls: every case
  renders from its own markdown alone, so the two graded runs are
  byte-identical by construction.

## Check it locally

Against the kit's practice set (720 cases: the CommonMark and GFM spec
examples plus 40 generated documents), the entry must match marked
exactly on every case:

```sh
node check-mrs.mjs   # prints "passed 720/720"
```

The check script lives beside this repository, not in it, so the repo
stays under the 1 MiB cap.

---

<sub>Entered on [make.fun](https://make.fun/?ref=xch7gh1j&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
