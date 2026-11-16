/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Minimal, injection-safe markdown renderer for chat message bodies.
 *
 * The input is split on fenced code blocks — three backticks or three
 * tildes — into alternating prose and code chunks. Code chunks are always
 * escaped and rendered literally in pre/code. Prose chunks take one of two
 * modes, picked by the live formatting.renderHtml toggle:
 *
 * Plain mode (renderHtml off) is the classic escape-first pipeline: every
 * chunk is HTML-escaped BEFORE any markup is produced, so nothing a user
 * or model emits can smuggle raw HTML through any transform. Supported
 * syntax, and no more: inline `code`, **bold**, *italic*, __underline__,
 * _italic_, [text](https://…) links, paragraphs and line breaks. Quote
 * highlighting still works — quoted speech is marked on the raw text
 * before escaping, and the markers become q tags around the
 * already-escaped content.
 *
 * HTML mode (renderHtml on) keeps the model's markup: style blocks are
 * lifted aside, attribute quotes are masked while quoted speech is
 * detected, the gated inline emphasis and quote highlighting apply,
 * single newlines become br tags (no p wrapping — raw block-level HTML
 * must not nest inside p), the finished chunk is filtered by
 * filterUnsafeMarkup(), the lifted styles are restored as
 * scopeStyleBlock()-scoped style elements, and prefixClasses()
 * namespaces the surviving class attributes.
 *
 * Every emphasis transform below is gated by the live formatting toggles,
 * so a switched-off style keeps its markup literal.
 */

import { formattingSnapshot } from "../stores/formatting";

/** Fence markers that split prose from code: three backticks or three tildes. */
const CODE_FENCE_PATTERN = /```|~~~/;

/** Only http(s) URLs become links; anything else stays literal text. */
const LINK_PATTERN = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Matched quote pairs count as speech; pairs never cross a line break. */
const QUOTED_SPEECH_PATTERN =
  /"[^"\r\n]+"|\u201C[^\u201D\r\n]+\u201D|\u00AB[^\u00BB\r\n]+\u00BB|\u300C[^\u300D\r\n]+\u300D|\u300E[^\u300F\r\n]+\u300F|\uFF02[^\uFF02\r\n]+\uFF02/g;

/** Wraps quoted speech in U+0002/U+0003 sentinels for later <q> tag rendering. */
export function wrapQuotedSpeech(text: string): string {
  return text.replace(QUOTED_SPEECH_PATTERN, (quoted) => `\u0002${quoted}\u0003`);
}

/**
 * Applies the inline emphasis transforms to already-escaped, code-free
 * prose, each gated by the live toggles read from formattingSnapshot():
 *
 * 1. [label](https://…) markdown links become anchor tags with
 *    rel="noopener noreferrer" target="_blank" — links have no toggle and
 *    always render;
 * 2. **span** becomes <strong> when the bold toggle is on;
 * 3. __span__ becomes <u> when the underline toggle is on;
 * 4. *span* becomes <em> when the italics toggle is on;
 * 5. _span_ becomes <em> when the italics toggle is on AND the span is not
 *    part of a double-underscore, so __span__ stays literal even when the
 *    underline toggle is off (the (?<!_) and (?!_) guards below).
 *
 * Order matters: links first, then bold, then double-underscore underline,
 * then single-star italic, then single-underscore italic. Each pass only
 * sees the output of the passes before it, so an already-consumed **span**
 * or __span__ can never collide with the single-star or single-underscore
 * passes that follow. With a toggle off, the markup passes through as
 * literal text, keeping rendering reversible from the settings panel.
 */
export function applyInlineEmphasis(text: string): string {
  const formatting = formattingSnapshot();
  let result = text.replace(
    LINK_PATTERN,
    '<a href="$2" rel="noopener noreferrer" target="_blank">$1</a>',
  );
  if (formatting.bold) {
    result = result.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  }
  if (formatting.underline) {
    result = result.replace(/__([^_\n]+)__/g, "<u>$1</u>");
  }
  if (formatting.italics) {
    result = result
      .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
      .replace(/(?<!_)_(?!_)([^_\n]+)_(?!_)/g, "<em>$1</em>");
  }
  return result;
}

/**
 * Matches a class attribute in either quote style: group 1 is the quote
 * character, group 2 the raw value. The lookbehind stops lookalike
 * attributes such as data-class from matching.
 */
const CLASS_ATTRIBUTE_PATTERN = /(?<![\w:-])class\s*=\s*(["'])(.*?)\1/g;

/**
 * Rewrites every class attribute value in an HTML string so each
 * whitespace-separated token gains the "custom-" prefix: class="a b" becomes
 * class="custom-a custom-b". Both quote styles are handled and keep their
 * original quote character; everything that is not a class attribute (ids,
 * data-* attributes, …) passes through untouched, and an empty value stays
 * empty. A pure string transform with no DOM dependency, so it runs in
 * tests and other non-browser contexts.
 */
export function prefixClasses(html: string): string {
  return html.replace(CLASS_ATTRIBUTE_PATTERN, (_match, quote: string, value: string) => {
    const prefixed = value
      .split(/\s+/)
      .filter((token) => token !== "")
      .map((token) => `custom-${token}`)
      .join(" ");
    return `class=${quote}${prefixed}${quote}`;
  });
}

/** At-rules whose blocks wrap ordinary rules; their bodies are recursed into. */
const CONDITIONAL_AT_RULE_PATTERN = /^@(?:media|supports)\b/i;

/** A class token inside a selector; names must start with a letter or underscore. */
const CLASS_SELECTOR_PATTERN = /\.([A-Za-z_][-\w]*)/g;

/** Every scoped selector becomes a descendant of the message bubble. */
const SCOPE_ANCESTOR = ".msg-bubble";

/** @import must never survive, whatever casing it arrives in. */
const IMPORT_PATTERN = /@import/i;

/**
 * Splits a selector list on the commas that separate its selectors, leaving
 * commas nested inside functional pseudo-classes like :is(a, b) or attribute
 * brackets like [data-x="a,b"] alone.
 */
function splitSelectorList(selectors: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < selectors.length; index++) {
    const char = selectors[index];
    if (char === "(" || char === "[") {
      depth++;
    } else if (char === ")" || char === "]") {
      depth = Math.max(depth - 1, 0);
    } else if (char === "," && depth === 0) {
      parts.push(selectors.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(selectors.slice(start));
  return parts;
}

/**
 * Rewrites one comma-separated selector list for the message bubble: each
 * selector gains the ".msg-bubble" descendant prefix and each class token is
 * renamed to its custom-prefixed form so it keeps matching the markup that
 * prefixClasses() produces. Element selectors, ids, pseudo-classes/elements,
 * and combinators are left intact — ".card .title p:hover" comes out as
 * ".msg-bubble .custom-card .custom-title p:hover".
 */
function scopeSelectorList(selectors: string): string {
  return splitSelectorList(selectors)
    .map((selector) => selector.trim())
    .filter((selector) => selector !== "")
    .map((selector) => {
      const renamed = selector.replace(CLASS_SELECTOR_PATTERN, ".custom-$1");
      return `${SCOPE_ANCESTOR} ${renamed}`;
    })
    .join(", ");
}

/**
 * Index of the "}" that closes the "{" at openIndex, counting nested braces;
 * -1 when the block never closes. Braces inside strings or comments are not
 * tracked — this parser is deliberately brace-simple.
 */
function findClosingBrace(css: string, openIndex: number): number {
  let depth = 1;
  for (let index = openIndex + 1; index < css.length; index++) {
    const char = css[index];
    if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

/**
 * Scopes a stylesheet so it can only style content inside a message bubble;
 * the CSS counterpart of prefixClasses(). The input is parsed with a plain
 * brace split — a rule is selector text followed by a { … } block, statements
 * end at a semicolon, and conditional at-rules like @media or @supports wrap
 * nested rules that are recursed into with the same treatment:
 *
 * 1. any rule or statement whose text contains an @import is dropped, so a
 *    stylesheet can never pull in remote CSS;
 * 2. every plain selector gains the ".msg-bubble" descendant prefix and has
 *    its class tokens renamed to the custom-prefixed forms, so ".card .title
 *    p:hover" becomes ".msg-bubble .custom-card .custom-title p:hover";
 * 3. other at-rules (@font-face, @keyframes, …) pass through verbatim, and
 *    declarations inside surviving rules are kept byte-for-byte.
 *
 * Unbalanced input degrades gracefully: stray closing braces are skipped and
 * an unterminated block extends to the end of the string.
 */
export function scopeStyleBlock(css: string): string {
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < css.length) {
    const rest = css.slice(cursor);
    const stop = rest.search(/[{;}]/);
    if (stop === -1) {
      break; // Trailing text with no rule structure; nothing to keep.
    }
    const prelude = rest.slice(0, stop).trim();
    const head = rest.charAt(stop);
    if (head === "}") {
      cursor += stop + 1; // Stray closing brace from unbalanced input; skip it.
      continue;
    }
    if (head === ";") {
      // A standalone statement (@charset, @import, …); @import never survives.
      if (prelude !== "" && !IMPORT_PATTERN.test(prelude)) {
        parts.push(`${prelude};`);
      }
      cursor += stop + 1;
      continue;
    }
    const open = cursor + stop;
    const close = findClosingBrace(css, open);
    const body = close === -1 ? css.slice(open + 1) : css.slice(open + 1, close);
    cursor = close === -1 ? css.length : close + 1;
    // The rule's text spans prelude and body; an @import in either drops it.
    if (IMPORT_PATTERN.test(prelude) || IMPORT_PATTERN.test(body)) {
      continue;
    }
    if (CONDITIONAL_AT_RULE_PATTERN.test(prelude)) {
      const inner = scopeStyleBlock(body);
      parts.push(inner === "" ? `${prelude} {}` : `${prelude} {\n${inner}\n}`);
    } else if (prelude.startsWith("@")) {
      parts.push(`${prelude} {${body}}`);
    } else {
      const scoped = scopeSelectorList(prelude);
      if (scoped !== "") {
        parts.push(`${scoped} {${body}}`);
      }
    }
  }
  return parts.join("\n");
}

/**
 * Elements that are removed wholesale, together with their entire subtree:
 * scripting containers (script, iframe, object, embed, noscript), form
 * controls (form, input, button, select, textarea), media with remote pull
 * semantics (video, audio, source, track), document metadata (base, meta,
 * link) that has no business inside a message bubble, and style — the only
 * style elements that can still reach the filter are malformed ones that
 * dodged the lift, and their unscoped CSS must never reach the page.
 */
const REMOVED_ELEMENTS = new Set([
  "script",
  "iframe",
  "object",
  "embed",
  "noscript",
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "video",
  "audio",
  "source",
  "track",
  "base",
  "meta",
  "link",
  "style",
]);

/**
 * The markup vocabulary that survives sanitization: structural blocks,
 * text-level semantics — q included, so the renderer's quote highlighting
 * survives the filter — tables, images, links, the legacy font element,
 * and collapsible details. Any tag not listed here unwraps to its
 * children. Style elements never survive the filter; their content
 * reaches the page only via the lifted/restored blocks that
 * scopeStyleBlock() has already scoped.
 */
const ALLOWED_ELEMENTS = new Set([
  "p",
  "div",
  "span",
  "br",
  "hr",
  "b",
  "i",
  "u",
  "s",
  "em",
  "strong",
  "mark",
  "q",
  "small",
  "sub",
  "sup",
  "code",
  "pre",
  "blockquote",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
  "caption",
  "colgroup",
  "col",
  "img",
  "a",
  "font",
  "details",
  "summary",
  "figure",
  "figcaption",
  "section",
  "article",
  "header",
  "footer",
  "main",
  "aside",
  "nav",
]);

/**
 * Attributes kept on surviving elements, alongside every data-* attribute.
 * Deliberately absent: event handlers (on*), srcset, target, rel — a
 * surviving element cannot run scripts, pick alternate resources, or dodge
 * the URL gates below.
 */
const ALLOWED_ATTRIBUTES = new Set([
  "style",
  "class",
  "id",
  "title",
  "alt",
  "width",
  "height",
  "src",
  "href",
  "color",
  "face",
  "size",
  "colspan",
  "rowspan",
  "align",
  "valign",
  "dir",
  "lang",
  "loading",
]);

/** href survives only with an http(s) scheme or an in-page #fragment. */
const SAFE_HREF_PATTERN = /^(?:https?:|#)/i;

/** src survives only with an http(s) scheme or an inline data:image/ URI. */
const SAFE_SRC_PATTERN = /^(?:https?:|data:image\/)/i;

/**
 * Browser-only safe-subset filter for model-generated HTML — the
 * input-side counterpart of the string transforms above: where plain-mode
 * rendering escapes everything and builds its own tags, this accepts
 * ready-made HTML (the output of HTML-mode renderMarkdown() among it) and
 * strips it down to a controlled vocabulary of elements and attributes
 * that are inert inside a message bubble.
 *
 * Outside a browser (no window or no DOMParser — tests, SSR) raw content is
 * never passed through unfiltered: the input comes back fully escaped via
 * escapeHtml(), degrading to visible literal text. In the browser the input
 * is parsed with DOMParser — lenient by design, it never throws on
 * malformed input — and every element in the resulting body runs through
 * three gates:
 *
 * 1. the REMOVED_ELEMENTS (script, iframe, style, form controls, media,
 *    document metadata, …) are removed together with their entire subtree;
 * 2. any other tag outside ALLOWED_ELEMENTS is unwrapped: its children
 *    (text nodes included) replace it in place, so the content survives
 *    while the unknown shell disappears;
 * 3. surviving elements keep only ALLOWED_ATTRIBUTES plus data-*, and URL
 *    attributes face a scheme gate on top — href must start with http:,
 *    https: or #, src must start with http:, https: or data:image/ — so
 *    javascript:, vbscript: and friends are dropped.
 *
 * The walk is an explicit worklist rather than recursion, so pathologically
 * nested input cannot overflow the stack, and elements orphaned by a
 * subtree removal (already disconnected) are skipped via isConnected. The
 * whole DOM surgery is wrapped defensively: should anything throw anyway,
 * the function falls back to the fully escaped input instead of emitting
 * partially filtered markup. The sanitized body is serialized back via
 * innerHTML.
 */
export function filterUnsafeMarkup(html: string): string {
  if (typeof window === "undefined" || typeof window.DOMParser === "undefined") {
    return escapeHtml(html);
  }
  try {
    const body = new window.DOMParser().parseFromString(html, "text/html").body;
    if (body === null) {
      return escapeHtml(html);
    }
    const worklist: Element[] = Array.from(body.children);
    while (worklist.length > 0) {
      const element = worklist.pop();
      if (element === undefined) {
        break; // Unreachable: the length check above guarantees a value.
      }
      if (!element.isConnected) {
        continue; // An ancestor was already removed with this whole subtree.
      }
      const tag = element.tagName.toLowerCase();
      if (REMOVED_ELEMENTS.has(tag)) {
        element.remove();
        continue;
      }
      if (!ALLOWED_ELEMENTS.has(tag)) {
        // Unknown tag: unwrap — splice every child (text nodes included)
        // into the parent at this element's position, then drop the shell.
        const parent = element.parentNode;
        if (parent === null) {
          element.remove();
          continue;
        }
        const children = Array.from(element.children);
        while (element.firstChild !== null) {
          parent.insertBefore(element.firstChild, element);
        }
        element.remove();
        for (const child of children) {
          worklist.push(child);
        }
        continue;
      }
      for (const attribute of Array.from(element.attributes)) {
        const name = attribute.name.toLowerCase();
        let urlSafe = true;
        if (name === "href") {
          urlSafe = SAFE_HREF_PATTERN.test(attribute.value);
        } else if (name === "src") {
          urlSafe = SAFE_SRC_PATTERN.test(attribute.value);
        }
        if (!urlSafe || (!ALLOWED_ATTRIBUTES.has(name) && !name.startsWith("data-"))) {
          element.removeAttribute(attribute.name);
        }
      }
      for (const child of Array.from(element.children)) {
        worklist.push(child);
      }
    }
    return body.innerHTML;
  } catch {
    return escapeHtml(html);
  }
}

/** Inline pass; `code` spans are set aside so markup inside stays literal. */
function renderInline(text: string): string {
  return text
    .split(/(`[^`\n]+`)/)
    .map((span) =>
      span.length > 2 && span.startsWith("`") && span.endsWith("`")
        ? `<code>${span.slice(1, -1)}</code>`
        : applyInlineEmphasis(span),
    )
    .join("");
}

