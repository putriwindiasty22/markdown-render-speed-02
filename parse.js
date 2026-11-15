// parse.js — a fast drop-in replacement for marked 18.1.3's marked.parse with
// default options (gfm: true, breaks: false, pedantic: false, async: false).
//
// This is a fork of marked 18.1.3 (MIT, Copyright (c) 2018-2026 MarkedJS;
// Copyright (c) 2011-2018 Christopher Jeffrey; see vendor/marked/LICENSE and
// vendor/marked/NOTICE). It re-implements marked's exact algorithm — same
// regexes, same tokenization and rendering rules — but streamlined for the
// default options only and optimized for speed: no classes, no options or
// extension machinery, first-character dispatch in both lexers, cheap
// pre-checks before expensive regular expressions, and a fused
// parser/renderer that writes HTML directly instead of going through a
// renderer object. The public entry point is parse(markdown).
//
// Revised in this session: trimTrailingBlankLines now scans backwards from
// the end instead of splitting and rejoining the whole string, and
// splitCells splits on unescaped pipes in a single pass; both keep marked's
// exact behaviour. expandTabs now indexes code units instead of iterating
// code points (its inputs are whitespace only, so this is identical).

// ---------- regex builders ----------
function edit(regex, opt = '') {
  let source = typeof regex === 'string' ? regex : regex.source;
  const obj = {
    replace: (name, val) => {
      let valSource = typeof val === 'string' ? val : val.source;
      valSource = valSource.replace(other.caret, '$1');
      source = source.replace(name, valSource);
      return obj;
    },
    getRegex: () => new RegExp(source, opt),
  };
  return obj;
}

function cachedIndentRegex(createRegex) {
  const cache = [];
  return (indent) => {
    const cacheIndex = Math.max(0, Math.min(3, indent - 1));
    let regex = cache[cacheIndex];
    if (!regex) {
      regex = createRegex(cacheIndex);
      cache[cacheIndex] = regex;
    }
    return regex;
  };
}

const noopTest = { exec: () => null };

// ---------- misc regexes (rules.other) ----------
const other = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
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
  pedanticHrefTitle: /^([^'"]*[^\s])\s+(['"])(.*)\2/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericCharacterReferenceOrAmpersand: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  caret: /(^|[^\[])\^/g,
  percentDecode: /%25/g,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  spaceLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  listItemRegex: (bull) => new RegExp(`^( {0,3}${bull})((?:[\t ][^\n]*)?(?:\n|$))`),
  nextBulletRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\n]*)?(?:\n|$))`)),
  hrRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`)),
  fencesBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}(?:\`\`\`|~~~)`)),
  headingBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}#{1,6}(?:\\s|$)`)),
  pedanticHeadingBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}#`)),
  htmlBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}(?:</?(?:${_tag})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i')),
  blockquoteBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}>`)),
};

// ---------- block grammar (GFM) ----------
const newline = /^(?:[ \t]*(?:\n|$))+/;
const blockCode = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const fences = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const hr = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const heading = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const bullet = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const lheadingCore = /^(?!bull |blockCode|fences|blockquote|heading|hr|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const lheading = edit(lheadingCore)
  .replace(/bull/g, bullet)
  .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .replace(/blockquote/g, / {0,3}>/)
  .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .replace(/html/g, / {0,3}<[^\n>]+>\n/)
  .replace(/\|table/g, '')
  .getRegex();
const lheadingGfm = edit(lheadingCore)
  .replace(/bull/g, bullet)
  .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .replace(/blockquote/g, / {0,3}>/)
  .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .replace(/html/g, / {0,3}<[^\n>]+>\n/)
  .replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
  .getRegex();
const _paragraph = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
const blockText = /^[^\n]+/;
const _blockLabel = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const def = edit(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .replace('label', _blockLabel)
  .replace('title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
  .getRegex();
const list = edit(/^(bull)([ \t][^\n]*?)?(?:\n|$)/)
  .replace(/bull/g, bullet)
  .getRegex();
const _tag = 'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';
const _comment = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const html = edit(
  '^ {0,3}(?:'
  + '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)'
  + '|comment[^\\n]*(\\n+|$)'
  + '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)'
  + '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)'
  + '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)'
  + '|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
  + '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
  + '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
  + ')', 'i')
  .replace('comment', _comment)
  .replace('tag', _tag)
  .replace('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
  .getRegex();

function createParagraph(listInterrupt) {
  return edit(_paragraph)
    .replace('hr', hr)
    .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .replace('|lheading', '')
    .replace('|table', '')
    .replace('blockquote', ' {0,3}>')
    .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .replace('list', listInterrupt)
    .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
    .replace('tag', _tag)
    .getRegex();
}
const paragraph = createParagraph(/ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/);
const blockquoteParagraph = createParagraph(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/);
const blockquote = edit(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/)
  .replace('paragraph', blockquoteParagraph)
  .getRegex();

const gfmTable = edit(
  '^ *([^\\n ].*)\\n'
  + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
  + '(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)')
  .replace('hr', hr)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('blockquote', ' {0,3}>')
  .replace('code', '(?: {4}| {0,3}\t)[^\\n]')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', _tag)
  .getRegex();

// GFM paragraph: like createParagraph but a table can interrupt it.
const paragraphGfm = edit(_paragraph)
  .replace('hr', hr)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('|lheading', '')
  .replace('table', gfmTable)
  .replace('blockquote', ' {0,3}>')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', _tag)
  .getRegex();

const block = {
  blockquote,
  code: blockCode,
  def,
  fences,
  heading,
  hr,
  html,
  lheading: lheadingGfm,
  list,
  newline,
  paragraph: paragraphGfm,
  table: gfmTable,
  text: blockText,
};

// ---------- inline grammar (GFM) ----------
const escape = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const inlineCode = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const br = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;

const _punctuation = /[\p{P}\p{S}]/u;
const _punctuationOrSpace = /[\s\p{P}\p{S}]/u;
const _notPunctuationOrSpace = /[^\s\p{P}\p{S}]/u;
const punctuation = edit(/^((?![*_])punctSpace)/, 'u')
  .replace(/punctSpace/g, _punctuationOrSpace).getRegex();

// GFM allows ~ inside strong and em for strikethrough
const _punctuationGfmStrongEm = /(?!~)[\p{P}\p{S}]/u;
const _punctuationOrSpaceGfmStrongEm = /(?!~)[\s\p{P}\p{S}]/u;
const _notPunctuationOrSpaceGfmStrongEm = /(?:[^\s\p{P}\p{S}]|~)/u;

const blockSkip = edit(/link|precode-code|html/, 'g')
  .replace('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .replace('precode-', '(?<!`)()')
  .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .replace('html', /<(?! )[^<>]*?>/)
  .getRegex();

const emStrongLDelimCore = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
const emStrongLDelimGfm = edit(emStrongLDelimCore, 'u')
  .replace(/punct/g, _punctuationGfmStrongEm)
  .getRegex();

const emStrongRDelimAstCore =
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)' // Skip orphan inside strong
  + '|[^*]+(?=[^*])' // Consume to delim
  + '|(?!\\*)punct(\\*+)(?=[\\s]|$)' // (1) #*** can only be a Right Delimiter
  + '|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)' // (2) a***#, a*** can only be a Right Delimiter
  + '|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)' // (3) #***a, ***a can only be Left Delimiter
  + '|[\\s](\\*+)(?!\\*)(?=punct)' // (4) ***# can only be Left Delimiter
  + '|(?!\\*)punct(\\*+)(?!\\*)(?=punct)' // (5) #***# can be either Left or Right Delimiter
  + '|notPunctSpace(\\*+)(?=notPunctSpace)'; // (6) a***a can be either Left or Right Delimiter
const emStrongRDelimAstGfm = edit(emStrongRDelimAstCore, 'gu')
  .replace(/notPunctSpace/g, _notPunctuationOrSpaceGfmStrongEm)
  .replace(/punctSpace/g, _punctuationOrSpaceGfmStrongEm)
  .replace(/punct/g, _punctuationGfmStrongEm)
  .getRegex();

const emStrongRDelimUnd = edit(
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)' // Skip orphan inside strong
  + '|[^_]+(?=[^_])' // Consume to delim
  + '|(?!_)punct(_+)(?=[\\s]|$)' // (1) #___ can only be a Right Delimiter
  + '|notPunctSpace(_+)(?!_)(?=punctSpace|$)' // (2) a___#, a___ can only be a Right Delimiter
  + '|(?!_)punctSpace(_+)(?=notPunctSpace)' // (3) #___a, ___a can only be Left Delimiter
  + '|[\\s](_+)(?!_)(?=punct)' // (4) ___# can only be Left Delimiter
  + '|(?!_)punct(_+)(?!_)(?=punct)', 'gu') // (5) #___# can be either Left or Right Delimiter
  .replace(/notPunctSpace/g, _notPunctuationOrSpace)
  .replace(/punctSpace/g, _punctuationOrSpace)
  .replace(/punct/g, _punctuation)
  .getRegex();

