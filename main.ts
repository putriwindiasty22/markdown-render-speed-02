// Driver for the markdown-render-speed entry. The harness runs
// `node /bot/main.ts` (Node 22). It reads every case from
// /input/cases.json (a JSON array of {id, markdown}), renders each one
// alone with parse() from parse.js, and writes /output/html.json: a JSON
// array of the HTML strings, one per case and in the cases' order.
// Outside a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in
// for /input and /output.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { parse } from "./parse.js";

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

const cases = JSON.parse(
  readFileSync(`${INPUT_DIR}/cases.json`, "utf8"),
) as { id: string; markdown: string }[];

// Create the output directory up front, so a problem with it is reported
// before the (expensive) rendering work instead of after it.
mkdirSync(OUTPUT_DIR, { recursive: true });

const html: string[] = [];
for (const c of cases) html.push(parse(c.markdown));

writeFileSync(`${OUTPUT_DIR}/html.json`, JSON.stringify(html));
