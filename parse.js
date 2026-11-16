// parse.js -- a fast, dependency-free drop-in for marked 18.1.3 with its default
// options (GFM on, breaks off, pedantic off, async off). Written from scratch for
// the make.fun markdown-render-speed-02 competition: it renders exactly the HTML
// marked 18.1.3 renders, byte for byte, on the competition's cases.
//
// How it works: a block parser turns the document into a small token list (link
// reference definitions are collected as it goes), then each block's text is run
// through an inline parser, and the tokens are rendered to HTML. Nothing is kept
// between parse() calls, so every case renders exactly as if it were alone.
//
// The regular expressions below encode the same matching behaviour as the
// reference renderer's; the surrounding code -- the tokenizers, the emphasis
// walk, the list and blockquote handling -- is this file's own.

// ---------- tiny regex composer ----------
// Build a RegExp from a template, substituting each [pattern, value] pair in
// order. A string pattern replaces its first occurrence only; a RegExp pattern
// replaces per its own flags. Values may be strings or RegExps; a leading ^ is
// stripped from a RegExp value, and a ^ that is not part of a character class
// is dropped, so a pattern built for the start of a string can be embedded in
// the middle of a larger one.
function rx(tpl, subs, flags = "") {
  let s = typeof tpl === "string" ? tpl : tpl.source;
  for (const [pat, val] of subs) {
    const rep = (typeof val === "string" ? val : val.source).replace(
      /(^|[^\[])\^/g,
      "$1",
    );
    s = s.replace(pat, () => rep);
  }
  return new RegExp(s, flags);
}

// ---------- character classes (unicode aware) ----------
const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_SPACE = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u;
const WORD_OR_TILDE = /(?:[^\s\p{P}\p{S}]|~)/u;
const PUNCT_NO_TILDE = /(?!~)[\p{P}\p{S}]/u;
const PUNCT_SPACE_NO_TILDE = /(?!~)[\s\p{P}\p{S}]/u;
const OPEN_QUOTE = /[\p{Pi}\p{Ps}"']/u;
const ALNUM = /[\p{L}\p{N}]/u;
// Punctuation or whitespace, but never * or _ (the reference's `punctuation`
// test, used by the emphasis and strikethrough openers).
const PUNCT_OR_WS = /^((?![*_])[\s\p{P}\p{S}])/u;

// Block-level HTML tag names (the CommonMark/GFM list).
const BLOCK_TAGS =
  "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
const HTML_COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const HTML_COMMENT_CLOSED = rx(HTML_COMMENT, [["(?:-->|$)", "-->"]]);

// ---------- block regexes ----------
const BLANK_RUN = /^(?:[ \t]*(?:\n|$))+/;
const INDENT_CODE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const FENCED =
  /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const HR_RX =
  /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const ATX_RX = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const BULLET_SRC = " {0,3}(?:[*+-]|\\d{1,9}[.)])";
const HR_INNER =
  " {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)";

const SETEXT_TPL =
  "^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\\n(?!\\s*?\\n|bull |fences|blockquote|heading|hr|html|table))+?)\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)";
const SETEXT_SUBS = [
  [/bull/g, BULLET_SRC],
  [/blockCode/g, "(?: {4}| {0,3}\\t)"],
  [/fences/g, " {0,3}(?:`{3,}|~{3,})"],
  [/blockquote/g, " {0,3}>"],
  [/heading/g, " {0,3}#{1,6}(?:\\s|$)"],
  [/hr/g, HR_INNER],
  [/html/g, " {0,3}<[^\\n>]+>\\n"],
];
const SETEXT_RX = rx(SETEXT_TPL, [...SETEXT_SUBS, [/\|table/g, ""]]);
const SETEXT_GUARD_RX = /\n[ \t]{0,3}[=-]/;
const SETEXT_GFM_RX = rx(SETEXT_TPL, [
  ...SETEXT_SUBS,
  [/table/g, " {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n"],
]);

const PARA_TPL =
  "^([^\\n]+(?:\\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \\t]+\\n)[^\\n]+)*)";
const PARA_HTML =
  " {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)";
const PARA_FENCES =
  " {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)";
function paraRx(listPat, tableSub) {
  return rx(PARA_TPL, [
    ["hr", HR_RX],
    ["heading", " {0,3}#{1,6}(?:\\s|$)"],
    ["|lheading", ""],
    tableSub,
    ["blockquote", " {0,3}>"],
    ["fences", PARA_FENCES],
    ["list", listPat],
    ["html", PARA_HTML],
    ["tag", BLOCK_TAGS],
  ]);
}
const PARA_RX = paraRx(" {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]", ["|table", ""]);
const PARA_BQ_RX = paraRx(" {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)", [
  "|table",
  "",
]);

const TABLE_RX = rx(
  "^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)",
  [
    ["hr", HR_RX],
    ["heading", " {0,3}#{1,6}(?:\\s|$)"],
    ["blockquote", " {0,3}>"],
    ["code", "(?: {4}| {0,3}\\t)[^\\n]"],
    ["fences", PARA_FENCES],
    ["list", " {0,3}(?:[*+-]|1[.)])[ \\t]"],
    ["html", PARA_HTML],
    ["tag", BLOCK_TAGS],
  ],
);
const PARA_GFM_RX = paraRx(" {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]", [
  "table",
  TABLE_RX,
]);

const LIST_START_RX = rx(/^(bull)([ \t][^\n]*?)?(?:\n|$)/, [[/bull/g, BULLET_SRC]]);

const LABEL_INNER_RX =
  /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const TITLE_RX =
  /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/;
const DEF_RX = rx(
  "^ {0,3}\\[(label)\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(title))? *(?:\\n+|$)",
  [
    ["label", LABEL_INNER_RX],
    ["title", TITLE_RX],
  ],
);

const HTML_BLOCK_RX = rx(
  "^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))",
  [
    ["comment", HTML_COMMENT],
    ["tag", BLOCK_TAGS],
    [
      "attribute",
      / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/,
    ],
  ],
  "i",
);

const BLOCKQUOTE_RX = rx(
  /^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/,
  [["paragraph", PARA_BQ_RX]],
);

// One-shot builders for the list tokenizer's inner loop, memoized per indent.
function memoIndent(build) {
  const cache = [];
  return (n) => {
    const i = Math.max(0, Math.min(3, n - 1));
    return (cache[i] ??= build(i));
  };
}
const listItemRx = (bullet) =>
  new RegExp(`^( {0,3}${bullet})((?:[\t ][^\\n]*)?(?:\\n|$))`);
const nextBulletRx = memoIndent(
  (n) =>
    new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`),
);
const hrAtRx = memoIndent(
  (n) =>
    new RegExp(
      `^ {0,${n}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`,
    ),
);
const fencesAtRx = memoIndent(
  (n) => new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`),
);
const headingAtRx = memoIndent(
  (n) => new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`),
);
const htmlAtRx = memoIndent(
  (n) =>
    new RegExp(
      `^ {0,${n}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`,
      "i",
    ),
);
const blockquoteAtRx = memoIndent((n) => new RegExp(`^ {0,${n}}>`));

// Small shared patterns.
const RE = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineGlobal: /\n/g,
  tabGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multiSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetext: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetext2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWs: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  spaceLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  setextLine: /^ {0,3}(?:=+|-+) *$/,
};

// ---------- inline regexes ----------
// Sticky (y-flag) patterns: no ^ anchor is needed because the sticky flag pins
// the match to lastIndex. `syrx` builds one from a template and drops any ^
// anchors the template carried.
function syrx(tpl, subs, flags = "y") {
  const r = rx(tpl, subs, flags);
  return new RegExp(r.source.replace(/(^|\|)\^/g, "$1"), flags);
}

const ESCAPE_RX = /\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/y;
const CODE_SPAN_RX = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/y;
const BR_RX = /( {2,}|\\)\n(?!\s*$)[ \t]*/y;

const EMAIL_RX =
  /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const EMAIL_PROTO_RX = rx(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/, [
  [/email/g, EMAIL_RX],
]);
const AUTOLINK_RX = syrx(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/, [
  ["scheme", /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/],
  [
    "email",
    /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/,
  ],
]);

const URL_RX = syrx(
  /^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/,
  [
    ["emailProtocol", EMAIL_PROTO_RX],
    ["protocol", /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/],
    [
      "email",
      /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/,
    ],
  ],
);
const BACKPEDAL_RX =
  /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

const LINK_LABEL_RX = rx(
  /(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/,
  [["brackets", /\[(?:\\[\s\S]|[^\[\]\\])*\]/]],
);
const LINK_TITLE_RX =
  /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/;
const LINK_RX = syrx(
  "^!?\\[(label)\\]\\([ \\t\\n]*(href)(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(title))?[ \\t\\n]*\\)",
  [
    ["label", LINK_LABEL_RX],
    ["href", /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/],
    ["title", LINK_TITLE_RX],
  ],
);
const REFLINK_RX = syrx("^!?\\[(label)\\]\\[(ref)\\]", [
  ["label", LINK_LABEL_RX],
  ["ref", LABEL_INNER_RX],
]);
const NOLINK_RX = syrx("^!?\\[(ref)\\](?:\\[\\])?", [
  ["ref", LABEL_INNER_RX],
]);

const LT_LABEL_RX = rx(
  /(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/,
  [["brackets", /\[(?:\\[\s\S]|[^\[\]\\])*\]/]],
);
const BE_RX = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const REFLINK_FULL_RX = rx(/^!?\[(label)\]\[(ref)\]/, [
  ["label", LT_LABEL_RX],
  ["ref", BE_RX],
]);
const NOLINK_FULL_RX = rx(/^!?\[(ref)\](?:\[\])?/, [["ref", BE_RX]]);
const REFLINK_SEARCH_RX = rx("reflink|nolink(?!\\()", [
  ["reflink", REFLINK_FULL_RX],
  ["nolink", NOLINK_FULL_RX],
], "g");

const TEXT_RX = syrx(
  /^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/,
  [
    ["protocol", /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/],
    [/emailProtocol/g, /(?:mailto|xmpp):/],
    ["wwwStart", "(?<![^\\s*_~(])www\\."],
  ],
);
// The same text run without the www, email, protocol and hard-break
// lookaheads: identical to TEXT_RX whenever the source holds none of @,
// www., ://, mailto:, xmpp: or two spaces before a line end, and much
// cheaper to run.
const TEXT_SIMPLE_RX =
  /(`+|~+|[^`~])(?:(?=[`~])|[\s\S]*?(?=[\\<!\[`*~_]|$))/y;

const TAG_RX = syrx(
  "^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>",
  [
    ["comment", HTML_COMMENT_CLOSED],
    [
      "attribute",
      /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/,
    ],
  ],
);

// Emphasis delimiters. The left pattern finds a run that may open; the right
// patterns walk a masked copy looking for runs that may close it.
const EM_L_RX = syrx(
  /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/,
  [[/punct/g, PUNCT_NO_TILDE]],
  "yu",
);
const EM_R_AST_TPL =
  "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)";
const EM_R_AST_RX = rx(EM_R_AST_TPL, [
  [/notPunctSpace/g, WORD_OR_TILDE],
  [/punctSpace/g, PUNCT_SPACE_NO_TILDE],
  [/punct/g, PUNCT_NO_TILDE],
], "gu");
const EM_R_UND_TPL =
  "^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)";
const EM_R_UND_RX = rx(EM_R_UND_TPL, [
  [/notPunctSpace/g, NOT_PUNCT_SPACE],
  [/punctSpace/g, PUNCT_SPACE],
  [/punct/g, PUNCT],
], "gu");

const DEL_L_RX = syrx(/^~~?(?:((?!~)punct)|[^\s~])/, [[/punct/g, PUNCT]], "yu");
const DEL_R_TPL =
  "^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)";
const DEL_R_RX = rx(DEL_R_TPL, [
  [/notPunctSpace/g, NOT_PUNCT_SPACE],
  [/punctSpace/g, PUNCT_SPACE],
  [/punct/g, PUNCT],
], "gu");

const ANY_PUNCT_RX = /\\([\p{P}\p{S}])/gu;
const ANY_PUNCT_OUTSIDE_CODE_RX = rx(
  /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/,
  [[/punct/g, PUNCT]],
  "gu",
);
const BLOCK_SKIP_RX = rx(/link|precode-code|html/, [
  [
    "link",
    /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/,
  ],
  ["precode-", "(?<!`)()"],
  ["code", /(?<b>`+)[^`]+\k<b>(?!`)/],
  ["html", /<(?! )[^<>]*?>/],
], "g");

// ---------- small helpers ----------
const ESC_MAP = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const ESC_TEST = /[&<>"']/;
const ESC_REPLACE = /[&<>"']/g;
const ESC_NO_ENCODE_TEST = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESC_NO_ENCODE_REPLACE =
  /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const NUMERIC_REF_RX = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUMERIC_REF_OR_AMP_RX =
  /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// Escape text for HTML. With encodeAmp every & is escaped; otherwise an &
// that already starts a valid entity or numeric reference is left alone.
function escHtml(s, encodeAmp) {
  if (encodeAmp) {
    if (ESC_TEST.test(s)) return s.replace(ESC_REPLACE, (c) => ESC_MAP[c]);
  } else if (ESC_NO_ENCODE_TEST.test(s)) {
    return s.replace(ESC_NO_ENCODE_REPLACE, (c) => ESC_MAP[c]);
  }
  return s;
}

// Decode numeric character references in a text run; a bare & that does not
// start a valid reference becomes &amp; (it is re-escaped on render).
function decodeEntities(s) {
  if (!NUMERIC_REF_RX.test(s)) return s;
  return s.replace(NUMERIC_REF_OR_AMP_RX, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return "&amp;";
    const cp =
      dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff))
      return "\uFFFD";
    if (cp === 38) return "&amp;";
    return String.fromCodePoint(cp);
  });
}

// Percent-encode a link destination the way encodeURI does, keeping % literal.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(RE.percentDecode, "%");
  } catch {
    return null;
  }
}

// Split a table row on unescaped pipes, trimming cells and honouring the
// column count (extra cells dropped, missing cells padded with "").
function splitTableRow(row, count) {
  const t = row.replace(RE.findPipe, (ch, off, str) => {
    let escaped = false;
    let p = off;
    while (--p >= 0 && str[p] === "\\") escaped = !escaped;
    return escaped ? "|" : " |";
  });
  const cells = t.split(RE.splitPipe);
  if (cells.length > 0 && !cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push("");
  }
  for (let i = 0; i < cells.length; i++)
    cells[i] = cells[i].trim().replace(RE.slashPipe, "|");
  return cells;
}

// Strip trailing characters: with invert false, trailing `ch`; with invert
// true, trailing characters that are not `ch`.
function stripEnd(s, ch, invert) {
  const n = s.length;
  if (n === 0) return "";
  let k = 0;
  while (k < n) {
    const c = s.charAt(n - k - 1);
    if (c === ch && !invert) k++;
    else if (c !== ch && invert) k++;
    else break;
  }
  return s.slice(0, n - k);
}

// Drop trailing blank lines, keeping at most one.
function trimTrailingBlanks(s) {
  const lines = s.split("\n");
  let t = lines.length - 1;
  while (t >= 0 && RE.blankLine.test(lines[t])) t--;
  return lines.length - t <= 2 ? s : lines.slice(0, t + 1).join("\n");
}

// Expand tabs to spaces, tracking the column offset for the first tab stop.
function expandTabs(s, col = 0) {
  let out = "";
  let t = col;
  for (const ch of s) {
    if (ch === "\t") {
      const r = 4 - (t % 4);
      out += " ".repeat(r);
      t += r;
    } else {
      out += ch;
      t++;
    }
  }
  return out;
}

// Normalize a link label for lookup: trim, collapse whitespace, fold case.
function normalizeLabel(s) {
  return s
    .trim()
    .replace(RE.multiSpaceGlobal, " ")
    .toLowerCase()
    .toUpperCase()
    .toLowerCase();
}

// Index of the close paren matching the open paren in `s`: -2 when the open
// paren is never closed, -1 when there is no paren pair at all.
function findParenEnd(s, open, close) {
  if (s.indexOf(open) === -1 && s.indexOf(close) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === open) depth++;
    else if (s[i] === close) {
      depth--;
      if (depth < 0) return i;
    }
  }
  return depth > 0 ? -2 : -1;
}

// For a masked inline source, the last index at which a run of each delimiter
// could close an opener: a run whose preceding character is not whitespace.
function lastCloserPositions(masked) {
  const res = { "*": -1, _: -1, "~": -1 };
  const n = masked.length;
  for (let i = 0; i < n; i++) {
    const ch = masked[i];
    if (ch !== "*" && ch !== "_" && ch !== "~") continue;
    const prev = i === 0 ? "\n" : masked[i - 1];
    let j = i + 1;
    while (j < n && masked[j] === ch) j++;
    if (
      prev !== " " &&
      prev !== "\t" &&
      prev !== "\n" &&
      prev !== "\r" &&
      prev !== "\f"
    ) {
      res[ch] = i;
    }
    i = j - 1;
  }
  return res;
}

// ---------- inline parsing ----------
// Anchored copies used when scanning a slice (the label of a link).
const CODE_SPAN_ANCHORED = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const TAG_ANCHORED = new RegExp("^(?:" + TAG_RX.source + ")");
const AUTOLINK_ANCHORED = new RegExp("^(?:" + AUTOLINK_RX.source + ")");

// Does the label of a link contain a `<` that starts an HTML tag or autolink
// reaching past the end of the label? Then the brackets are not a link.
function hasHtmlBeforeLabelEnd(full, label, offset) {
  if (!label.includes("<")) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === "\\") {
      s++;
      continue;
    }
    if (label[s] === "`") {
      const m = CODE_SPAN_ANCHORED.exec(label.slice(s));
      if (m) {
        s += m[0].length - 1;
        continue;
      }
    }
    if (label[s] !== "<") continue;
    const rest = full.slice(offset + s);
    const m = TAG_ANCHORED.exec(rest) || AUTOLINK_ANCHORED.exec(rest);
    if (m) {
      if (m[0].length > label.length - s) return true;
      s += m[0].length - 1;
    }
  }
  return false;
}

// Does this text hold a link (inline or reference) that is not an image?
function linkInText(src, links) {
  if (!src.includes("[")) return false;
  for (const m of src.matchAll(BLOCK_SKIP_RX)) {
    LINK_RX.lastIndex = 0;
    if (LINK_RX.test(m[0]) && src.charAt(m.index - 1) !== "!") return true;
  }
  for (const m of src.matchAll(REFLINK_SEARCH_RX)) {
    const s = m[0];
    const r = s.lastIndexOf("[");
    if (
      !(
        s.charAt(0) === "!" ||
        !Object.hasOwn(links, normalizeLabel(s.slice(r + 1, -1)))
      ) &&
      !(r > 1 && linkInText(s.slice(1, r - 1), links))
    )
      return true;
  }
  return false;
}

// Mask a source for emphasis scanning: links, code spans and HTML tags are
// replaced by same-length `[aaa...]` placeholders so a delimiter inside one
// can never open or close emphasis outside it. Reference links are only
// masked when the document actually defines some (`hasLinks`).
function maskInline(src, links, hasLinks) {
  let t = src;
  if (hasLinks && src.includes("[")) {
    const search = (r) => {
      const o = r.lastIndexOf("[");
      if (!Object.hasOwn(links, normalizeLabel(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== "!") {
        const inner = r.slice(1, o - 1);
        if (linkInText(inner, links)) {
          return (
            "[" +
            inner.replace(REFLINK_SEARCH_RX, search) +
            "][" +
            "a".repeat(r.length - o - 2) +
            "]"
          );
        }
      }
      return "[" + "a".repeat(r.length - 2) + "]";
    };
    t = t.replace(REFLINK_SEARCH_RX, search);
  }
  // Code spans and backslash escapes only exist when the source holds a
  // backtick or a backslash; links and tags only when it holds [, ` or <.
  if (src.includes("`") || src.includes("\\")) {
    t = t.replace(ANY_PUNCT_OUTSIDE_CODE_RX, (n, s, r) =>
      r
        ? "+".repeat(n.length)
        : s
          ? s + n.slice(s.length, -s.length).replace(/`/g, "+") + s
          : n,
    );
  }
  if (src.includes("[") || src.includes("`") || src.includes("<")) {
    t = t.replace(BLOCK_SKIP_RX, (n, s, r) => {
      const o = r ? r.length : 0;
      return n.slice(0, o) + "[" + "a".repeat(n.length - o - 2) + "]";
    });
  }
  return t;
}

// Build a link or image token from a matched bracket pair, tokenizing its
// label. A link whose label itself contains a link is not a link at all.
function makeLink(m, href, title, links, st) {
  const isImage = m[0].charAt(0) === "!";
  const label = m[1].replace(RE.outputLinkReplace, "$1");
  const savedInLink = st.inLink;
  const savedEmitted = st.linkEmitted;
  const savedRaw = st.inRawBlock;
  st.inLink = true;
  st.linkEmitted = false;
  const inner = tokenizeInline(label, links, st);
  const hadNestedLink = st.linkEmitted;
  st.linkEmitted = savedEmitted;
  st.inLink = savedInLink;
  if (!isImage) {
    if (hadNestedLink) {
      st.inRawBlock = savedRaw;
      return null;
    }
    st.linkEmitted = true;
  }
  return {
    type: isImage ? "image" : "link",
    raw: m[0],
    href,
    title: title || null,
    text: label,
    tokens: inner,
  };
}

function tryTag(src, i, st) {
  TAG_RX.lastIndex = i;
  const m = TAG_RX.exec(src);
  if (!m) return null;
  if (!st.inLink && RE.startATag.test(m[0])) st.inLink = true;
  else if (st.inLink && RE.endATag.test(m[0])) st.inLink = false;
  if (!st.inRawBlock && RE.startPreScriptTag.test(m[0])) st.inRawBlock = true;
  else if (st.inRawBlock && RE.endPreScriptTag.test(m[0]))
    st.inRawBlock = false;
  return {
    type: "html",
    raw: m[0],
    inLink: st.inLink,
    inRawBlock: st.inRawBlock,
    block: false,
    text: m[0],
  };
}

function tryLink(src, i, ctx) {
  const st = ctx.st;
  if (!st.linkParenPossible) return null;
  LINK_RX.lastIndex = i;
  const m = LINK_RX.exec(src);
  if (!m) return null;
  const bang = m[0].charAt(0) === "!" ? 2 : 1;
  if (hasHtmlBeforeLabelEnd(src.slice(i), m[1], bang)) return null;
  const hrefRaw = m[2].trim();
  if (RE.startAngleBracket.test(hrefRaw)) {
    if (!RE.endAngleBracket.test(hrefRaw)) return null;
    const stripped = stripEnd(hrefRaw.slice(0, -1), "\\");
    if ((hrefRaw.length - stripped.length) % 2 === 0) return null;
  } else {
    const p = findParenEnd(m[2], "(", ")");
    if (p === -2) return null;
    if (p > -1) {
      const cut = (m[0].indexOf("!") === 0 ? 5 : 4) + m[1].length + p;
      m[2] = m[2].substring(0, p);
      m[0] = m[0].substring(0, cut).trim();
      m[3] = "";
    }
  }
  const rawStripped = stripEnd(m[0].slice(0, -1), "\\");
  if ((m[0].length - rawStripped.length) % 2 === 0) return null;
  let dest = m[2].trim();
  const title = m[3] ? m[3].slice(1, -1) : "";
  if (RE.startAngleBracket.test(dest)) dest = dest.slice(1, -1);
  return makeLink(
    m,
    dest.replace(ANY_PUNCT_RX, "$1"),
    title.replace(ANY_PUNCT_RX, "$1"),
    ctx.links,
    st,
  );
}

function tryReflink(src, i, ctx) {
  REFLINK_RX.lastIndex = i;
  let m = REFLINK_RX.exec(src);
  if (!m) {
    NOLINK_RX.lastIndex = i;
    m = NOLINK_RX.exec(src);
  }
  if (!m) return null;
  const bang = m[0].charAt(0) === "!" ? 2 : 1;
  if (hasHtmlBeforeLabelEnd(src.slice(i), m[1], bang)) return null;
  const ref = ctx.links[normalizeLabel(m[2] || m[1])];
  if (!ref) {
    const ch = m[0].charAt(0);
    return { type: "text", raw: ch, text: ch };
  }
  return makeLink(m, ref.href, ref.title, ctx.links, ctx.st);
}

function tryCodespan(src, i) {
  CODE_SPAN_RX.lastIndex = i;
  const m = CODE_SPAN_RX.exec(src);
  if (!m) return null;
  let text = m[2].replace(RE.newLineGlobal, " ");
  const hasNonSpace = RE.nonSpaceChar.test(text);
  const wrapped =
    RE.startingSpaceChar.test(text) && RE.endingSpaceChar.test(text);
  if (hasNonSpace && wrapped) text = text.substring(1, text.length - 1);
  return { type: "codespan", raw: m[0], text };
}

function tryBr(src, i) {
  BR_RX.lastIndex = i;
  const m = BR_RX.exec(src);
  return m ? { type: "br", raw: m[0] } : null;
}

function tryAutolink(src, i) {
  AUTOLINK_RX.lastIndex = i;
  const m = AUTOLINK_RX.exec(src);
  if (!m) return null;
  let text;
  let href;
  if (m[2] === "@") {
    text = m[1];
    href = "mailto:" + text;
  } else {
    text = m[1];
    href = text;
  }
  return {
    type: "link",
    raw: m[0],
    text,
    href,
    autolink: true,
    tokens: [{ type: "text", raw: text, text }],
  };
}

function tryUrl(src, i) {
  URL_RX.lastIndex = i;
  const m = URL_RX.exec(src);
  if (!m) return null;
  let text;
  let href;
  if (m[2] === "@") {
    text = m[0];
    href = "mailto:" + text;
  } else {
    let cur = m[0];
    let prev;
    do {
      prev = cur;
      cur = BACKPEDAL_RX.exec(cur)?.[0] ?? "";
    } while (prev !== cur);
    text = cur;
    href = m[1] === "www." ? "http://" + cur : cur;
  }
  return {
    type: "link",
    raw: text,
    text,
    href,
    autolink: true,
    tokens: [{ type: "text", raw: text, text }],
  };
}

// Emphasis and strong emphasis, following the delimiter rules: an opener is
// found by the left pattern, a closer by scanning the masked source with the
// right pattern, honouring the rule of three and the run-length accounting.
function tryEmStrong(src, i, ctx, prevChar) {
  EM_L_RX.lastIndex = i;
  const m = EM_L_RX.exec(src);
  if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return null;
  const r = m[0][0];
  const openerSameAsPrev = prevChar === r;
  const off = ctx.masked.length - (src.length - i);
  let l = off;
  while (l > 0 && ctx.masked[l - 1] === r) l--;
  const beforeRun =
    [...ctx.masked.slice(Math.max(0, l - 2), l)].at(-1) ?? "";
  const beforeIsPunct =
    beforeRun === "*" ||
    beforeRun === "_" ||
    PUNCT_OR_WS.test(beforeRun);
  let prev = prevChar;
  if (l < off) prev = beforeRun;
  const canOpen = l < off ? beforeIsPunct : PUNCT_OR_WS.test(prev);
  if (m[4] && ALNUM.test(prev)) return null;
  const afterPunct = m[1] || m[3] || "";
  if (!afterPunct || !prev || canOpen) {
    const k = [...m[0]].length - 1;
    let need = k;
    let extra = 0;
    const y = off - l + k;
    const strongOk =
      !!beforeRun.trim() && (!!afterPunct || (r === "*" && !beforeIsPunct));
    const rDelim = r === "*" ? EM_R_AST_RX : EM_R_UND_RX;
    const lastCloser = ctx.closers[r];
    const q = off + k;
    if (lastCloser < q) return null;
    const t2 = ctx.masked.slice(-1 * (src.length - i) + k);
    const limit = lastCloser - q;
    rDelim.lastIndex = 0;
    let s2;
    while ((s2 = rDelim.exec(t2)) !== null && !(s2.index > limit)) {
      const g = s2[1] || s2[2] || s2[3] || s2[4] || s2[5] || s2[6];
      if (!g) continue;
      const b = [...g].length;
      if (s2[3] || s2[4]) {
        need += b;
        continue;
      } else if (s2[5] || s2[6] || strongOk) {
        if (openerSameAsPrev && (s2[5] || s2[6])) break;
        if (y % 3 && !((y + b) % 3)) {
          extra += b;
          continue;
        }
      }
      need -= b;
      if (need > 0) continue;
      const used = Math.min(b, b + need + extra);
      const firstLen = [...s2[0]][0].length;
      const raw = src.slice(i, i + k + s2.index + firstLen + used);
      if (Math.min(k, used) % 2) {
        const inner = raw.slice(1, -1);
        return {
          type: "em",
          raw,
          text: inner,
          tokens: tokenizeInline(inner, ctx.links, ctx.st),
        };
      }
      const inner = raw.slice(2, -2);
      return {
        type: "strong",
        raw,
        text: inner,
        tokens: tokenizeInline(inner, ctx.links, ctx.st),
      };
    }
  }
  return null;
}

// Strikethrough, mirroring the emphasis walk with its own delimiters.
function tryDel(src, i, ctx, prevChar) {
  DEL_L_RX.lastIndex = i;
  const m = DEL_L_RX.exec(src);
  if (!m) return null;
  if (!m[1] || !prevChar || PUNCT_OR_WS.test(prevChar)) {
    const runLen = [...m[0]].length - 1;
    let need = runLen;
    const closerPos = ctx.closers["~"];
    const start = ctx.masked.length - (src.length - i) + runLen;
    if (closerPos < start) return null;
    const t2 = ctx.masked.slice(-1 * (src.length - i) + runLen);
    const limit = closerPos - start;
    DEL_R_RX.lastIndex = 0;
    let s2;
    while ((s2 = DEL_R_RX.exec(t2)) !== null && !(s2.index > limit)) {
      const g = s2[1] || s2[2] || s2[3] || s2[4] || s2[5] || s2[6];
      if (!g) continue;
      const len = [...g].length;
      if (len !== runLen) continue;
      if (s2[3] || s2[4]) {
        need += len;
        continue;
      }
      need -= len;
      if (need > 0) continue;
      const used = Math.min(len, len + need);
      const firstLen = [...s2[0]][0].length;
      const raw = src.slice(i, i + runLen + s2.index + firstLen + used);
      const inner = raw.slice(runLen, -runLen);
      return {
        type: "del",
        raw,
        text: inner,
        tokens: tokenizeInline(inner, ctx.links, ctx.st),
      };
    }
  }
  return null;
}

// Turn inline markdown into a token list. `st` is the per-document inline
// state (inLink leaks across blocks; inRawBlock is reset by the caller before
// each block's inline pass; linkParenPossible is saved and restored here).
function tokenizeInline(src, links, st) {
  const savedParen = st.linkParenPossible;
  st.linkParenPossible = savedParen && src.includes(")");
  try {
    return tokenizeInlineInner(src, links, st);
  } finally {
    st.linkParenPossible = savedParen;
  }
}

function tokenizeInlineInner(src, links, st) {
  const tokens = [];
  const needsMask =
    src.includes("*") || src.includes("_") || src.includes("~");
  // Masking only changes the source when it holds a bracket, a backtick, a
  // `<` or a backslash; without those the masked copy is the source itself.
  const masked =
    needsMask &&
    (src.includes("[") ||
      src.includes("`") ||
      src.includes("<") ||
      src.includes("\\"))
      ? maskInline(src, links, st.hasLinks)
      : src;
  const closers = needsMask
    ? lastCloserPositions(masked)
    : { "*": -1, _: -1, "~": -1 };
  const ctx = { masked, closers, links, st };
  // Whether the plain text regex may be used for this whole run: it is
  // identical to the full one when the source holds no @, www., ://,
  // mailto:, xmpp: or two spaces before a line end.
  const simpleText =
    !src.includes("@") &&
    !src.includes("www.") &&
    !src.includes("://") &&
    !src.includes("mailto:") &&
    !src.includes("xmpp:") &&
    !src.includes("  \n");
  const textRx = simpleText ? TEXT_SIMPLE_RX : TEXT_RX;
  const n = src.length;
  let i = 0;
  let prevChar = "";
  let prevWasText = false;
  while (i < n) {
    if (!prevWasText) prevChar = "";
    prevWasText = false;
    // Dispatch on the first character: only a few tokenizers can match at
    // each one, so most positions try one or two patterns instead of ten.
    const ch = src.charCodeAt(i);
    let tok = null;
    if (ch === 92) {
      // backslash: an escape, or a hard break, or text
      ESCAPE_RX.lastIndex = i;
      const m = ESCAPE_RX.exec(src);
      if (m) tok = { type: "escape", raw: m[0], text: m[1] };
      else tok = tryBr(src, i);
    } else if (ch === 60) {
      // <: an HTML tag or an autolink
      tok = tryTag(src, i, st) || tryAutolink(src, i);
    } else if (ch === 91 || ch === 33) {
      // [ or !: an inline or reference link (or image)
      tok = tryLink(src, i, ctx) || tryReflink(src, i, ctx);
    } else if (ch === 42 || ch === 95) {
      // * or _: emphasis or strong emphasis
      tok = tryEmStrong(src, i, ctx, prevChar);
    } else if (ch === 96) {
      // backtick: a code span
      tok = tryCodespan(src, i);
    } else if (ch === 126) {
      // ~: strikethrough
      tok = tryDel(src, i, ctx, prevChar);
    } else if (ch === 32) {
      // space: a hard break (two spaces and a line end), or text
      tok = tryBr(src, i);
    } else if (
      (ch >= 48 && ch <= 57) ||
      (ch >= 65 && ch <= 90) ||
      (ch >= 97 && ch <= 122) ||
      ch === 43 ||
      ch === 46 ||
      ch === 45
    ) {
      // a letter, digit, +, . or -: an extended autolink (www, protocol,
      // or email address), or text; never inside another link
      tok = st.inLink ? null : tryUrl(src, i);
    }
    if (tok) {
      if (tok.type === "text") {
        const prev = tokens[tokens.length - 1];
        if (prev && prev.type === "text") {
          prev.raw += tok.raw;
          prev.text += tok.text;
        } else tokens.push(tok);
      } else {
        tokens.push(tok);
      }
      i += tok.raw.length;
      continue;
    }
    textRx.lastIndex = i;
    const m = textRx.exec(src);
    if (!m) throw new Error("Infinite loop on byte: " + src.charCodeAt(i));
    const rawText = m[0];
    const inRaw = st.inRawBlock;
    const textTok = {
      type: "text",
      raw: rawText,
      text: inRaw ? rawText : decodeEntities(rawText),
      escaped: inRaw,
    };
    const prev = tokens[tokens.length - 1];
    if (prev && prev.type === "text") {
      prev.raw += textTok.raw;
      prev.text += textTok.text;
    } else tokens.push(textTok);
    if (rawText.slice(-1) !== "_") prevChar = rawText.slice(-1);
    prevWasText = true;
    i += rawText.length;
  }
  return tokens;
}

// ---------- block parsing ----------
// Each tokenizer takes the remaining source and returns a token, or null.
// `links` collects link reference definitions as they are found.

function tokenizeSpace(src) {
  const m = BLANK_RUN.exec(src);
  return m && m[0].length > 0 ? { type: "space", raw: m[0] } : null;
}

// Does one of the first four characters of `src` belong to `set`? Block
// starters all sit within the first three spaces, so this is a cheap
// pre-filter for the block tokenizers below.
function headHas(src, set) {
  const n = Math.min(4, src.length);
  for (let i = 0; i < n; i++) if (set.indexOf(src[i]) !== -1) return true;
  return false;
}

function tokenizeIndentedCode(src) {
  if (src[0] !== " " && src[0] !== "\t") return null;
  const m = INDENT_CODE.exec(src);
  if (!m) return null;
  const raw = trimTrailingBlanks(m[0]);
  return {
    type: "code",
    raw,
    codeBlockStyle: "indented",
    text: raw.replace(RE.codeRemoveIndent, ""),
  };
}

function fenceContent(raw, content) {
  const n = raw.match(RE.indentCodeCompensation);
  if (n === null) return content;
  const indent = n[1];
  return content
    .split("\n")
    .map((line) => {
      const o = line.match(RE.beginningSpace);
      if (o === null) return line;
      return line.slice(Math.min(o[0].length, indent.length));
    })
    .join("\n");
}

function tokenizeFenced(src) {
  if (!headHas(src, "`~")) return null;
  const m = FENCED.exec(src);
  if (!m) return null;
  return {
    type: "code",
    raw: m[0],
    lang: m[2] ? m[2].trim().replace(ANY_PUNCT_RX, "$1") : m[2],
    text: fenceContent(m[0], m[3] || ""),
  };
}

function tokenizeAtx(src) {
  if (!headHas(src, "#")) return null;
  const m = ATX_RX.exec(src);
  if (!m) return null;
  let text = m[2].trim();
  if (RE.endingHash.test(text)) {
    const stripped = stripEnd(text, "#");
    if (!stripped || RE.endingSpaceTabChar.test(stripped))
      text = stripped.trim();
  }
  return {
    type: "heading",
    raw: stripEnd(m[0], "\n"),
    depth: m[1].length,
    text,
  };
}

function tokenizeHr(src) {
  if (!headHas(src, "-_*")) return null;
  const m = HR_RX.exec(src);
  if (!m) return null;
  return { type: "hr", raw: stripEnd(m[0], "\n") };
}

function tokenizeHtmlBlock(src) {
  if (!headHas(src, "<")) return null;
  const m = HTML_BLOCK_RX.exec(src);
  if (!m) return null;
  const raw = trimTrailingBlanks(m[0]);
  return {
    type: "html",
    block: true,
    raw,
    pre: m[1] === "pre" || m[1] === "script" || m[1] === "style",
    text: raw,
  };
}

function tokenizeDef(src) {
  if (!headHas(src, "[")) return null;
  const m = DEF_RX.exec(src);
  if (!m) return null;
  if (!RE.startAngleBracket.test(m[2]) && findParenEnd(m[2], "(", ")") !== -1)
    return null;
  const tag = normalizeLabel(m[1]);
  const href = m[2]
    ? m[2].replace(RE.hrefBrackets, "$1").replace(ANY_PUNCT_RX, "$1")
    : "";
  const title = m[3]
    ? m[3].substring(1, m[3].length - 1).replace(ANY_PUNCT_RX, "$1")
    : m[3];
  return { type: "def", tag, raw: stripEnd(m[0], "\n"), href, title };
}

function tokenizeTable(src) {
  // The delimiter row is the second line, and it must hold a | or a :;
  // without one the table pattern cannot match.
  const nl = src.indexOf("\n");
  if (nl === -1) return null;
  const lineEnd = src.indexOf("\n", nl + 1);
  const delimLine =
    lineEnd === -1 ? src.slice(nl + 1) : src.slice(nl + 1, lineEnd);
  if (!delimLine.includes("|") && !delimLine.includes(":")) return null;
  const m = TABLE_RX.exec(src);
  if (!m || !RE.tableDelimiter.test(m[2])) return null;
  const headerCells = splitTableRow(m[1]);
  const aligns = m[2].replace(RE.tableAlignChars, "").split("|");
  const bodyLines = m[3]?.trim()
    ? m[3].replace(RE.tableRowBlankLine, "").split("\n")
    : [];
  const table = {
    type: "table",
    raw: stripEnd(m[0], "\n"),
    header: [],
    align: [],
    rows: [],
  };
  if (headerCells.length !== aligns.length) return null;
  for (const a of aligns) {
    if (RE.tableAlignRight.test(a)) table.align.push("right");
    else if (RE.tableAlignCenter.test(a)) table.align.push("center");
    else if (RE.tableAlignLeft.test(a)) table.align.push("left");
    else table.align.push(null);
  }
  for (let i = 0; i < headerCells.length; i++) {
    table.header.push({
      text: headerCells[i],
      header: true,
      align: table.align[i],
    });
  }
  for (const line of bodyLines) {
    table.rows.push(
      splitTableRow(line, table.header.length).map((cell, p) => ({
        text: cell,
        header: false,
        align: table.align[p],
      })),
    );
  }
  return table;
}

function tokenizeSetext(src) {
  // Cheap pre-filter: a setext underline is a later line starting (after at
  // most three spaces) with = or -, so without one the big pattern cannot
  // match. This keeps ordinary paragraphs from paying for it.
  if (!SETEXT_GUARD_RX.test(src)) return null;
  const m = SETEXT_GFM_RX.exec(src);
  if (!m) return null;
  return {
    type: "heading",
    raw: stripEnd(m[0], "\n"),
    depth: m[2].charAt(0) === "=" ? 1 : 2,
    text: m[1].trim(),
  };
}

function tokenizeParagraph(src) {
  const m = PARA_GFM_RX.exec(src);
  if (!m) return null;
  const text =
    m[1].charAt(m[1].length - 1) === "\n" ? m[1].slice(0, -1) : m[1];
  return { type: "paragraph", raw: m[0], text };
}

function tokenizeTextLine(src) {
  const m = /^[^\n]+/.exec(src);
  if (!m) return null;
  return { type: "text", raw: m[0], text: m[0] };
}

function tokenizeBlockquote(src, links) {
  if (!headHas(src, ">")) return null;
  const m = BLOCKQUOTE_RX.exec(src);
  if (!m) return null;
  let lines = stripEnd(m[0], "\n").split("\n");
  let rawOut = "";
  let textOut = "";
  const tokens = [];
  while (lines.length > 0) {
    let hasMarker = false;
    const chunk = [];
    let p;
    for (p = 0; p < lines.length; p++) {
      if (RE.blockquoteStart.test(lines[p])) {
        chunk.push(lines[p]);
        hasMarker = true;
      } else if (!hasMarker) chunk.push(lines[p]);
      else break;
    }
    lines = lines.slice(p);
    const chunkStr = chunk.join("\n");
    const cleaned = chunkStr
      .replace(
        RE.blockquoteMarkerWs,
        (g, b, ws) => b + expandTabs(ws, b.length),
      )
      .replace(RE.blockquoteSetext, "\n    $1")
      .replace(RE.blockquoteSetext2, "");
    rawOut = rawOut ? rawOut + "\n" + chunkStr : chunkStr;
    textOut = textOut ? textOut + "\n" + cleaned : cleaned;
    parseBlocks(cleaned, links, tokens, true, true);
    if (lines.length === 0) break;
    const last = tokens[tokens.length - 1];
    if (
      last &&
      (last.type === "code" ||
        last.type === "heading" ||
        last.type === "hr" ||
        last.type === "html" ||
        last.type === "table")
    )
      break;
    if (last && last.type === "blockquote") {
      const g = last;
      const rest = lines.join("\n");
      const combined = g.raw + "\n" + rest.replace(RE.blockquoteSetext2, "");
      const reparsed = tokenizeBlockquote(combined, links);
      tokens[tokens.length - 1] = reparsed;
      const tail = combined
        .substring(reparsed.raw.length)
        .replace(/^\n/, "");
      const tailLines = tail ? tail.split("\n").length : 0;
      const consumedLines = tailLines ? lines.slice(0, -tailLines) : lines;
      if (consumedLines.length > 0)
        rawOut = rawOut + "\n" + consumedLines.join("\n");
      textOut =
        textOut.substring(0, textOut.length - g.text.length) + reparsed.text;
      lines = lines.slice(consumedLines.length);
      if (lines.length > 0 && RE.blockquoteStart.test(lines[0])) continue;
      break;
    } else if (last && last.type === "list") {
      const g = last;
      const combined = g.raw + "\n" + lines.join("\n");
      const reparsed = tokenizeList(combined, links);
      tokens[tokens.length - 1] = reparsed;
      const extra =
        reparsed.raw.length > g.raw.length
          ? combined
              .slice(g.raw.length + 1, reparsed.raw.length)
              .split("\n").length
          : 0;
      if (extra > 0) {
        const y = lines.slice(0, extra).join("\n");
        rawOut = rawOut + "\n" + y;
        textOut = textOut + "\n" + y;
      }
      lines = lines.slice(extra);
      continue;
    }
  }
  return { type: "blockquote", raw: rawOut, tokens, text: textOut };
}

function tokenizeList(src, links) {
  const m = LIST_START_RX.exec(src);
  if (!m) return null;
  const full = src;
  let rest = src;
  const consumed = () => full.length - rest.length;
  const bullet = m[1].trim();
  const ordered = bullet.length > 1;
  const list = {
    type: "list",
    raw: "",
    ordered,
    start: ordered ? +bullet.slice(0, -1) : "",
    loose: false,
    items: [],
  };
  const bulletPat = ordered
    ? `\\d{1,9}\\${bullet.slice(-1)}`
    : `\\${bullet}`;
  const itemRx = listItemRx(bulletPat);
  let prevHadBlank = false;
  while (rest) {
    let isEmptyItem = false;
    const textParts = [];
    const it = itemRx.exec(rest);
    if (!it || HR_RX.test(rest)) break;
    const startPos = consumed();
    rest = rest.substring(it[0].length);
    const nl2 = it[2].indexOf("\n");
    const firstLine = nl2 === -1 ? it[2] : it[2].slice(0, nl2);
    const markerLen = it[1].length;
    let content = firstLine.replace(RE.leadingSpaceTab, (v) =>
      expandTabs(v, markerLen),
    );
    const nl3 = rest.indexOf("\n");
    const nextLine = nl3 === -1 ? rest : rest.slice(0, nl3);
    let isEmpty = !content.trim();
    let indent;
    if (isEmpty) {
      indent = markerLen + 1;
    } else {
      indent = content.search(RE.nonSpaceChar);
      indent = indent > 4 ? 1 : indent;
      textParts.push(content.slice(indent));
      indent += markerLen;
    }
    if (isEmpty && RE.blankLine.test(nextLine)) {
      rest = rest.substring(nextLine.length + 1);
      isEmptyItem = true;
    }
    if (!isEmptyItem) {
      const nextBullet = nextBulletRx(indent);
      const hrAt = hrAtRx(indent);
      const fencesAt = fencesAtRx(indent);
      const headingAt = headingAtRx(indent);
      const htmlAt = htmlAtRx(indent);
      const blockquoteAt = blockquoteAtRx(indent);
      let cur = content;
      while (rest) {
        const nl = rest.indexOf("\n");
        const line = nl === -1 ? rest : rest.slice(0, nl);
        const expanded = line.replace(RE.leadingSpaceTab, (v) =>
          expandTabs(v),
        );
        // Fast path: the six break tests can only match a line whose first
        // non-space character (within the allowed indent) starts a fence,
        // heading, HTML block, block quote, bullet or thematic break.
        let mayBreak = false;
        if (line.charCodeAt(0) !== 9) {
          let sp = 0;
          while (sp < line.length && line.charCodeAt(sp) === 32) sp++;
          if (sp <= 3) {
            const c = line.charCodeAt(sp);
            mayBreak =
              c === 96 ||
              c === 126 ||
              c === 35 ||
              c === 60 ||
              c === 62 ||
              c === 42 ||
              c === 43 ||
              c === 45 ||
              c === 95 ||
              (c >= 48 && c <= 57);
          }
        }
        if (
          mayBreak &&
          (fencesAt.test(line) ||
            headingAt.test(line) ||
            htmlAt.test(line) ||
            blockquoteAt.test(line) ||
            nextBullet.test(line) ||
            hrAt.test(line))
        )
          break;
        if (expanded.search(RE.nonSpaceChar) >= indent || !line.trim()) {
          textParts.push(expanded.slice(indent));
        } else {
          if (
            isEmpty ||
            cur.replace(RE.tabGlobal, "    ").search(RE.nonSpaceChar) >= 4 ||
            fencesAt.test(cur) ||
            headingAt.test(cur) ||
            htmlAt.test(cur) ||
            hrAt.test(cur)
          )
            break;
          const qe =
            /^ {0,3}(?:=+|-+) *$/.test(line) &&
            SETEXT_RX.test(`${cur}\n${line}`)
              ? `    ${expanded.replace(/^ {0,3}/, "")}`
              : line;
          textParts.push(qe);
        }
        isEmpty = !line.trim();
        rest = rest.substring(line.length + 1);
        cur = expanded.slice(indent);
      }
    }
    const itemRaw = full.slice(startPos, consumed());
    const itemText = textParts.join("\n");
    if (!list.loose) {
      if (prevHadBlank) list.loose = true;
      else if (RE.doubleBlankLine.test(itemRaw)) prevHadBlank = true;
    }
    list.items.push({
      type: "list_item",
      raw: itemRaw,
      task: RE.listIsTask.test(itemText),
      loose: false,
      text: itemText,
      tokens: [],
    });
  }
  const lastItem = list.items[list.items.length - 1];
  if (lastItem) {
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
  } else return null;
  list.raw = full.slice(0, consumed()).trimEnd();
  for (const item of list.items) {
    item.tokens = parseBlocks(item.text, links, [], false, false);
    if (!list.loose) {
      const spaces = item.tokens.filter((t) => t.type === "space");
      const hasDouble =
        spaces.length > 0 && spaces.some((t) => RE.anyLine.test(t.raw));
      if (hasDouble) list.loose = true;
    }
  }
  for (const item of list.items) {
    const first = item.tokens[0];
    if (item.task && first && (first.type === "text" || first.type === "paragraph")) {
      item.text = item.text.replace(RE.listReplaceTask, "");
      first.raw = first.raw.replace(RE.listReplaceTask, "");
      first.text = first.text.replace(RE.listReplaceTask, "");
      const cb = RE.listTaskCheckbox.exec(item.raw);
      if (cb) {
        const checkbox = {
          type: "checkbox",
          raw: cb[0] + " ",
          checked: cb[0] !== "[ ]",
        };
        item.checked = checkbox.checked;
        if (list.loose) {
          if (
            first &&
            (first.type === "paragraph" || first.type === "text")
          ) {
            first.preTokens = [checkbox];
          } else {
            item.tokens.unshift({
              type: "paragraph",
              raw: checkbox.raw,
              text: checkbox.raw,
              fixedTokens: [checkbox],
            });
          }
        } else {
          item.tokens.unshift(checkbox);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const t of item.tokens) if (t.type === "text") t.type = "paragraph";
    }
  }
  return list;
}

// The block loop: try each block kind in turn, advancing through the source.
// `tokens` is appended to (blockquote and list recursion reuse it).
// `mergePara` merges a leading paragraph into a previous one (blockquote
// lazy continuation); `top` allows paragraphs (false inside list items).
function parseBlocks(src, links, tokens, mergePara, top) {
  let guard = Infinity;
  while (src.length > 0) {
    if (src.length < guard) guard = src.length;
    else throw new Error("Infinite loop on byte: " + src.charCodeAt(0));
    let tok;
    if ((tok = tokenizeSpace(src))) {
      src = src.slice(tok.raw.length);
      const prev = tokens[tokens.length - 1];
      if (tok.raw.length === 1 && prev !== undefined) prev.raw += "\n";
      else tokens.push(tok);
      continue;
    }
    if ((tok = tokenizeIndentedCode(src))) {
      src = src.slice(tok.raw.length);
      const prev = tokens[tokens.length - 1];
      if (prev && (prev.type === "paragraph" || prev.type === "text")) {
        prev.raw += (prev.raw.endsWith("\n") ? "" : "\n") + tok.raw;
        prev.text += "\n" + tok.text;
      } else tokens.push(tok);
      continue;
    }
    if ((tok = tokenizeFenced(src))) {
      src = src.slice(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = tokenizeAtx(src))) {
      src = src.slice(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = tokenizeHr(src))) {
      src = src.slice(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = tokenizeBlockquote(src, links))) {
      src = src.slice(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = tokenizeList(src, links))) {
      src = src.slice(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = tokenizeHtmlBlock(src))) {
      src = src.slice(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = tokenizeDef(src))) {
      src = src.slice(tok.raw.length);
      const prev = tokens[tokens.length - 1];
      if (prev && (prev.type === "paragraph" || prev.type === "text")) {
        prev.raw += (prev.raw.endsWith("\n") ? "" : "\n") + tok.raw;
        prev.text += "\n" + tok.raw;
      } else {
        if (!links[tok.tag])
          links[tok.tag] = { href: tok.href, title: tok.title };
        tokens.push(tok);
      }
      continue;
    }
    if ((tok = tokenizeTable(src))) {
      src = src.slice(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = tokenizeSetext(src))) {
      src = src.slice(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if (top && (tok = tokenizeParagraph(src))) {
      const prev = tokens[tokens.length - 1];
      if (mergePara && prev && prev.type === "paragraph") {
        prev.raw += (prev.raw.endsWith("\n") ? "" : "\n") + tok.raw;
        prev.text += "\n" + tok.text;
      } else tokens.push(tok);
      mergePara = false;
      src = src.slice(tok.raw.length);
      continue;
    }
    if ((tok = tokenizeTextLine(src))) {
      src = src.slice(tok.raw.length);
      const prev = tokens[tokens.length - 1];
      if (prev && prev.type === "text") {
        prev.raw += (prev.raw.endsWith("\n") ? "" : "\n") + tok.raw;
        prev.text += "\n" + tok.text;
      } else tokens.push(tok);
      continue;
    }
    throw new Error("Infinite loop on byte: " + src.charCodeAt(0));
  }
  return tokens;
}

// ---------- rendering ----------
// Inline tokens for a block token: fixed tokens are used as-is (a task-list
// checkbox wrapped as a paragraph); otherwise the block's text is tokenized,
// with any prepended tokens first. The raw-block flag is reset before each
// block's inline pass, as the reference does for each queued inline run.
function blockInlineTokens(tok, links, st) {
  if (tok.fixedTokens) return tok.fixedTokens;
  st.inRawBlock = false;
  const toks = tokenizeInline(tok.text, links, st);
  return tok.preTokens ? [...tok.preTokens, ...toks] : toks;
}

function renderLink(t, links, st) {
  const inner = t.autolink
    ? escHtml(t.text, true)
    : renderInline(t.tokens, links, st, false);
  const href = cleanUrl(t.href);
  if (href === null) return inner;
  let out = '<a href="' + escHtml(href, t.autolink) + '"';
  if (t.title) out += ' title="' + escHtml(t.title) + '"';
  return out + ">" + inner + "</a>";
}

function renderImage(t, links, st) {
  let alt = t.text;
  if (t.tokens) alt = renderInline(t.tokens, links, st, true);
  const href = cleanUrl(t.href);
  if (href === null) return escHtml(alt);
  let out = `<img src="${escHtml(href)}" alt="${escHtml(alt)}"`;
  if (t.title) out += ` title="${escHtml(t.title)}"`;
  return out + ">";
}

function renderInline(tokens, links, st, plain) {
  let out = "";
  for (const t of tokens) {
    switch (t.type) {
      case "escape":
        out += plain ? t.text : escHtml(t.text);
        break;
      case "html":
        out += t.text;
        break;
      case "link":
        out += plain
          ? renderInline(t.tokens, links, st, true)
          : renderLink(t, links, st);
        break;
      case "image":
        out += plain
          ? renderInline(t.tokens, links, st, true)
          : renderImage(t, links, st);
        break;
      case "checkbox":
        out += plain
          ? t.raw
          : "<input " +
            (t.checked ? 'checked="" ' : "") +
            'disabled="" type="checkbox"> ';
        break;
      case "strong":
        out += plain
          ? renderInline(t.tokens, links, st, true)
          : `<strong>${renderInline(t.tokens, links, st, false)}</strong>`;
        break;
      case "em":
        out += plain
          ? renderInline(t.tokens, links, st, true)
          : `<em>${renderInline(t.tokens, links, st, false)}</em>`;
        break;
      case "codespan":
        out += plain ? t.text : `<code>${escHtml(t.text, true)}</code>`;
        break;
      case "br":
        out += plain ? "" : "<br>";
        break;
      case "del":
        out += plain
          ? renderInline(t.tokens, links, st, true)
          : `<del>${renderInline(t.tokens, links, st, false)}</del>`;
        break;
      case "text":
        out += plain ? t.text : t.escaped ? t.text : escHtml(t.text);
        break;
      default:
        throw new Error('Token with "' + t.type + '" type was not found.');
    }
  }
  return out;
}

function renderCode(t) {
  const lang = (t.lang || "").match(RE.notSpaceStart)?.[0];
  const body = t.text ? t.text.replace(RE.endingNewline, "") + "\n" : "";
  const esc = escHtml(body, true);
  return lang
    ? `<pre><code class="language-${escHtml(lang)}">${esc}</code></pre>\n`
    : `<pre><code>${esc}</code></pre>\n`;
}

function renderTableCell(cell, links, st) {
  const inner = renderInline(
    blockInlineTokens(cell, links, st),
    links,
    st,
    false,
  );
  const tag = cell.header ? "th" : "td";
  return (
    (cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`) +
    inner +
    `</${tag}>\n`
  );
}

function renderTable(t, links, st) {
  let headCells = "";
  for (const cell of t.header) headCells += renderTableCell(cell, links, st);
  const head = `<tr>\n${headCells}</tr>\n`;
  let body = "";
  for (const row of t.rows) {
    let rowCells = "";
    for (const cell of row) rowCells += renderTableCell(cell, links, st);
    body += `<tr>\n${rowCells}</tr>\n`;
  }
  if (body) body = `<tbody>${body}</tbody>`;
  return `<table>\n<thead>\n${head}</thead>\n${body}</table>\n`;
}

function renderBlocks(tokens, links, st) {
  let out = "";
  for (const t of tokens) {
    switch (t.type) {
      case "space":
        break;
      case "hr":
        out += "<hr>\n";
        break;
      case "heading": {
        const inner = renderInline(
          blockInlineTokens(t, links, st),
          links,
          st,
          false,
        );
        out += `<h${t.depth}>${inner}</h${t.depth}>\n`;
        break;
      }
      case "code":
        out += renderCode(t);
        break;
      case "table":
        out += renderTable(t, links, st);
        break;
      case "blockquote":
        out += `<blockquote>\n${renderBlocks(t.tokens, links, st)}</blockquote>\n`;
        break;
      case "list": {
        let items = "";
        for (const item of t.items)
          items += `<li>${renderBlocks(item.tokens, links, st)}</li>\n`;
        const tag = t.ordered ? "ol" : "ul";
        const start =
          t.ordered && t.start !== 1 ? ` start="${t.start}"` : "";
        out += `<${tag}${start}>\n${items}</${tag}>\n`;
        break;
      }
      case "checkbox":
        out +=
          "<input " +
          (t.checked ? 'checked="" ' : "") +
          'disabled="" type="checkbox"> ';
        break;
      case "html":
        out += t.text;
        break;
      case "def":
        break;
      case "paragraph":
        out += `<p>${renderInline(blockInlineTokens(t, links, st), links, st, false)}</p>\n`;
        break;
      case "text":
        out += renderInline(blockInlineTokens(t, links, st), links, st, false);
        break;
      default:
        throw new Error('Token with "' + t.type + '" type was not found.');
    }
  }
  return out;
}

// ---------- entry point ----------
// Render `markdown` exactly as marked 18.1.3 does with its default options.
// Fresh state per call: nothing is kept from an earlier case.
export function parse(markdown) {
  const src = markdown.replace(RE.carriageReturn, "\n");
  const links = Object.create(null);
  const st = {
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
    hasLinks: false,
  };
  const tokens = parseBlocks(src, links, [], false, true);
  st.hasLinks = Object.keys(links).length > 0;
  return renderBlocks(tokens, links, st);
}