const delLDelim = edit(/^~~?(?:((?!~)punct)|[^\s~])/, 'u')
  .replace(/punct/g, _punctuation)
  .getRegex();

const delRDelimCore =
  '^[^~]+(?=[^~])' // Consume to delim
  + '|(?!~)punct(~~?)(?=[\\s]|$)' // (1) #~~ can only be a Right Delimiter
  + '|notPunctSpace(~~?)(?!~)(?=punctSpace|$)' // (2) a~~#, a~~ can only be a Right Delimiter
  + '|(?!~)punctSpace(~~?)(?=notPunctSpace)' // (3) #~~a, ~~a can only be Left Delimiter
  + '|[\\s](~~?)(?!~)(?=punct)' // (4) ~~# can only be Left Delimiter
  + '|(?!~)punct(~~?)(?!~)(?=punct)' // (5) #~~# can be either Left or Right Delimiter
  + '|notPunctSpace(~~?)(?=notPunctSpace)'; // (6) a~~a can be either Left or Right Delimiter
const delRDelim = edit(delRDelimCore, 'gu')
  .replace(/notPunctSpace/g, _notPunctuationOrSpace)
  .replace(/punctSpace/g, _punctuationOrSpace)
  .replace(/punct/g, _punctuation)
  .getRegex();

const anyPunctuation = edit(/\\(punct)/, 'gu')
  .replace(/punct/g, _punctuation)
  .getRegex();

const anyPunctuationOutsideCode = edit(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu')
  .replace(/punct/g, _punctuation)
  .getRegex();

const autolink = edit(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .replace('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .replace('email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/)
  .getRegex();

const _inlineComment = edit(_comment).replace('(?:-->|$)', '-->').getRegex();
const tag = edit(
  '^comment'
  + '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>' // self-closing tag
  + '|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>' // open tag
  + '|^<\\?[\\s\\S]*?\\?>' // processing instruction
  + '|^<![a-zA-Z]+\\s[\\s\\S]*?>' // declaration
  + '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>') // CDATA section
  .replace('comment', _inlineComment)
  .replace('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)
  .getRegex();

const _inlineLabelBrackets = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const _inlineLabel = edit(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/)
  .replace('brackets', _inlineLabelBrackets)
  .getRegex();

const link = edit(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .replace('label', _inlineLabel)
  .replace('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .replace('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
  .getRegex();

const reflink = edit(/^!?\[(label)\]\[(ref)\]/)
  .replace('label', _inlineLabel)
  .replace('ref', _blockLabel)
  .getRegex();

const nolink = edit(/^!?\[(ref)\](?:\[\])?/)
  .replace('ref', _blockLabel)
  .getRegex();

const _boundedBlockLabel = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const _boundedInlineLabel = edit(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/)
  .replace('brackets', _inlineLabelBrackets)
  .getRegex();

const reflinkSearch = edit('reflink|nolink(?!\\()', 'g')
  .replace('reflink', edit(/^!?\[(label)\]\[(ref)\]/)
    .replace('label', _boundedInlineLabel)
    .replace('ref', _boundedBlockLabel)
    .getRegex())
  .replace('nolink', edit(/^!?\[(ref)\](?:\[\])?/)
    .replace('ref', _boundedBlockLabel)
    .getRegex())
  .getRegex();

const _caseInsensitiveProtocol = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const _extendedEmail = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const _extendedEmailProtocol = edit(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/)
  .replace(/email/g, _extendedEmail)
  .getRegex();

const url = edit(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .replace('emailProtocol', _extendedEmailProtocol)
  .replace('protocol', _caseInsensitiveProtocol)
  .replace('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)
  .getRegex();
const _backpedal = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const del = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;
const inlineTextGfm = edit(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/)
  .replace('protocol', _caseInsensitiveProtocol)
  .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
  .replace('wwwStart', '(?<![^\\s*_~(])www\\.')
  .getRegex();

const inline = {
  _backpedal,
  anyPunctuation,
  anyPunctuationOutsideCode,
  autolink,
  blockSkip,
  br,
  code: inlineCode,
  del,
  delLDelim,
  delRDelim,
  emStrongLDelim: emStrongLDelimGfm,
  emStrongRDelimAst: emStrongRDelimAstGfm,
  emStrongRDelimUnd,
  escape,
  link,
  nolink,
  punctuation,
  reflink,
  reflinkSearch,
  tag,
  text: inlineTextGfm,
  url,
};

// ---------- helpers ----------
const escapeReplacements = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const getEscapeReplacement = (ch) => escapeReplacements[ch];

function escapeHtmlEntities(html, encode) {
  if (encode) {
    if (other.escapeTest.test(html)) {
      return html.replace(other.escapeReplace, getEscapeReplacement);
    }
  } else if (other.escapeTestNoEncode.test(html)) {
    return html.replace(other.escapeReplaceNoEncode, getEscapeReplacement);
  }
  return html;
}

function decodeNumericCharacterReferences(text) {
  // Fast path: no '&' means no reference and nothing to escape.
  if (text.indexOf('&') === -1) return text;
  if (!other.numericCharacterReference.test(text)) {
    return text;
  }
  return text.replace(other.numericCharacterReferenceOrAmpersand, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) {
      return '&amp;';
    }
    const code = dec === undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      return '�';
    }
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(other.percentDecode, '%');
  } catch {
    return null;
  }
  return href;
}

function splitCells(tableRow, count) {
  // Split on unescaped pipes in a single pass: a pipe preceded by an odd
  // run of backslashes stays in its cell (the backslash is kept, and the
  // slashPipe replace below turns "\|" into "|"). The old version first
  // replaced the row, rescanning backwards from every pipe, then split.
  const cells = [];
  let cell = '';
  let escaped = false;
  for (let i = 0; i < tableRow.length; i++) {
    const ch = tableRow[i];
    if (escaped) {
      cell += ch;
      escaped = false;
    } else if (ch === '\\') {
      escaped = true;
      cell += ch;
    } else if (ch === '|') {
      cells.push(cell);
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  let i = 0;
  if (!cells[0].trim()) {
    cells.shift();
  }
  if (cells.length > 0 && !cells.at(-1)?.trim()) {
    cells.pop();
  }
  if (count) {
    if (cells.length > count) {
      cells.splice(count);
    } else {
      while (cells.length < count) cells.push('');
    }
  }
  for (; i < cells.length; i++) {
    cells[i] = cells[i].trim().replace(other.slashPipe, '|');
  }
  return cells;
}

function rtrim(str, c, invert) {
  const l = str.length;
  if (l === 0) {
    return '';
  }
  let suffLen = 0;
  while (suffLen < l) {
    const currChar = str.charAt(l - suffLen - 1);
    if (currChar === c && !invert) {
      suffLen++;
    } else if (currChar !== c && invert) {
      suffLen++;
    } else {
      break;
    }
  }
  return str.slice(0, l - suffLen);
}

function trimTrailingBlankLines(str) {
  // Count the trailing blank lines (lines of only spaces/tabs) by scanning
  // backwards from the end; the string is unchanged unless there are two
  // or more of them, in which case it is cut just after the last non-blank
  // line. This avoids splitting and rejoining the whole string for the
  // common case of a code or HTML block with no trailing blank lines.
  let end = str.length;
  let blanks = 0;
  while (end > 0) {
    const nl = str.lastIndexOf('\n', end - 1);
    const lineStart = nl + 1;
    let j = end;
    while (j > lineStart && (str[j - 1] === ' ' || str[j - 1] === '\t')) j--;
    if (j !== lineStart) break;
    blanks++;
    end = nl;
  }
  if (end === 0) blanks++; // the empty first line is blank too
  if (blanks <= 1) {
    return str;
  }
  return str.slice(0, Math.max(end, 0));
}

function normalizeLabel(label) {
  return label.trim().replace(other.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}

function findClosingBracket(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) {
    return -1;
  }
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') {
      i++;
    } else if (str[i] === b[0]) {
      level++;
    } else if (str[i] === b[1]) {
      level--;
      if (level < 0) {
        return i;
      }
    }
  }
  if (level > 0) {
    return -2;
  }
  return -1;
}

function scanLastPossibleEmStrongDelClosers(src) {
  const lastPossibleEmStrongCloserIndex = { '*': -1, _: -1 };
  let lastPossibleDelCloserIndex = -1;
  const len = src.length;
  for (let i = 0; i < len; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') {
      continue;
    }
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    while (j < len && src[j] === ch) {
      j++;
    }
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') {
        lastPossibleDelCloserIndex = i;
      } else {
        lastPossibleEmStrongCloserIndex[ch] = i;
      }
    }
    i = j - 1;
  }
  return {
    maskedSrc: src,
    lastPossibleEmStrongCloserIndex,
    lastPossibleDelCloserIndex,
  };
}

// Closer hints for the inline pass currently running, held on the parse
// context (one frame per nested inline pass) instead of a WeakMap.
function beginEmStrongDelCloserScan(ctx, maskedSrc) {
  ctx.hintStack.push(scanLastPossibleEmStrongDelClosers(maskedSrc));
}
function endEmStrongDelCloserScan(ctx) {
  ctx.hintStack.pop();
}
function cachedLastPossibleEmStrongCloserIndex(ctx, maskedSrc, delim) {
  const frame = ctx.hintStack.at(-1);
  if (frame && frame.maskedSrc === maskedSrc) {
    return frame.lastPossibleEmStrongCloserIndex[delim];
  }
  return scanLastPossibleEmStrongDelClosers(maskedSrc).lastPossibleEmStrongCloserIndex[delim];
}
function cachedLastPossibleDelCloserIndex(ctx, maskedSrc) {
  const frame = ctx.hintStack.at(-1);
  if (frame && frame.maskedSrc === maskedSrc) {
    return frame.lastPossibleDelCloserIndex;
  }
  return scanLastPossibleEmStrongDelClosers(maskedSrc).lastPossibleDelCloserIndex;
}

function expandTabs(line, indent = 0) {
  // Index code units rather than iterating code points: every caller passes
  // only spaces and tabs, so the two are identical here, and indexing
  // avoids the string iterator.
  let col = indent;
  let expanded = '';
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '\t') {
      const added = 4 - (col % 4);
      expanded += ' '.repeat(added);
      col += added;
    } else {
      expanded += char;
      col++;
    }
  }
  return expanded;
}