/** A fenced block body, escaped, minus its outer newlines. */
function renderCodeBlock(body: string): string {
  const trimmed = body.replace(/^\n/, "").replace(/\n$/, "");
  return `<pre><code>${escapeHtml(trimmed)}</code></pre>`;
}

/** Blank-line-separated paragraphs; single newlines become <br>. */
function renderParagraphs(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "")
    .map((paragraph) => `<p>${renderInline(paragraph).replaceAll("\n", "<br>")}</p>`)
    .join("");
}

/**
 * A style element, open tag through close tag; group 1 is its raw CSS
 * body. The non-greedy body ends each block at its first closing tag, and
 * the open tag is tag-simple — an attribute value containing `>` can end
 * the match early, leaving a malformed block behind for the sanitizer.
 */
const STYLE_BLOCK_PATTERN = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;

/** Sentinels bracketing the placeholder token for a lifted style block. */
const STYLE_TOKEN_START = "\u0004";
const STYLE_TOKEN_END = "\u0005";

/** Placeholder tokens as a pattern; group 1 is the parked sheet's index.
 * Built with new RegExp so the control-character sentinels stay in string
 * form (biome keeps regex literals free of control characters). */
const STYLE_TOKEN_PATTERN = new RegExp(`${STYLE_TOKEN_START}(\\d+)${STYLE_TOKEN_END}`, "g");

