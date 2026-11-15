// main.ts — the entrypoint the harness runs as `node /bot/main.ts` (Node 22,
// which strips TypeScript types natively, so only erasable syntax is used
// here). It reads every case from /input/cases.json, renders each one on its
// own with parse() from parse.js, and writes /output/html.json: a JSON array
// of the HTML strings, one per case and in the cases' order. Outside a
// container, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input
// and /output.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

type Case = { id: string; markdown: string };

function main(): void {
  const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as Case[];
  const html = new Array<string>(cases.length);
  for (let i = 0; i < cases.length; i++) {
    html[i] = parse(cases[i].markdown);
  }
  // The harness provides /output, but creating it when missing costs
  // nothing and keeps local runs (e.g. a fresh MAKEFUN_OUTPUT_DIR) working.
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
}

main();