// ---------- block tokenizers ----------
// Each takes (ctx, src) and returns a token or undefined. ctx is the
// per-parse state: { links, inlineQueue, state, hintStack }.

function indentCodeCompensation(raw, text) {
  const matchIndentToCode = raw.match(other.indentCodeCompensation);
  if (matchIndentToCode === null) {
    return text;
  }
  const indentToCode = matchIndentToCode[1];
  return text
    .split('\n')
    .map((node) => {
      const matchIndentInNode = node.match(other.beginningSpace);
      if (matchIndentInNode === null) {
        return node;
      }
      const [indentInNode] = matchIndentInNode;
      return node.slice(Math.min(indentInNode.length, indentToCode.length));
    })
    .join('\n');
}

function tokSpace(ctx, src) {
  const cap = block.newline.exec(src);
  if (cap && cap[0].length > 0) {
    return { type: 'space', raw: cap[0] };
  }
}

function tokCode(ctx, src) {
  const cap = block.code.exec(src);
  if (cap) {
    const raw = trimTrailingBlankLines(cap[0]);
    const text = raw.replace(other.codeRemoveIndent, '');
    return { type: 'code', raw, codeBlockStyle: 'indented', text };
  }
}

function tokFences(ctx, src) {
  const cap = block.fences.exec(src);
  if (cap) {
    const raw = cap[0];
    const text = indentCodeCompensation(raw, cap[3] || '');
    return {
      type: 'code',
      raw,
      lang: cap[2] ? cap[2].trim().replace(inline.anyPunctuation, '$1') : cap[2],
      text,
    };
  }
}

function tokHeading(ctx, src) {
  const cap = block.heading.exec(src);
  if (cap) {
    let text = cap[2].trim();
    if (other.endingHash.test(text)) {
      const trimmed = rtrim(text, '#');
      if (!trimmed || other.endingSpaceTabChar.test(trimmed)) {
        text = trimmed.trim();
      }
    }
    return {
      type: 'heading',
      raw: rtrim(cap[0], '\n'),
      depth: cap[1].length,
      text,
      tokens: queueInline(ctx, text),
    };
  }
}

function tokHr(ctx, src) {
  const cap = block.hr.exec(src);
  if (cap) {
    return { type: 'hr', raw: rtrim(cap[0], '\n') };
  }
}

function tokBlockquote(ctx, src) {
  const cap = block.blockquote.exec(src);
  if (cap) {
    let lines = rtrim(cap[0], '\n').split('\n');
    let raw = '';
    let text = '';
    const tokens = [];
    while (lines.length > 0) {
      let inBlockquote = false;
      const currentLines = [];
      let i;
      for (i = 0; i < lines.length; i++) {
        if (other.blockquoteStart.test(lines[i])) {
          currentLines.push(lines[i]);
          inBlockquote = true;
        } else if (!inBlockquote) {
          currentLines.push(lines[i]);
        } else {
          break;
        }
      }
      lines = lines.slice(i);
      const currentRaw = currentLines.join('\n');
      const currentText = currentRaw
        .replace(
          other.blockquoteMarkerWhitespace,
          (_, marker, whitespace) => marker + expandTabs(whitespace, marker.length),
        )
        .replace(other.blockquoteSetextReplace, '\n    $1')
        .replace(other.blockquoteSetextReplace2, '');
      raw = raw ? `${raw}\n${currentRaw}` : currentRaw;
      text = text ? `${text}\n${currentText}` : currentText;
      const top = ctx.state.top;
      ctx.state.top = true;
      blockTokens(ctx, currentText, tokens, true);
      ctx.state.top = top;
      if (lines.length === 0) {
        break;
      }
      const lastToken = tokens.at(-1);
      if (lastToken?.type === 'code' || lastToken?.type === 'heading' || lastToken?.type === 'hr' || lastToken?.type === 'html' || lastToken?.type === 'table') {
        break;
      } else if (lastToken?.type === 'blockquote') {
        const oldToken = lastToken;
        const continuation = lines.join('\n');
        const newText = oldToken.raw + '\n' + continuation.replace(other.blockquoteSetextReplace2, '');
        const newToken = tokBlockquote(ctx, newText);
        tokens[tokens.length - 1] = newToken;
        const leftover = newText.substring(newToken.raw.length).replace(/^\n/, '');
        const leftoverCount = leftover ? leftover.split('\n').length : 0;
        const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
        if (consumed.length > 0) {
          raw = `${raw}\n${consumed.join('\n')}`;
        }
        text = text.substring(0, text.length - oldToken.text.length) + newToken.text;
        lines = lines.slice(consumed.length);
        if (lines.length > 0 && other.blockquoteStart.test(lines[0])) {
          continue;
        }
        break;
      } else if (lastToken?.type === 'list') {
        const oldToken = lastToken;
        const newText = oldToken.raw + '\n' + lines.join('\n');
        const newToken = tokList(ctx, newText);
        tokens[tokens.length - 1] = newToken;
        const consumedCount = newToken.raw.length > oldToken.raw.length
          ? newText.slice(oldToken.raw.length + 1, newToken.raw.length).split('\n').length
          : 0;
        if (consumedCount > 0) {
          const consumed = lines.slice(0, consumedCount).join('\n');
          raw = `${raw}\n${consumed}`;
          text = `${text}\n${consumed}`;
        }
        lines = lines.slice(consumedCount);
        continue;
      }
    }
    return { type: 'blockquote', raw, tokens, text };
  }
}

// Does `s` start a block that ends a list item? The six regexes are all
// anchored `^ {0,indent}X`, so only the regexes whose opening character
// follows the leading spaces can match; the rest are skipped outright.
function listBreakTest(s, indent, fencesRe, headingRe, htmlRe, bqRe, nbRe, hrRe) {
  let s0 = 0;
  while (s0 < s.length && s[s0] === ' ') s0++;
  if (s0 > indent) return false;
  const c = s[s0];
  if (c === '`' || c === '~') return fencesRe ? fencesRe.test(s) : false;
  if (c === '#') return headingRe ? headingRe.test(s) : false;
  if (c === '<') return htmlRe ? htmlRe.test(s) : false;
  if (c === '>') return bqRe ? bqRe.test(s) : false;
  if (c === '*' || c === '-') {
    if (nbRe && nbRe.test(s)) return true;
    return hrRe ? hrRe.test(s) : false;
  }
  if (c === '+' || (c >= '0' && c <= '9')) return nbRe ? nbRe.test(s) : false;
  if (c === '_') return hrRe ? hrRe.test(s) : false;
  return false;
}

// Index of the first non-space character of `line` with every tab counted
// as four spaces (as in line.replace(/\t/g, '    ').search(/[^ ]/)); -1
// when the line holds only whitespace.
function expandedFirstNonSpace(line) {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === ' ') col++;
    else if (ch === '\t') col += 4;
    else return col;
  }
  return -1;
}

// True when `s` holds only spaces and tabs (the blankLine regex).
function isBlankLine(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== ' ' && s[i] !== '\t') return false;
  }
  return true;
}