/** A tag-shaped region: a `<`, any run without `>`, then `>`. */
const TAG_PATTERN = /<[^>]*>/g;

/** The noncharacter that hides a double quote from the quoted-speech pass. */
const TAG_QUOTE_MASK = "\uFFFE";

/**
 * Lifts every complete style block out of the chunk, parking its raw CSS
 * in `sheets` and leaving a U+0004/U+0005 placeholder token behind. The
 * sheets must sit out the emphasis, quote and newline transforms so their
 * CSS reaches restoreStyleBlocks() untouched.
 */
function liftStyleBlocks(text: string): { text: string; sheets: string[] } {
  const sheets: string[] = [];
  const lifted = text.replace(STYLE_BLOCK_PATTERN, (_match, css: string) => {
    sheets.push(css);
    return `${STYLE_TOKEN_START}${sheets.length - 1}${STYLE_TOKEN_END}`;
  });
  return { text: lifted, sheets };
}

/**
 * Restores the placeholders left by liftStyleBlocks(): each becomes a real
 * style element whose CSS body went through scopeStyleBlock(), so its
 * rules can only target the message bubble; the original open-tag
 * attributes are dropped, as nothing on a style element carries meaning
 * for the bubble. A token without a parked sheet — only possible when the
 * raw text itself contained the sentinels — collapses to the empty string
 * rather than leaking the token through.
 */
