// Fast CommonMark + GFM renderer, written from scratch to match
// marked 18.1.3 (default options: gfm on, breaks off) byte for byte.
// Single module, no dependencies. Public entry: parse(markdown) -> HTML.
//
// Layout of this file:
//   1. small string helpers (escaping, entities, urls, labels)
//   2. regex patterns for the block grammar and the inline grammar
//   3. BlockLexer: turns the source into block tokens
//   4. InlineLexer: turns block text into inline tokens
//   5. Renderer: turns tokens into the final HTML string
//   6. parse(): normalise, lex, render

// ---------------------------------------------------------------------------
// 1. Small string helpers
// ---------------------------------------------------------------------------

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_TEST = /[&<>"']/;
const ESCAPE_REPLACE = /[&<>"']/g;
// When not encoding, an ampersand that starts a valid entity reference is
// left alone; every other & is still escaped.
const ESCAPE_TEST_LOOSE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESCAPE_REPLACE_LOOSE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const NUMERIC_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUMERIC_REF_OR_BARE_AMP =
  /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const BACKSLASH_PUNCT = /\\([\p{P}\p{S}])/gu;
const MULTI_SPACE = /\s+/g;
const NON_SPACE_START = /^\S*/;
const TRAILING_NEWLINE = /\n$/;

function escapeHtml(str, encodeAll) {
  if (encodeAll) {
    if (ESCAPE_TEST.test(str)) return str.replace(ESCAPE_REPLACE, (ch) => HTML_ESCAPES[ch]);
  } else if (ESCAPE_TEST_LOOSE.test(str)) {
    return str.replace(ESCAPE_REPLACE_LOOSE, (ch) => HTML_ESCAPES[ch]);
  }
  return str;
}

// Decode numeric character references (&#65; &#x41;) and turn a bare & that
// does not start a valid entity into &amp;. Named entities are passed
// through untouched (the loose escaper above keeps them valid).
function decodeRefs(str) {
  if (!NUMERIC_REF.test(str)) return str;
  return str.replace(NUMERIC_REF_OR_BARE_AMP, (whole, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = hex === undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (code === 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) return '\uFFFD';
    if (code === 38) return '&amp;';
    return String.fromCodePoint(code);
  });
}

function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Normalise a link reference label for lookup: trim, collapse inner
// whitespace to one space, case-fold (lower then upper then lower, which
// handles the Unicode case-fold edge cases the spec calls out).
function normalizeLabel(label) {
  return label.trim().replace(MULTI_SPACE, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Find the index of the closing character of a balanced pair, honouring
// backslash escapes. Returns -2 when the opener is left unclosed, -1 when
// there is no closing character at all.
function findPairEnd(str, pair) {
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') { i++; continue; }
    if (str[i] === pair[0]) depth++;
    else if (str[i] === pair[1]) {
      depth--;
      if (depth < 0) return i;
    }
  }
  return depth > 0 ? -2 : -1;
}

// Split one table row on unescaped pipes, trimming cells and dropping the
// optional leading/trailing empty cell. Pads/truncates to `columns`.
function splitTableRow(str, columns) {
  let out = str.replace(/\|/g, (ch, off, full) => {
    let escaped = false;
    for (let p = off - 1; p >= 0 && full[p] === '\\'; p--) escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = out.split(' |');
  let i = 0;
  if (cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  if (columns) {
    if (cells.length > columns) cells.splice(columns);
    else while (cells.length < columns) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

// Strip trailing characters: with `invert` false, strip chars equal to `ch`;
// with it true, strip chars not equal to `ch`.
function stripTrailing(str, ch, invert) {
  const n = str.length;
  let cut = 0;
  for (; cut < n;) {
    const c = str.charAt(n - cut - 1);
    if (c === ch && !invert) cut++;
    else if (c !== ch && invert) cut++;
    else break;
  }
  return str.slice(0, n - cut);
}

// True when the string ends with a blank line: a newline, then only
// spaces/tabs, then another newline, then only spaces/tabs to the end.
// (The same test the /\n[ \t]*\n[ \t]*$/ pattern performs, as a short
// backwards scan instead of a regex.)
function endsWithBlankLine(str) {
  let i = str.length - 1;
  while (i >= 0 && (str[i] === ' ' || str[i] === '\t')) i--;
  if (i < 0 || str[i] !== '\n') return false;
  i--;
  while (i >= 0 && (str[i] === ' ' || str[i] === '\t')) i--;
  return i >= 0 && str[i] === '\n';
}

// Drop trailing blank lines, but keep the text unchanged when there is at
// most one trailing blank line.
function dropTrailingBlanks(str) {
  const lines = str.split('\n');
  let last = lines.length - 1;
  for (; last >= 0 && /^[ \t]*$/.test(lines[last]);) last--;
  if (lines.length - last <= 2) return str;
  return lines.slice(0, last + 1).join('\n');
}

// Expand tabs to spaces, tracking the column starting at `col`.
function expandTabs(str, col = 0) {
  let out = '';
  let c = col;
  for (const ch of str) {
    if (ch === '\t') {
      const w = 4 - (c % 4);
      out += ' '.repeat(w);
      c += w;
    } else {
      out += ch;
      c++;
    }
  }
  return out;
}

// Check whether a link label contains an autolink or tag that runs past the
// end of the label (which would disqualify the link). `full` is the whole
// remaining source, `label` the candidate label text, `start` the index of
// the label inside `full`.
function labelHasRunawayTag(full, label, start, inlineRules) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') { s++; continue; }
    if (label[s] === '`') {
      const m = inlineRules.code.exec(label.slice(s));
      if (m) { s += m[0].length - 1; continue; }
    }
    if (label[s] !== '<') continue;
    const rest = full.slice(start + s);
    const m = inlineRules.tag.exec(rest) || inlineRules.autolink.exec(rest);
    if (m) {
      if (m[0].length > label.length - s) return true;
      s += m[0].length - 1;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// 2. Regex patterns
// ---------------------------------------------------------------------------
// Patterns are built from small named fragments so the grammar stays
// readable. `rx` substitutes fragment names inside a pattern string and
// returns a RegExp; `rxg` is the same with the global flag.

function rx(source, flags, subs) {
  let out = typeof source === 'string' ? source : source.source;
  if (subs) {
    for (const [name, frag] of Object.entries(subs)) {
      // Fragments are spliced into a larger pattern, so a leading ^ in a
      // fragment would only ever match at the start of the whole string.
      // Strip it (but keep ^ inside character classes, where it negates).
      const fragSrc = (typeof frag === 'string' ? frag : frag.source).replace(
        /(^|[^\[])\^/g,
        '$1'
      );
      out = out.split(name).join(fragSrc);
    }
  }
  return new RegExp(out, flags);
}

const BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

const HR_SRC = '(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,}';
const BULLET_SRC = '(?:[*+-]|\\d{1,9}[.)])';
const FENCE_OPEN_SRC = ' {0,3}(?:`{3,}|~{3,})';
const BLOCKQUOTE_SRC = ' {0,3}>';
const HEADING_SRC = ' {0,3}#{1,6}(?:\\s|$)';
const HTML_OPEN_SRC =
  ' {0,3}(?:</?(?:TAG)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';
const INDENTED_CODE_SRC = '(?: {4}| {0,3}\\t)';

// A paragraph line may not be followed by a line that starts one of these
// constructs. Built once per list flavour.
function paragraphPattern(listSrc, tableSrc) {
  const base =
    '^([^\\n]+(?:\\n(?!HR|HEADING|LHEADING|BLOCKQUOTE|FENCES|LIST|HTML|TABLE|[ \\t]+\\n)[^\\n]+)*)';
  const subs = {
    HR: rx('^ {0,3}(' + HR_SRC + ')(?:\\n+|$)', ''),
    HEADING: HEADING_SRC,
    BLOCKQUOTE: BLOCKQUOTE_SRC,
    FENCES: ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)',
    LIST: listSrc,
    HTML: HTML_OPEN_SRC.replace(/TAG/g, BLOCK_TAGS),
  };
  // Removing the lheading/table alternatives must also remove their
  // leading pipe, or the lookahead gains an empty branch that matches
  // everywhere and the paragraph would stop after its first line.
  subs['|LHEADING'] = '';
  if (tableSrc) subs.TABLE = tableSrc;
  else subs['|TABLE'] = '';
  return rx(base, '', subs);
}

// Setext heading: text lines followed by = or - underline.
function setextPattern(tableSrc) {
  const base =
    '^(?!BULLET |INDENT|FENCES|BLOCKQUOTE|HEADING|HTML|TABLE)((?:.|\\n(?!\\s*?\\n|BULLET |FENCES|BLOCKQUOTE|HEADING|HR|HTML|TABLE))+?)\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)';
  return rx(base, '', {
    BULLET: BULLET_SRC,
    INDENT: INDENTED_CODE_SRC,
    FENCES: FENCE_OPEN_SRC,
    BLOCKQUOTE: BLOCKQUOTE_SRC,
    HEADING: HEADING_SRC,
    HTML: ' {0,3}<[^\\n>]+>\\n',
    // Non-capturing: a capturing group here would shift the underline
    // group (group 2) that the setext tokenizer reads.
    HR: ' {0,3}(?:' + HR_SRC + ')(?:\\n+|$)',
    TABLE: tableSrc || '',
  });
}

const TABLE_SRC =
  '^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|HR|HEADING|BLOCKQUOTE|CODE|FENCES|LIST|HTML).*(?:\\n|$))*)\\n*|$)';

function tablePattern() {
  return rx(TABLE_SRC, '', {
    HR: rx('^ {0,3}(' + HR_SRC + ')(?:\\n+|$)', ''),
    HEADING: HEADING_SRC,
    BLOCKQUOTE: BLOCKQUOTE_SRC,
    CODE: INDENTED_CODE_SRC + '[^\\n]',
    FENCES: ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)',
    LIST: ' {0,3}(?:[*+-]|1[.)])[ \\t]',
    HTML: HTML_OPEN_SRC.replace(/TAG/g, BLOCK_TAGS),
  });
}

// Link reference definition: [label]: <href> "title"
const LABEL_INNER = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+';
const DEF_PATTERN = rx(
  '^ {0,3}\\[(LABEL)\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(TITLE))? *(?:\\n+|$)',
  '',
  {
    LABEL: LABEL_INNER,
    TITLE: '(?:"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\\\n]|\\n(?!\\n))*\'|\\((?:\\\\[\\s\\S]|[^()\\\\])*\\))',
  }
);

// HTML block, type 6 start is a block tag on its own line, type 7 is any
// other tag that must be followed by a blank line.
const HTML_BLOCK = rx(
  '^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|COMMENT[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(TAG)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:ATTRIBUTE)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$))',
  'i',
  {
    COMMENT: /<!--(?:-?>|[\s\S]*?(?:-->|$))/,
    TAG: BLOCK_TAGS,
    ATTRIBUTE: / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/,
  }
);

const blockRules = {
  newline: /^(?:[ \t]*(?:\n|$))+/,
  indentedCode: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  fences:
    /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  hr: rx('^ {0,3}(' + HR_SRC + ')(?:\\n+|$)', ''),
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  def: DEF_PATTERN,
  html: HTML_BLOCK,
  table: tablePattern(),
  lheading: setextPattern(
    ' {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n'
  ),
  text: /^[^\n]+/,
  // The blockquote pattern embeds the "inner paragraph" grammar.
  blockquote: null, // filled below (needs the inner paragraph pattern)
  list: /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/,
};

// Inner-paragraph grammar used inside blockquotes: a line starting an
// ordered list must use any number here (unlike the top-level paragraph).
const blockquoteParagraph = paragraphPattern(
  ' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)',
  ''
);
blockRules.blockquote = rx(
  '^(( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(PARA)|[^\\n]*)(?:\\n|$))+)',
  '',
  { PARA: blockquoteParagraph }
);
blockRules.paragraph = paragraphPattern(
  ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]',
  tablePattern().source
);

const otherRules = {
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
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  listItemRegex: (marker) =>
    new RegExp(`^( {0,3}${marker})((?:[ \t][^\\n]*)?(?:\\n|$))`),
  nextBulletRegex: (() => {
    const cache = [];
    return (indent) => {
      const n = Math.max(0, Math.min(3, indent - 1));
      return (
        cache[n] ||
        (cache[n] = new RegExp(
          `^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`
        ))
      );
    };
  })(),
  hrRegex: (() => {
    const cache = [];
    return (indent) => {
      const n = Math.max(0, Math.min(3, indent - 1));
      return (
        cache[n] ||
        (cache[n] = new RegExp(
          `^ {0,${n}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`
        ))
      );
    };
  })(),
  fencesBeginRegex: (() => {
    const cache = [];
    return (indent) => {
      const n = Math.max(0, Math.min(3, indent - 1));
      return cache[n] || (cache[n] = new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`));
    };
  })(),
  headingBeginRegex: (() => {
    const cache = [];
    return (indent) => {
      const n = Math.max(0, Math.min(3, indent - 1));
      return cache[n] || (cache[n] = new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`));
    };
  })(),
  htmlBeginRegex: (() => {
    const cache = [];
    return (indent) => {
      const n = Math.max(0, Math.min(3, indent - 1));
      return (
        cache[n] ||
        (cache[n] = new RegExp(
          `^ {0,${n}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`,
          'i'
        ))
      );
    };
  })(),
  blockquoteBeginRegex: (() => {
    const cache = [];
    return (indent) => {
      const n = Math.max(0, Math.min(3, indent - 1));
      return cache[n] || (cache[n] = new RegExp(`^ {0,${n}}>`));
    };
  })(),
  // One test for "this line starts a new block construct" (the six tests
  // the list continuation used to run one by one). The html alternative
  // needs the case-insensitive flag; the other alternatives hold no
  // letters, so sharing the flag changes nothing for them.
  listBreakRegex: (() => {
    const cache = [];
    return (indent) => {
      const n = Math.max(0, Math.min(3, indent - 1));
      return (
        cache[n] ||
        (cache[n] = new RegExp(
          `^ {0,${n}}(?:\`\`\`|~~~|#{1,6}(?:\\s|$)|>|(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|$)|(?:-[ \\t]*){3,}$|(?:_[ \\t]*){3,}$|(?:\\*[ \\t]*){3,}$|</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`,
          'i'
        ))
      );
    };
  })(),
  // Same, but without the blockquote and bullet alternatives: the test
  // applied to the previous line inside a list item.
  listPrevBreakRegex: (() => {
    const cache = [];
    return (indent) => {
      const n = Math.max(0, Math.min(3, indent - 1));
      return (
        cache[n] ||
        (cache[n] = new RegExp(
          `^ {0,${n}}(?:\`\`\`|~~~|#{1,6}(?:\\s|$)|(?:-[ \\t]*){3,}$|(?:_[ \\t]*){3,}$|(?:\\*[ \\t]*){3,}$|</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`,
          'i'
        ))
      );
    };
  })(),
};

// The emphasis scanner works on a masked copy of the source: links and code
// spans are replaced by runs of "a" (so a * inside them cannot be mistaken
// for a closer), and backslash-escaped punctuation is neutralised. The mask
// is cached per tokenizer so the scan is only redone when the source text
// actually changes.
function scanDelimiters(src) {
  const last = { '*': -1, _: -1 };
  let lastTilde = -1;
  const n = src.length;
  for (let i = 0; i < n; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    while (j < n && src[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') lastTilde = i;
      else last[ch] = i;
    }
    i = j - 1;
  }
  return { maskedSrc: src, lastEm: last, lastDel: lastTilde };
}

const maskCache = new WeakMap();
function rememberMask(tokenizer, masked) {
  const entry = { maskedSrc: masked, ...scanDelimiters(masked) };
  const stack = maskCache.get(tokenizer);
  if (stack) stack.push(entry);
  else maskCache.set(tokenizer, [entry]);
  return entry;
}
function forgetMask(tokenizer) {
  const stack = maskCache.get(tokenizer);
  if (stack) {
    stack.pop();
    if (stack.length === 0) maskCache.delete(tokenizer);
  }
}
function lastEmCloser(tokenizer, src, delim) {
  const stack = maskCache.get(tokenizer);
  const top = stack && stack[stack.length - 1];
  if (top && top.maskedSrc === src) return top.lastEm[delim];
  return scanDelimiters(src).lastEm[delim];
}
function lastDelCloser(tokenizer, src) {
  const stack = maskCache.get(tokenizer);
  const top = stack && stack[stack.length - 1];
  if (top && top.maskedSrc === src) return top.lastDel;
  return scanDelimiters(src).lastDel;
}

// Build the masked source for the emphasis scan: reference links and code
// spans become "[aaa...]" (same length, no delimiters inside), escaped
// punctuation becomes "+" runs, and backticks inside a code span become "+"
// so the code-span matcher in the next step can span them.
function freshReflinkSearch() {
  return new RegExp(inlineRules.reflinkSearch.source, 'g');
}

function maskSource(tokenizer, src) {
  let masked = src;
  // The reference-link pass only changes anything when a link reference
  // is actually defined; the other two passes are no-ops when the source
  // holds none of the characters they look for.
  if (tokenizer.linkCount > 0 && src.includes('[')) {
    const search = freshReflinkSearch();
    masked = masked.replace(search, (whole) => {
      const open = whole.lastIndexOf('[');
      if (!Object.hasOwn(tokenizer.links, normalizeLabel(whole.slice(open + 1, -1)))) return whole;
      if (open > 1 && whole.charAt(0) !== '!') {
        const inner = whole.slice(1, open - 1);
        if (linkInText(tokenizer, inner)) {
          return '[' + inner.replace(freshReflinkSearch(), (w) => {
            const o = w.lastIndexOf('[');
            if (!Object.hasOwn(tokenizer.links, normalizeLabel(w.slice(o + 1, -1)))) return w;
            return '[' + 'a'.repeat(w.length - 2) + ']';
          }) + '][' + 'a'.repeat(whole.length - open - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(whole.length - 2) + ']';
    });
  }
  if (src.includes('\\') || src.includes('`')) {
    masked = masked.replace(
      inlineRules.anyPunctuationOutsideCode,
      (whole, ticks, escaped) =>
        escaped
          ? '+'.repeat(whole.length)
          : ticks
            ? ticks + whole.slice(ticks.length, -ticks.length).replace(/`/g, '+') + ticks
            : whole
    );
  }
  if (src.includes('[') || src.includes('`') || src.includes('<')) {
    masked = masked.replace(inlineRules.blockSkip, (whole) => {
      // With lookbehind support the code-span branch captures an empty group
      // before the backticks, so nothing is kept: the whole construct is
      // hidden from the emphasis scan.
      return '[' + 'a'.repeat(whole.length - 2) + ']';
    });
  }
  return masked;
}

// True when the text contains a link (inline or reference) that is not an
// image. Used by the masking pass to decide how to hide nested brackets.
function linkInText(tokenizer, src) {
  if (!src.includes('[')) return false;
  const linkRe = inlineRules.link;
  for (const m of src.matchAll(inlineRules.blockSkip)) {
    if (linkRe.test(m[0]) && src.charAt(m.index - 1) !== '!') return true;
  }
  const search = freshReflinkSearch();
  for (const m of src.matchAll(search)) {
    const whole = m[0];
    const open = whole.lastIndexOf('[');
    if (
      !(whole.charAt(0) === '!' || !Object.hasOwn(tokenizer.links, normalizeLabel(whole.slice(open + 1, -1)))) &&
      !(open > 1 && linkInText(tokenizer, whole.slice(1, open - 1)))
    ) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// 2b. Inline grammar (GFM flavour: default options)
// ---------------------------------------------------------------------------
// A "word" character is anything that is not whitespace, punctuation or a
// symbol; a tilde counts as a word character for emphasis purposes (so ~
// does not break a word), but not for strikethrough.
const EMAIL_LOCAL = '[A-Za-z0-9._+-]+';
const EMAIL_DOMAIN = '[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])';
const EMAIL_FULL =
  "[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])";
const SCHEME = '[a-zA-Z][a-zA-Z0-9+.-]{1,31}';

// A link label: nested balanced brackets, backslash escapes, complete code
// spans, or plain characters that are not brackets or backticks. A lone
// backtick inside a label can never be consumed here, which is exactly why
// a label with an unpaired backtick fails to form a link at all.
const BRACKETED = '\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]';
const LINK_LABEL =
  '(?:\\[(?:' + BRACKETED + '|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]`])*?';
// The longer label used when searching for reference links in the masking
// pass (it allows unbalanced content, up to 999 nested pieces).
const LONG_LABEL =
  '(?:[^\\[\\]`]*(?:\\[(?:' + BRACKETED + '|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]`]*?';
const REF_LABEL = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999}';
const REF_LABEL_SHORT = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+';
const LINK_HREF = '<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\))';
const LINK_TITLE = '"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\])*\'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)';

const inlineRules = {
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,
  code: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  br: /^( {2,}|\\)\n(?!\s*$)[ \t]*/,
  // Plain text: stops just before a character that can start another token
  // (backslash, <, !, [, backtick, *, _, ~, an autolink scheme, www. or an
  // @ that begins an email address), or before a hard line break.
  text: /^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|(?<![^\s*_~(])www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/,
  tag: /^<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/,
  autolink: new RegExp(
    '^<(' + SCHEME + ':[^\\s\\x00-\\x1f<>]*|' + EMAIL_FULL + ')>'
  ),
  link: new RegExp(
    '^!?\\[(' + LINK_LABEL + ')\\]\\([ \\t\\n]*(' + LINK_HREF + ')(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(' + LINK_TITLE + '))?[ \\t\\n]*\\)'
  ),
  reflink: new RegExp(
    '^!?\\[(' + LINK_LABEL + ')\\]\\[(' + REF_LABEL_SHORT + ')\\]'
  ),
  nolink: new RegExp('^!?\\[(' + REF_LABEL_SHORT + ')\\](?:\\[\\])?'),
  // Finds candidate reference links while masking the source for the
  // emphasis scan. Group 1 = reflink label, 2 = reflink ref, 3 = nolink ref.
  reflinkSearch: new RegExp(
    '!?\\[(' + LONG_LABEL + ')\\]\\[(' + REF_LABEL + ')\\]|!?\\[(' + REF_LABEL + ')\\](?:\\[\\])?(?!\\()',
    'g'
  ),
  url: new RegExp(
    '^(?:mailto:' + EMAIL_LOCAL + '@' + EMAIL_DOMAIN + '|xmpp:' + EMAIL_LOCAL + '@' + EMAIL_DOMAIN + '(?:\\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*|^' + EMAIL_LOCAL + '(@)' + EMAIL_DOMAIN
  ),
  // Trims trailing punctuation off an extended autolink URL.
  backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,
  // Opening delimiter of an emphasis / strong run: the run plus the first
  // character after it (a punctuation character, or any non-space char).
  emStrongLDelim:
    /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u,
  // Scans for the next delimiter run that could close an asterisk run.
  // Alternatives that match plain text have no capture group; the six
  // groups are the closer candidates (see the emphasis tokenizer).
  emStrongRDelimAst: new RegExp(
    '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])' +
    '|(?!\\*)(?!~)[\\p{P}\\p{S}](\\*+)(?=[\\s]|$)' +
    '|(?:[^\\s\\p{P}\\p{S}]|~)(\\*+)(?!\\*)(?=(?!~)[\\s\\p{P}\\p{S}]|$)' +
    '|(?!\\*)(?!~)[\\s\\p{P}\\p{S}](\\*+)(?=(?:[^\\s\\p{P}\\p{S}]|~))' +
    '|[\\s](\\*+)(?!\\*)(?=(?!~)[\\p{P}\\p{S}])' +
    '|(?!\\*)(?!~)[\\p{P}\\p{S}](\\*+)(?!\\*)(?=(?!~)[\\p{P}\\p{S}])' +
    '|(?:[^\\s\\p{P}\\p{S}]|~)(\\*+)(?=(?:[^\\s\\p{P}\\p{S}]|~))',
    'gu'
  ),
  // Same scan for an underscore run. Its last two alternatives collapse:
  // an underscore between two word characters can never close.
  emStrongRDelimUnd: new RegExp(
    '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])' +
    '|(?!_)[\\p{P}\\p{S}](_+)(?=[\\s]|$)' +
    '|[^\\s\\p{P}\\p{S}](_+)(?!_)(?=[\\s\\p{P}\\p{S}]|$)' +
    '|(?!_)[\\s\\p{P}\\p{S}](_+)(?=[^\\s\\p{P}\\p{S}])' +
    '|[\\s](_+)(?!_)(?=[\\p{P}\\p{S}])' +
    '|(?!_)[\\p{P}\\p{S}](_+)(?!_)(?=[\\p{P}\\p{S}])',
    'gu'
  ),
  delLDelim: /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u,
  delRDelim: new RegExp(
    '^[^~]+(?=[^~])' +
    '|(?!~)[\\p{P}\\p{S}](~~?)(?=[\\s]|$)' +
    '|[^\\s\\p{P}\\p{S}](~~?)(?!~)(?=[\\s\\p{P}\\p{S}]|$)' +
    '|(?!~)[\\s\\p{P}\\p{S}](~~?)(?=[^\\s\\p{P}\\p{S}])' +
    '|[\\s](~~?)(?!~)(?=[\\p{P}\\p{S}])' +
    '|(?!~)[\\p{P}\\p{S}](~~?)(?!~)(?=[\\p{P}\\p{S}])' +
    '|[^\\s\\p{P}\\p{S}](~~?)(?=[^\\s\\p{P}\\p{S}])',
    'gu'
  ),
  // One whitespace-or-punctuation character that is not * or _.
  punctuation: /^((?![*_])[\s\p{P}\p{S}])/u,
  // Matches a code span (group 1 = its opening backticks), a lone backtick
  // run, or a backslash-escaped punctuation character (group 2).
  anyPunctuationOutsideCode: /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu,
  // Matches an inline link, a code span (only when not preceded by a
  // backtick), or raw HTML. Used to hide those constructs from the
  // emphasis scan.
  blockSkip: new RegExp(
    '\\[(?:[^\\[\\]`]|(?<a>`+)[^`]+\\k<a>(?!`))*?\\]\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)]|\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)])*\\))*\\)' +
    '|(?<!`)()(?<b>`+)[^`]+\\k<b>(?!`)' +
    '|<(?! )[^<>]*?>',
    'g'
  ),
};

// ---------------------------------------------------------------------------
// 3. Tokenizer (block + inline) and Lexer
// ---------------------------------------------------------------------------

// Compensate for an indented fence: when the fence itself is indented, the
// same amount of indentation is stripped from every content line.
function fenceIndent(raw, content) {
  const m = raw.match(otherRules.indentCodeCompensation);
  if (m === null) return content;
  const indent = m[1];
  return content
    .split('\n')
    .map((line) => {
      const lead = line.match(otherRules.beginningSpace);
      if (lead === null) return line;
      return line.slice(Math.min(lead[0].length, indent.length));
    })
    .join('\n');
}

// Build a link or image token from a matched link. The label is lexed as
// inline content; if a nested link is produced while lexing the label of a
// link (not an image), the outer link is dropped.
function makeLink(match, dest, raw, lexer) {
  const href = dest.href;
  const title = dest.title || null;
  const label = match[1].replace(otherRules.outputLinkReplace, '$1');
  const isImage = match[0].charAt(0) === '!';
  const savedInLink = lexer.state.inLink;
  const savedEmitted = lexer.state.linkEmitted;
  const savedRawBlock = lexer.state.inRawBlock;
  lexer.state.inLink = true;
  lexer.state.linkEmitted = false;
  const labelTokens = lexer.inlineTokens(label);
  const nestedLink = lexer.state.linkEmitted;
  lexer.state.linkEmitted = savedEmitted;
  lexer.state.inLink = savedInLink;
  if (!isImage) {
    if (nestedLink) {
      lexer.state.inRawBlock = savedRawBlock;
      return undefined;
    }
    lexer.state.linkEmitted = true;
  }
  return {
    type: isImage ? 'image' : 'link',
    raw,
    href,
    title,
    text: label,
    tokens: labelTokens,
  };
}

class Tokenizer {
  constructor(lexer) {
    this.lexer = lexer;
    this.links = lexer.tokens.links;
    this.linkCount = 0;
  }

  // ---- block tokens ----

  space(src) {
    const m = blockRules.newline.exec(src);
    if (m && m[0].length > 0) return { type: 'space', raw: m[0] };
    return undefined;
  }

  indentedCode(src) {
    const m = blockRules.indentedCode.exec(src);
    if (!m) return undefined;
    const raw = dropTrailingBlanks(m[0]);
    return {
      type: 'code',
      raw,
      text: raw.replace(otherRules.codeRemoveIndent, ''),
      indented: true,
    };
  }

  fencedCode(src) {
    const m = blockRules.fences.exec(src);
    if (!m) return undefined;
    return {
      type: 'code',
      raw: m[0],
      lang: m[2] ? m[2].trim().replace(BACKSLASH_PUNCT, '$1') : m[2],
      text: fenceIndent(m[0], m[3] || ''),
    };
  }

  heading(src) {
    const m = blockRules.heading.exec(src);
    if (!m) return undefined;
    let text = m[2].trim();
    if (otherRules.endingHash.test(text)) {
      const stripped = stripTrailing(text, '#');
      if (!stripped || otherRules.endingSpaceTabChar.test(stripped)) text = stripped.trim();
    }
    return {
      type: 'heading',
      raw: stripTrailing(m[0], '\n'),
      depth: m[1].length,
      text,
      tokens: this.lexer.inline(text),
    };
  }

  hr(src) {
    const m = blockRules.hr.exec(src);
    if (!m) return undefined;
    return { type: 'hr', raw: stripTrailing(m[0], '\n') };
  }

  blockquote(src) {
    const m = blockRules.blockquote.exec(src);
    if (!m) return undefined;
    let lines = stripTrailing(m[0], '\n').split('\n');
    let raw = '';
    let text = '';
    const tokens = [];
    while (lines.length > 0) {
      let hasMarker = false;
      const chunk = [];
      let p = 0;
      for (; p < lines.length; p++) {
        if (otherRules.blockquoteStart.test(lines[p])) {
          chunk.push(lines[p]);
          hasMarker = true;
        } else if (!hasMarker) chunk.push(lines[p]);
        else break;
      }
      lines = lines.slice(p);
      const chunkRaw = chunk.join('\n');
      const inner = chunkRaw
        .replace(otherRules.blockquoteMarkerWhitespace, (whole, marker, ws) => marker + expandTabs(ws, marker.length))
        .replace(otherRules.blockquoteSetextReplace, '\n    $1')
        .replace(otherRules.blockquoteSetextReplace2, '');
      raw = raw ? raw + '\n' + chunkRaw : chunkRaw;
      text = text ? text + '\n' + inner : inner;
      const savedTop = this.lexer.state.top;
      this.lexer.state.top = true;
      this.lexer.blockTokens(inner, tokens, true);
      this.lexer.state.top = savedTop;
      if (lines.length === 0) break;
      const last = tokens[tokens.length - 1];
      if (
        last &&
        (last.type === 'code' || last.type === 'heading' || last.type === 'hr' || last.type === 'html' || last.type === 'table')
      ) {
        break;
      }
      if (last && last.type === 'blockquote') {
        const rest = lines.join('\n');
        const combined = last.raw + '\n' + rest.replace(otherRules.blockquoteSetextReplace2, '');
        const innerQuote = this.blockquote(combined);
        tokens[tokens.length - 1] = innerQuote;
        const remaining = combined.substring(innerQuote.raw.length).replace(/^\n/, '');
        const remainingLines = remaining ? remaining.split('\n').length : 0;
        const consumed = remainingLines ? lines.slice(0, -remainingLines) : lines;
        if (consumed.length > 0) raw = raw + '\n' + consumed.join('\n');
        text = text.substring(0, text.length - last.text.length) + innerQuote.text;
        lines = lines.slice(consumed.length);
        if (lines.length > 0 && otherRules.blockquoteStart.test(lines[0])) continue;
        break;
      } else if (last && last.type === 'list') {
        const rest = last.raw + '\n' + lines.join('\n');
        const relist = this.list(rest);
        tokens[tokens.length - 1] = relist;
        let extra = 0;
        if (relist.raw.length > last.raw.length) {
          extra = rest.slice(last.raw.length + 1, relist.raw.length).split('\n').length;
        }
        if (extra > 0) {
          const taken = lines.slice(0, extra).join('\n');
          raw = raw + '\n' + taken;
          text = text + '\n' + taken;
        }
        lines = lines.slice(extra);
        continue;
      }
    }
    return { type: 'blockquote', raw, tokens, text };
  }

  list(src) {
    let m = blockRules.list.exec(src);
    if (!m) return undefined;
    const whole = src;
    let rest = src;
    const pos = () => whole.length - rest.length;
    let marker = m[1].trim();
    const ordered = marker.length > 1;
    const listTok = {
      type: 'list',
      raw: '',
      ordered,
      start: ordered ? +marker.slice(0, -1) : '',
      loose: false,
      items: [],
    };
    marker = ordered ? `\\d{1,9}\\${marker.slice(-1)}` : `\\${marker}`;
    const itemRe = otherRules.listItemRegex(marker);
    let sawBlank = false;
    while (rest) {
      let emptyItem = false;
      let itemText = '';
      m = itemRe.exec(rest);
      if (!m || blockRules.hr.test(rest)) break;
      const itemStart = pos();
      rest = rest.substring(m[0].length);
      const nl2 = m[2].indexOf('\n');
      const firstLine = nl2 === -1 ? m[2] : m[2].slice(0, nl2);
      const bulletLen = m[1].length;
      const content = firstLine.replace(otherRules.leadingSpaceTab, (ws) => expandTabs(ws, bulletLen));
      const nl3 = rest.indexOf('\n');
      let nextLine = nl3 === -1 ? rest : rest.slice(0, nl3);
      let prevBlank = !content.trim();
      let indent = 0;
      if (prevBlank) {
        indent = bulletLen + 1;
      } else {
        indent = content.search(otherRules.nonSpaceChar);
        if (indent > 4) indent = 1;
        itemText = content.slice(indent);
        indent += bulletLen;
      }
      if (prevBlank && otherRules.blankLine.test(nextLine)) {
        rest = rest.substring(nextLine.length + 1);
        emptyItem = true;
      }
      if (!emptyItem) {
        const breakRe = otherRules.listBreakRegex(indent);
        const prevBreakRe = otherRules.listPrevBreakRegex(indent);
        let prevContent = content;
        while (rest) {
          const nl = rest.indexOf('\n');
          const line = nl === -1 ? rest : rest.slice(0, nl);
          let expanded = line;
          if (line[0] === ' ' || line[0] === '\t') {
            const lead = otherRules.leadingSpaceTab.exec(line)[0];
            if (lead.includes('\t')) expanded = expandTabs(lead) + line.slice(lead.length);
          }
          if (breakRe.test(line)) break;
          if (expanded.search(otherRules.nonSpaceChar) >= indent || !line.trim()) {
            itemText += '\n' + expanded.slice(indent);
          } else {
            if (
              prevBlank ||
              prevContent.replace(otherRules.tabCharGlobal, '    ').search(otherRules.nonSpaceChar) >= 4 ||
              prevBreakRe.test(prevContent)
            ) {
              break;
            }
            let addLine = line;
            if (/^ {0,3}(?:=+|-+) *$/.test(line) && blockRules.lheading.test(prevContent + '\n' + line)) {
              addLine = '    ' + expanded.replace(/^ {0,3}/, '');
            }
            itemText += '\n' + addLine;
          }
          prevBlank = !line.trim();
          rest = nl === -1 ? '' : rest.substring(nl + 1);
          prevContent = expanded.slice(indent);
        }
      }
      const itemRaw = whole.slice(itemStart, pos());
      if (!listTok.loose) {
        if (sawBlank) listTok.loose = true;
        else if (endsWithBlankLine(itemRaw)) sawBlank = true;
      }
      listTok.items.push({
        type: 'list_item',
        raw: itemRaw,
        task: otherRules.listIsTask.test(itemText),
        loose: false,
        text: itemText,
        tokens: [],
      });
    }
    const lastItem = listTok.items[listTok.items.length - 1];
    if (!lastItem) return undefined;
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
    listTok.raw = whole.slice(0, pos()).trimEnd();
    for (const item of listTok.items) {
      this.lexer.state.top = false;
      item.tokens = this.lexer.blockTokens(item.text, []);
      if (!listTok.loose) {
        const spaces = item.tokens.filter((t) => t.type === 'space');
        if (spaces.length > 0 && spaces.some((t) => otherRules.anyLine.test(t.raw))) {
          listTok.loose = true;
        }
      }
    }
    for (const item of listTok.items) {
      const first = item.tokens[0];
      if (item.task && first && (first.type === 'text' || first.type === 'paragraph')) {
        item.text = item.text.replace(otherRules.listReplaceTask, '');
        first.raw = first.raw.replace(otherRules.listReplaceTask, '');
        first.text = first.text.replace(otherRules.listReplaceTask, '');
        for (let i = this.lexer.inlineQueue.length - 1; i >= 0; i--) {
          if (otherRules.listIsTask.test(this.lexer.inlineQueue[i].src)) {
            this.lexer.inlineQueue[i].src = this.lexer.inlineQueue[i].src.replace(
              otherRules.listReplaceTask,
              ''
            );
            break;
          }
        }
        const cb = otherRules.listTaskCheckbox.exec(item.raw);
        if (cb) {
          const box = { type: 'checkbox', raw: cb[0] + ' ', checked: cb[0] !== '[ ]' };
          item.checked = box.checked;
          if (listTok.loose) {
            if (
              first &&
              (first.type === 'paragraph' || first.type === 'text') &&
              'tokens' in first &&
              first.tokens
            ) {
              first.raw = box.raw + first.raw;
              first.text = box.raw + first.text;
              first.tokens.unshift(box);
            } else {
              item.tokens.unshift({ type: 'paragraph', raw: box.raw, text: box.raw, tokens: [box] });
            }
          } else {
            item.tokens.unshift(box);
          }
        }
      } else if (item.task) {
        item.task = false;
      }
    }
    if (listTok.loose) {
      for (const item of listTok.items) {
        item.loose = true;
        for (const t of item.tokens) if (t.type === 'text') t.type = 'paragraph';
      }
    }
    return listTok;
  }

  htmlBlock(src) {
    const m = blockRules.html.exec(src);
    if (!m) return undefined;
    const raw = dropTrailingBlanks(m[0]);
    return {
      type: 'html',
      raw,
      pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style',
      text: raw,
      block: true,
    };
  }

  linkDef(src) {
    const m = blockRules.def.exec(src);
    if (!m) return undefined;
    if (!otherRules.startAngleBracket.test(m[2]) && findPairEnd(m[2], '()') !== -1) return undefined;
    const tag = normalizeLabel(m[1]);
    const href = m[2]
      ? m[2].replace(otherRules.hrefBrackets, '$1').replace(BACKSLASH_PUNCT, '$1')
      : '';
    const title = m[3]
      ? m[3].substring(1, m[3].length - 1).replace(BACKSLASH_PUNCT, '$1')
      : m[3];
    return { type: 'def', tag, raw: stripTrailing(m[0], '\n'), href, title };
  }

  table(src) {
    const m = blockRules.table.exec(src);
    if (!m || !otherRules.tableDelimiter.test(m[2])) return undefined;
    const headerCells = splitTableRow(m[1]);
    const aligns = m[2].replace(otherRules.tableAlignChars, '').split('|');
    const bodyLines =
      m[3] && m[3].trim() ? m[3].replace(otherRules.tableRowBlankLine, '').split('\n') : [];
    const tableTok = { type: 'table', raw: stripTrailing(m[0], '\n'), header: [], align: [], rows: [] };
    if (headerCells.length !== aligns.length) return undefined;
    for (const a of aligns) {
      tableTok.align.push(
        otherRules.tableAlignRight.test(a)
          ? 'right'
          : otherRules.tableAlignCenter.test(a)
            ? 'center'
            : otherRules.tableAlignLeft.test(a)
              ? 'left'
              : null
      );
    }
    for (let i = 0; i < headerCells.length; i++) {
      tableTok.header.push({
        text: headerCells[i],
        tokens: this.lexer.inline(headerCells[i]),
        header: true,
        align: tableTok.align[i],
      });
    }
    for (const line of bodyLines) {
      tableTok.rows.push(
        splitTableRow(line, tableTok.header.length).map((cell, j) => ({
          text: cell,
          tokens: this.lexer.inline(cell),
          header: false,
          align: tableTok.align[j],
        }))
      );
    }
    return tableTok;
  }

  setextHeading(src) {
    // Cheap necessary condition: a setext underline (= or - line) must
    // appear before the first blank line. Without one the full pattern
    // cannot match, and the full pattern is expensive on long text.
    // An empty line is the common blank line; only fall back to the
    // regex when there is none (a spaces-only blank line). Using the
    // empty line as the bound when an earlier spaces-only blank exists
    // only makes the bound later, which is safe for this gate.
    let blankAt = src.indexOf('\n\n');
    if (blankAt === -1) {
      const m = /\n[ \t]*\n/.exec(src);
      blankAt = m ? m.index : -1;
    }
    const head = blankAt === -1 ? src : src.slice(0, blankAt + 1);
    if (!/\n {0,3}(?:=+|-+)[ \t]*(?:\n|$)/.test(head)) return undefined;
    const m = blockRules.lheading.exec(src);
    if (!m) return undefined;
    const text = m[1].trim();
    return {
      type: 'heading',
      raw: stripTrailing(m[0], '\n'),
      depth: m[2].charAt(0) === '=' ? 1 : 2,
      text,
      tokens: this.lexer.inline(text),
    };
  }

  paragraph(src) {
    const m = blockRules.paragraph.exec(src);
    if (!m) return undefined;
    let text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
    return { type: 'paragraph', raw: m[0], text, tokens: this.lexer.inline(text) };
  }

  text(src) {
    const m = blockRules.text.exec(src);
    if (!m) return undefined;
    return { type: 'text', raw: m[0], text: m[0], tokens: this.lexer.inline(m[0]) };
  }

  // ---- inline tokens ----

  escape(src) {
    const m = inlineRules.escape.exec(src);
    if (!m) return undefined;
    return { type: 'escape', raw: m[0], text: m[1] };
  }

  tag(src) {
    const m = inlineRules.tag.exec(src);
    if (!m) return undefined;
    const state = this.lexer.state;
    if (!state.inLink && otherRules.startATag.test(m[0])) state.inLink = true;
    else if (state.inLink && otherRules.endATag.test(m[0])) state.inLink = false;
    if (!state.inRawBlock && otherRules.startPreScriptTag.test(m[0])) state.inRawBlock = true;
    else if (state.inRawBlock && otherRules.endPreScriptTag.test(m[0])) state.inRawBlock = false;
    return {
      type: 'html',
      raw: m[0],
      inLink: state.inLink,
      inRawBlock: state.inRawBlock,
      block: false,
      text: m[0],
    };
  }

  link(src) {
    if (this.lexer.state.linkParenPossible === false) return undefined;
    const m = inlineRules.link.exec(src);
    if (!m) return undefined;
    const bang = m[0].charAt(0) === '!' ? 2 : 1;
    if (labelHasRunawayTag(src, m[1], bang, inlineRules)) return undefined;
    const hrefTrimmed = m[2].trim();
    if (otherRules.startAngleBracket.test(hrefTrimmed)) {
      if (!otherRules.endAngleBracket.test(hrefTrimmed)) return undefined;
      const stripped = stripTrailing(hrefTrimmed.slice(0, -1), '\\');
      if ((hrefTrimmed.length - stripped.length) % 2 === 0) return undefined;
    } else {
      const paren = findPairEnd(m[2], '()');
      if (paren === -2) return undefined;
      if (paren > -1) {
        const cut = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + paren;
        m[2] = m[2].substring(0, paren);
        m[0] = m[0].substring(0, cut).trim();
        m[3] = '';
      }
    }
    const trailing = stripTrailing(m[0].slice(0, -1), '\\');
    if ((m[0].length - trailing.length) % 2 === 0) return undefined;
    let dest = m[2].trim();
    const title = m[3] ? m[3].slice(1, -1) : '';
    if (otherRules.startAngleBracket.test(dest)) dest = dest.slice(1, -1);
    return makeLink(
      m,
      {
        href: dest.replace(BACKSLASH_PUNCT, '$1'),
        title: title.replace(BACKSLASH_PUNCT, '$1'),
      },
      m[0],
      this.lexer
    );
  }

  reflink(src, links) {
    const m = inlineRules.reflink.exec(src) || inlineRules.nolink.exec(src);
    if (!m) return undefined;
    const bang = m[0].charAt(0) === '!' ? 2 : 1;
    if (labelHasRunawayTag(src, m[1], bang, inlineRules)) return undefined;
    const ref = links[normalizeLabel(m[2] || m[1])];
    if (!ref) {
      const ch = m[0].charAt(0);
      return { type: 'text', raw: ch, text: ch };
    }
    return makeLink(m, ref, m[0], this.lexer);
  }

  emStrong(src, masked, prevChar = '') {
    const m = inlineRules.emStrongLDelim.exec(src);
    if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return undefined;
    const delim = m[0][0];
    const sameAsPrev = prevChar === delim;
    const pos = masked.length - src.length;
    let runStart = pos;
    while (runStart > 0 && masked[runStart - 1] === delim) runStart--;
    const beforeRun = [...masked.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
    const beforeIsDelimOrPunct =
      beforeRun === '*' || beforeRun === '_' || !!inlineRules.punctuation.exec(beforeRun);
    let prev = prevChar;
    if (runStart < pos) prev = beforeRun;
    const prevIsPunct = runStart < pos ? beforeIsDelimOrPunct : !!inlineRules.punctuation.exec(prev);
    if (m[4] && otherRules.unicodeAlphaNumeric.test(prev)) return undefined;
    const punctAfter = m[1] || m[3] || '';
    if (!punctAfter || !prev || prevIsPunct) {
      const runLen = [...m[0]].length - 1;
      let openLeft = runLen;
      let extra = 0;
      const totalRun = pos - runStart + runLen;
      const canAlsoClose =
        !!beforeRun.trim() && (!!punctAfter || (delim === '*' && !beforeIsDelimOrPunct));
      const closerRe = delim === '*' ? inlineRules.emStrongRDelimAst : inlineRules.emStrongRDelimUnd;
      const lastPossible = lastEmCloser(this, masked, delim);
      const closerStart = pos + runLen;
      if (lastPossible < closerStart) return undefined;
      const rest = masked.slice(closerStart);
      const limit = lastPossible - closerStart;
      closerRe.lastIndex = 0;
      let mm;
      while ((mm = closerRe.exec(rest)) !== null && !(mm.index > limit)) {
        const g = mm[1] || mm[2] || mm[3] || mm[4] || mm[5] || mm[6];
        if (!g) continue;
        const len = [...g].length;
        if (mm[3] || mm[4]) {
          openLeft += len;
          continue;
        } else if (mm[5] || mm[6] || canAlsoClose) {
          if (sameAsPrev && (mm[5] || mm[6])) break;
          if (totalRun % 3 && !((totalRun + len) % 3)) {
            extra += len;
            continue;
          }
        }
        openLeft -= len;
        if (openLeft > 0) continue;
        const take = Math.min(len, len + openLeft + extra);
        const firstLen = [...mm[0]][0].length;
        const whole = src.slice(0, runLen + mm.index + firstLen + take);
        if (Math.min(runLen, take) % 2) {
          const inner = whole.slice(1, -1);
          return { type: 'em', raw: whole, text: inner, tokens: this.lexer.inlineTokens(inner) };
        }
        const inner = whole.slice(2, -2);
        return { type: 'strong', raw: whole, text: inner, tokens: this.lexer.inlineTokens(inner) };
      }
    }
    return undefined;
  }

  codespan(src) {
    const m = inlineRules.code.exec(src);
    if (!m) return undefined;
    let text = m[2].replace(otherRules.newLineCharGlobal, ' ');
    const hasNonSpace = otherRules.nonSpaceChar.test(text);
    const wrapped = otherRules.startingSpaceChar.test(text) && otherRules.endingSpaceChar.test(text);
    if (hasNonSpace && wrapped) text = text.substring(1, text.length - 1);
    return { type: 'codespan', raw: m[0], text };
  }

  br(src) {
    const m = inlineRules.br.exec(src);
    if (!m) return undefined;
    return { type: 'br', raw: m[0] };
  }

  del(src, masked, prevChar = '') {
    const m = inlineRules.delLDelim.exec(src);
    if (!m) return undefined;
    if (!(m[1] || '') || !prevChar || inlineRules.punctuation.exec(prevChar)) {
      const runLen = [...m[0]].length - 1;
      let openLeft = runLen;
      const lastPossible = lastDelCloser(this, masked);
      const closerStart = masked.length - src.length + runLen;
      if (lastPossible < closerStart) return undefined;
      const rest = masked.slice(closerStart);
      const limit = lastPossible - closerStart;
      const re = inlineRules.delRDelim;
      re.lastIndex = 0;
      let mm;
      while ((mm = re.exec(rest)) !== null && !(mm.index > limit)) {
        const g = mm[1] || mm[2] || mm[3] || mm[4] || mm[5] || mm[6];
        if (!g) continue;
        const len = [...g].length;
        if (len !== runLen) continue;
        if (mm[3] || mm[4]) {
          openLeft += len;
          continue;
        }
        openLeft -= len;
        if (openLeft > 0) continue;
        const take = Math.min(len, len + openLeft);
        const firstLen = [...mm[0]][0].length;
        const whole = src.slice(0, runLen + mm.index + firstLen + take);
        const inner = whole.slice(runLen, -runLen);
        return { type: 'del', raw: whole, text: inner, tokens: this.lexer.inlineTokens(inner) };
      }
    }
    return undefined;
  }

  autolink(src) {
    const m = inlineRules.autolink.exec(src);
    if (!m) return undefined;
    let text;
    let href;
    if (m[2] === '@') {
      text = m[1];
      href = 'mailto:' + text;
    } else {
      text = m[1];
      href = text;
    }
    return {
      type: 'link',
      raw: m[0],
      text,
      href,
      autolink: true,
      tokens: [{ type: 'text', raw: text, text }],
    };
  }

  extUrl(src) {
    const m = inlineRules.url.exec(src);
    if (!m) return undefined;
    let text;
    let href;
    if (m[2] === '@') {
      text = m[0];
      href = 'mailto:' + text;
    } else {
      let raw = m[0];
      let prev;
      do {
        prev = raw;
        raw = inlineRules.backpedal.exec(raw)?.[0] ?? '';
      } while (raw !== prev);
      text = raw;
      href = m[1] === 'www.' ? 'http://' + raw : raw;
    }
    return {
      type: 'link',
      raw: text,
      text,
      href,
      autolink: true,
      tokens: [{ type: 'text', raw: text, text }],
    };
  }

  inlineText(src) {
    const m = inlineRules.text.exec(src);
    if (!m) return undefined;
    const inRaw = this.lexer.state.inRawBlock;
    return {
      type: 'text',
      raw: m[0],
      text: inRaw ? m[0] : decodeRefs(m[0]),
      escaped: inRaw,
    };
  }
}

class Lexer {
  constructor() {
    this.tokens = [];
    this.tokens.links = Object.create(null);
    this.state = {
      inLink: false,
      inRawBlock: false,
      linkEmitted: false,
      linkParenPossible: true,
      top: true,
    };
    this.inlineQueue = [];
    this.tokenizer = new Tokenizer(this);
  }

  lex(src) {
    src = src.replace(/\r\n|\r/g, '\n');
    this.blockTokens(src, this.tokens);
    for (let i = 0; i < this.inlineQueue.length; i++) {
      const item = this.inlineQueue[i];
      this.state.inRawBlock = false;
      this.inlineTokens(item.src, item.tokens);
    }
    this.inlineQueue = [];
    return this.tokens;
  }

  inline(src, out = []) {
    this.inlineQueue.push({ src, tokens: out });
    return out;
  }

  blockTokens(src, out = [], inQuote = false) {
    let guard = Infinity;
    while (src) {
      if (src.length < guard) guard = src.length;
      else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      let tok;
      if ((tok = this.tokenizer.space(src))) {
        src = src.substring(tok.raw.length);
        const prev = out[out.length - 1];
        if (tok.raw.length === 1 && prev !== undefined) prev.raw += '\n';
        else out.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.indentedCode(src))) {
        src = src.substring(tok.raw.length);
        const prev = out[out.length - 1];
        if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          this.inlineQueue[this.inlineQueue.length - 1].src = prev.text;
        } else out.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.fencedCode(src))) {
        src = src.substring(tok.raw.length);
        out.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.heading(src))) {
        src = src.substring(tok.raw.length);
        out.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.hr(src))) {
        src = src.substring(tok.raw.length);
        out.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.blockquote(src))) {
        src = src.substring(tok.raw.length);
        out.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.list(src))) {
        src = src.substring(tok.raw.length);
        out.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.htmlBlock(src))) {
        src = src.substring(tok.raw.length);
        out.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.linkDef(src))) {
        src = src.substring(tok.raw.length);
        const prev = out[out.length - 1];
        if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.raw;
          this.inlineQueue[this.inlineQueue.length - 1].src = prev.text;
        } else {
          if (!this.tokens.links[tok.tag]) {
            this.tokens.links[tok.tag] = { href: tok.href, title: tok.title };
            this.tokenizer.linkCount++;
          }
          out.push(tok);
        }
        continue;
      }
      if ((tok = this.tokenizer.table(src))) {
        src = src.substring(tok.raw.length);
        out.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.setextHeading(src))) {
        src = src.substring(tok.raw.length);
        out.push(tok);
        continue;
      }
      if (this.state.top && (tok = this.tokenizer.paragraph(src))) {
        const prev = out[out.length - 1];
        if (inQuote && prev && prev.type === 'paragraph') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue[this.inlineQueue.length - 1].src = prev.text;
        } else {
          out.push(tok);
        }
        inQuote = false;
        src = src.substring(tok.raw.length);
        continue;
      }
      if ((tok = this.tokenizer.text(src))) {
        src = src.substring(tok.raw.length);
        const prev = out[out.length - 1];
        if (prev && prev.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue[this.inlineQueue.length - 1].src = prev.text;
        } else {
          out.push(tok);
        }
        continue;
      }
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    this.state.top = true;
    return out;
  }

  inlineTokens(src, out = []) {
    const savedParen = this.state.linkParenPossible;
    this.state.linkParenPossible = savedParen && src.includes(')');
    try {
      let masked = src;
      if (src.includes('*') || src.includes('_') || src.includes('~')) {
        masked = maskSource(this.tokenizer, src);
      }
      rememberMask(this.tokenizer, masked);
      try {
        return this.inlineLoop(src, masked, out);
      } finally {
        forgetMask(this.tokenizer);
      }
    } finally {
      this.state.linkParenPossible = savedParen;
    }
  }

  inlineLoop(src, masked, out) {
    let wasText = false;
    let prevChar = '';
    let guard = Infinity;
    while (src) {
      if (src.length < guard) guard = src.length;
      else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      if (!wasText) prevChar = '';
      wasText = false;
      const ch = src[0];
      let tok;
      // Dispatch on the first character: each inline construct can only
      // start with one of a few characters, so most positions only need
      // the text tokenizer. The order inside each branch is the same as
      // the full scan order, so behaviour is unchanged.
      if (ch === '\\') {
        if ((tok = this.tokenizer.escape(src))) {
          src = src.substring(tok.raw.length);
          out.push(tok);
          continue;
        }
        if ((tok = this.tokenizer.br(src))) {
          src = src.substring(tok.raw.length);
          out.push(tok);
          continue;
        }
      } else if (ch === '<') {
        if ((tok = this.tokenizer.tag(src))) {
          src = src.substring(tok.raw.length);
          out.push(tok);
          continue;
        }
        if ((tok = this.tokenizer.autolink(src))) {
          src = src.substring(tok.raw.length);
          out.push(tok);
          continue;
        }
      } else if (ch === '[' || ch === '!') {
        if ((tok = this.tokenizer.link(src))) {
          src = src.substring(tok.raw.length);
          out.push(tok);
          continue;
        }
        if ((tok = this.tokenizer.reflink(src, this.tokens.links))) {
          src = src.substring(tok.raw.length);
          const prev = out[out.length - 1];
          if (tok.type === 'text' && prev && prev.type === 'text') {
            prev.raw += tok.raw;
            prev.text += tok.text;
          } else {
            out.push(tok);
          }
          continue;
        }
      } else if (ch === '*' || ch === '_') {
        if ((tok = this.tokenizer.emStrong(src, masked, prevChar))) {
          src = src.substring(tok.raw.length);
          out.push(tok);
          continue;
        }
      } else if (ch === '~') {
        if ((tok = this.tokenizer.del(src, masked, prevChar))) {
          src = src.substring(tok.raw.length);
          out.push(tok);
          continue;
        }
      } else if (ch === '`') {
        if ((tok = this.tokenizer.codespan(src))) {
          src = src.substring(tok.raw.length);
          out.push(tok);
          continue;
        }
      } else if (ch === ' ') {
        if ((tok = this.tokenizer.br(src))) {
          src = src.substring(tok.raw.length);
          out.push(tok);
          continue;
        }
      } else if (
        (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9')
      ) {
        if (!this.state.inLink && (tok = this.tokenizer.extUrl(src))) {
          src = src.substring(tok.raw.length);
          out.push(tok);
          continue;
        }
      }
      if ((tok = this.tokenizer.inlineText(src))) {
        src = src.substring(tok.raw.length);
        if (tok.raw.slice(-1) !== '_') prevChar = tok.raw.slice(-1);
        wasText = true;
        const prev = out[out.length - 1];
        if (prev && prev.type === 'text') {
          prev.raw += tok.raw;
          prev.text += tok.text;
        } else {
          out.push(tok);
        }
        continue;
      }
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// 4. Renderer
// ---------------------------------------------------------------------------

// Plain-text rendering used for image alt text: markup is dropped, only the
// readable text survives.
function renderTextOnly(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'strong':
      case 'em':
      case 'del':
      case 'link':
      case 'image':
        out += tok.tokens ? renderTextOnly(tok.tokens) : tok.text;
        break;
      case 'codespan':
      case 'html':
      case 'text':
        out += tok.text;
        break;
      case 'checkbox':
        out += tok.raw;
        break;
      case 'br':
        break;
      default:
        break;
    }
  }
  return out;
}

function renderInlineToken(tok) {
  switch (tok.type) {
    case 'escape':
      return escapeHtml(tok.text);
    case 'html':
      return tok.text;
    case 'link': {
      const text = tok.autolink ? escapeHtml(tok.text, true) : renderInlineTokens(tok.tokens);
      const href = cleanUrl(tok.href);
      if (href === null) return text;
      const safeHref = escapeHtml(href, tok.autolink);
      let out = '<a href="' + safeHref + '"';
      if (tok.title) out += ' title="' + escapeHtml(tok.title) + '"';
      return out + '>' + text + '</a>';
    }
    case 'image': {
      const alt = tok.tokens ? renderTextOnly(tok.tokens) : tok.text;
      const href = cleanUrl(tok.href);
      if (href === null) return escapeHtml(alt);
      let out = '<img src="' + escapeHtml(href) + '" alt="' + escapeHtml(alt) + '"';
      if (tok.title) out += ' title="' + escapeHtml(tok.title) + '"';
      return out + '>';
    }
    case 'checkbox':
      return '<input ' + (tok.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
    case 'strong':
      return '<strong>' + renderInlineTokens(tok.tokens) + '</strong>';
    case 'em':
      return '<em>' + renderInlineTokens(tok.tokens) + '</em>';
    case 'codespan':
      return '<code>' + escapeHtml(tok.text, true) + '</code>';
    case 'br':
      return '<br>';
    case 'del':
      return '<del>' + renderInlineTokens(tok.tokens) + '</del>';
    case 'text':
      if ('tokens' in tok && tok.tokens) return renderInlineTokens(tok.tokens);
      if ('escaped' in tok && tok.escaped) return tok.text;
      return escapeHtml(tok.text);
    default:
      return '';
  }
}

function renderInlineTokens(tokens) {
  let out = '';
  for (const tok of tokens) out += renderInlineToken(tok);
  return out;
}

function renderToken(tok) {
  switch (tok.type) {
    case 'space':
      return '';
    case 'hr':
      return '<hr>\n';
    case 'heading':
      return '<h' + tok.depth + '>' + renderInlineTokens(tok.tokens) + '</h' + tok.depth + '>\n';
    case 'code': {
      const lang = (tok.lang || '').match(NON_SPACE_START)?.[0] || '';
      const text = tok.text ? tok.text.replace(TRAILING_NEWLINE, '') + '\n' : '';
      const body = escapeHtml(text, true);
      if (lang) {
        return '<pre><code class="language-' + escapeHtml(lang) + '">' + body + '</code></pre>\n';
      }
      return '<pre><code>' + body + '</code></pre>\n';
    }
    case 'table': {
      let head = '';
      for (const cell of tok.header) head += renderTableCell(cell);
      let out = '<table>\n<thead>\n<tr>\n' + head + '</tr>\n</thead>\n';
      let body = '';
      for (const row of tok.rows) {
        let cells = '';
        for (const cell of row) cells += renderTableCell(cell);
        body += '<tr>\n' + cells + '</tr>\n';
      }
      if (body) out += '<tbody>' + body + '</tbody>';
      return out + '</table>\n';
    }
    case 'blockquote':
      return '<blockquote>\n' + renderTokens(tok.tokens) + '</blockquote>\n';
    case 'list': {
      const tag = tok.ordered ? 'ol' : 'ul';
      const start = tok.ordered && tok.start !== 1 ? ' start="' + tok.start + '"' : '';
      let items = '';
      for (const item of tok.items) items += renderListItem(item);
      return '<' + tag + start + '>\n' + items + '</' + tag + '>\n';
    }
    case 'checkbox':
      return '<input ' + (tok.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
    case 'html':
      return tok.text;
    case 'def':
      return '';
    case 'paragraph':
      return '<p>' + renderInlineTokens(tok.tokens) + '</p>\n';
    case 'text':
      if ('tokens' in tok && tok.tokens) return renderInlineTokens(tok.tokens);
      if ('escaped' in tok && tok.escaped) return tok.text;
      return escapeHtml(tok.text);
    default:
      return '';
  }
}

function renderTableCell(cell) {
  const tag = cell.header ? 'th' : 'td';
  const open = cell.align ? '<' + tag + ' align="' + cell.align + '">' : '<' + tag + '>';
  return open + renderInlineTokens(cell.tokens) + '</' + tag + '>\n';
}

function renderListItem(item) {
  return '<li>' + renderTokens(item.tokens) + '</li>\n';
}

function renderTokens(tokens) {
  let out = '';
  for (const tok of tokens) out += renderToken(tok);
  return out;
}

// ---------------------------------------------------------------------------
// 5. Public entry point
// ---------------------------------------------------------------------------

export function parse(markdown) {
  const lexer = new Lexer();
  const tokens = lexer.lex(markdown);
  return renderTokens(tokens);
}