// First line of `s` (up to the first newline, or the whole string).
function firstLineOf(s) {
  const nl = s.indexOf('\n');
  return nl === -1 ? s : s.slice(0, nl);
}

// Does `raw` end with a blank line (the doubleBlankLine regex)?
function rawEndsWithBlankLine(raw) {
  let end = raw.length;
  while (end > 0 && (raw[end - 1] === ' ' || raw[end - 1] === '\t')) end--;
  if (end === 0 || raw[end - 1] !== '\n') return false;
  let j = end - 2;
  while (j >= 0 && (raw[j] === ' ' || raw[j] === '\t')) j--;
  return j >= 0 && raw[j] === '\n';
}

function tokList(ctx, src) {
  let cap = block.list.exec(src);
  if (cap) {
    const listSrc = src;
    const taken = () => listSrc.length - src.length;
    let bull = cap[1].trim();
    const isordered = bull.length > 1;
    const list = {
      type: 'list',
      raw: '',
      ordered: isordered,
      start: isordered ? +bull.slice(0, -1) : '',
      loose: false,
      items: [],
    };
    bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
    const itemRegex = other.listItemRegex(bull);
    let endsWithBlankLine = false;
    while (src) {
      let endEarly = false;
      let itemContents = '';
      if (!(cap = itemRegex.exec(src))) {
        break;
      }
      if (blockStartChar(src) === '-' || blockStartChar(src) === '_' || blockStartChar(src) === '*') {
        if (block.hr.test(src)) {
          break;
        }
      }
      const itemStart = taken();
      src = src.substring(cap[0].length);
      const firstLine = firstLineOf(cap[2]);
      const bulletIndent = cap[1].length;
      let line = firstLine;
      {
        let leadEnd = 0;
        while (leadEnd < firstLine.length && (firstLine[leadEnd] === ' ' || firstLine[leadEnd] === '\t')) leadEnd++;
        if (leadEnd > 0 && firstLine.slice(0, leadEnd).includes('\t')) {
          line = expandTabs(firstLine.slice(0, leadEnd), bulletIndent) + firstLine.slice(leadEnd);
        }
      }
      let nextLine = firstLineOf(src);
      let blankLine = !line.trim();
      let indent = 0;
      if (blankLine) {
        indent = bulletIndent + 1;
      } else {
        indent = 0;
        while (indent < line.length && line[indent] === ' ') indent++;
        indent = indent > 4 ? 1 : indent;
        itemContents = line.slice(indent);
        indent += bulletIndent;
      }
      if (blankLine && isBlankLine(nextLine)) {
        src = src.substring(nextLine.length + 1);
        endEarly = true;
      }
      if (!endEarly) {
        const nextBulletRegex = other.nextBulletRegex(indent);
        const hrRegex = other.hrRegex(indent);
        const fencesBeginRegex = other.fencesBeginRegex(indent);
        const headingBeginRegex = other.headingBeginRegex(indent);
        const htmlBeginRegex = other.htmlBeginRegex(indent);
        const blockquoteBeginRegex = other.blockquoteBeginRegex(indent);
        while (src) {
          const nlIdx = src.indexOf('\n');
          const rawLine = nlIdx === -1 ? src : src.slice(0, nlIdx);
          nextLine = rawLine;
          let nextLineWithoutTabs = nextLine;
          let firstNonSpace;
          {
            let leadEnd = 0;
            let hasTab = false;
            while (leadEnd < nextLine.length) {
              const ch = nextLine[leadEnd];
              if (ch === ' ') leadEnd++;
              else if (ch === '\t') { hasTab = true; leadEnd++; }
              else break;
            }
            if (leadEnd === nextLine.length) {
              firstNonSpace = -1;
            } else if (hasTab) {
              const expandedLead = expandTabs(nextLine.slice(0, leadEnd));
              nextLineWithoutTabs = expandedLead + nextLine.slice(leadEnd);
              firstNonSpace = expandedLead.length;
            } else {
              firstNonSpace = leadEnd;
            }
          }
          if (listBreakTest(nextLine, indent, fencesBeginRegex, headingBeginRegex, htmlBeginRegex, blockquoteBeginRegex, nextBulletRegex, hrRegex)) {
            break;
          }
          if (firstNonSpace >= indent || !nextLine.trim()) {
            itemContents += '\n' + nextLineWithoutTabs.slice(indent);
          } else {
            if (blankLine) {
              break;
            }
            if (expandedFirstNonSpace(line) >= 4) {
              break;
            }
            if (listBreakTest(line, indent, fencesBeginRegex, headingBeginRegex, htmlBeginRegex, null, null, hrRegex)) {
              break;
            }
            const setextContinuation = /^ {0,3}(?:=+|-+) *$/.test(nextLine)
              && block.lheading.test(`${line}\n${nextLine}`);
            const continuation = setextContinuation
              ? `    ${nextLineWithoutTabs.replace(/^ {0,3}/, '')}`
              : nextLine;
            itemContents += '\n' + continuation;
          }
          blankLine = !nextLine.trim();
          src = src.substring(rawLine.length + 1);
          line = nextLineWithoutTabs.slice(indent);
        }
      }
      const raw = listSrc.slice(itemStart, taken());
      if (!list.loose) {
        if (endsWithBlankLine) {
          list.loose = true;
        } else if (rawEndsWithBlankLine(raw)) {
          endsWithBlankLine = true;
        }
      }
      list.items.push({
        type: 'list_item',
        raw,
        task: other.listIsTask.test(itemContents),
        loose: false,
        text: itemContents,
        tokens: [],
      });
    }
    const lastItem = list.items.at(-1);
    if (lastItem) {
      lastItem.raw = lastItem.raw.trimEnd();
      lastItem.text = lastItem.text.trimEnd();
    } else {
      return;
    }
    list.raw = listSrc.slice(0, taken()).trimEnd();
    for (const item of list.items) {
      ctx.state.top = false;
      item.tokens = blockTokens(ctx, item.text, []);
      if (!list.loose) {
        const spacers = item.tokens.filter((t) => t.type === 'space');
        const hasMultipleLineBreaks = spacers.length > 0 && spacers.some((t) => other.anyLine.test(t.raw));
        list.loose = hasMultipleLineBreaks;
      }
    }
    for (const item of list.items) {
      const itemToken = item.tokens[0];
      if (item.task && (itemToken?.type === 'text' || itemToken?.type === 'paragraph')) {
        item.text = item.text.replace(other.listReplaceTask, '');
        itemToken.raw = itemToken.raw.replace(other.listReplaceTask, '');
        itemToken.text = itemToken.text.replace(other.listReplaceTask, '');
        for (let i = ctx.inlineQueue.length - 1; i >= 0; i--) {
          if (other.listIsTask.test(ctx.inlineQueue[i].src)) {
            ctx.inlineQueue[i].src = ctx.inlineQueue[i].src.replace(other.listReplaceTask, '');
            break;
          }
        }
        const taskRaw = other.listTaskCheckbox.exec(item.raw);
        if (taskRaw) {
          const checkboxToken = {
            type: 'checkbox',
            raw: taskRaw[0] + ' ',
            checked: taskRaw[0] !== '[ ]',
          };
          item.checked = checkboxToken.checked;
          if (list.loose) {
            if (item.tokens[0] && ['paragraph', 'text'].includes(item.tokens[0].type) && 'tokens' in item.tokens[0] && item.tokens[0].tokens) {
              item.tokens[0].raw = checkboxToken.raw + item.tokens[0].raw;
              item.tokens[0].text = checkboxToken.raw + item.tokens[0].text;
              item.tokens[0].tokens.unshift(checkboxToken);
            } else {
              item.tokens.unshift({
                type: 'paragraph',
                raw: checkboxToken.raw,
                text: checkboxToken.raw,
                tokens: [checkboxToken],
              });
            }
          } else {
            item.tokens.unshift(checkboxToken);
          }
        }
      } else if (item.task) {
        item.task = false;
      }
    }
    if (list.loose) {
      for (const item of list.items) {
        item.loose = true;
        for (const token of item.tokens) {
          if (token.type === 'text') {
            token.type = 'paragraph';
          }
        }
      }
    }
    return list;
  }
}

function tokHtml(ctx, src) {
  const cap = block.html.exec(src);
  if (cap) {
    const raw = trimTrailingBlankLines(cap[0]);
    return {
      type: 'html',
      block: true,
      raw,
      pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style',
      text: raw,
    };
  }
}

function tokDef(ctx, src) {
  const cap = block.def.exec(src);
  if (cap) {
    if (!other.startAngleBracket.test(cap[2]) && findClosingBracket(cap[2], '()') !== -1) {
      return;
    }
    const tag = normalizeLabel(cap[1]);
    const href = cap[2] ? cap[2].replace(other.hrefBrackets, '$1').replace(inline.anyPunctuation, '$1') : '';
    const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(inline.anyPunctuation, '$1') : cap[3];
    return { type: 'def', tag, raw: rtrim(cap[0], '\n'), href, title };
  }
}