function restoreStyleBlocks(text: string, sheets: string[]): string {
  return text.replace(STYLE_TOKEN_PATTERN, (_match, digits: string) => {
    const css = sheets[Number(digits)];
    return css === undefined ? "" : `<style>${scopeStyleBlock(css)}</style>`;
  });
}

/**
 * Masks every double quote that sits inside a tag with U+FFFE, a
 * noncharacter the quoted-speech pattern cannot match, so
 * wrapQuotedSpeech() never mistakes an attribute's quotes for quoted
 * speech. Only the ASCII double quote is masked — the typographic quote
 * pairs the speech pass also recognizes are never attribute delimiters.
 */
function maskTagQuotes(text: string): string {
  return text.replace(TAG_PATTERN, (tag) => tag.replaceAll('"', TAG_QUOTE_MASK));
}

/**
 * Reverses maskTagQuotes() once the quoted-speech pass is done. U+FFFE
 * reaches the text only through the mask — one written literally in the
 * raw input maps back to a plain double quote in text position, which the
 * sanitizer's parse treats as inert character data.
 */
function unmaskTagQuotes(text: string): string {
  return text.replaceAll(TAG_QUOTE_MASK, '"');
}

/**
 * Turns the U+0002/U+0003 sentinel pairs from wrapQuotedSpeech() into q
 * tags; the quoted content between them — its own quote marks included,
 * since the bubble styles suppress the browser's q punctuation — is
 * already in its final form (escaped in plain mode, raw-but-soon-filtered
 * in HTML mode). In HTML mode this must run before filterUnsafeMarkup(): q
 * sits on the sanitizer's allowlist precisely so the highlighting
 * survives the filter.
 */
