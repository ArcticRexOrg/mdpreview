/*
 * editor-core.js — pure markdown-editing transforms for MarkdownPreview.
 *
 * No DOM, no globals: every function takes a markdown string (and integer
 * source offsets) plus the `marked` module, and returns markdown (plus caret
 * offsets). This is the load-bearing logic, unit-tested under Node via
 * `node --test`. The browser loads this file with a <script> tag and reaches
 * the functions through `window.EditorCore`; the thin DOM adapter that maps
 * selections to source offsets lives separately.
 *
 * UMD wrapper so the same file works as a CommonJS module (Node tests) and as
 * a classic browser script (template.html).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.EditorCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Block token types the user is allowed to edit in place. Everything else
  // (frontmatter, space separators, fenced/indented code, mermaid — which is a
  // `code` token with lang "mermaid" — html, hr) is rendered read-only and its
  // source bytes pass through verbatim.
  // Tables use a distinct token shape (.header/.rows) the leaf re-serializer
  // doesn't reconstruct, so they stay read-only for now (correct-but-limited).
  var EDITABLE_BLOCKS = { paragraph: true, heading: true, blockquote: true, list: true, table: true };

  function isEditableBlock(token) {
    return EDITABLE_BLOCKS[token.type] === true;
  }

  /**
   * Recognize YAML frontmatter only at the start of a document. Frontmatter is
   * an extension to CommonMark, so marked otherwise reads the opening fence as
   * an hr and the closing fence as a setext-heading underline.
   *
   * The returned `raw` includes both fences and the closing newline (when
   * present); `content` is the YAML between them. No YAML interpretation is
   * attempted here — arbitrary valid YAML must remain byte-inert.
   *
   * The pattern deliberately carries no `m` flag: `^` must mean "start of
   * document", not "start of any line", or a pair of thematic breaks in the
   * middle of a document would be swallowed as frontmatter. The closing fence
   * is instead pinned to a line start by requiring the captured YAML to be
   * either empty or newline-terminated.
   */
  function leadingFrontmatter(md) {
    var match = /^(?:\uFEFF)?---[ \t]*\r?\n((?:[\s\S]*?\r?\n)?)---[ \t]*(?:\r?\n|$)/.exec(md);
    if (!match) return null;
    return {
      raw: match[0],
      content: match[1],
      rest: md.slice(match[0].length),
    };
  }

  /**
   * Split markdown into top-level block segments. The invariant the rest of the
   * editor relies on: segs.map(s => s.raw).join('') === md, byte for byte.
   */
  /**
   * Split a document into top-level blocks.
   *
   * `doc` is optional but wanted: given one, a block is editable exactly when
   * the model can build a coordinate map for it (see blockCoords), and the map
   * is carried on the token for the DOM adapter to use. Editable, mappable and
   * reconcilable then name one property instead of three overlapping ones —
   * the mismatch between them is what let blocks accept keystrokes they could
   * not fold back into source. Without a `doc` we fall back to the old
   * by-token-type test, which is enough for callers that only read `.raw`
   * (conflict reconciliation, whole-document parsing).
   */
  function segment(md, marked, doc) {
    var frontmatter = leadingFrontmatter(md);
    var tokens = marked.lexer(frontmatter ? frontmatter.rest : md);
    var segments = [];
    if (frontmatter) {
      var token = {
        type: 'frontmatter',
        raw: frontmatter.raw,
        text: frontmatter.content,
      };
      segments.push({
        index: 0,
        type: token.type,
        raw: token.raw,
        token: token,
        editable: false,
      });
    }
    tokens.forEach(function (token) {
      var editable = isEditableBlock(token);
      if (editable && doc) {
        var coords = blockCoords(doc, token.raw, marked);
        setCoords(token, coords);
        editable = coords !== null;
      }
      segments.push({
        index: segments.length,
        type: token.type,
        raw: token.raw,
        token: token,
        editable: editable,
      });
    });
    return segments;
  }

  // The coordinate map rides on the token rather than being threaded through
  // the adapter's twenty-odd call sites: a signature change there would let a
  // missed site pass `undefined` and silently drop back to the old ledger,
  // which is the failure mode this whole change exists to remove.
  var COORDS = '__coords';
  function setCoords(token, coords) {
    try { Object.defineProperty(token, COORDS, { value: coords, configurable: true }); }
    catch (_) { token[COORDS] = coords; }
  }
  function coordsOf(token) {
    return token && token[COORDS] ? token[COORDS] : null;
  }

  function childrenOf(token) {
    if (token.tokens && token.tokens.length) return token.tokens;
    if (token.items && token.items.length) return token.items;
    return null;
  }

  // --- StyledDoc model — inline layer ----------------------------------------
  //
  // Styled text is an array of chars: { ch, attrs } for one display code
  // point, { obj:'image', src, alt, title, attrs } for an atomic object.
  // attrs is { b, i, code, del, link:{href,title} }. Operations are functions
  // on this space and therefore are their own specs — no delimiters exist
  // here. parseInline lifts an inline markdown fragment into the model (null
  // = refused, out of model scope); printInline lowers styled text back,
  // reusing original bytes for provenance spans whose chars are untouched —
  // that is how `_em_`, `\*` escapes and `&amp;` entities survive edits
  // elsewhere in the same fragment.

  var ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

  // Decode HTML entities to display chars; null when an entity is outside the
  // supported set (the fragment is then refused — never guess display text).
  function decodeEntities(s) {
    var bad = false;
    var out = s.replace(/&(#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, function (m, body) {
      if (body.charAt(0) === '#') {
        var code = (body.charAt(1) === 'x' || body.charAt(1) === 'X')
          ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        // Out of Unicode range, or a lone surrogate: fromCodePoint throws on
        // the first and yields an unpaired surrogate on the second. The
        // renderer substitutes U+FFFD for both; the model never guesses
        // display text, so refuse instead and leave the fragment byte-opaque.
        if (!isFinite(code) || code <= 0 || code > 0x10FFFF ||
            (code >= 0xD800 && code <= 0xDFFF)) { bad = true; return m; }
        return String.fromCodePoint(code);
      }
      if (ENTITIES.hasOwnProperty(body)) return ENTITIES[body];
      bad = true;
      return m;
    });
    return bad ? null : out;
  }

  function copyAttrs(attrs) {
    var out = {};
    if (attrs) {
      if (attrs.b) out.b = true;
      if (attrs.i) out.i = true;
      if (attrs.code) out.code = true;
      if (attrs.del) out.del = true;
      if (attrs.link) out.link = attrs.link; // shared by reference within a run
    }
    return out;
  }

  function copyChar(c) {
    return c.obj
      ? { obj: c.obj, src: c.src, alt: c.alt, title: c.title || '', attrs: copyAttrs(c.attrs) }
      : { ch: c.ch, attrs: copyAttrs(c.attrs) };
  }

  function attrsEqM(a, b) {
    a = a || {}; b = b || {};
    if (!a.b !== !b.b || !a.i !== !b.i || !a.code !== !b.code || !a.del !== !b.del) return false;
    var la = a.link || null, lb = b.link || null;
    if (!la !== !lb) return false;
    if (la && (la.href !== lb.href || (la.title || '') !== (lb.title || ''))) return false;
    return true;
  }

  function charEqM(x, y) {
    if (!x.obj !== !y.obj) return false;
    if (x.obj) {
      if (x.obj !== y.obj || x.src !== y.src || x.alt !== y.alt ||
          (x.title || '') !== (y.title || '')) return false;
    } else if (x.ch !== y.ch) return false;
    return attrsEqM(x.attrs, y.attrs);
  }

  function textEqM(x, y) {
    if (x.length !== y.length) return false;
    for (var i = 0; i < x.length; i++) if (!charEqM(x[i], y[i])) return false;
    return true;
  }

  function isWsChar(c) { return !c.obj && /^\s$/.test(c.ch); }

  /**
   * Parse an inline markdown fragment into styled text.
   * Returns { text:[Char], prov:[{from,to,raw,chars}] } — one provenance span
   * per top-level inline token (their raws tile the fragment) — or null when
   * the fragment contains a construct outside the model (raw html, hard
   * breaks, unknown entities). Refused fragments stay byte-opaque upstream.
   */
  function parseInline(frag, marked) {
    var toks;
    try { toks = marked.Lexer.lexInline(frag); } catch (_) { return null; }
    var joined = '';
    for (var i = 0; i < toks.length; i++) joined += toks[i].raw;
    if (joined !== frag) return null; // positions unknowable — out of scope
    var text = [];
    // Does a token render as bare text (merging into a neighbouring text
    // node) rather than as an element?
    function rendersAsText(t) { return t && (t.type === 'text' || t.type === 'escape'); }
    function emit(t, attrs, prevT, nextT) {
      var k, a;
      switch (t.type) {
        case 'text': {
          if (t.tokens && t.tokens.length) return emitList(t.tokens, attrs);
          // A whitespace-only run containing a newline, with elements (or the
          // fragment edge) on both sides, renders as an inter-element text
          // node that stripStructuralWhitespace removes — it contributes
          // nothing to the display currency. Its bytes live on in the
          // provenance span. Adjacent to bare text it merges into that node
          // and survives.
          if (/^\s*$/.test(t.text) && t.text.indexOf('\n') >= 0 &&
              !rendersAsText(prevT) && !rendersAsText(nextT)) return true;
          var dec = decodeEntities(t.text);
          if (dec === null) return false;
          for (k = 0; k < dec.length; k++) text.push({ ch: dec.charAt(k), attrs: copyAttrs(attrs) });
          return true;
        }
        case 'escape':
          for (k = 0; k < t.text.length; k++) text.push({ ch: t.text.charAt(k), attrs: copyAttrs(attrs) });
          return true;
        case 'codespan':
          // Two code spans that end up touching are one run of identical chars
          // here, so the model cannot tell "`a``b`" from "`ab`" and printing
          // merges them into a single span — which renders differently. They
          // need not be adjacent in the source: a whitespace-only run between
          // them renders as an inter-element text node that is stripped, so
          // "` `\n`  `" arrives here as one run too. Checking the chars
          // already emitted catches both spellings.
          if (text.length && !text[text.length - 1].obj && text[text.length - 1].attrs.code) return false;
          a = copyAttrs(attrs); a.code = true;
          for (k = 0; k < t.text.length; k++) text.push({ ch: t.text.charAt(k), attrs: copyAttrs(a) });
          return true;
        case 'strong': a = copyAttrs(attrs); a.b = true; return emitList(t.tokens, a);
        case 'em': a = copyAttrs(attrs); a.i = true; return emitList(t.tokens, a);
        case 'del': a = copyAttrs(attrs); a.del = true; return emitList(t.tokens, a);
        case 'link':
          a = copyAttrs(attrs); a.link = { href: t.href, title: t.title || '' };
          return emitList(t.tokens, a);
        case 'image':
          text.push({ obj: 'image', src: t.href, alt: t.text, title: t.title || '', attrs: copyAttrs(attrs) });
          return true;
        default:
          return false; // br, html, anything new marked grows — refused
      }
    }
    function emitList(list, attrs) {
      for (var j = 0; j < list.length; j++) {
        if (!emit(list[j], attrs, list[j - 1], list[j + 1])) return false;
      }
      return true;
    }
    var prov = [];
    for (var n = 0; n < toks.length; n++) {
      var from = text.length;
      if (!emit(toks[n], {}, toks[n - 1], toks[n + 1])) return null;
      prov.push({ from: from, to: text.length, raw: toks[n].raw, chars: text.slice(from).map(copyChar) });
    }
    // A blank line cannot live inside a paragraph: printed back it would end
    // the block and start another. Sources spell it with an entity ("&#10;"),
    // which this model does not carry, so such a fragment is out of scope.
    var shown = '';
    for (var z = 0; z < text.length; z++) if (!text[z].obj) shown += text[z].ch;
    if (/\n[ \t]*\n/.test(shown)) return null;
    return { text: text, prov: prov };
  }

  /**
   * Normalize styled text to the printable subset: emphasis-family attrs
   * (b/i/del) can't sit on run-boundary whitespace (the delimiters wouldn't
   * lex) and can't survive inside code. Display chars are never changed.
   */
  // Styled text with emphasis removed from its code characters — the shape the
  // printer falls back to when the richer nesting has no markdown spelling.
  function codeExclusive(text) {
    return text.map(function (c) {
      var o = copyChar(c);
      if (o.attrs.code) { delete o.attrs.b; delete o.attrs.i; delete o.attrs.del; }
      return o;
    });
  }

  function canonText(text) {
    var out = text.map(copyChar), i;
    for (i = 0; i < out.length; i++) {
      // Emphasis around a codespan (`*foo `x`*`) is ordinary markdown and the
      // printer can nest it correctly, so this exclusivity is stricter than it
      // needs to be: it is why an edit inside an emphasised codespan is still
      // refused (see laws.test.mjs — the remaining "Links"/"Code spans" tail).
      // Lifting it, though, lets the printer emit a bold run that ends
      // immediately before another codespan, and those delimiters do not
      // always pair — `**``a`b``**` ` ` reparses with literal asterisks. The
      // model would need a representability check with somewhere to fall back
      // to before this rule can go; until then the strict version is the one
      // that keeps print/parse a round trip.
      if (out[i].obj) delete out[i].attrs.code;
    }
    var KEYS = ['b', 'i', 'del'];
    for (var k = 0; k < KEYS.length; k++) {
      var key = KEYS[k];
      i = 0;
      while (i < out.length) {
        if (!out[i].attrs[key]) { i++; continue; }
        var j = i;
        while (j < out.length && out[j].attrs[key]) j++;
        var p = i;
        while (p < j && isWsChar(out[p])) { delete out[p].attrs[key]; p++; }
        var q = j - 1;
        while (q >= p && isWsChar(out[q])) { delete out[q].attrs[key]; q--; }
        i = j;
      }
    }
    return out;
  }

  /**
   * The model op behind Cmd+B/Cmd+I: if every non-whitespace char in
   * [start,end) already carries `attr`, remove it from the range; otherwise
   * set it on the whole range (interior whitespace included — canonText hoists
   * it back off the boundaries). Returns the input array itself when the range
   * has nothing togglable, so callers can detect the refusal.
   */
  function toggleAttr(text, start, end, attr) {
    start = Math.max(0, start); end = Math.min(text.length, end);
    var any = false, allSet = true, i;
    for (i = start; i < end; i++) {
      if (isWsChar(text[i])) continue;
      any = true;
      if (!text[i].attrs[attr]) allSet = false;
    }
    if (!any) return text;
    var out = text.map(copyChar);
    for (i = start; i < end; i++) {
      if (allSet) delete out[i].attrs[attr];
      else out[i].attrs[attr] = true;
    }
    return out;
  }

  // --- the printer -----------------------------------------------------------

  // Outermost-first delimiter order; code is innermost and exclusive of b/i/del
  // (canonText guarantees that), link compared by reference so two adjacent
  // distinct links to the same href stay two links.
  var PRINT_PRIO = ['link', 'b', 'i', 'del', 'code'];
  var ESCAPABLE = /[\\`*_~\[\]&<]/;

  function attrValOf(c, key) { return key === 'link' ? (c.attrs.link || null) : !!c.attrs[key]; }

  /**
   * A link destination written bare cannot hold whitespace, angle brackets, or
   * unbalanced parentheses. `[a](<b)c>)` has destination "b)c"; printed bare it
   * becomes `[a](b)c)`, which ends the link at the first ")" and leaves "c)" as
   * text — so every edit in such a link was refused. The pointy form accepts
   * all of it and needs only < and > escaped.
   */
  function emitDest(href) {
    href = href || '';
    var depth = 0, ok = true;
    for (var i = 0; i < href.length && ok; i++) {
      var ch = href.charAt(i);
      if (ch === '(') depth++;
      else if (ch === ')' && --depth < 0) ok = false;
    }
    if (href !== '' && ok && depth === 0 && !/[\s<>]/.test(href)) return href;
    return '<' + href.replace(/([<>\\])/g, '\\$1') + '>';
  }
  function emitTitle(title) {
    return title ? ' "' + title.replace(/(["\\])/g, '\\$1') + '"' : '';
  }

  function emitCharCanon(c, k, B, noEsc) {
    B.pos[k] = B.s.length;
    if (c.obj) B.s += '![' + (c.alt || '') + '](' + emitDest(c.src) + emitTitle(c.title) + ')';
    else B.s += (!noEsc && ESCAPABLE.test(c.ch)) ? '\\' + c.ch : c.ch;
    B.end[k] = B.s.length;
  }

  // A codespan whose content contains backticks needs a longer fence; content
  // with a boundary space/backtick needs the one-space padding CommonMark
  // strips back off.
  function emitCodeCanon(text, i, j, B) {
    var content = '', k;
    for (k = i; k < j; k++) content += text[k].ch;
    var runs = content.match(/`+/g), longest = 0;
    if (runs) for (k = 0; k < runs.length; k++) longest = Math.max(longest, runs[k].length);
    var fence = new Array(longest + 2).join('`');
    // The one-space padding is stripped back off by CommonMark only when the
    // content is not entirely spaces. For all-space content the padding is
    // therefore added to it, not protection for it: `` ` ` `` already means one
    // space, while `` `   ` `` means three.
    var allSpace = content.length > 0 && !/[^ ]/.test(content);
    var pad = (!allSpace && (content === '' || /^[ `]|[ `]$/.test(content))) ? ' ' : '';
    B.s += fence + pad;
    for (k = i; k < j; k++) { B.pos[k] = B.s.length; B.s += text[k].ch; B.end[k] = B.s.length; }
    B.s += pad + fence;
  }

  // How far the run of `key` starting at i extends, within [i,b). Links compare
  // by reference — parseInline shares one link object across a run — so two
  // adjacent links to the same target stay two runs, as they render.
  function runEndOf(text, i, b, key) {
    var v = attrValOf(text[i], key);
    if (!v) return i;
    var j = i + 1;
    while (j < b && attrValOf(text[j], key) === v) j++;
    return j;
  }

  /**
   * Print a range of styled text as canonical markdown.
   *
   * At each position the attribute with the *longest* remaining run becomes the
   * outer delimiter. A fixed priority order cannot work: with bold ranked above
   * italic, `*foo **bar** baz*` printed as `*foo *` + `***bar***` + `* baz*` —
   * the italic closed and reopened around the bold, which both renders as three
   * <em>s instead of one and (with the delimiters running together) reparses as
   * something else entirely. Widest-first is the only order that nests.
   *
   * `mask` carries the attributes already opened by enclosing calls. Code stays
   * innermost by construction rather than by rank: it is emitted only once no
   * other attribute applies, so it can never swallow an enclosing link.
   */
  function printCanonInto(text, a, b, B, noEsc, mask) {
    if (a >= b) return;
    mask = mask || {};
    var NESTABLE = ['link', 'b', 'i', 'del'];
    var i = a;
    while (i < b) {
      var bestKey = null, bestEnd = i, k;
      for (k = 0; k < NESTABLE.length; k++) {
        var key = NESTABLE[k];
        if (mask[key] || !attrValOf(text[i], key)) continue;
        var end = runEndOf(text, i, b, key);
        if (end > bestEnd) { bestKey = key; bestEnd = end; }
      }
      if (!bestKey) {
        if (!mask.code && attrValOf(text[i], 'code')) {
          var ce = runEndOf(text, i, b, 'code');
          emitCodeCanon(text, i, ce, B);
          i = ce;
        } else {
          emitCharCanon(text[i], i, B, noEsc);
          i++;
        }
        continue;
      }
      var hv = attrValOf(text[i], bestKey);
      var sub = {};
      for (var m in mask) if (mask.hasOwnProperty(m)) sub[m] = mask[m];
      sub[bestKey] = true;
      if (bestKey === 'link') {
        B.s += '[';
        printCanonInto(text, i, bestEnd, B, noEsc, sub);
        B.s += '](' + emitDest(hv.href) + emitTitle(hv.title) + ')';
      } else {
        var dlm = bestKey === 'b' ? '**' : bestKey === 'i' ? '*' : '~~';
        B.s += dlm;
        printCanonInto(text, i, bestEnd, B, noEsc, sub);
        B.s += dlm;
      }
      i = bestEnd;
    }
  }

  // Leading delimiter width of a provenance span's raw — how far into the raw
  // its first display char sits. Used for approximate char→byte positions in
  // reused spans and for snapping source offsets to char indices.
  function provLeadLen(raw) {
    var m = raw.match(/^(\*+|_+|~+)/);
    if (m) return m[1].length;
    m = raw.match(/^`+ ?/);
    if (m) return m[0].length;
    if (raw.charAt(0) === '\\') return 1;
    if (raw.slice(0, 2) === '![') return 0;
    if (raw.charAt(0) === '[') return 1;
    return 0;
  }

  // Do two chars carry a style that would run continuously between them?
  // Links compare by target, not by reference: two adjacent links to the same
  // place still render as two <a> elements.
  function sharesAttr(a, b) {
    a = a || {}; b = b || {};
    if (a.b && b.b) return true;
    if (a.i && b.i) return true;
    if (a.code && b.code) return true;
    if (a.del && b.del) return true;
    if (a.link && b.link && a.link.href === b.link.href &&
        (a.link.title || '') === (b.link.title || '')) return true;
    return false;
  }

  /**
   * Would a seam between emitted pieces at char index k split a styled run?
   *
   * Every seam closes and reopens whatever styles cross it: `*X*_foo_` is two
   * <em> elements where `*Xfoo*` is one. The model cannot see that difference —
   * per-char attributes are identical either way, so printInlineParts' own
   * reparse check passes happily — but the rendered DOM plainly can, and
   * reconciliation compares rendered structure. That gap is why typing a
   * character anywhere inside nested emphasis (`_foo __bar__ baz_`,
   * `[link *foo*][ref]`) was refused at every position: the printer produced a
   * source that modelled correctly and rendered wrongly.
   */
  function splitsRun(text, k) {
    if (k <= 0 || k >= text.length) return false;
    return sharesAttr(text[k - 1].attrs, text[k].attrs);
  }

  function matchChunk(text, at, chars) {
    if (at < 0 || at + chars.length > text.length) return false;
    for (var k = 0; k < chars.length; k++) if (!charEqM(text[at + k], chars[k])) return false;
    return true;
  }

  function emitProvSpan(sp, atIdx, B) {
    var base = B.s.length, lead = provLeadLen(sp.raw), n = sp.to - sp.from;
    for (var k = 0; k < n; k++) {
      B.pos[atIdx + k] = Math.min(base + lead + k, base + sp.raw.length);
      B.end[atIdx + k] = Math.min(B.pos[atIdx + k] + 1, base + sp.raw.length);
    }
    B.s += sp.raw;
  }

  /**
   * Print styled text to markdown. With prov (and marked), original bytes are
   * reused for the longest prefix and suffix of provenance spans whose chars
   * are untouched; the changed middle is printed canonically, and the result
   * is verified by reparse — any disagreement falls back to a full canonical
   * print, which is always representable. Returns { s, pos, end } where
   * pos[k]/end[k] bracket char k's bytes in s.
   */
  function printInlineParts(text, prov, marked) {
    var B = { s: '', pos: new Array(text.length), end: new Array(text.length) };
    if (!prov || !prov.length || !marked) {
      return canonPrint(text, marked);
    }
    var i = 0, pi = 0;
    while (pi < prov.length && matchChunk(text, i, prov[pi].chars)) {
      i += prov[pi].chars.length; pi++;
    }
    var j = text.length, sj = prov.length, tail = [];
    while (sj > pi) {
      var sp = prov[sj - 1], L = sp.chars.length;
      if (j - L >= i && matchChunk(text, j - L, sp.chars)) { tail.unshift(sp); sj--; j -= L; }
      else break;
    }
    // Pull both reuse boundaries out of any styled run they landed inside, a
    // whole provenance span at a time (the boundaries are span-aligned). The
    // widened middle is then printed canonically, which re-emits the run as one
    // piece. If the two boundaries cross, nothing can be reused and the full
    // canonical print below takes over.
    while (pi > 0 && splitsRun(text, i)) { pi--; i -= prov[pi].chars.length; }
    while (tail.length && splitsRun(text, j)) { j += tail[0].chars.length; tail.shift(); }
    if (i > j) { i = 0; j = text.length; pi = 0; tail = []; }
    function assemble(noEsc) {
      var A = { s: '', pos: new Array(text.length), end: new Array(text.length) };
      var at = 0, h;
      for (h = 0; h < pi; h++) { emitProvSpan(prov[h], at, A); at += prov[h].chars.length; }
      printCanonInto(text, i, j, A, noEsc);
      at = j;
      for (h = 0; h < tail.length; h++) { emitProvSpan(tail[h], at, A); at += tail[h].chars.length; }
      return A;
    }
    function verified(A) {
      var reparsed = parseInline(A.s, marked);
      return reparsed && textEqM(reparsed.text, want) ? A : null;
    }
    var want = canonText(text);
    // Bytes stay exactly what was typed when the unescaped form already
    // renders right (a*b intraword stays literal); escape only when the
    // reparse disagrees; a stale provenance adoption falls back to a full
    // canonical print, which is always representable.
    B = verified(assemble(true));
    if (!B && i < j) B = verified(assemble(false));
    if (!B) B = canonPrint(text, marked);
    return B;
  }

  /**
   * Canonical print of styled text, with one documented retreat.
   *
   * Emphasis around a code span is ordinary markdown and prints correctly:
   * `*foo `x`*`, `**`x`**`, `*`x` `y`*` all round-trip. One shape does not — a
   * code span whose own content holds a backtick, wrapped in emphasis and
   * immediately followed by another code span — where marked reads the
   * delimiters as literal asterisks. Rather than forbid the whole combination
   * in the model (which made every edit inside an emphasised code span
   * unreconcilable), print it without the emphasis on the code characters: a
   * form that is always representable, differing only in styling markdown
   * declines to express here. The retreat is verified against the degraded
   * text, never assumed, and is counted by the round-trip property test so a
   * future printing bug cannot hide behind it.
   */
  function canonPrint(text, marked) {
    var B = { s: '', pos: new Array(text.length), end: new Array(text.length) };
    printCanonInto(text, 0, text.length, B, false);
    if (!marked) return B;
    var re = parseInline(B.s, marked);
    if (re && textEqM(re.text, canonText(text))) return B;
    var exText = canonText(codeExclusive(text));
    var ex = { s: '', pos: new Array(text.length), end: new Array(text.length) };
    printCanonInto(exText, 0, text.length, ex, false);
    var reEx = parseInline(ex.s, marked);
    return (reEx && textEqM(reEx.text, exText)) ? ex : B;
  }

  function printInline(text, prov, marked) { return printInlineParts(text, prov, marked).s; }

  // --- StyledDoc model — block layer ------------------------------------------
  //
  // Block shapes (discriminated on .kind):
  //   { kind:'paragraph'|'quote', text, prov, raw, sep }
  //   { kind:'heading', level, text, prov, raw, sep }
  //   { kind:'listItem', depth, marker, text, prov, raw, sep }
  //     marker: { bullet:'-'|'*'|'+' } | { ordered:true, num, delim:'.'|')' }
  //   { kind:'opaque', raw }
  // raw is the block's original source bytes — print returns it verbatim; an
  // op (or diff) nulls it. sep is the trailing newline run (including a loose
  // list's blank line) so canonical reprints keep the block spacing.

  var LIST_LINE_M = /^([ \t]*)([-*+]|\d+[.)])([ \t]*)(.*)$/;
  // Item content that marked would lex as block structure inside the item —
  // out of the line-wise model's scope.
  var ITEM_BLOCK_HAZARD = /^(\[[ xX]\][ \t]|#{1,6}[ \t]|>|([-*+]|\d+[.)])([ \t]|$))/;

  /**
   * Parse a list segment line-wise into a flat run of listItem blocks.
   *
   * Why a hand scanner and not marked's list token: marked deindents the raws
   * of nested items (a sub-list's item.raw loses its source indentation), so
   * its tree can't reconstruct exact source bytes for depth > 0 — and the
   * reconciler needs those bytes for provenance. The scanner recovers them
   * from the source lines. marked still owns *acceptance*: `parseBlocks` only
   * calls this once marked has classified the segment as a list.
   *
   * The contract that keeps the two model-entry paths symmetric: this must
   * accept every list `readBlocksFromDom` accepts. So a marker-less, non-blank
   * line is a lazy paragraph continuation of the current item (folded in,
   * deindented) — not a refusal. It returns null only for what the DOM side
   * also rejects: task items, and a second paragraph after a blank line.
   */
  function parseListBlocks(raw, marked) {
    var blocks = [], stack = [], pos = 0, n = raw.length;
    // The item lazy continuations fold into, with the deindented inline content
    // gathered across its physical lines; parsed on close (finalize).
    var cur = null;
    function finalize() {
      if (!cur) return true;
      var pr = cur.content === '' ? { text: [], prov: [] } : parseInline(cur.content, marked);
      if (!pr) return false;
      cur.block.text = pr.text; cur.block.prov = pr.prov;
      cur = null;
      return true;
    }
    while (pos < n) {
      var nl = raw.indexOf('\n', pos);
      var lineEnd = nl < 0 ? n : nl;
      var line = raw.slice(pos, lineEnd);
      var lineRaw = raw.slice(pos, nl < 0 ? n : nl + 1);
      var m = line.match(LIST_LINE_M);
      // A leading [-*+]/number opens an item only when followed by whitespace
      // or end of line. "*every*" or "-word" is inline text (emphasis, a
      // hyphenated word) that the browser renders into the current item — not
      // a new bullet — so it must fall through to the continuation path, the
      // way marked reads it. Treating it as a marker was the second face of the
      // same asymmetry: the source side inventing structure the DOM side lacks.
      var marker = m && m[1].indexOf('\t') < 0 && (m[3] !== '' || m[4] === '');
      if (!marker) {
        if (/^[ \t]*$/.test(line) && blocks.length) {
          // blank line inside the segment (loose list) — part of the previous
          // item's separator, and it closes that item's paragraph.
          blocks[blocks.length - 1].sep += lineRaw;
          blocks[blocks.length - 1].raw += lineRaw;
          if (cur) cur.blank = true;
          pos = lineEnd + 1;
          continue;
        }
        // Marker-less, non-blank: a lazy continuation of the current item.
        // Deindent (marked drops the wrap indent) and fold into its content.
        if (cur && !cur.blank) {
          var contLine = line.replace(/^[ \t]*/, '');
          if (ITEM_BLOCK_HAZARD.test(contLine)) return null;
          cur.content += '\n' + contLine;
          cur.block.raw += lineRaw;
          cur.block.sep = nl < 0 ? '' : '\n';
          pos = lineEnd + 1;
          continue;
        }
        return null; // 2nd paragraph after a blank, or no current item
      }
      if (!finalize()) return null; // close the previous item before opening one
      var content = m[4];
      if (ITEM_BLOCK_HAZARD.test(content)) return null;
      var W = m[1].length, mlen = m[2].length;
      while (stack.length && W < stack[stack.length - 1].content) {
        if (W >= stack[stack.length - 1].indent) break;
        stack.pop();
      }
      if (!stack.length || W >= stack[stack.length - 1].content) {
        stack.push({ indent: W, content: W + mlen + 1 });
      } else {
        stack[stack.length - 1] = { indent: W, content: W + mlen + 1 };
      }
      var block = {
        kind: 'listItem',
        depth: stack.length - 1,
        marker: /\d/.test(m[2].charAt(0))
          ? { ordered: true, num: parseInt(m[2], 10), delim: m[2].charAt(m[2].length - 1) }
          : { bullet: m[2] },
        text: [],
        prov: [],
        raw: lineRaw,
        sep: nl < 0 ? '' : '\n',
      };
      blocks.push(block);
      cur = { block: block, content: content, blank: false };
      pos = lineEnd + 1;
    }
    if (!finalize()) return null;
    return blocks.length ? blocks : null;
  }

  /**
   * A pipe table as one block per cell.
   *
   * Cells are the only part of a table anyone edits; the pipes, the alignment
   * row and the column padding are scaffolding. So each cell block owns the
   * source bytes from the end of the previous cell's content up to the end of
   * its own — `pre` is the scaffolding at the front, kept verbatim — and the
   * blocks tile the segment exactly, which is what the offset machinery
   * requires. Editing a cell reprints that cell and nothing else; the table's
   * shape on disk survives untouched, padding and all.
   *
   * The split is done over the source and then *checked* against marked's own
   * cell texts, rather than trusted. Splitting on pipes is not quite a lexer —
   * escaped pipes and pipes inside code spans do not divide cells — so where
   * our reading disagrees with marked's we return null and the table stays
   * read-only, which is the safe direction.
   */
  function parseTableBlocks(segRaw, token, marked) {
    var want = [];
    var h = token.header || [], rows = token.rows || [], i, j;
    for (i = 0; i < h.length; i++) want.push(h[i].text);
    for (i = 0; i < rows.length; i++) for (j = 0; j < rows[i].length; j++) want.push(rows[i][j].text);
    if (!want.length) return null;

    var blocks = [], pos = 0, wi = 0, pendingPre = '';
    var lines = segRaw.split('\n');
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li];
      var lineStart = pos;
      pos += line.length + (li < lines.length - 1 ? 1 : 0);
      // The alignment row and any trailing blank line are scaffolding: hand
      // their bytes to the next cell as prefix, or to the document as the last
      // cell's separator.
      var isDelim = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/.test(line);
      if (isDelim || !line.trim() || wi >= want.length) {
        pendingPre += segRaw.slice(lineStart, pos);
        continue;
      }
      // Split the row on unescaped pipes, keeping every byte.
      var parts = [], cur = '', k;
      for (k = 0; k < line.length; k++) {
        var ch = line.charAt(k);
        if (ch === '\\' && k + 1 < line.length) { cur += ch + line.charAt(++k); continue; }
        if (ch === '|') { parts.push(cur); cur = ''; continue; }
        cur += ch;
      }
      parts.push(cur);
      // A leading or trailing pipe produces an empty outer part that is not a
      // cell; it belongs to the scaffolding.
      var lead = '', trail = '';
      if (parts.length > 1 && !parts[0].trim()) { lead = parts.shift() + '|'; }
      if (parts.length > 1 && !parts[parts.length - 1].trim()) { trail = '|' + parts.pop(); }

      for (k = 0; k < parts.length; k++) {
        if (wi >= want.length) return null;
        var cellRaw = parts[k];
        // tm is taken from the remainder AFTER lm, or a whitespace-only cell
        // (an empty cell, "| |") counts its padding twice — once as leading,
        // once as trailing — and the tiling check below rejects the table,
        // silently demoting it to read-only.
        var lm = /^[ \t]*/.exec(cellRaw)[0];
        var tm = /[ \t]*$/.exec(cellRaw.slice(lm.length))[0];
        var content = cellRaw.slice(lm.length, cellRaw.length - tm.length);
        // marked reports a cell's text with its escaped pipes already
        // unescaped, since only an unescaped one divides cells. Compare on
        // those terms; the model still parses the source form, where "\|" is an
        // ordinary escape and shows the same character.
        if (content.replace(/\\\|/g, '|') !== want[wi]) return null; // our split is not marked's
        var pr = parseInline(content, marked);
        if (!pr) return null;
        // The cell must show what marked says it shows. GFM strips the escape
        // from "\|" before parsing the cell's inlines, so inside a code span —
        // where a backslash is otherwise literal — our reading of the source
        // and marked's reading of the cell diverge. Comparing the two parses
        // catches exactly that case and leaves the table read-only, instead of
        // handing back a model whose text is one character off from the screen.
        var pw = parseInline(want[wi], marked);
        if (!pw || !textEqM(pr.text, pw.text)) return null;
        var prefix = pendingPre + (k === 0 ? lead : '|') + lm;
        blocks.push({
          kind: 'cell', text: pr.text, prov: pr.prov,
          raw: prefix + content, pre: prefix, sep: '',
        });
        wi++;
        // This cell's trailing padding rides on the next cell's prefix, so the
        // blocks tile the source without gaps.
        pendingPre = tm;
      }
      pendingPre += trail + (li < lines.length - 1 ? '\n' : '');
    }
    if (wi !== want.length || !blocks.length) return null;
    // The table's tail — the closing pipe, its padding, the newline — belongs to
    // the last cell twice over: inside `raw`, which the printer emits verbatim
    // while the cell is untouched, and in `sep`, which it appends when the cell
    // has been reprinted. Keeping it in only one of the two loses those bytes
    // down whichever path is not taken.
    var last = blocks[blocks.length - 1];
    last.sep = pendingPre;
    last.raw += pendingPre;
    // The blocks must account for every byte of the segment, or every offset
    // downstream of the table drifts.
    var total = '';
    for (i = 0; i < blocks.length; i++) total += blocks[i].raw;
    return total === segRaw ? blocks : null;
  }

  function parseBlocks(segRaw, marked) {
    var token;
    try { token = marked.lexer(segRaw)[0]; } catch (_) { return null; }
    if (!token) return null;
    var content, pr, sep;
    switch (token.type) {
      case 'paragraph':
        content = segRaw.replace(/\n+$/, '');
        pr = parseInline(content, marked);
        if (!pr) return null;
        return [{ kind: 'paragraph', text: pr.text, prov: pr.prov, raw: segRaw, sep: segRaw.slice(content.length) }];
      case 'heading':
        pr = parseInline(token.text, marked);
        if (!pr) return null;
        sep = (segRaw.match(/\n*$/) || [''])[0];
        return [{ kind: 'heading', level: token.depth, text: pr.text, prov: pr.prov, raw: segRaw, sep: sep }];
      case 'blockquote': {
        // Acceptance is marked's: its blockquote token already de-prefixes the
        // `>` markers and joins lazy continuations into inner block tokens. We
        // only model a single-paragraph quote — exactly what readBlocksFromDom
        // accepts (one <p> child) — so the source side can never reject a quote
        // the DOM side keeps. The hand-rolled `>`-prefix line scan this
        // replaced rejected lazy continuations marked accepts (uneditable).
        var inner = token.tokens.filter(function (t) { return t.type !== 'space'; });
        if (inner.length !== 1 || inner[0].type !== 'paragraph') return null; // multi-block quote — out of model
        // marked can report a quote's text with whitespace the source never
        // had: "> foo\nbar\n===" comes back with the "===" indented four
        // spaces. The display then agrees with the render while every source
        // offset past the injected run is wrong, which is worse than declining
        // — a silently misplaced caret rather than a visibly read-only block.
        var deprefixed = segRaw.replace(/\n+$/, '').split('\n')
          .map(function (l) { return l.replace(/^[ \t]{0,3}>[ \t]?/, ''); }).join('\n')
          .replace(/^[ \t]*\n/, '').replace(/\n[ \t]*$/, ''); // blank first/last lines are marked's to drop
        if (deprefixed !== inner[0].text) return null;
        pr = parseInline(inner[0].text, marked);
        if (!pr) return null;
        content = segRaw.replace(/\n+$/, '');
        return [{ kind: 'quote', text: pr.text, prov: pr.prov, raw: segRaw, sep: segRaw.slice(content.length) }];
      }
      case 'table':
        return parseTableBlocks(segRaw, token, marked);
      case 'list':
        return parseListBlocks(segRaw, marked);
      default:
        return null;
    }
  }

  /** Parse a whole document; segments outside the model become opaque blocks. */
  function parseDoc(md, marked) {
    var segs = segment(md, marked), blocks = [];
    for (var i = 0; i < segs.length; i++) {
      var bs = segs[i].editable ? parseBlocks(segs[i].raw, marked) : null;
      if (bs) blocks.push.apply(blocks, bs);
      else blocks.push({ kind: 'opaque', raw: segs[i].raw });
    }
    return { blocks: blocks };
  }

  // A canonically-printed line must not re-lex as block structure (a printed
  // paragraph line starting "- " would become a list). Escape the marker;
  // `at` reports where the backslash went so caret mapping can shift past it.
  function guardBlockPrefixPos(line) {
    var m = line.match(/^([ \t]*)(#{1,6})[ \t]/);
    if (m) return { s: line.slice(0, m[1].length) + '\\' + line.slice(m[1].length), at: m[1].length };
    m = line.match(/^([ \t]*)([-*+])([ \t]|$)/);
    if (m) return { s: line.slice(0, m[1].length) + '\\' + line.slice(m[1].length), at: m[1].length };
    m = line.match(/^([ \t]*)(\d+)([.)])([ \t]|$)/);
    if (m) return { s: m[1] + m[2] + '\\' + line.slice(m[1].length + m[2].length), at: m[1].length + m[2].length };
    m = line.match(/^([ \t]*)(=+|-+)[ \t]*$/); // setext underline / hr
    if (m) return { s: line.slice(0, m[1].length) + '\\' + line.slice(m[1].length), at: m[1].length };
    if (line.charAt(0) === '>') return { s: '\\' + line, at: 0 };
    return { s: line, at: -1 };
  }
  function guardBlockPrefix(line) { return guardBlockPrefixPos(line).s; }

  /**
   * Render a styled (non-listItem) block's body — prefix + inline content,
   * sans separator. When `ch` is given, `pos` maps that char index to a byte
   * offset within the body (through guard escapes and quote prefixes).
   */
  function renderBlockBody(b, marked, ch) {
    var parts = printInlineParts(canonText(b.text), b.prov || null, marked);
    var inline = parts.s;
    var local = -1;
    if (ch != null) {
      local = ch >= b.text.length ? inline.length : parts.pos[ch];
      if (local == null) local = inline.length;
    }
    if (b.kind === 'cell') {
      // Everything before the content is table scaffolding — pipes, padding,
      // the alignment row that preceded this cell — and is reproduced byte for
      // byte. Only the cell's own text is reprinted, so editing one cell never
      // reflows the table on disk.
      var cpre = b.pre != null ? b.pre : '|';
      // A literal pipe would divide the cell in two, so every unescaped one is
      // escaped on the way out. GFM applies the escape before inline parsing,
      // so this is right inside a code span as well — `a \| b` shows "a | b".
      var esc = '', shift = 0;
      for (var ci = 0; ci < inline.length; ci++) {
        if (inline.charAt(ci) === '|') { esc += '\\|'; if (local >= 0 && ci < local) shift++; }
        else esc += inline.charAt(ci);
      }
      return { s: cpre + esc, pos: local >= 0 ? cpre.length + local + shift : -1 };
    }
    if (b.kind === 'heading') {
      // Two things ATX cannot hold, both of which setext can. A newline: ATX is
      // single-line, so "## Foo\nBar" lexes as a heading followed by a
      // paragraph. And leading whitespace: the hashes swallow it, so "  Foo"
      // came back as "Foo" and the edit landed a character short. Only levels 1
      // and 2 have a setext form, and only those can carry either.
      if ((inline.indexOf('\n') >= 0 || /^\s/.test(inline)) && (b.level === 1 || b.level === 2)) {
        return { s: inline + '\n' + (b.level === 1 ? '===' : '---'), pos: local >= 0 ? local : -1 };
      }
      var pre = new Array((b.level || 1) + 1).join('#') + ' ';
      return { s: pre + inline, pos: local >= 0 ? pre.length + local : -1 };
    }
    var quote = b.kind === 'quote';
    var lines = inline.split('\n'), built = '', acc = 0, pos = -1;
    for (var li = 0; li < lines.length; li++) {
      var g = guardBlockPrefixPos(lines[li]);
      var prefix = quote ? (g.s ? '> ' : '>') : '';
      if (local >= acc && local <= acc + lines[li].length && pos < 0) {
        var rel = local - acc;
        if (g.at >= 0 && rel > g.at) rel++;
        pos = built.length + prefix.length + rel;
      }
      built += prefix + g.s;
      if (li < lines.length - 1) built += '\n';
      acc += lines[li].length + 1;
    }
    return { s: built, pos: pos };
  }

  function markerTextOf(marker) {
    if (marker && marker.ordered) return marker.num + marker.delim;
    return (marker && marker.bullet) || '-';
  }

  /**
   * Print a run of blocks. Untouched blocks (raw non-null) pass through
   * byte-identical; touched blocks print canonically, with list indentation
   * derived from the actual parent marker width (marked's content-column
   * nesting rule — 2 spaces under "- ", 3 under "1. ").
   *
   * `caret` ({ block, ch }) is optional: the printer records the byte offset
   * of char `ch` of block `block` into caret.offset.
   */
  function printBlocks(blocks, marked, caret) {
    var out = '', sibIndent = [], childIndent = [];
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      var wantCaret = caret && caret.block === i;
      if (b.kind !== 'listItem') { sibIndent = []; childIndent = []; }
      if (b.kind === 'opaque') {
        if (wantCaret) caret.offset = out.length;
        out += b.raw;
        continue;
      }
      if (b.kind === 'listItem') {
        var indent, mk;
        if (b.raw != null) {
          var firstNl = b.raw.indexOf('\n');
          var lm = b.raw.slice(0, firstNl < 0 ? b.raw.length : firstNl).match(LIST_LINE_M);
          indent = lm ? lm[1] : '';
          mk = lm ? lm[2] : '-';
        } else {
          indent = sibIndent[b.depth] != null ? sibIndent[b.depth]
            : childIndent[b.depth - 1] != null ? childIndent[b.depth - 1]
            : new Array(b.depth + 1).join('  ');
          mk = markerTextOf(b.marker);
        }
        sibIndent.length = b.depth + 1;
        childIndent.length = b.depth + 1;
        sibIndent[b.depth] = indent;
        childIndent[b.depth] = indent + new Array(mk.length + 2).join(' ');
        if (b.raw != null) {
          if (wantCaret) caret.offset = out.length;
          out += b.raw;
          continue;
        }
        var sepL = b.sep != null ? b.sep : '\n';
        if (!b.text.length) {
          // an empty item is a bare marker: "- " with a trailing space lexes
          // as a paragraph at the head or tail of a list, bare "-" is an item
          // in every position; an indented empty "-" would lex as a setext
          // underline, so it becomes "*"
          if (b.depth > 0 && mk === '-') mk = '*';
          if (wantCaret) caret.offset = out.length + indent.length + mk.length;
          out += indent + mk + sepL;
          continue;
        }
        var parts = printInlineParts(canonText(b.text), b.prov || null, marked);
        if (wantCaret) {
          var local = caret.ch >= b.text.length ? parts.s.length : parts.pos[caret.ch];
          if (local == null) local = parts.s.length;
          caret.offset = out.length + indent.length + mk.length + 1 + local;
        }
        out += indent + mk + ' ' + parts.s + sepL;
        continue;
      }
      if (b.raw != null) {
        if (wantCaret) caret.offset = out.length;
        out += b.raw;
        continue;
      }
      var sep = b.sep != null ? b.sep : '\n';
      var body = renderBlockBody(b, marked, wantCaret ? caret.ch : null);
      if (wantCaret) caret.offset = out.length + (body.pos >= 0 ? body.pos : body.s.length);
      out += body.s + sep;
    }
    return out;
  }

  function printDoc(doc, marked) { return printBlocks(doc.blocks, marked); }

  // --- DOM readback ------------------------------------------------------------
  //
  // The promoted canonicalOfEl: the same walk and the same allowlist (empty
  // inline formatting elements and empty <p> are browser leftovers and are
  // ignored), but producing model blocks instead of a fingerprint string.
  // Returns null when the DOM holds structure outside the model — the caller
  // refuses the edit rather than guessing.

  var READ_INLINE_TAGS = { STRONG: 'b', B: 'b', EM: 'i', I: 'i', CODE: 'code', DEL: 'del', S: 'del', STRIKE: 'del' };

  // --- visibility -----------------------------------------------------------------
  // The DOM the reconciler reads has been chewed on by WebKit's editing
  // engine, which strews placeholder nodes — a caret <br>, emptied <li>s,
  // stray wrappers — that no rendered markdown contains. Rather than
  // cataloguing those artifacts, readback and the canonical fingerprint both
  // judge nodes by what they RENDER: a subtree that shows nothing is a
  // leftover to skip, whatever its tags; only nodes with visible content may
  // refuse an edit. Safe because reconcileDomEdit's acceptance compares
  // display text and canonical structure — skipping can never drop anything
  // visible. VISIBLE_EMPTY: elements that render without text content.
  var VISIBLE_EMPTY = 'img,hr,input,video,audio,iframe,embed,object,canvas,svg,button,select,textarea,progress,meter';
  var VISIBLE_EMPTY_TAGS = (function () {
    var m = {};
    VISIBLE_EMPTY.split(',').forEach(function (t) { m[t.toUpperCase()] = 1; });
    return m;
  })();
  function subtreeVisible(n) {
    if (n.nodeType === 3) return n.textContent.length > 0;
    if (n.nodeType !== 1) return false;
    if (VISIBLE_EMPTY_TAGS[n.tagName.toUpperCase()]) return true;
    return !!n.textContent.length || !!n.querySelector(VISIBLE_EMPTY);
  }
  // A <br> renders a line break only when something visible follows it inside
  // its block; trailing, or alone in an emptied block, it is the editing
  // engine's caret placeholder.
  function brIsContent(br, root) {
    var block = br.parentNode, tag;
    while (block !== root) {
      tag = (block.tagName || '').toUpperCase();
      if (tag === 'P' || tag === 'LI' || tag === 'BLOCKQUOTE' || /^H[1-6]$/.test(tag)) break;
      block = block.parentNode;
    }
    var n = br;
    for (;;) {
      while (!n.nextSibling) {
        n = n.parentNode;
        if (!n || n === block) return false;
      }
      n = n.nextSibling;
      if (subtreeVisible(n)) return true;
    }
  }

  // marked trims leading and trailing whitespace from every block's rendered
  // text, so no markdown source can reproduce a block whose text starts or ends
  // with whitespace. WebKit's editing engine strands exactly that — an &nbsp;
  // injected after a delete, a space typed at an edge — and a block carrying it
  // could never reconcile (it would revert, losing the edit it rode in on).
  // Return a clone with each renderable container's edge whitespace trimmed, so
  // the DOM reads back the way a source would render it.
  //
  // The edge is found by CONTENT, not by text node: a visible code span or
  // image at a block's boundary IS the boundary, and the space in the text
  // node beside it ("via `/tdd`") is rendered inter-word content, not an
  // artifact — trimming it would glue the words ("via/tdd"). Only when the
  // outermost item on a side is a text node can that side hold an artifact.
  var EDGE_TRIM_SEL = 'h1,h2,h3,h4,h5,h6,p,li,td,th';
  var EDGE_BLOCK = { UL: 1, OL: 1, LI: 1, P: 1, BLOCKQUOTE: 1, PRE: 1, TABLE: 1, DIV: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, TD: 1, TH: 1 };
  function edgeItems(container) {
    var out = [];
    (function walk(node) {
      for (var n = node.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3) { out.push(n); continue; }
        if (n.nodeType !== 1) continue;
        var tag = n.tagName.toUpperCase();
        if (n !== container && EDGE_BLOCK[tag]) continue;   // a nested block — not this container's edge
        if (tag === 'CODE' || VISIBLE_EMPTY_TAGS[tag]) {
          // Opaque inline content (code span, image, …): when visible it can
          // occupy the edge; when empty it's an editing leftover to skip past.
          if (subtreeVisible(n)) out.push(n);
          continue;
        }
        walk(n);
      }
    })(container);
    return out;
  }
  function edgeContainersOf(root) {
    var conts = [];
    if (/^(H[1-6]|P|LI)$/.test((root.tagName || '').toUpperCase())) conts.push(root);
    if (root.querySelectorAll) {
      var found = root.querySelectorAll(EDGE_TRIM_SEL);
      for (var i = 0; i < found.length; i++) conts.push(found[i]);
    }
    return conts;
  }
  // With `srcEl` given, an edge is trimmed only where srcEl's corresponding
  // container has no whitespace at that same edge. The whitespace decision must
  // be per-edge, not block-global: one item can legitimately end in a
  // source-held space ("**chalie** ") while WebKit strands an &nbsp; at another
  // item's edge — an all-or-nothing reading makes that block permanently
  // unreconcilable. Containers are matched by position; when the two structures
  // disagree (an edit is reshaping the block), fall back to trimming
  // everything — the caller's acceptance checks still gate the result.
  function normalizeBoundaryWs(el, srcEl) {
    var clone = el.cloneNode(true);
    var conts = edgeContainersOf(clone);
    var srcConts = srcEl ? edgeContainersOf(srcEl) : null;
    var aligned = srcConts !== null && srcConts.length === conts.length;
    for (var c = 0; c < conts.length; c++) {
      var items = edgeItems(conts[c]);
      if (!items.length) continue;
      var first = items[0], last = items[items.length - 1];
      var keepLead = false, keepTail = false;
      if (aligned) {
        var sItems = edgeItems(srcConts[c]);
        var sFirst = sItems.length ? sItems[0] : null;
        var sLast = sItems.length ? sItems[sItems.length - 1] : null;
        keepLead = !!(sFirst && sFirst.nodeType === 3 && /^\s/.test(sFirst.textContent));
        keepTail = !!(sLast && sLast.nodeType === 3 && /\s$/.test(sLast.textContent));
      }
      if (first.nodeType === 3 && !keepLead) first.textContent = first.textContent.replace(/^\s+/, '');
      if (last.nodeType === 3 && !keepTail) last.textContent = last.textContent.replace(/\s+$/, '');
    }
    return clone;
  }

  function readBlocksFromDom(el, base) {
    var root = el.cloneNode(true);
    stripStructuralWhitespace(root);
    function deBase(v) {
      v = v || '';
      return base && v.indexOf(base) === 0 ? v.slice(base.length) : v;
    }
    var blocks = [];

    function readInlineNode(n, attrs, out) {
      if (n.nodeType === 3) {
        var s = n.textContent;
        for (var k = 0; k < s.length; k++) out.push({ ch: s.charAt(k), attrs: copyAttrs(attrs) });
        return true;
      }
      if (n.nodeType !== 1) return true;
      var tag = n.tagName.toUpperCase();
      if (tag === 'IMG') {
        out.push({ obj: 'image', src: deBase(n.getAttribute('src')), alt: n.getAttribute('alt') || '', title: n.getAttribute('title') || '', attrs: copyAttrs(attrs) });
        return true;
      }
      if (!subtreeVisible(n)) return true; // zombie/leftover, incl. placeholder <br>
      var a2;
      // Symmetry with parseInline: two code spans that end up touching are one
      // run of identical chars in this model, so neither side may accept what
      // the other refuses — the DOM would read back a block the source parser
      // cannot fold an edit into.
      if (READ_INLINE_TAGS[tag] === 'code' && out.length &&
          !out[out.length - 1].obj && out[out.length - 1].attrs.code) return false;
      if (READ_INLINE_TAGS[tag]) { a2 = copyAttrs(attrs); a2[READ_INLINE_TAGS[tag]] = true; }
      else if (tag === 'A') { a2 = copyAttrs(attrs); a2.link = { href: deBase(n.getAttribute('href')), title: n.getAttribute('title') || '' }; }
      else return false; // visible unknown structure (inputs, wrappers with content)
      for (var c = n.firstChild; c; c = c.nextSibling) if (!readInlineNode(c, a2, out)) return false;
      return true;
    }
    function readInline(container, out) {
      for (var n = container.firstChild; n; n = n.nextSibling) if (!readInlineNode(n, {}, out)) return false;
      return true;
    }

    function readList(listEl, depth) {
      var ordered = listEl.tagName.toUpperCase() === 'OL';
      var num = parseInt(listEl.getAttribute('start') || '1', 10);
      for (var li = listEl.firstChild; li; li = li.nextSibling) {
        if (li.nodeType === 3) { if (/^\s*$/.test(li.textContent)) continue; return false; }
        if (li.nodeType !== 1 || li.tagName.toUpperCase() !== 'LI') return false;
        if (!subtreeVisible(li)) {
          // Visually empty item — whatever placeholder nodes it holds (<br>,
          // empty <p>) are deletion leftovers, not content. Keep the bullet.
          blocks.push({ kind: 'listItem', depth: depth, marker: null, ordered: ordered, num: num, text: [], prov: null, raw: null, sep: null });
          num++;
          continue;
        }
        var text = [], nested = [], seenP = false;
        for (var n = li.firstChild; n; n = n.nextSibling) {
          var tag = n.nodeType === 1 ? n.tagName.toUpperCase() : '';
          if (tag === 'UL' || tag === 'OL') { nested.push(n); continue; }
          if (nested.length) {
            if (n.nodeType === 3 && /^\s*$/.test(n.textContent)) continue;
            return false; // inline content after a nested list
          }
          if (tag === 'P') {
            if (!subtreeVisible(n)) continue; // leftover
            if (seenP || text.length) return false; // multi-paragraph item
            seenP = true;
            if (!readInline(n, text)) return false;
            continue;
          }
          if (tag === 'INPUT') return false; // task list
          if (!readInlineNode(n, {}, text)) return false;
        }
        blocks.push({ kind: 'listItem', depth: depth, marker: null, ordered: ordered, num: num, text: text, prov: null, raw: null, sep: null });
        for (var q = 0; q < nested.length; q++) {
          if (!readList(nested[q], depth + 1)) return false;
        }
        num++;
      }
      return true;
    }

    // Cells in document order — header first, then each row. Only their text
    // is read: the table's shape stays whatever the source says, so a cell
    // added or removed in the DOM is a structure change we decline rather than
    // guess at (the block counts will not match and the edit is refused).
    function readTable(tableEl) {
      var rows = tableEl.getElementsByTagName('tr');
      for (var r = 0; r < rows.length; r++) {
        for (var c = rows[r].firstChild; c; c = c.nextSibling) {
          if (c.nodeType === 3) { if (/^\s*$/.test(c.textContent)) continue; return false; }
          if (c.nodeType !== 1) continue;
          var t = c.tagName.toUpperCase();
          if (t !== 'TD' && t !== 'TH') return false;
          var ct = [];
          if (!readInline(c, ct)) return false;
          blocks.push({ kind: 'cell', text: ct, prov: null, raw: null, pre: null, sep: '' });
        }
      }
      return true;
    }

    function walk(container) {
      for (var n = container.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3) { if (/^\s*$/.test(n.textContent)) continue; return false; }
        if (n.nodeType !== 1) continue;
        var tag = n.tagName.toUpperCase();
        var hm = tag.match(/^H([1-6])$/);
        if (hm) {
          var ht = [];
          if (!readInline(n, ht)) return false;
          blocks.push({ kind: 'heading', level: parseInt(hm[1], 10), text: ht, prov: null, raw: null, sep: null });
        } else if (tag === 'P') {
          if (!subtreeVisible(n)) continue; // leftover
          var pt = [];
          if (!readInline(n, pt)) return false;
          blocks.push({ kind: 'paragraph', text: pt, prov: null, raw: null, sep: null });
        } else if (tag === 'BLOCKQUOTE') {
          var ps = [];
          for (var c = n.firstChild; c; c = c.nextSibling) {
            if (c.nodeType === 3) { if (!/^\s*$/.test(c.textContent)) return false; continue; }
            if (c.nodeType !== 1) continue;
            if (!subtreeVisible(c)) continue; // leftover
            if (c.tagName.toUpperCase() !== 'P') return false;
            ps.push(c);
          }
          if (ps.length > 1) return false; // multi-block quote — out of model
          var qt = [];
          if (ps.length && !readInline(ps[0], qt)) return false;
          blocks.push({ kind: 'quote', text: qt, prov: null, raw: null, sep: null });
        } else if (tag === 'TABLE') {
          if (!readTable(n)) return false;
        } else if (tag === 'UL' || tag === 'OL') {
          if (!readList(n, 0)) return false;
        } else if (!subtreeVisible(n)) {
          continue; // invisible junk (placeholder <br>, emptied wrappers)
        } else {
          return false; // visible structure outside the model
        }
      }
      return true;
    }

    return walk(root) ? blocks : null;
  }

  // --- model diff ----------------------------------------------------------------

  function markerEqM(a, b) {
    if (!a || !b) return false;
    if (a.bullet) return a.bullet === b.bullet;
    return !!b.ordered && a.num === b.num && a.delim === b.delim;
  }

  // Structural agreement — text aside. A readback block's marker is null
  // (markers aren't in the DOM) and matches anything of the right orderedness.
  function blockStructEq(o, n) {
    if (o.kind !== n.kind) return false;
    if (o.kind === 'cell') return true; // a cell's identity is its position
    if (o.kind === 'heading' && o.level !== n.level) return false;
    if (o.kind === 'listItem') {
      if (o.depth !== n.depth) return false;
      if (n.marker) { if (!markerEqM(o.marker, n.marker)) return false; }
      else if (n.ordered !== undefined && !o.marker.ordered !== !n.ordered) return false;
    }
    return true;
  }

  function blockMatches(o, n) {
    return o.kind !== 'opaque' && blockStructEq(o, n) && textEqM(o.text, n.text);
  }

  // Marker for a new item: nearest sibling at the same depth (continuing its
  // numbering), else the DOM's orderedness hint, else "-".
  function synthMarker(nb, ctx, k, oldBlocks) {
    if (nb.kind !== 'listItem') return null;
    var src = null, i;
    for (i = k - 1; i >= 0 && !src; i--) {
      if (ctx[i] && ctx[i].kind === 'listItem' && ctx[i].depth === nb.depth) src = ctx[i].marker;
    }
    for (i = 0; i < oldBlocks.length && !src; i++) {
      if (oldBlocks[i].kind === 'listItem' && oldBlocks[i].depth === nb.depth) src = oldBlocks[i].marker;
    }
    if (src && src.ordered && nb.ordered !== false) return { ordered: true, num: src.num + 1, delim: src.delim };
    if (src && src.bullet && !nb.ordered) return { bullet: src.bullet };
    return nb.ordered ? { ordered: true, num: nb.num || 1, delim: '.' } : { bullet: '-' };
  }

  /**
   * Adopt provenance from the old parse into freshly-read blocks: blocks in
   * the common prefix/suffix are taken wholesale (raw and all), and inside
   * the changed region structure-matched pairs keep their inline provenance,
   * marker, and separator so the printer can reuse original bytes.
   */
  function diffBlocks(oldBlocks, newBlocks) {
    var oN = oldBlocks.length, nN = newBlocks.length;
    var out = new Array(nN);
    var lo = 0;
    while (lo < oN && lo < nN && blockMatches(oldBlocks[lo], newBlocks[lo])) {
      out[lo] = oldBlocks[lo];
      lo++;
    }
    var hiO = oN, hiN = nN;
    while (hiO > lo && hiN > lo && blockMatches(oldBlocks[hiO - 1], newBlocks[hiN - 1])) {
      hiO--; hiN--;
      out[hiN] = oldBlocks[hiO];
    }
    for (var k = lo; k < hiN; k++) {
      var nb = newBlocks[k];
      var ob = (lo + (k - lo) < hiO) ? oldBlocks[lo + (k - lo)] : null;
      var adopted = {
        kind: nb.kind, level: nb.level, depth: nb.depth,
        marker: null, text: nb.text, prov: null, raw: null, sep: '\n',
      };
      if (ob && blockStructEq(ob, nb)) {
        adopted.prov = ob.prov;
        if (nb.kind === 'cell') adopted.pre = ob.pre; // scaffolding is not in the DOM
        adopted.sep = ob.sep != null ? ob.sep : '\n';
        adopted.marker = nb.marker || ob.marker;
      } else {
        adopted.marker = nb.marker || synthMarker(nb, out, k, oldBlocks);
        if (k === nN - 1 && oN && oldBlocks[oN - 1].sep != null) adopted.sep = oldBlocks[oN - 1].sep;
      }
      out[k] = adopted;
    }
    return out;
  }

  // --- Bold / italic toggle ------------------------------------------------

  // Inline content span [fs, fe) of the line/block the selection sits in,
  // plus the block's lexed type. Paragraph content is the whole block
  // (emphasis may span soft breaks); everything else is line-scoped, with
  // quote/list/heading markers excluded via the prefix match.
  var LINE_PREFIX = /^(\s*(?:>[ \t]?|[-*+][ \t]+|\d+[.)][ \t]+)*)(#{1,6}[ \t]+)?/;
  function inlineFragSpanAt(s, start, end, marked) {
    var tok;
    try { tok = marked.lexer(s)[0]; } catch (_) { return null; }
    if (!tok) return null;
    if (tok.type === 'paragraph') {
      var fe = s.replace(/\n+$/, '').length;
      return start >= 0 && end <= fe ? { fs: 0, fe: fe, type: tok.type } : null;
    }
    var ls = s.lastIndexOf('\n', start - 1) + 1;
    var le = s.indexOf('\n', start);
    if (le < 0) le = s.length;
    var m = s.slice(ls, le).match(LINE_PREFIX);
    var fs = ls + (m ? m[0].length : 0);
    return start >= fs && end <= le ? { fs: fs, fe: le, type: tok.type } : null;
  }

  // Snap a source offset (relative to the fragment) to a char index, through
  // the provenance spans (their raws tile the fragment). Inside a pure text
  // span the mapping is linear; inside a delimited span it is linear past the
  // leading delimiter, clamped to the span's chars.
  /**
   * Where each display char of a provenance span begins in its source bytes,
   * for spans built out of plain text, entities and backslash escapes — the
   * ones whose source is longer than what they show, with no delimiters to
   * account for. Returns null when the walk does not land exactly on the
   * span's char count, which is the signal that the span is something else
   * (an emphasis run, a link) and the caller should use its own reasoning.
   */
  function unitStarts(raw, chars) {
    var starts = [], i = 0, k = 0;
    while (i < raw.length && k < chars.length) {
      if (chars[k].obj) return null; // an image is not spelled out in the text
      var m = /^&(#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/.exec(raw.slice(i));
      var len = m ? m[0].length
        : (raw.charAt(i) === '\\' && i + 1 < raw.length) ? 2
        : chars[k].ch.length; // a surrogate pair spans two code units
      starts.push(i);
      i += len;
      k++;
    }
    return (i === raw.length && k === chars.length) ? starts : null;
  }

  function srcToCharIdx(prov, srcOff) {
    var acc = 0;
    for (var k = 0; k < prov.length; k++) {
      var sp = prov[k], re = acc + sp.raw.length, n = sp.to - sp.from;
      if (srcOff < re) {
        if (srcOff <= acc) return sp.from;
        var plain = '';
        for (var c = 0; c < sp.chars.length; c++) plain += sp.chars[c].obj ? '\x00' : sp.chars[c].ch;
        if (sp.raw === plain) return sp.from + Math.min(srcOff - acc, n);
        // A span whose bytes differ from its display only because of entities
        // and backslash escapes maps exactly, one source unit per char. The
        // interpolation below cannot: it assumes every char costs one byte
        // after a fixed leading delimiter, so in "foo&amp;bar" every offset
        // past the entity resolved four characters short — a caret misplaced
        // in any text containing an entity, which is most real documents.
        var starts = unitStarts(sp.raw, sp.chars);
        if (starts) {
          var d = srcOff - acc, u = 0;
          while (u + 1 < starts.length && starts[u + 1] <= d) u++;
          return sp.from + Math.min(u, n);
        }
        var lead = provLeadLen(sp.raw);
        return sp.from + Math.max(0, Math.min(srcOff - acc - lead, n));
      }
      acc = re;
    }
    return prov.length ? prov[prov.length - 1].to : 0;
  }

  /**
   * Toggle bold/italic over a source range [start,end) within one block's
   * markdown. Returns { md, selStart, selEnd } or null if the toggle is
   * refused (nothing togglable, unsupported constructs, or the result would
   * not re-lex as the same block showing the same text). kind is 'strong' or
   * 'em'. Implemented as parse → toggleAttr → canonicalize → print with
   * raw-reuse — no delimiter arithmetic.
   */
  function tryToggle(s, span, pr, a, b, attr, marked) {
    var toggled = toggleAttr(pr.text, a, b, attr);
    if (toggled === pr.text) return null;
    var B = printInlineParts(canonText(toggled), pr.prov, marked);
    var md = s.slice(0, span.fs) + B.s + s.slice(span.fe);
    // Refusal contract: the result must still lex as one block of the same
    // type displaying exactly the same text, or the op does not happen.
    var toks;
    try { toks = marked.lexer(md); } catch (_) { return null; }
    var real = [];
    for (var t = 0; t < toks.length; t++) if (toks[t].type !== 'space') real.push(toks[t]);
    if (real.length !== 1 || real[0].type !== span.type) return null;
    if (displayTextOf(md, marked) !== displayTextOf(s, marked)) return null;
    return { md: md, selStart: span.fs + B.pos[a], selEnd: span.fs + B.end[b - 1] };
  }
  var EDGE_SLOP = /[\s!-\/:-@\[-`{-~¡¿‐-‧‰-⁞]/;
  function toggleEmphasis(s, start, end, kind, marked) {
    var span = inlineFragSpanAt(s, start, end, marked);
    if (!span) return null;
    var frag = s.slice(span.fs, span.fe);
    var pr = parseInline(frag, marked);
    if (!pr) return null;
    var a = srcToCharIdx(pr.prov, start - span.fs);
    var b = srcToCharIdx(pr.prov, end - span.fs);
    if (a >= b) return null;
    var attr = kind === 'strong' ? 'b' : 'i';
    // "Select the words, not the trailing period": when an un-toggle covers a
    // run except for attributed punctuation/whitespace at its edges, the user
    // means the whole run — snap to it. Splitting at the selection instead
    // either refuses outright (a stranded "**.**" is unrepresentable under
    // flanking rules, so Cmd+B silently did nothing) or leaves silly bold
    // punctuation behind ('**"**Not today**."**'). A selection that leaves
    // real letters emphasized on either side is a genuine split and takes the
    // strict path unchanged.
    function hasAttr(i) { return i >= 0 && i < pr.text.length && pr.text[i].attrs && pr.text[i].attrs[attr]; }
    function slop(i) { return hasAttr(i) && pr.text[i].ch != null && EDGE_SLOP.test(pr.text[i].ch); }
    var covered = true;
    for (var i = a; i < b; i++) if (!hasAttr(i)) { covered = false; break; }
    if (covered) {
      var a2 = a, b2 = b;
      while (slop(a2 - 1)) a2--;
      while (slop(b2)) b2++;
      if ((a2 !== a || b2 !== b) && !hasAttr(a2 - 1) && !hasAttr(b2)) { a = a2; b = b2; }
    }
    return tryToggle(s, span, pr, a, b, attr, marked);
  }

  // --- StyledDoc model — block ops --------------------------------------------
  //
  // Each op is a function on the block list — definitional, no delimiters.
  // Splitting slices a text array (emphasis close/reopen across the split is
  // free: attrs travel with the chars); merging concatenates; indenting is
  // depth±1. The wrappers below keep the original string-based signatures.

  function blockWith(b, over) {
    var out = {
      kind: b.kind, level: b.level, depth: b.depth, marker: b.marker,
      text: b.text, prov: b.prov, raw: b.raw, sep: b.sep,
    };
    for (var k in over) out[k] = over[k];
    return out;
  }

  /**
   * Split block i at char index ch. Returns { blocks } — or, for Return on an
   * empty list item, { exit, before, after } (block lists) so the caller can
   * leave the list. Null on opaque blocks.
   */
  function splitBlockM(blocks, i, ch) {
    var b = blocks[i];
    if (!b || b.kind === 'opaque') return null;
    if (b.kind === 'listItem' && !b.text.length) {
      return { exit: true, before: blocks.slice(0, i), after: blocks.slice(i + 1) };
    }
    var left, right;
    if (b.kind === 'listItem') {
      left = blockWith(b, { text: b.text.slice(0, ch), raw: null, sep: '\n' });
      right = blockWith(b, {
        marker: b.marker && b.marker.ordered
          ? { ordered: true, num: b.marker.num + 1, delim: b.marker.delim }
          : { bullet: (b.marker && b.marker.bullet) || '-' },
        text: b.text.slice(ch), raw: null,
        // a new empty trailing item prints as a bare marker (sep '')
        sep: (ch >= b.text.length && i === blocks.length - 1) ? '' : (b.sep != null ? b.sep : '\n'),
      });
    } else {
      left = blockWith(b, { text: b.text.slice(0, ch), raw: null, sep: '\n\n' });
      right = {
        kind: 'paragraph', text: b.text.slice(ch), prov: b.prov, raw: null,
        sep: b.sep != null ? b.sep : '\n',
      };
    }
    return { blocks: blocks.slice(0, i).concat([left, right], blocks.slice(i + 1)) };
  }

  /** Merge block i into block i-1: texts concatenate, the left kind wins. */
  function mergeBlocksM(blocks, i) {
    var left = blocks[i - 1], right = blocks[i];
    if (!left || !right || left.kind === 'opaque' || right.kind === 'opaque') return null;
    var merged = blockWith(left, {
      text: left.text.concat(right.text), raw: null,
      sep: right.sep != null ? right.sep : left.sep,
    });
    return blocks.slice(0, i - 1).concat([merged], blocks.slice(i + 1));
  }

  /** Tab: depth+1. The first block has nothing to nest under. */
  function indentM(blocks, i) {
    var b = blocks[i];
    if (!b || b.kind !== 'listItem' || i === 0) return null;
    var out = blocks.slice();
    out[i] = blockWith(b, { depth: b.depth + 1, raw: null });
    return out;
  }

  // Append a blank line after a block (a paragraph following a list item
  // needs one, or it lazily continues the item).
  function widenSepAfter(b) {
    if (b.raw != null) {
      if (/\n\s*\n$/.test(b.raw)) return b;
      return blockWith(b, { raw: b.raw + '\n', sep: (b.sep || '') + '\n' });
    }
    if (/\n\s*\n$/.test(b.sep || '')) return b;
    return blockWith(b, { sep: (b.sep != null ? b.sep : '\n') + '\n' });
  }

  /** Shift+Tab: depth-1; a top-level item becomes a paragraph. */
  function outdentM(blocks, i) {
    var b = blocks[i];
    if (!b || b.kind !== 'listItem') return null;
    var out = blocks.slice();
    if (b.depth > 0) {
      out[i] = blockWith(b, { depth: b.depth - 1, raw: null });
      return out;
    }
    out[i] = {
      kind: 'paragraph', text: b.text, prov: b.prov, raw: null,
      sep: i < blocks.length - 1 ? '\n\n' : (b.sep != null && b.sep !== '' ? b.sep : '\n'),
    };
    if (i > 0 && out[i - 1].kind === 'listItem') out[i - 1] = widenSepAfter(out[i - 1]);
    return out;
  }

  /** Swap a styled block's kind, keeping its text. */
  function setBlockKindM(blocks, i, kind, level) {
    var b = blocks[i];
    if (!b || b.kind === 'opaque') return null;
    var out = blocks.slice();
    var nb = { kind: kind, text: b.text, prov: b.prov, raw: null, sep: b.sep != null ? b.sep : '\n' };
    if (kind === 'heading') nb.level = level || b.level || 1;
    if (kind === 'listItem') { nb.depth = b.depth || 0; nb.marker = b.marker || { bullet: '-' }; }
    out[i] = nb;
    return out;
  }

  // --- the wrappers: original signatures over model ops ------------------------

  // Which block of a parsed run contains the source offset (their raws tile
  // the segment), and where that block starts.
  function blockAtOffset(blocks, offset) {
    var acc = 0;
    for (var i = 0; i < blocks.length; i++) {
      var len = blocks[i].raw != null ? blocks[i].raw.length : 0;
      if (offset < acc + len) return { i: i, start: acc };
      acc += len;
    }
    var last = blocks.length - 1;
    return last < 0 ? null : { i: last, start: acc - (blocks[last].raw || '').length };
  }

  function blockFragStart(b) {
    if (b.kind === 'listItem') {
      var firstNl = (b.raw || '').indexOf('\n');
      var line = (b.raw || '').slice(0, firstNl < 0 ? (b.raw || '').length : firstNl);
      var lm = line.match(LIST_LINE_M);
      return lm ? lm[1].length + lm[2].length + lm[3].length : 0;
    }
    if (b.kind === 'heading') {
      var hm = (b.raw || '').match(/^#{1,6}[ \t]+/);
      return hm ? hm[0].length : 0;
    }
    if (b.kind === 'cell') return (b.pre || '').length;
    return 0;
  }

  // Source offset (relative to the block's raw) → char index in its text.
  function blockCharAt(b, rel) {
    var prov = b.prov || [];
    if (b.kind === 'quote') {
      var content = (b.raw || '').replace(/\n+$/, '');
      var lines = content.split('\n'), pos = 0, fragOff = 0;
      for (var li = 0; li < lines.length; li++) {
        var qm = lines[li].match(/^>[ \t]?/);
        var plen = qm ? qm[0].length : 0;
        var cLen = lines[li].length - plen;
        if (rel <= pos + lines[li].length) {
          return srcToCharIdx(prov, fragOff + Math.max(0, Math.min(rel - pos - plen, cLen)));
        }
        pos += lines[li].length + 1;
        fragOff += cLen + 1;
      }
      return srcToCharIdx(prov, fragOff);
    }
    return srcToCharIdx(prov, Math.max(0, rel - blockFragStart(b)));
  }

  /**
   * Split a block at a source offset (Return). Same contract as ever:
   * { md, caret }, or { exit, before, after } for Return on an empty item.
   */
  function splitBlock(blockMd, offset, marked) {
    var blocks = parseBlocks(blockMd, marked);
    if (!blocks) {
      var tok0;
      try { tok0 = marked.lexer(blockMd)[0]; } catch (_) { tok0 = null; }
      if (tok0 && tok0.type === 'list') return { md: blockMd, caret: offset }; // out-of-model list — refuse
      return { md: blockMd.slice(0, offset) + '\n\n' + blockMd.slice(offset), caret: offset + 2 };
    }
    var loc = blockAtOffset(blocks, offset);
    var ch = blockCharAt(blocks[loc.i], offset - loc.start);
    var r = splitBlockM(blocks, loc.i, ch);
    if (!r) return { md: blockMd, caret: offset };
    if (r.exit) {
      return { exit: true, before: printBlocks(r.before, marked), after: printBlocks(r.after, marked) };
    }
    var caret = { block: loc.i + 1, ch: 0, offset: -1 };
    var md = printBlocks(r.blocks, marked, caret);
    return { md: md, caret: caret.offset >= 0 ? caret.offset : md.length };
  }

  /**
   * Backspace at the start of a list item's content: a non-first item merges
   * into the previous item; the first item outdents to a paragraph.
   */
  function mergeListItem(listMd, offset, marked) {
    var blocks = parseBlocks(listMd, marked);
    if (!blocks) return { md: listMd, caret: offset };
    var loc = blockAtOffset(blocks, offset);
    var b = blocks[loc.i];
    if (!b || b.kind !== 'listItem') return { md: listMd, caret: offset };
    if (offset > loc.start + blockFragStart(b)) return { md: listMd, caret: offset }; // not at item start
    if (loc.i === 0) {
      var out = blocks.slice();
      out[0] = {
        kind: 'paragraph', text: b.text, prov: b.prov, raw: null,
        sep: blocks.length > 1 ? '\n\n' : (b.sep != null && b.sep !== '' ? b.sep : '\n'),
      };
      return { md: printBlocks(out, marked), caret: 0 };
    }
    var merged = mergeBlocksM(blocks, loc.i);
    if (!merged) return { md: listMd, caret: offset };
    var caret = { block: loc.i - 1, ch: blocks[loc.i - 1].text.length, offset: -1 };
    var md = printBlocks(merged, marked, caret);
    return { md: md, caret: caret.offset >= 0 ? caret.offset : 0 };
  }

  /** Tab: nest the caret's item one level deeper. */
  function indentItem(listMd, offset, marked) {
    var blocks = parseBlocks(listMd, marked);
    if (!blocks) return { md: listMd, caret: offset };
    var loc = blockAtOffset(blocks, offset);
    var ch = blockCharAt(blocks[loc.i], offset - loc.start);
    var out = indentM(blocks, loc.i);
    if (!out) return { md: listMd, caret: offset };
    var caret = { block: loc.i, ch: ch, offset: -1 };
    var md = printBlocks(out, marked, caret);
    return { md: md, caret: caret.offset >= 0 ? caret.offset : offset };
  }

  /** Shift+Tab: unindent; a top-level item becomes a paragraph. */
  function outdentItem(listMd, offset, marked) {
    var blocks = parseBlocks(listMd, marked);
    if (!blocks) return { md: listMd, caret: offset };
    var loc = blockAtOffset(blocks, offset);
    var ch = blockCharAt(blocks[loc.i], offset - loc.start);
    var out = outdentM(blocks, loc.i);
    if (!out) return { md: listMd, caret: offset };
    var caret = { block: loc.i, ch: ch, offset: -1 };
    var md = printBlocks(out, marked, caret);
    return { md: md, caret: caret.offset >= 0 ? caret.offset : 0 };
  }

  /**
   * Merge the block starting at `offset` into the preceding block. With
   * `marked` and styled prose blocks on both sides this is a model merge
   * (texts concatenate); otherwise it falls back to removing the whitespace
   * run before the offset, the historical behavior.
   */
  function mergeBlock(md, offset, marked) {
    if (marked) {
      var blocks, acc = 0, ti = -1;
      try { blocks = parseDoc(md, marked).blocks; } catch (_) { blocks = null; }
      if (blocks) {
        for (var i = 0; i < blocks.length; i++) {
          if (acc === offset) { ti = i; break; }
          acc += blocks[i].raw != null ? blocks[i].raw.length : 0;
        }
      }
      var mergeable = { paragraph: 1, heading: 1, quote: 1 };
      if (ti > 0 && mergeable[blocks[ti].kind]) {
        var pi = ti - 1;
        while (pi >= 0 && blocks[pi].kind === 'opaque' && /^\s*$/.test(blocks[pi].raw)) pi--;
        if (pi >= 0 && mergeable[blocks[pi].kind]) {
          var seq = blocks.slice(0, pi + 1).concat(blocks.slice(ti));
          var merged = mergeBlocksM(seq, pi + 1);
          if (merged) {
            var caret = { block: pi, ch: blocks[pi].text.length, offset: -1 };
            var outMd = printBlocks(merged, marked, caret);
            return { md: outMd, caret: caret.offset >= 0 ? caret.offset : 0 };
          }
        }
      }
    }
    var j = offset;
    while (j > 0 && /\s/.test(md[j - 1])) j--;
    return { md: md.slice(0, j) + md.slice(offset), caret: j };
  }

  // --- Conflict reconciliation ---------------------------------------------

  /**
   * Per-block 3-way merge. `base` is the last version common to both sides,
   * `view` carries the in-view edits, `disk` the external change. When the
   * block count is stable across all three, each block is merged independently:
   * a side that left a block untouched yields to the side that changed it, and
   * a block changed differently on both sides becomes a conflict (view wins in
   * the merged output, pre-selected for the UI). A block-count change can't be
   * aligned safely, so it degrades to one document-level conflict.
   */
  function reconcile(base, view, disk, marked) {
    if (view === disk) return { merged: view, conflicts: [] };
    if (base === view) return { merged: disk, conflicts: [] }; // view untouched → take disk
    if (base === disk) return { merged: view, conflicts: [] }; // disk untouched → keep view

    var B = segment(base, marked).map(function (s) { return s.raw; });
    var V = segment(view, marked).map(function (s) { return s.raw; });
    var D = segment(disk, marked).map(function (s) { return s.raw; });

    if (B.length === V.length && V.length === D.length) {
      var merged = [], conflicts = [];
      for (var i = 0; i < B.length; i++) {
        if (V[i] === B[i]) merged.push(D[i]);
        else if (D[i] === B[i]) merged.push(V[i]);
        else if (V[i] === D[i]) merged.push(V[i]);
        else {
          merged.push(V[i]);
          conflicts.push({ segIndex: i, base: B[i], view: V[i], disk: D[i] });
        }
      }
      return { merged: merged.join(''), conflicts: conflicts };
    }

    // Block count changed — alignment isn't safe; surface one coarse conflict.
    return { merged: view, conflicts: [{ segIndex: -1, base: base, view: view, disk: disk }] };
  }

  // --- DOM adapter ---------------------------------------------------------
  //
  // The only DOM-coupled functions. They map between a rendered block element
  // and source offsets, and read pure-text edits back out. Mapping is done on
  // *linear display offsets* (cumulative textContent length), which is robust
  // to the fact that escapes/entities merge into neighbouring text nodes and
  // marked appends a trailing "\n" to each block.
  //
  // Everything here runs on the StyledDoc model — the same parse the reconciler
  // and every block op use. It used to run on a second, private ledger
  // (`leafMap`) that predicted what the renderer would show by summing token
  // text, and located source spans by searching for each token's raw in the
  // block source. Both were guesses, and each construct where they guessed
  // wrong was a bug: blank lines inside a blockquote, hard breaks, task-list
  // checkboxes, and images — the last already carrying a hand-written patch for
  // exactly this. Measured across the CommonMark corpus, that ledger placed the
  // caret wrongly at 10% of positions and mishandled a quarter of single-
  // character insertions. There is now one model, and blocks it cannot map are
  // not offered for editing at all (see `blockCoords` and `segment`).

  var SHOW_TEXT = 4; // NodeFilter.SHOW_TEXT



  // Display offset of (node, offset) within el — text length from el's start.
  function displayOffset(el, node, offset) {
    var r = el.ownerDocument.createRange();
    r.setStart(el, 0);
    r.setEnd(node, offset);
    return r.toString().length;
  }

  // The (node, offset) for a linear display offset (stops before the trailing \n).
  function locateTextNode(el, dispTarget) {
    var w = el.ownerDocument.createTreeWalker(el, SHOW_TEXT);
    var acc = 0, node, last = null;
    while ((node = w.nextNode())) {
      last = node;
      var len = node.textContent.length;
      if (dispTarget <= acc + len) return { node: node, offset: dispTarget - acc };
      acc += len;
    }
    return { node: last, offset: last ? last.textContent.length : 0 };
  }

  // Remove whitespace-only text nodes (outside <pre>/<code>) from a rendered
  // block. marked pretty-prints HTML with "\n" between block tags (e.g. between
  // <li> elements); those nodes inflate the DOM's textContent relative to the
  // token-based leaf display model, so caret mapping drifts in multi-element
  // blocks like lists. Stripping them makes textContent === concat(leaf text).
  function stripStructuralWhitespace(el) {
    var doc = el.ownerDocument;
    var w = doc.createTreeWalker(el, SHOW_TEXT);
    var kill = [], n;
    while ((n = w.nextNode())) {
      // Only marked's block pretty-printing ("\n" between <li>s etc.) — an
      // inline whitespace-only node (the space in "**a** **b**") is content.
      if (!/^\s*$/.test(n.textContent) || n.textContent.indexOf('\n') < 0) continue;
      var p = n.parentNode, inPre = false;
      while (p && p !== el) {
        var tag = (p.tagName || '').toUpperCase();
        if (tag === 'PRE' || tag === 'CODE') { inPre = true; break; }
        p = p.parentNode;
      }
      if (!inPre) kill.push(n);
    }
    kill.forEach(function (x) { x.parentNode.removeChild(x); });
    return el;
  }

  // Ordered non-empty text nodes of el. After stripStructuralWhitespace these
  // carry exactly the leaf display text, in document order. A single node may
  // span several leaves (e.g. text + escape + text within one <p>), so the
  // correspondence is by display *range*, not 1:1.
  function textNodesOf(el) {
    var w = el.ownerDocument.createTreeWalker(el, SHOW_TEXT);
    var nodes = [], n;
    while ((n = w.nextNode())) { if (n.textContent.length) nodes.push(n); }
    return nodes;
  }


  // The (node, offset) at a linear display offset, biased to the node that
  // *starts* at the offset (preferStart) or *ends* at it. This is what tells
  // start-of-item-2 (node "two", 0) apart from end-of-item-1 (node "one", end)
  // — they share a display offset but live in different list elements.
  function locateDisp(nodes, dispPos, preferStart) {
    var acc = 0;
    for (var i = 0; i < nodes.length; i++) {
      var len = nodes[i].textContent.length, end = acc + len;
      if (preferStart ? (dispPos >= acc && dispPos < end)
                      : (dispPos > acc && dispPos <= end)) {
        return { node: nodes[i], offset: dispPos - acc };
      }
      acc = end;
    }
    var last = nodes.length ? nodes[nodes.length - 1] : null;
    return last ? { node: last, offset: last.textContent.length } : { node: null, offset: 0 };
  }

  /**
   * The coordinate map for one editable block — or null, meaning the block
   * cannot be mapped and so must not be offered for editing.
   *
   * Three coordinate systems meet in the editor, and every caret bug this file
   * has ever had was two of them disagreeing:
   *
   *   src   byte offset into the block's markdown source
   *   char  index into the model's styled-text array
   *   disp  offset into the rendered DOM's textContent — where the caret is
   *
   * src → char already exists as blockCharAt, the function the block ops use.
   * Rather than hand-write its inverse — a second implementation, which is
   * precisely how this file acquired two disagreeing ledgers — we invert it by
   * enumeration: run every source offset through the forward map and record
   * where each char first appears. Round-tripping is then structural. The two
   * directions cannot disagree because there is only one direction.
   *
   * The `disp` axis is not predicted either. It is checked: the model's own
   * display text must equal what the renderer actually produces for this
   * source, or we return null. That single comparison is what makes the map
   * trustworthy — and it is the honest definition of "editable", since a block
   * whose displayed text we cannot account for is one whose caret positions we
   * would be guessing at.
   */
  function blockCoords(doc, segRaw, marked) {
    var blocks = parseBlocks(segRaw, marked);
    if (!blocks) return null;

    // Global char array across the block's inner blocks (list items, etc).
    var chars = [], charBase = [], srcBase = [], b, i, at = 0;
    for (i = 0; i < blocks.length; i++) {
      b = blocks[i];
      if (b.kind === 'opaque' || !b.text) return null; // no styled text — unmappable
      charBase.push(chars.length);
      srcBase.push(at);
      at += (b.raw || '').length;
      chars = chars.concat(b.text);
    }

    // The check that makes this map worth trusting.
    var modelDisp = '';
    for (i = 0; i < chars.length; i++) if (!chars[i].obj) modelDisp += chars[i].ch;
    if (renderedDisplayOf(doc, segRaw, marked) !== modelDisp) return null;

    // src → char, by the model's own forward map.
    var srcOfChar = new Array(chars.length);      // first source offset for a char
    var srcEndOfChar = new Array(chars.length);   // last source offset for a char
    var charOfSrc = new Array(segRaw.length + 1);
    for (var s = 0; s <= segRaw.length; s++) {
      var loc = blockAtOffset(blocks, s); // clamps to the last block past the end
      if (!loc) return null;
      var c = charBase[loc.i] + blockCharAt(blocks[loc.i], s - loc.start);
      c = Math.max(0, Math.min(c, chars.length));
      charOfSrc[s] = c;
      if (srcOfChar[c] === undefined) srcOfChar[c] = s;
      srcEndOfChar[c] = s;
    }
    // Chars no source offset landed on (inside a delimiter run) take the
    // nearest earlier char's source position — the caret before them.
    for (i = 0; i < chars.length; i++) {
      if (srcOfChar[i] === undefined) srcOfChar[i] = i > 0 ? srcOfChar[i - 1] : 0;
    }
    if (srcOfChar[chars.length] === undefined) srcOfChar[chars.length] = segRaw.length;

    // char ↔ disp. Widths are in UTF-16 code units, the unit DOM offsets use,
    // so astral characters do not skew the map. Images occupy a char but show
    // nothing.
    var dispOfChar = new Array(chars.length + 1), charOfDisp = [];
    var d = 0;
    for (i = 0; i < chars.length; i++) {
      dispOfChar[i] = d;
      var w = chars[i].obj ? 0 : chars[i].ch.length;
      for (var k = 0; k < w; k++) { charOfDisp[d + k] = i; }
      d += w;
    }
    dispOfChar[chars.length] = d;
    charOfDisp[d] = chars.length;

    // Inner blocks with no text — a just-created empty list item — host a caret
    // but occupy no display offset, so they are unreachable through the disp
    // axis: every position there belongs to the following item's first char.
    // They are addressed by element instead, paired in document order with the
    // empty <li>/<p> the renderer produces.
    var empties = [];
    for (i = 0; i < blocks.length; i++) {
      if (blocks[i].text.length) continue;
      // Past its own marker: the caret sits where the item's content would
      // start, not at the earliest offset that snaps to the following char.
      empties.push({
        src: srcBase[i] + blockFragStart(blocks[i]),
        srcStart: srcBase[i],
        srcEnd: srcBase[i] + (blocks[i].raw || '').length,
      });
    }
    return {
      chars: chars, dispLen: d, empties: empties,
      srcOfChar: srcOfChar, srcEndOfChar: srcEndOfChar, charOfSrc: charOfSrc,
      dispOfChar: dispOfChar, charOfDisp: charOfDisp,
    };
  }

  // bias resolves leaf-boundary ambiguity: a selection START at a leaf boundary
  // biases into the following leaf (e.g. just past an opening **), an END into
  // the preceding leaf (just before a closing **) so emphasis stays selectable.
  // With no bias the caret resolves by which *node* it sits in — at a node's
  // end it stays in that node's last leaf (so end-of-item-1 ≠ start-of-item-2).
  // Within a node, adjacent leaves are source-contiguous so either side agrees.
  function domOffsetToSourceOffset(el, node, offset, blockToken, bias) {
    var coords = coordsOf(blockToken);
    if (coords) {
      // A caret parked in an empty block element has no display offset of its
      // own — it would resolve to the next item's first character — so resolve
      // it by element identity instead.
      if (node && node.nodeType === 1 && coords.empties.length) {
        var ei = emptyBlockEls(el).indexOf(node);
        if (ei >= 0 && ei < coords.empties.length) return coords.empties[ei].src;
      }
      var dispPos = displayOffset(el, node, offset);
      dispPos = Math.max(0, Math.min(dispPos, coords.dispLen));
      var ci = coords.charOfDisp[dispPos];
      if (ci === undefined) ci = coords.chars.length;
      // One display offset can be two source positions — the end of one list
      // item and the start of the next share it — and which one is meant
      // decides whether Backspace merges items or deletes a character. Inside a
      // run the two coincide (adjacent chars are source-contiguous), so this
      // only bites at a seam: resolve it the way the caret sits, biased by the
      // caller for selection ends.
      // srcOfChar holds the earliest source offset that resolves to this char —
      // at a seam that is the end of the *previous* item; srcEndOfChar holds the
      // latest, which is the start of this item's own content.
      var preferNext = bias === 'start' ? true : bias === 'end' ? false : (offset <= 0);
      if (preferNext && coords.srcEndOfChar[ci] !== undefined) return coords.srcEndOfChar[ci];
      return coords.srcOfChar[ci];
    }
    // No coordinate map: either a transient block with no source at all (a
    // just-created empty paragraph) or an intermediate state of a structural
    // op whose source does not lex as the block it is standing in for — an
    // item indented past four spaces reads as a code block. Neither is ever
    // offered to the user for editing. Treat display and source as the same
    // axis, which is exact for plain text and the best available guess
    // otherwise; the old token-scanning ledger that used to live here was not
    // better, only longer, and kept a second model alive to be maintained.
    return blockToken && blockToken.raw != null
      ? Math.min(displayOffset(el, node, offset), blockToken.raw.length)
      : displayOffset(el, node, offset);
  }



  // --- Cross-block arrow navigation ----------------------------------------
  //
  // Each top-level block is its own contenteditable, so the browser's caret
  // navigation stops at a block's edge. These helpers decide when an Up/Down
  // press should hop to the neighbouring block. dir is -1 (Up) or +1 (Down).

  // Is the caret on the block's first (Up) or last (Down) visual line? Compared
  // geometrically against the block's edge, within ~0.6 of a line height.
  function atBlockEdge(caretRect, blockRect, dir) {
    var pad = Math.max(4, (caretRect.height || 16) * 0.6);
    return dir < 0 ? (caretRect.top - blockRect.top) <= pad
                   : (blockRect.bottom - caretRect.bottom) <= pad;
  }

  // The next/previous sibling block that is itself editable (skips read-only
  // blocks like code/tables/hr). Returns null at the document edge.
  function adjacentEditableSeg(div, dir) {
    var sib = div;
    for (;;) {
      sib = dir < 0 ? sib.previousElementSibling : sib.nextElementSibling;
      if (!sib) return null;
      if (sib.getAttribute && sib.getAttribute('contenteditable') === 'true') return sib;
    }
  }

  // Empty editable block elements (e.g. an empty <li> from a just-created list
  // item) in document order. They host a caret but have no text node, so they
  // can't be reached through the display-offset machinery; they pair, in order,
  // with the textless blocks the model reports for those items.
  function emptyBlockEls(el) {
    var out = [];
    Array.prototype.forEach.call(el.querySelectorAll('li,p,td,th'), function (e) {
      if (e.textContent === '' && !e.querySelector('li,p,td,th')) out.push(e);
    });
    return out;
  }

  function sourceOffsetToDom(el, srcOffset, blockToken) {
    var coords = coordsOf(blockToken);
    if (coords) {
      var s = Math.max(0, Math.min(srcOffset, coords.charOfSrc.length - 1));
      // An offset inside a textless block belongs to that block's element, not
      // to the next item's first character.
      for (var e = 0; e < coords.empties.length; e++) {
        if (s >= coords.empties[e].srcStart && s <= coords.empties[e].srcEnd) {
          var els = emptyBlockEls(el);
          if (e < els.length) return { node: els[e], offset: 0 };
        }
      }
      var ci = coords.charOfSrc[s];
      if (ci === undefined) ci = coords.chars.length;
      var dispPos = coords.dispOfChar[ci];
      if (dispPos === undefined) dispPos = coords.dispLen;
      // Both sides of a seam share this display offset. An offset below the
      // char's own start names the trailing edge of the previous item, so put
      // the caret at the end of that text node rather than the start of the
      // next — otherwise end-of-item-1 and start-of-item-2 collapse together
      // and Backspace stops being able to tell them apart.
      var atStart = coords.srcEndOfChar[ci] === undefined || s >= coords.srcEndOfChar[ci];
      return locateDisp(textNodesOf(el), dispPos, atStart);
    }
    return locateDisp(textNodesOf(el), Math.max(0, srcOffset), true);
  }


  // --- Generalized DOM edit reconciliation ----------------------------------
  //
  // Everything the browser can do to a contenteditable block — from a single
  // typed char to selection deletes spanning leaves, items, or whole
  // formatting runs — lands here.
  // The contract that matters: an edit that exists in the DOM must either be
  // folded into the source or be reported as impossible; it must never sit
  // silently in the DOM to be resurrected by the next re-render.

  // What `md` actually renders to, through the same pipeline the editor uses
  // for its blocks (marked.parse + structural-whitespace strip). The lexer's
  // token text is NOT a safe proxy: e.g. a paragraph's leading space survives
  // in the token but is dropped by the renderer.
  function renderedDisplayOf(doc, md, marked) {
    var r = renderedOf(doc, md, marked);
    return r === null ? null : r.disp;
  }

  // The convergence fingerprint: the entire rendered DOM, canonicalized.
  // Earlier versions compared projections (text, then inline runs, then list
  // items) and every divergence bug lived in what the projection discarded —
  // link hrefs, images, heading levels. Canonicalizing the whole tree closes
  // the family: tag structure, text runs (merged across node splits), link
  // targets, image sources all participate.
  //
  // The explicit allowlist of permitted differences:
  //  - invisible subtrees (per subtreeVisible — zombie inline elements and
  //    the editing engine's leftovers: emptied <li>/<p>, stray wrappers;
  //    requiring a one-for-one match would make whole-block deletion
  //    unreconcilable — worse than a transient ghost)
  //  - placeholder <br>s (per brIsContent — only a break with visible
  //    content after it inside its block renders anything)
  //  - element attributes other than href/src/alt (classes, data-*)
  //  - `base` prefix on href/src (the live DOM resolves relative paths)
  // Markdown cannot spell emphasis whose run starts or ends on whitespace —
  // `**x **` does not lex — so the printer hoists such whitespace outside the
  // delimiters (canonText). WebKit's deletes strand exactly the unspellable
  // shape: cutting the tail off a <strong>'s text leaves the run's trailing
  // space inside the tag. A reader cannot tell the two apart and only the
  // hoisted one has a source, so the fingerprint reads edge whitespace of an
  // emphasis-family element as sitting outside it. Code spans stay put:
  // whitespace inside them is visible content with a spelling. Descendants
  // are processed before ancestors so whitespace bubbles the whole way out
  // (`<strong><em>a </em></strong>` → `<strong><em>a</em></strong> `).
  //
  // Directly adjacent identical emphasis siblings are the other unspellable
  // shape from the same family: a delete spanning two bold runs can leave
  // <strong>a</strong><strong>b</strong>, whose only printable reading is one
  // run, so the fingerprint merges them. Merging runs first — before the edge
  // hoist — so whitespace that becomes interior to the merged run stays put
  // (`<strong>a </strong><strong>b</strong>` is `**a b**`, not `**a** **b**`).
  // Siblings separated by anything visible — a space text node, a hard <br> —
  // are two runs with a spelling of their own and are never merged.
  function hoistEmphasisEdgeWs(root) {
    var els = root.querySelectorAll ? root.querySelectorAll('em,strong,del') : [];
    var i, e, n, m;
    // Merge pass in document order: a merge that turns two descendants into
    // siblings is finished when the walk reaches them.
    for (i = 0; i < els.length; i++) {
      e = els[i];
      if (!e.parentNode) continue; // consumed by an earlier merge
      for (;;) {
        n = e.nextSibling;
        while (n && ((n.nodeType === 3 && n.textContent === '') ||
                     (n.nodeType === 1 && n.tagName.toUpperCase() !== 'BR' && !subtreeVisible(n)))) n = n.nextSibling;
        if (!n || n.nodeType !== 1 || n.tagName !== e.tagName) break;
        while (n.firstChild) e.appendChild(n.firstChild);
        n.parentNode.removeChild(n);
      }
    }
    for (i = els.length - 1; i >= 0; i--) {
      var p; e = els[i]; p = e.parentNode;
      if (!p) continue;
      while ((n = e.firstChild) && n.nodeType === 3 && (m = /^\s+/.exec(n.textContent))) {
        if (m[0] === n.textContent) { p.insertBefore(n, e); continue; }
        p.insertBefore(root.ownerDocument.createTextNode(m[0]), e);
        n.textContent = n.textContent.slice(m[0].length);
        break;
      }
      while ((n = e.lastChild) && n.nodeType === 3 && (m = /\s+$/.exec(n.textContent))) {
        if (m[0] === n.textContent) { p.insertBefore(n, e.nextSibling); continue; }
        p.insertBefore(root.ownerDocument.createTextNode(m[0]), e.nextSibling);
        n.textContent = n.textContent.slice(0, -m[0].length);
        break;
      }
    }
  }
  function canonicalOfEl(el, base) {
    if (el.querySelector && el.querySelector('em,strong,del')) {
      var hoisted = el.cloneNode(true);
      hoistEmphasisEdgeWs(hoisted);
      el = hoisted;
    }
    var out = [], buf = '';
    function flush() { if (buf) { out.push(JSON.stringify(buf)); buf = ''; } }
    function deBase(v) {
      v = v || '';
      return base && v.indexOf(base) === 0 ? v.slice(base.length) : v;
    }
    // Styling that nests inside itself is idempotent: <em><em>x</em></em> and
    // <em>x</em> are the same thing to a reader, and the model — where a char
    // is italic or is not — cannot tell them apart either. Sources like
    // `_foo _bar_ baz_` produce the doubled form, so counting it as a distinct
    // structure made every edit in such a block unreconcilable. Collapsing it
    // here costs nothing: the block is re-rendered from the reconciled source,
    // so the redundant wrapper disappears on the first edit and the rendering
    // is identical either way.
    var IDEMPOTENT = { EM: true, STRONG: true, DEL: true, CODE: true };
    (function walk(node, open) {
      for (var n = node.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3) { buf += n.textContent; continue; }
        if (n.nodeType !== 1) continue;
        var tag = n.tagName.toUpperCase();
        if (tag === 'IMG') { flush(); out.push('IMG[' + deBase(n.getAttribute('src')) + '|' + (n.getAttribute('alt') || '') + ']'); continue; }
        if (tag === 'BR') { if (!brIsContent(n, el)) continue; flush(); out.push('BR'); continue; }
        if (!subtreeVisible(n)) continue;
        if (IDEMPOTENT[tag] && open[tag]) { walk(n, open); continue; }
        flush();
        out.push(tag + (tag === 'A' ? '[' + deBase(n.getAttribute('href')) + ']' : '') + '(');
        var inner = {};
        for (var t in open) if (open.hasOwnProperty(t)) inner[t] = open[t];
        inner[tag] = true;
        walk(n, inner);
        flush();
        out.push(')');
      }
    })(el, {});
    flush();
    return out.join('');
  }
  // Render `md` into a scratch element once and read both ledgers off it.
  // Display text and canonical structure are always wanted together, and the
  // parse is the expensive half.
  function renderedOf(doc, md, marked) {
    var scratch = doc.createElement('div');
    try { scratch.innerHTML = marked.parse(md); } catch (_) { return null; }
    stripStructuralWhitespace(scratch);
    return { el: scratch, disp: (scratch.textContent || '').replace(/\n+$/, ''), canon: canonicalOfEl(scratch) };
  }
  function renderedCanonicalOf(doc, md, marked) {
    var r = renderedOf(doc, md, marked);
    return r === null ? null : r.canon;
  }

  // Does `cand` still lex as (at most) one block that renders exactly
  // `wantDisp`? The acceptance test for any reconciled source.
  function relexMatches(doc, cand, wantDisp, marked) {
    var toks;
    try { toks = marked.lexer(cand); } catch (_) { return null; }
    var real = toks.filter(function (t) { return t.type !== 'space'; });
    if (real.length > 1) return null;
    if (renderedDisplayOf(doc, cand, marked) !== wantDisp) return null;
    return real.length ? real[0] : false; // false = block vanished entirely
  }

  // Visible text a markdown fragment renders to — the editor's convergence
  // currency: source and DOM agree iff their display texts are equal. Read off
  // the model, so there is no second opinion about what a construct shows.
  // Blocks the model refuses contribute nothing, which is what the one caller
  // wants: the emphasis toggle compares a fragment against itself before and
  // after, and a toggle that pushed the block out of the model must be refused.
  function displayTextOf(md, marked) {
    var parsed;
    try { parsed = parseDoc(md, marked); } catch (_) { return null; }
    var out = '';
    for (var i = 0; i < parsed.blocks.length; i++) {
      var t = parsed.blocks[i].text;
      if (!t) continue;
      for (var j = 0; j < t.length; j++) if (!t[j].obj) out += t[j].ch;
    }
    return out;
  }

  /**
   * The block's source with the display-text change spliced straight in.
   *
   * Reduces the edit to the one contiguous run that differs between the old and
   * new display text, maps its ends to source offsets through the coordinate
   * map, and replaces those bytes. Returns null when there is no map, or when
   * the change is not a single run (the model print handles those better
   * anyway). Deliberately approximate at the ends — a char whose source is more
   * than one byte, an escape or an entity, may splice a byte off — because the
   * caller verifies the result by rendering it, so a bad splice costs nothing.
   */
  function spliceCandidate(blockToken, oldDisp, wantDisp) {
    var coords = coordsOf(blockToken);
    if (!coords || oldDisp === null || wantDisp === oldDisp) return null;
    var raw = blockToken.raw;
    var a = 0;
    while (a < oldDisp.length && a < wantDisp.length && oldDisp.charAt(a) === wantDisp.charAt(a)) a++;
    var z = 0;
    while (z < oldDisp.length - a && z < wantDisp.length - a &&
           oldDisp.charAt(oldDisp.length - 1 - z) === wantDisp.charAt(wantDisp.length - 1 - z)) z++;
    var oldEnd = oldDisp.length - z;
    // Source offset for a display offset: the position of the character that
    // starts there, or just past the last one at the end of the block.
    function srcAt(d) {
      if (d >= coords.dispLen) {
        var last = coords.chars.length - 1;
        return last < 0 ? 0 : (coords.srcEndOfChar[last] === undefined ? raw.length : coords.srcEndOfChar[last] + 1);
      }
      var ci = coords.charOfDisp[d];
      if (ci === undefined) return null;
      var s = coords.srcEndOfChar[ci];
      return s === undefined ? coords.srcOfChar[ci] : s;
    }
    var s0 = srcAt(a), s1 = srcAt(oldEnd);
    if (s0 === null || s1 === null || s1 < s0 || s1 > raw.length) return null;
    return raw.slice(0, s0) + wantDisp.slice(a, wantDisp.length - z) + raw.slice(s1);
  }

  /**
   * Fold an arbitrary text edit in `el` back into the block's source.
   * Returns { changed:false } if DOM and source agree,
   *         { changed:true, raw, empty } when reconciled (empty: the block's
   *         visible text is now gone — caller may drop/convert the block), or
   *         null when the DOM state can't be mapped to source (caller reverts).
   *
   * The write path is the model: parse the block, read the DOM back into the
   * same space, adopt provenance for everything the edit didn't touch, print.
   * No candidate enumeration — in (ch, attrs) space the boundary ambiguities
   * that needed it don't exist. The old acceptance check stays as the last
   * line of defense: a reconciled source must re-lex as one block rendering
   * exactly the DOM's text and canonical structure, or the edit is refused.
   */
  function reconcileDomEdit(el, blockToken, marked, base) {
    var doc = el.ownerDocument;
    var src = renderedOf(doc, blockToken.raw, marked);
    var oldDisp = src === null ? null : src.disp;
    // Read the DOM with WebKit's edge-whitespace artifacts normalized away (see
    // normalizeBoundaryWs). `artifact: true` on a changed:false result records
    // that the live DOM holds such an artifact: the source needs no extra
    // content, but the DOM and source have not converged — the caller marks
    // the block for re-render, which sheds the artifact once no live caret
    // depends on it. (This used to be reported as a refusal so the revert
    // would clean it; a revert destroys the caret and any keystroke in
    // flight, which is far worse than a stranded space.)
    // Whitespace at a block's edge is only an editing artifact if the source
    // did not put it there. Test the DOM exactly as it stands first: a
    // paragraph that legitimately begins with a space, or a quote written
    // "> <spaces>text", matches its own source and is simply clean.
    // Normalizing before this comparison rewrote those blocks on load —
    // "  aaa" became "aaa" with nobody typing anything.
    // One reconciliation attempt against a particular reading of the DOM.
    // `isArtifact` says this reading differs from what is actually on screen,
    // so plain "unchanged" cannot be reported: the DOM still needs a re-render
    // to shed the difference, which same() flags for the caller.
    function attempt(readEl, isArtifact) {
      var wantDisp = (readEl.textContent || '').replace(/\n+$/, '');
      var wantCanon = canonicalOfEl(readEl, base);
      function same() { return isArtifact ? { changed: false, artifact: true } : { changed: false }; }
      if (oldDisp !== null && wantDisp === oldDisp && src.canon === wantCanon) return same();
      function accept(cand) {
        if (cand === null) return null;
        if (cand === blockToken.raw) return same();
        if (relexMatches(doc, cand, wantDisp, marked) === null) return null;
        if (renderedCanonicalOf(doc, cand, marked) !== wantCanon) return null;
        return { changed: true, raw: cand, empty: wantDisp === '' };
      }
      var oldBlocks = parseBlocks(blockToken.raw, marked);
      if (!oldBlocks) return null; // block outside the model — refuse, don't guess
      var newBlocks = readBlocksFromDom(readEl, base);
      if (!newBlocks) return null; // DOM structure outside the model
      var adopted = diffBlocks(oldBlocks, newBlocks);
      var cand = printBlocks(adopted, marked);
      var r = accept(cand);
      if (r) return r;
      // Adopted provenance can go stale against a heavily-rearranged DOM;
      // retry once with a fully canonical print before refusing.
      var canonical = printBlocks(adopted.map(function (b) {
        return b.kind === 'opaque' ? b : {
          kind: b.kind, level: b.level, depth: b.depth, marker: b.marker, pre: b.pre,
          text: b.text, prov: null, raw: null, sep: b.sep,
        };
      }), marked);
      if (canonical !== cand) {
        r = accept(canonical);
        if (r) return r;
      }
      // Last resort: keep the source and change as little of it as possible.
      // Printing rewrites the whole block from the model, which loses spellings
      // the model does not carry — a link written [x](foo%20b&auml;) comes back
      // decoded, and marked then percent-encodes it into a different URL. When
      // the edit is one contiguous run of display text, splicing it into the
      // original bytes preserves everything it did not touch. accept() checks
      // the result as strictly as any other candidate, so an inexact splice is
      // rejected rather than trusted.
      return accept(spliceCandidate(blockToken, oldDisp, wantDisp));
    }

    // Which reading to believe first depends on the source, not the DOM alone.
    // Edge whitespace the source's own rendering also has is content — "  aaa"
    // really does begin with two spaces, and "foo  " really does end with the
    // two that make a hard break; normalizing those away deleted them on the
    // first edit anywhere in the block. Edge whitespace the source does *not*
    // account for is WebKit's, and must be shed rather than written to the file.
    var rd = normalizeBoundaryWs(el, src && src.el);
    var normalized = canonicalOfEl(rd, base) !== canonicalOfEl(el, base);
    // Both readings are self-consistent — a paragraph really can end with a
    // space, a list item really can start with one — so the DOM alone cannot
    // say which is meant. The source can: normalize its *own* rendering and see
    // whether that changes anything. If the source has edge whitespace of its
    // own, the live DOM's is content and normalizing would delete it ("  aaa"
    // reconciled to "X aaa"; "foo  " lost the two spaces that make it a hard
    // break). If the source has none, whatever is on screen came from the
    // editing engine — WebKit's &nbsp; at the head of a list item — and writing
    // it to the file would plant an invisible character the renderer then
    // strips back out. This covers edges inside the block, not just its ends.
    var srcHasEdgeWs = src !== null &&
      canonicalOfEl(normalizeBoundaryWs(src.el), base) !== canonicalOfEl(src.el, base);
    if (normalized && !srcHasEdgeWs) return attempt(rd, true);
    var r = attempt(el, false);
    if (r) return r;
    // Fall back to the trimmed reading. rd is source-aware: edges the source
    // itself holds whitespace at are preserved (per-edge, see
    // normalizeBoundaryWs), so this no longer deletes content like "&#9;foo"'s
    // tab — and refusing here is not the harmless option it was once thought
    // to be: a refusal reverts the block, which destroys the caret and any
    // keystroke in flight.
    return normalized ? attempt(rd, true) : null;
  }

  return {
    segment: segment,
    leadingFrontmatter: leadingFrontmatter,
    isEditableBlock: isEditableBlock,
    toggleEmphasis: toggleEmphasis,
    splitBlock: splitBlock,
    mergeBlock: mergeBlock,
    mergeListItem: mergeListItem,
    indentItem: indentItem,
    outdentItem: outdentItem,
    reconcile: reconcile,
    domOffsetToSourceOffset: domOffsetToSourceOffset,
    sourceOffsetToDom: sourceOffsetToDom,
    reconcileDomEdit: reconcileDomEdit,
    displayTextOf: displayTextOf,
    renderedDisplayOf: renderedDisplayOf,
    renderedCanonicalOf: renderedCanonicalOf,
    canonicalOfEl: canonicalOfEl,
    normalizeBoundaryWs: normalizeBoundaryWs,
    stripStructuralWhitespace: stripStructuralWhitespace,
    atBlockEdge: atBlockEdge,
    adjacentEditableSeg: adjacentEditableSeg,
    Model: {
      parseInline: parseInline,
      printInline: printInline,
      printInlineParts: printInlineParts,
      canonText: canonText,
      toggleAttr: toggleAttr,
      attrsEq: attrsEqM,
      charEq: charEqM,
      textEq: textEqM,
      parseBlocks: parseBlocks,
      parseDoc: parseDoc,
      printBlocks: printBlocks,
      printDoc: printDoc,
      readBlocksFromDom: readBlocksFromDom,
      diffBlocks: diffBlocks,
      splitBlockM: splitBlockM,
      mergeBlocksM: mergeBlocksM,
      indentM: indentM,
      outdentM: outdentM,
      setBlockKindM: setBlockKindM,
    },
  };
});