function tokTable(ctx, src) {
  const cap = block.table.exec(src);
  if (!cap) {
    return;
  }
  if (!other.tableDelimiter.test(cap[2])) {
    return;
  }
  const headers = splitCells(cap[1]);
  const aligns = cap[2].replace(other.tableAlignChars, '').split('|');
  const rows = cap[3]?.trim() ? cap[3].replace(other.tableRowBlankLine, '').split('\n') : [];
  const item = { type: 'table', raw: rtrim(cap[0], '\n'), header: [], align: [], rows: [] };
  if (headers.length !== aligns.length) {
    return;
  }
  for (const align of aligns) {
    if (other.tableAlignRight.test(align)) {
      item.align.push('right');
    } else if (other.tableAlignCenter.test(align)) {
      item.align.push('center');
    } else if (other.tableAlignLeft.test(align)) {
      item.align.push('left');
    } else {
      item.align.push(null);
    }
  }
  for (let i = 0; i < headers.length; i++) {
    item.header.push({
      text: headers[i],
      tokens: queueInline(ctx, headers[i]),
      header: true,
      align: item.align[i],
    });
  }
  for (const row of rows) {
    item.rows.push(splitCells(row, item.header.length).map((cell, i) => ({
      text: cell,
      tokens: queueInline(ctx, cell),
      header: false,
      align: item.align[i],
    })));
  }
  return item;
}

function tokLheading(ctx, src) {
  const cap = block.lheading.exec(src);
  if (cap) {
    const text = cap[1].trim();
    return {
      type: 'heading',
      raw: rtrim(cap[0], '\n'),
      depth: cap[2].charAt(0) === '=' ? 1 : 2,
      text,
      tokens: queueInline(ctx, text),
    };
  }
}

function tokParagraph(ctx, src) {
  const cap = block.paragraph.exec(src);
  if (cap) {
    const text = cap[1].charAt(cap[1].length - 1) === '\n'
      ? cap[1].slice(0, -1)
      : cap[1];
    return { type: 'paragraph', raw: cap[0], text, tokens: queueInline(ctx, text) };
  }
}

function tokText(ctx, src) {
  const cap = block.text.exec(src);
  if (cap) {
    return { type: 'text', raw: cap[0], text: cap[0], tokens: queueInline(ctx, cap[0]) };
  }
}

// ---------- inline tokenizers ----------
function outputLink(cap, link, raw, ctx) {
  const href = link.href;
  const title = link.title || null;
  const text = cap[1].replace(other.outputLinkReplace, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const outerInLink = ctx.state.inLink;
  const outerLinkEmitted = ctx.state.linkEmitted;
  const outerInRawBlock = ctx.state.inRawBlock;
  ctx.state.inLink = true;
  ctx.state.linkEmitted = false;
  const tokens = inlineTokens(ctx, text);
  const textHasLink = ctx.state.linkEmitted;
  ctx.state.linkEmitted = outerLinkEmitted;
  ctx.state.inLink = outerInLink;
  if (!isImage) {
    if (textHasLink) {
      ctx.state.inRawBlock = outerInRawBlock;
      return;
    }
    ctx.state.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title, text, tokens };
}

function isLabelEndInsideToken(src, label, labelStart) {
  if (!label.includes('<')) {
    return false;
  }
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') {
      i++;
      continue;
    }
    if (label[i] === '`') {
      const code = inline.code.exec(label.slice(i));
      if (code) {
        i += code[0].length - 1;
        continue;
      }
    }
    if (label[i] !== '<') {
      continue;
    }
    const tokenSrc = src.slice(labelStart + i);
    const token = inline.tag.exec(tokenSrc) || inline.autolink.exec(tokenSrc);
    if (!token) {
      continue;
    }
    if (token[0].length > label.length - i) {
      return true;
    }
    i += token[0].length - 1;
  }
  return false;
}

function tokEscape(ctx, src) {
  const cap = inline.escape.exec(src);
  if (cap) {
    return { type: 'escape', raw: cap[0], text: cap[1] };
  }
}

function tokTag(ctx, src) {
  const cap = inline.tag.exec(src);
  if (cap) {
    if (!ctx.state.inLink && other.startATag.test(cap[0])) {
      ctx.state.inLink = true;
    } else if (ctx.state.inLink && other.endATag.test(cap[0])) {
      ctx.state.inLink = false;
    }
    if (!ctx.state.inRawBlock && other.startPreScriptTag.test(cap[0])) {
      ctx.state.inRawBlock = true;
    } else if (ctx.state.inRawBlock && other.endPreScriptTag.test(cap[0])) {
      ctx.state.inRawBlock = false;
    }
    return {
      type: 'html',
      raw: cap[0],
      inLink: ctx.state.inLink,
      inRawBlock: ctx.state.inRawBlock,
      block: false,
      text: cap[0],
    };
  }
}

function tokLink(ctx, src) {
  if (ctx.state.linkParenPossible === false) {
    return undefined;
  }
  const cap = inline.link.exec(src);
  if (cap) {
    const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
    if (isLabelEndInsideToken(src, cap[1], labelStart)) {
      return;
    }
    const trimmedUrl = cap[2].trim();
    if (other.startAngleBracket.test(trimmedUrl)) {
      if (!(other.endAngleBracket.test(trimmedUrl))) {
        return;
      }
      const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
      if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) {
        return;
      }
    } else {
      const lastParenIndex = findClosingBracket(cap[2], '()');
      if (lastParenIndex === -2) {
        return;
      }
      if (lastParenIndex > -1) {
        const start = cap[0].indexOf('!') === 0 ? 5 : 4;
        const linkLen = start + cap[1].length + lastParenIndex;
        cap[2] = cap[2].substring(0, lastParenIndex);
        cap[0] = cap[0].substring(0, linkLen).trim();
        cap[3] = '';
      }
    }
    const unescaped = rtrim(cap[0].slice(0, -1), '\\');
    if ((cap[0].length - unescaped.length) % 2 === 0) {
      return;
    }
    let href = cap[2];
    let title = cap[3] ? cap[3].slice(1, -1) : '';
    href = href.trim();
    if (other.startAngleBracket.test(href)) {
      href = href.slice(1, -1);
    }
    return outputLink(cap, {
      href: href ? href.replace(inline.anyPunctuation, '$1') : href,
      title: title ? title.replace(inline.anyPunctuation, '$1') : title,
    }, cap[0], ctx);
  }
}

function tokReflink(ctx, src) {
  let cap;
  if ((cap = inline.reflink.exec(src)) || (cap = inline.nolink.exec(src))) {
    const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
    if (isLabelEndInsideToken(src, cap[1], labelStart)) {
      return;
    }
    const link = ctx.links[normalizeLabel(cap[2] || cap[1])];
    if (!link) {
      const text = cap[0].charAt(0);
      return { type: 'text', raw: text, text };
    }
    return outputLink(cap, link, cap[0], ctx);
  }
}