function restoreQuoteSentinels(text: string): string {
  return text.replaceAll("\u0002", "<q>").replaceAll("\u0003", "</q>");
}

/** Prose chunks take one of the two pipelines, picked by the renderHtml toggle. */
function renderProse(text: string): string {
  return formattingSnapshot().renderHtml ? renderHtmlProse(text) : renderPlainProse(text);
}

/**
 * Plain-mode prose pipeline (renderHtml off): everything is escaped before
 * any markup is built — the classic injection-safe path. Quote
 * highlighting threads through the escape: wrapQuotedSpeech() runs on the
 * raw chunk first, its sentinel characters survive escaping, and the
 * sentinels then become q tags around the already-escaped content.
 * renderParagraphs() finishes with the gated inline emphasis and the
 * blank-line paragraph wrapping with p tags and newline-to-br.
 */
function renderPlainProse(text: string): string {
  const quoted = formattingSnapshot().quotes ? wrapQuotedSpeech(text) : text;
  return renderParagraphs(restoreQuoteSentinels(escapeHtml(quoted)));
}

/**
 * HTML-mode prose pipeline (renderHtml on): the model's markup stays live.
 * Chunk-edge newlines are dropped — mirroring renderCodeBlock() — so
 * fences never acquire stray blank lines; internally, single newlines
 * become br tags and nothing is wrapped in p tags, because raw
 * block-level HTML must not nest inside p. The order of operations is
 * load-bearing:
 *
 * 1. style blocks are lifted aside so no later pass can touch their CSS;
 * 2. double quotes inside tags are masked with U+FFFE so the quoted-speech
 *    pass (3) cannot corrupt attribute values;
 * 3. quoted speech is sentinel-wrapped, gated by the quotes toggle;
 * 4. the masked quotes are restored, then applyInlineEmphasis() runs;
 * 5. single newlines become br tags;
 * 6. the sentinels become q tags — before filterUnsafeMarkup(), which
 *    keeps q on its allowlist so the highlighting survives the filter;
 * 7. filterUnsafeMarkup() strips the chunk to the safe vocabulary; the
 *    lifted sheets ride this pass out as inert sentinel text tokens, so a
 *    style element that does reach the filter — only possible when
 *    malformed markup dodged the lift — is removed with its subtree;
 * 8. the lifted styles come back as scoped style elements, then
 *    prefixClasses() namespaces every surviving class attribute.
 */
