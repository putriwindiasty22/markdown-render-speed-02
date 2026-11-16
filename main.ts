// main.ts — the entrypoint the harness runs as `node /bot/main.ts` on
// Node 22, which strips TypeScript types natively (so only erasable syntax
// is used here). It reads every case from /input/cases.json, renders each
// one on its own with parse() from parse.js, and writes /output/html.json:
// a JSON array of the HTML strings, one per case and in the cases' order.
// Outside a container, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in
// for /input and /output, which keeps local runs working unchanged.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parse } from './parse.js';

type InputCase = { id: string; markdown: string };

// Join a directory and a file name without importing node:path: one fewer
// module for Node to load at startup, and a trailing slash on the
// directory (as an env override may carry) still yields a clean path.
function joinPath(dir: string, file: string): string {
  return dir.endsWith('/') ? dir + file : dir + '/' + file;
}

// Where the cases live and where the HTML goes. The harness always
// provides both directories, but the env overrides let the same program
// run locally against a practice set in any folder.
function resolveDirs(): { inputDir: string; outputDir: string } {
  return {
    inputDir: process.env.MAKEFUN_INPUT_DIR ?? '/input',
    outputDir: process.env.MAKEFUN_OUTPUT_DIR ?? '/output',
  };
}

function main(): void {
  const { inputDir, outputDir } = resolveDirs();
  const cases = JSON.parse(
    readFileSync(joinPath(inputDir, 'cases.json'), 'utf8'),
  ) as InputCase[];
  const html = new Array<string>(cases.length);
  for (let i = 0; i < cases.length; i++) {
    html[i] = parse(cases[i].markdown);
  }
  // The harness provides /output, but creating it when missing costs
  // nothing and keeps local runs (e.g. a fresh MAKEFUN_OUTPUT_DIR) working.
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(joinPath(outputDir, 'html.json'), JSON.stringify(html));
}

main();