function tokEmStrong(ctx, src, maskedSrc, prevChar = '') {
  let match = inline.emStrongLDelim.exec(src);
  if (!match) return;
  if (!match[1] && !match[2] && !match[3] && !match[4]) return;
  const delimChar = match[0][0];
  const midRun = prevChar === delimChar;
  const srcStart = maskedSrc.length - src.length;
  let runStart = srcStart;
  while (runStart > 0 && maskedSrc[runStart - 1] === delimChar) {
    runStart--;
  }
  const runPrevChar = [...maskedSrc.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!inline.punctuation.exec(runPrevChar);
  if (runStart < srcStart) {
    prevChar = runPrevChar;
  }
  const prevPunct = runStart < srcStart ? runPrevPunct : !!inline.punctuation.exec(prevChar);
  if (match[4] && prevChar.match(other.unicodeAlphaNumeric)) return;
  const nextChar = match[1] || match[3] || '';
  if (!nextChar || !prevChar || prevPunct) {
    const lLength = [...match[0]].length - 1;
    let rDelim, rLength, delimTotal = lLength, midDelimTotal = 0;
    const runLength = srcStart - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim()
      && (!!nextChar || (delimChar === '*' && !runPrevPunct));
    if (delimChar !== '*' && delimChar !== '_') return;
    const endReg = delimChar === '*' ? inline.emStrongRDelimAst : inline.emStrongRDelimUnd;
    const lastPossibleEmStrongCloserIndex = cachedLastPossibleEmStrongCloserIndex(ctx, maskedSrc, delimChar);
    const emStrongCloserWindowStart = maskedSrc.length - src.length + lLength;
    if (lastPossibleEmStrongCloserIndex < emStrongCloserWindowStart) return;
    maskedSrc = maskedSrc.slice(-1 * src.length + lLength);
    const lastPossibleEmStrongCloserIndexInWindow = lastPossibleEmStrongCloserIndex - emStrongCloserWindowStart;
    endReg.lastIndex = 0;
    while ((match = endReg.exec(maskedSrc)) !== null) {
      if (match.index > lastPossibleEmStrongCloserIndexInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = [...rDelim].length;
      if (match[3] || match[4]) {
        delimTotal += rLength;
        continue;
      } else if (match[5] || match[6] || openerCanClose) {
        if (midRun && (match[5] || match[6])) {
          break;
        }
        if (runLength % 3 && !((runLength + rLength) % 3)) {
          midDelimTotal += rLength;
          continue;
        }
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);
      if (Math.min(lLength, rLength) % 2) {
        const text = raw.slice(1, -1);
        return { type: 'em', raw, text, tokens: inlineTokens(ctx, text) };
      }
      const text = raw.slice(2, -2);
      return { type: 'strong', raw, text, tokens: inlineTokens(ctx, text) };
    }
  }
}

function tokCodespan(ctx, src) {
  const cap = inline.code.exec(src);
  if (cap) {
    let text = cap[2].replace(other.newLineCharGlobal, ' ');
    const hasNonSpaceChars = other.nonSpaceChar.test(text);
    const hasSpaceCharsOnBothEnds = other.startingSpaceChar.test(text) && other.endingSpaceChar.test(text);
    if (hasNonSpaceChars && hasSpaceCharsOnBothEnds) {
      text = text.substring(1, text.length - 1);
    }
    return { type: 'codespan', raw: cap[0], text };
  }
}

function tokBr(ctx, src) {
  const cap = inline.br.exec(src);
  if (cap) {
    return { type: 'br', raw: cap[0] };
  }
}

function tokDel(ctx, src, maskedSrc, prevChar = '') {
  let match = inline.delLDelim.exec(src);
  if (!match) return;
  const nextChar = match[1] || '';
  if (!nextChar || !prevChar || inline.punctuation.exec(prevChar)) {
    const lLength = [...match[0]].length - 1;
    let rDelim, rLength, delimTotal = lLength;
    const endReg = inline.delRDelim;
    const lastPossibleDelCloserIndex = cachedLastPossibleDelCloserIndex(ctx, maskedSrc);
    const delCloserWindowStart = maskedSrc.length - src.length + lLength;
    if (lastPossibleDelCloserIndex < delCloserWindowStart) return;
    maskedSrc = maskedSrc.slice(-1 * src.length + lLength);
    const lastPossibleDelCloserIndexInWindow = lastPossibleDelCloserIndex - delCloserWindowStart;
    endReg.lastIndex = 0;
    while ((match = endReg.exec(maskedSrc)) !== null) {
      if (match.index > lastPossibleDelCloserIndexInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = [...rDelim].length;
      if (rLength !== lLength) continue;
      if (match[3] || match[4]) {
        delimTotal += rLength;
        continue;
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);
      const text = raw.slice(lLength, -lLength);
      return { type: 'del', raw, text, tokens: inlineTokens(ctx, text) };
    }
  }
}

function tokAutolink(ctx, src) {
  const cap = inline.autolink.exec(src);
  if (cap) {
    let text, href;
    if (cap[2] === '@') {
      text = cap[1];
      href = 'mailto:' + text;
    } else {
      text = cap[1];
      href = text;
    }
    return {
      type: 'link',
      raw: cap[0],
      text,
      href,
      autolink: true,
      tokens: [{ type: 'text', raw: text, text }],
    };
  }
}

function tokUrl(ctx, src) {
  let cap;
  if (cap = inline.url.exec(src)) {
    let text, href;
    if (cap[2] === '@') {
      text = cap[0];
      href = 'mailto:' + text;
    } else {
      let prevCapZero;
      do {
        prevCapZero = cap[0];
        cap[0] = inline._backpedal.exec(cap[0])?.[0] ?? '';
      } while (prevCapZero !== cap[0]);
      text = cap[0];
      if (cap[1] === 'www.') {
        href = 'http://' + cap[0];
      } else {
        href = cap[0];
      }
    }
    return {
      type: 'link',
      raw: cap[0],
      text,
      href,
      autolink: true,
      tokens: [{ type: 'text', raw: text, text }],
    };
  }
}

// Next stop for an inline text run: a special character, or two or more
// spaces followed by a newline (a hard break).
const textStopRe = /[\\<!\[`*~_]| {2,}\n/g;
// An email run (email characters followed by '@').
const textEmailRe = /[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+@/g;
// A protocol autolink start.
const textProtoRe = /(?:https?|ftp):\/\//gi;

function isAlnumCode(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

// Length of the inline text match at the start of `src`, replicating the
// GFM text regex: the run ends at the earliest of a special character, a
// hard break (two or more spaces before a newline), an email run, a
// protocol autolink, a www autolink, or the end of the string. A mailto:/
// xmpp: run only stops the text when a non-alphanumeric precedes it.
function scanInlineText(src) {
  const n = src.length;
  if (n === 0) return 0;
  const c0 = src.charCodeAt(0);
  // Alternative A: one non-alphanumeric before mailto:/xmpp:
  if (!isAlnumCode(c0) && (src.startsWith('mailto:', 1) || src.startsWith('xmpp:', 1))) {
    return 1;
  }
  // First unit: a run of backticks or tildes, or a single other character.
  let i;
  if (c0 === 96 || c0 === 126) {
    i = 0;
    while (i < n && src.charCodeAt(i) === c0) i++;
  } else {
    i = 1;
  }
  let end = n;
  // (1) next special character or hard break
  textStopRe.lastIndex = i;
  const m = textStopRe.exec(src);
  if (m) end = m.index;
  // (2) next email run
  if (src.indexOf('@', i) !== -1) {
    textEmailRe.lastIndex = i;
    const em = textEmailRe.exec(src);
    if (em && em.index < end) end = em.index;
  }
  // (3) next protocol autolink
  if (src.indexOf('://', i) !== -1) {
    textProtoRe.lastIndex = i;
    const pm = textProtoRe.exec(src);
    if (pm && pm.index < end) end = pm.index;
  }
  // (4) next www. autolink (only at a line start, after whitespace, or
  // after *, _, ~ or ()
  let w = src.indexOf('www.', i);
  while (w !== -1 && w < end) {
    if (w === 0) { end = w; break; }
    const prev = src[w - 1];
    if (prev === '*' || prev === '_' || prev === '~' || prev === '(' || /\s/.test(prev)) {
      end = w;
      break;
    }
    w = src.indexOf('www.', w + 1);
  }
  // (5) next mailto:/xmpp: preceded by a non-alphanumeric
  for (const proto of ['mailto:', 'xmpp:']) {
    let q = src.indexOf(proto, i + 1);
    while (q !== -1 && q < end) {
      if (!isAlnumCode(src.charCodeAt(q - 1))) { end = q; break; }
      q = src.indexOf(proto, q + 1);
    }
  }
  return end;
}

function tokInlineText(ctx, src) {
  const len = scanInlineText(src);
  if (len > 0) {
    const raw = src.slice(0, len);
    const escaped = ctx.state.inRawBlock;
    return {
      type: 'text',
      raw,
      text: escaped ? raw : decodeNumericCharacterReferences(raw),
      escaped,
    };
  }
}

// ---------- lexer ----------
// First character after up to three leading spaces; '' when the line is
// indented by four or more spaces (so no block construct can start here).
function blockStartChar(src) {
  let i = 0;
  while (i < 3 && src.charCodeAt(i) === 32) i++;
  if (src.charCodeAt(i) === 32) return '';
  return src[i] || '';
}

// Can the GFM table regex match at src? Cheap pre-check: the header line
// must hold a non-space character and the next line must look like a
// delimiter row (only | : - and spaces, holding a -). A "no" is exact.
function tableMaybe(src) {
  const nl = src.indexOf('\n');
  if (nl === -1) return false;
  let headerOk = false;
  for (let i = 0; i < nl; i++) {
    if (src[i] !== ' ') { headerOk = true; break; }
  }
  if (!headerOk) return false;
  let j = nl + 1;
  let spaces = 0;
  while (spaces < 3 && src[j] === ' ') { j++; spaces++; }
  let hasDash = false;
  let k = j;
  while (k < src.length && src[k] !== '\n') {
    const c = src[k];
    if (c === '-') hasDash = true;
    else if (c !== '|' && c !== ':' && c !== ' ') return false;
    k++;
  }
  return hasDash;
}

// Can the setext-heading regex match at src? Cheap pre-check: a line after
// the first that is an underline (up to 3 spaces, a run of = or -, then
// spaces/tabs) before the first blank line. A "no" is exact.
function lheadingMaybe(src) {
  let i = src.indexOf('\n');
  if (i === -1) return false;
  i++;
  while (i < src.length) {
    const nl = src.indexOf('\n', i);
    const lineEnd = nl === -1 ? src.length : nl;
    let j = i;
    while (j < lineEnd && (src[j] === ' ' || src[j] === '\t')) j++;
    if (j === lineEnd) return false;
    let k = i;
    let spaces = 0;
    while (spaces < 3 && src[k] === ' ') { k++; spaces++; }
    if (k < lineEnd && (src[k] === '=' || src[k] === '-')) {
      const c = src[k];
      let m = k;
      while (m < lineEnd && src[m] === c) m++;
      let ok = true;
      while (m < lineEnd) {
        if (src[m] !== ' ' && src[m] !== '\t') { ok = false; break; }
        m++;
      }
      if (ok) return true;
    }
    if (nl === -1) break;
    i = nl + 1;
  }
  return false;
}

function blockTokens(ctx, src, tokens = [], lastParagraphClipped = false) {
  let srcLength = Infinity;
  while (src) {
    if (src.length < srcLength) {
      srcLength = src.length;
    } else {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    let token;
    const c0 = src[0];
    const bs = blockStartChar(src);
    // newline
    if ((c0 === ' ' || c0 === '\t' || c0 === '\n') && (token = tokSpace(ctx, src))) {
      src = src.substring(token.raw.length);
      const lastToken = tokens.at(-1);
      if (token.raw.length === 1 && lastToken !== undefined) {
        lastToken.raw += '\n';
      } else {
        tokens.push(token);
      }
      continue;
    }
    // code
    if ((c0 === ' ' || c0 === '\t') && (token = tokCode(ctx, src))) {
      src = src.substring(token.raw.length);
      const lastToken = tokens.at(-1);
      if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
        ctx.inlineQueue.at(-1).src = lastToken.text;
      } else {
        tokens.push(token);
      }
      continue;
    }
    // fences
    if ((bs === '`' || bs === '~') && (token = tokFences(ctx, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // heading
    if (bs === '#' && (token = tokHeading(ctx, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // hr
    if ((bs === '-' || bs === '_' || bs === '*') && (token = tokHr(ctx, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // blockquote
    if (bs === '>' && (token = tokBlockquote(ctx, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // list
    if ((bs === '*' || bs === '+' || bs === '-' || (bs >= '0' && bs <= '9')) && (token = tokList(ctx, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // html
    if (bs === '<' && (token = tokHtml(ctx, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // def
    if (bs === '[' && (token = tokDef(ctx, src))) {
      src = src.substring(token.raw.length);
      const lastToken = tokens.at(-1);
      if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.raw;
        ctx.inlineQueue.at(-1).src = lastToken.text;
      } else {
        if (!ctx.links[token.tag]) {
          ctx.links[token.tag] = { href: token.href, title: token.title };
          ctx.hasLinks = true;
        }
        tokens.push(token);
      }
      continue;
    }
    // table (gfm)
    if (tableMaybe(src) && (token = tokTable(ctx, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // lheading
    if (lheadingMaybe(src) && (token = tokLheading(ctx, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // top-level paragraph
    if (ctx.state.top && (token = tokParagraph(ctx, src))) {
      const lastToken = tokens.at(-1);
      if (lastParagraphClipped && lastToken?.type === 'paragraph') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
        ctx.inlineQueue.pop();
        ctx.inlineQueue.at(-1).src = lastToken.text;
      } else {
        tokens.push(token);
      }
      lastParagraphClipped = false;
      src = src.substring(token.raw.length);
      continue;
    }
    // text
    if (token = tokText(ctx, src)) {
      src = src.substring(token.raw.length);
      const lastToken = tokens.at(-1);
      if (lastToken?.type === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
        ctx.inlineQueue.pop();
        ctx.inlineQueue.at(-1).src = lastToken.text;
      } else {
        tokens.push(token);
      }
      continue;
    }
    if (src) {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
  }
  ctx.state.top = true;
  return tokens;
}

// Queue an inline run for later lexing (after link definitions are known).
function queueInline(ctx, src, tokens = []) {
  ctx.inlineQueue.push({ src, tokens });
  return tokens;
}

function linkInText(ctx, text) {
  if (!text.includes('[')) {
    return false;
  }
  const linkRule = inline.link;
  for (const match of text.matchAll(inline.blockSkip)) {
    if (linkRule.test(match[0]) && text.charAt(match.index - 1) !== '!') {
      return true;
    }
  }
  for (const match of text.matchAll(inline.reflinkSearch)) {
    const match0 = match[0];
    const refStart = match0.lastIndexOf('[');
    if (match0.charAt(0) === '!' || !Object.hasOwn(ctx.links, normalizeLabel(match0.slice(refStart + 1, -1)))) {
      continue;
    }
    if (refStart > 1 && linkInText(ctx, match0.slice(1, refStart - 1))) {
      continue;
    }
    return true;
  }
  return false;
}

function maskSrc(ctx, src) {
  let maskedSrc = src;
  // A reflink only masks when its label is a known definition; with no
  // definitions at all the pass changes nothing.
  if (src.includes('[') && ctx.hasLinks) {
    const reflinkSearch = inline.reflinkSearch;
    const maskReflink = (match0) => {
      const refStart = match0.lastIndexOf('[');
      if (!Object.hasOwn(ctx.links, normalizeLabel(match0.slice(refStart + 1, -1)))) {
        return match0;
      }
      if (refStart > 1 && match0.charAt(0) !== '!') {
        const text = match0.slice(1, refStart - 1);
        if (linkInText(ctx, text)) {
          return '[' + text.replace(reflinkSearch, maskReflink) + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match0.length - 2) + ']';
    };
    maskedSrc = maskedSrc.replace(reflinkSearch, maskReflink);
  }
  // Escaped punctuation and code spans only exist when a backslash or a
  // backtick is present; otherwise this pass cannot match.
  if (src.includes('\\') || src.includes('`')) {
    maskedSrc = maskedSrc.replace(inline.anyPunctuationOutsideCode, (match0, code, punct) => {
      if (punct) {
        return '+'.repeat(match0.length);
      }
      if (code) {
        return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
      }
      return match0;
    });
  }
  // Links, code spans and HTML only exist when '[', '`' or '<' is present.
  if (src.includes('[') || src.includes('`') || src.includes('<')) {
    maskedSrc = maskedSrc.replace(inline.blockSkip, (match0, _link, context) => {
      const offset = context ? context.length : 0;
      return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
    });
  }
  return maskedSrc;
}

function isUrlStart(c) {
  if (!c) return false;
  const code = c.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
    || c === '.' || c === '_' || c === '+' || c === '-';
}

function inlineTokens(ctx, src, tokens = []) {
  const prevLinkParenPossible = ctx.state.linkParenPossible;
  ctx.state.linkParenPossible = prevLinkParenPossible && src.includes(')');
  try {
    return inlineTokensInner(ctx, src, tokens);
  } finally {
    ctx.state.linkParenPossible = prevLinkParenPossible;
  }
}

function inlineTokensInner(ctx, src, tokens) {
  const hasDelim = src.includes('*') || src.includes('_') || src.includes('~');
  // Masking only changes the string when a link, code span, HTML tag or
  // escape is present; otherwise the masked source is the source itself.
  // (An inline link is masked by blockSkip whether or not any link
  // definition exists, so '[' alone is enough to need the pass.)
  const needsMask = hasDelim
    && (src.includes('[') || src.includes('`') || src.includes('<') || src.includes('\\'));
  const maskedSrc = needsMask ? maskSrc(ctx, src) : src;
  // Without a delimiter, emStrong and del never run, so no closer hint is
  // ever read for this pass; skip the scan (a nested pass pushes its own).
  if (hasDelim) beginEmStrongDelCloserScan(ctx, maskedSrc);
  try {
    return tokenizeInlines(ctx, src, maskedSrc, tokens);
  } finally {
    if (hasDelim) endEmStrongDelCloserScan(ctx);
  }
}

function tokenizeInlines(ctx, src, maskedSrc, tokens) {
  let keepPrevChar = false;
  let prevChar = '';
  let srcLength = Infinity;
  while (src) {
    if (src.length < srcLength) {
      srcLength = src.length;
    } else {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    if (!keepPrevChar) {
      prevChar = '';
    }
    keepPrevChar = false;
    let token;
    const c0 = src[0];
    // escape
    if (c0 === '\\' && (token = tokEscape(ctx, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // tag
    if (c0 === '<' && (token = tokTag(ctx, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // link
    if ((c0 === '[' || c0 === '!') && (token = tokLink(ctx, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // reflink, nolink
    if ((c0 === '[' || c0 === '!') && (token = tokReflink(ctx, src))) {
      src = src.substring(token.raw.length);
      const lastToken = tokens.at(-1);
      if (token.type === 'text' && lastToken?.type === 'text') {
        lastToken.raw += token.raw;
        lastToken.text += token.text;
      } else {
        tokens.push(token);
      }
      continue;
    }
    // em & strong
    if ((c0 === '*' || c0 === '_') && (token = tokEmStrong(ctx, src, maskedSrc, prevChar))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // code
    if (c0 === '`' && (token = tokCodespan(ctx, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // br
    if ((c0 === ' ' || c0 === '\\') && (token = tokBr(ctx, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // del (gfm)
    if (c0 === '~' && (token = tokDel(ctx, src, maskedSrc, prevChar))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // autolink
    if (c0 === '<' && (token = tokAutolink(ctx, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // url (gfm)
    if (!ctx.state.inLink && isUrlStart(c0) && (token = tokUrl(ctx, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // text
    if (token = tokInlineText(ctx, src)) {
      src = src.substring(token.raw.length);
      if (token.raw.slice(-1) !== '_') {
        prevChar = token.raw.slice(-1);
      }
      keepPrevChar = true;
      const lastToken = tokens.at(-1);
      if (lastToken?.type === 'text') {
        lastToken.raw += token.raw;
        lastToken.text += token.text;
      } else {
        tokens.push(token);
      }
      continue;
    }
    if (src) {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
  }
  return tokens;
}

function lex(ctx, src) {
  if (src.indexOf('\r') !== -1) {
    src = src.replace(other.carriageReturn, '\n');
  }
  const tokens = blockTokens(ctx, src, []);
  for (let i = 0; i < ctx.inlineQueue.length; i++) {
    const next = ctx.inlineQueue[i];
    ctx.state.inRawBlock = false;
    inlineTokens(ctx, next.src, next.tokens);
  }
  ctx.inlineQueue = [];
  return tokens;
}

// ---------- rendering (parser + renderer fused) ----------
function renderText(ctx, token) {
  if ('tokens' in token && token.tokens) {
    return renderInline(ctx, token.tokens);
  }
  return ('escaped' in token && token.escaped) ? token.text : escapeHtmlEntities(token.text);
}

function renderCode(token) {
  const langString = (token.lang || '').match(other.notSpaceStart)?.[0];
  const code = token.text ? token.text.replace(other.endingNewline, '') + '\n' : '';
  if (!langString) {
    return '<pre><code>'
      + (token.escaped ? code : escapeHtmlEntities(code, true))
      + '</code></pre>\n';
  }
  return '<pre><code class="language-'
    + escapeHtmlEntities(langString)
    + '">'
    + (token.escaped ? code : escapeHtmlEntities(code, true))
    + '</code></pre>\n';
}

function renderTableCell(ctx, token) {
  const content = renderInline(ctx, token.tokens);
  const type = token.header ? 'th' : 'td';
  const tag = token.align ? `<${type} align="${token.align}">` : `<${type}>`;
  return tag + content + `</${type}>\n`;
}

function renderTable(ctx, token) {
  let header = '';
  let cell = '';
  for (let j = 0; j < token.header.length; j++) {
    cell += renderTableCell(ctx, token.header[j]);
  }
  header += `<tr>\n${cell}</tr>\n`;
  let body = '';
  for (let j = 0; j < token.rows.length; j++) {
    const row = token.rows[j];
    cell = '';
    for (let k = 0; k < row.length; k++) {
      cell += renderTableCell(ctx, row[k]);
    }
    body += `<tr>\n${cell}</tr>\n`;
  }
  if (body) body = `<tbody>${body}</tbody>`;
  return '<table>\n'
    + '<thead>\n'
    + header
    + '</thead>\n'
    + body
    + '</table>\n';
}

function renderList(ctx, token) {
  const ordered = token.ordered;
  const start = token.start;
  let body = '';
  for (let j = 0; j < token.items.length; j++) {
    body += `<li>${renderTokens(ctx, token.items[j].tokens)}</li>\n`;
  }
  const type = ordered ? 'ol' : 'ul';
  const startAttr = (ordered && start !== 1) ? (' start="' + start + '"') : '';
  return '<' + type + startAttr + '>\n' + body + '</' + type + '>\n';
}

function renderLink(ctx, token) {
  const parsedText = token.autolink
    ? escapeHtmlEntities(token.text, true)
    : renderInline(ctx, token.tokens);
  const cleanHref = cleanUrl(token.href);
  if (cleanHref === null) {
    return parsedText;
  }
  const href = escapeHtmlEntities(cleanHref, token.autolink);
  let out = '<a href="' + href + '"';
  if (token.title) {
    out += ' title="' + escapeHtmlEntities(token.title) + '"';
  }
  out += '>' + parsedText + '</a>';
  return out;
}

function renderImage(ctx, token) {
  let text = token.text;
  if (token.tokens) {
    text = renderInlineText(ctx, token.tokens);
  }
  const cleanHref = cleanUrl(token.href);
  if (cleanHref === null) {
    return escapeHtmlEntities(text);
  }
  const href = cleanHref;
  let out = `<img src="${escapeHtmlEntities(href)}" alt="${escapeHtmlEntities(text)}"`;
  if (token.title) {
    out += ` title="${escapeHtmlEntities(token.title)}"`;
  }
  out += '>';
  return out;
}

function renderInline(ctx, tokens) {
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    switch (token.type) {
      case 'escape': {
        out += renderText(ctx, token);
        break;
      }
      case 'html': {
        out += token.text;
        break;
      }
      case 'link': {
        out += renderLink(ctx, token);
        break;
      }
      case 'image': {
        out += renderImage(ctx, token);
        break;
      }
      case 'checkbox': {
        out += '<input '
          + (token.checked ? 'checked="" ' : '')
          + 'disabled="" type="checkbox"> ';
        break;
      }
      case 'strong': {
        out += `<strong>${renderInline(ctx, token.tokens)}</strong>`;
        break;
      }
      case 'em': {
        out += `<em>${renderInline(ctx, token.tokens)}</em>`;
        break;
      }
      case 'codespan': {
        out += `<code>${escapeHtmlEntities(token.text, true)}</code>`;
        break;
      }
      case 'br': {
        out += '<br>';
        break;
      }
      case 'del': {
        out += `<del>${renderInline(ctx, token.tokens)}</del>`;
        break;
      }
      case 'text': {
        out += renderText(ctx, token);
        break;
      }
      default: {
        throw new Error('Token with "' + token.type + '" type was not found.');
      }
    }
  }
  return out;
}

// Plain-text rendering of inline tokens (image alt text).
function renderInlineText(ctx, tokens) {
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    switch (token.type) {
      case 'strong':
      case 'em':
      case 'del':
      case 'link':
      case 'image': {
        out += token.tokens ? renderInlineText(ctx, token.tokens) : token.text;
        break;
      }
      case 'codespan':
      case 'html':
      case 'text':
      case 'escape': {
        out += token.text;
        break;
      }
      case 'br': {
        break;
      }
      case 'checkbox': {
        out += token.raw;
        break;
      }
      default: {
        throw new Error('Token with "' + token.type + '" type was not found.');
      }
    }
  }
  return out;
}

function renderTokens(ctx, tokens) {
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    switch (token.type) {
      case 'space': {
        break;
      }
      case 'hr': {
        out += '<hr>\n';
        break;
      }
      case 'heading': {
        out += `<h${token.depth}>${renderInline(ctx, token.tokens)}</h${token.depth}>\n`;
        break;
      }
      case 'code': {
        out += renderCode(token);
        break;
      }
      case 'table': {
        out += renderTable(ctx, token);
        break;
      }
      case 'blockquote': {
        out += `<blockquote>\n${renderTokens(ctx, token.tokens)}</blockquote>\n`;
        break;
      }
      case 'list': {
        out += renderList(ctx, token);
        break;
      }
      case 'checkbox': {
        out += '<input '
          + (token.checked ? 'checked="" ' : '')
          + 'disabled="" type="checkbox"> ';
        break;
      }
      case 'html': {
        out += token.text;
        break;
      }
      case 'def': {
        break;
      }
      case 'paragraph': {
        out += `<p>${renderInline(ctx, token.tokens)}</p>\n`;
        break;
      }
      case 'text': {
        out += renderText(ctx, token);
        break;
      }
      default: {
        throw new Error('Token with "' + token.type + '" type was not found.');
      }
    }
  }
  return out;
}

// ---------- entry point ----------
/** The HTML marked 18.1.3 renders for `markdown`, with marked's defaults. */
export function parse(markdown) {
  const ctx = {
    links: Object.create(null),
    hasLinks: false,
    inlineQueue: [],
    state: { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true },
    hintStack: [],
  };
  const tokens = lex(ctx, markdown);
  return renderTokens(ctx, tokens);
}