function renderHtmlProse(text: string): string {
  let body = text.replace(/^\n+/, "").replace(/\n+$/, "");
  if (body === "") {
    return "";
  }
  const lifted = liftStyleBlocks(body);
  body = maskTagQuotes(lifted.text);
  if (formattingSnapshot().quotes) {
    body = wrapQuotedSpeech(body);
  }
  body = unmaskTagQuotes(body);
  body = applyInlineEmphasis(body);
  body = body.replaceAll("\n", "<br>");
  body = restoreQuoteSentinels(body);
  body = filterUnsafeMarkup(body);
  body = restoreStyleBlocks(body, lifted.sheets);
  return prefixClasses(body);
}

/**
 * Renders message markdown to an HTML string (pure, no dependencies): the
 * input splits into alternating prose and code chunks on ``` and ~~~
 * fences, code chunks are escaped and rendered literally, and each prose
 * chunk goes through the plain or the HTML pipeline per the live
 * formatting.renderHtml toggle — see the module docstring for the contract.
 */
export function renderMarkdown(text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n");
  // Odd chunks sit between fences — code; even chunks are prose.
  return normalized
    .split(CODE_FENCE_PATTERN)
    .map((chunk, index) => (index % 2 === 1 ? renderCodeBlock(chunk) : renderProse(chunk)))
    .join("");
}
