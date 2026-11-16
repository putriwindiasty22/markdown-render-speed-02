# markdown-render-speed-02

A dependency-free, from-scratch Markdown renderer written to match the
HTML that marked 18.1.3 produces with its default options (GFM on,
breaks off), byte for byte, on the CommonMark 0.31.2 spec examples, the
GFM 0.29 examples, and long generated README documents — and to do it
faster than marked itself.

## Layout

- `parse.js` — the whole renderer. `parse(markdown)` returns the HTML
  string. No imports, no dependencies.
- `main.ts` — the competition driver: reads `/input/cases.json`, renders
  each case alone with `parse()`, writes `/output/html.json`.

## How the renderer works

Three stages, in the order marked itself uses:

1. **Block parsing.** A small lexer walks the source once and emits
   block tokens (paragraph, heading, fence, indented code, list,
   blockquote, table, HTML block, thematic break, link-reference
   definition, space). Each tokenizer is a single anchored pattern, and
   cheap first-character guards skip the ones that cannot match, so a
   paragraph line never pays for a table or setext pattern it cannot be.
2. **Inline parsing.** Paragraphs, headings, table cells and list items
   are tokenized inline with an index-based scanner: backslash escapes,
   code spans, links and reference links, emphasis and strong emphasis
   (the delimiter walk), strikethrough, autolinks, HTML tags, hard
   breaks and plain text. Before the delimiter walk, links, code spans
   and tags are masked with same-length placeholders, so a `*` inside a
   link or a code span can never open or close emphasis.
3. **Rendering.** The block tokens render to HTML with the same escaping,
   URL cleaning and entity decoding marked applies, so the output is
   byte-identical to marked's.

## Correctness

The renderer is checked against the competition's practice set: 680 spec
examples plus 40 long generated documents, 720 cases in total. The
output must match marked's HTML byte for byte on every case, and two
runs over the same set must produce identical bytes.

## Speed notes

The hot paths are the ones a long document exercises most: the inline
text scan, the list-item loop and the block-start dispatch. They are
kept cheap by reusing sticky patterns instead of re-slicing the source,
by skipping the masking pass entirely when a paragraph holds none of
`[`, backtick, `<` or `\`, by using a cut-down text pattern when a
paragraph holds no autolink or hard-break trigger, and by accumulating
list-item text in an array and joining once instead of concatenating
per line.

## Running it

```sh
node main.ts
```

`MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` override `/input` and
`/output` outside the competition container.
