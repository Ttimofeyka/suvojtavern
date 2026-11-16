/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The tracker template language — the shared renderer for tracker HTML
 * presets and plugin drawer tabs (docs/TRACKER.md → "Template syntax").
 *
 * The data root is the JSON itself (NOT wrapped):
 *
 * - `{{path.to.value}}` — dot-path interpolation, HTML-escaped (`& < > " '`);
 * - `{{{path}}}` — dot-path interpolation, unescaped;
 * - `{{#each array}}…{{/each}}` — iteration; `{{this}}`, `{{this.field}}`
 *   and `{{@index}}` inside;
 * - `{{#if path}}…{{else}}…{{/if}}` — truthiness branching (empty strings,
 *   null, false, 0 and EMPTY ARRAYS read as falsy — an absent list renders
 *   the else branch, which is what template authors expect);
 * - `{{join array ", "}}` — joins an array of strings/numbers.
 *
 * Unknown paths render as an empty string (never an error). Malformed
 * templates — unterminated tags, mismatched or unknown block tags — throw
 * `Error("Template syntax error: …")`.
 */

/** One lexical unit: raw text or a parsed `{{ }}` tag. */
type Token =
  | { kind: "text"; text: string }
  | { kind: "var"; path: string; raw: boolean }
  | { kind: "join"; path: string; separator: string }
  | { kind: "each-open"; path: string }
  | { kind: "if-open"; path: string }
  | { kind: "else" }
  | { kind: "each-close" }
  | { kind: "if-close" };

/** Parsed template tree; block nodes own their bodies. */
type Node =
  | { type: "text"; text: string }
  | { type: "var"; path: string; raw: boolean }
  | { type: "join"; path: string; separator: string }
  | { type: "each"; path: string; body: Node[] }
  | { type: "if"; path: string; body: Node[]; elseBody: Node[] };

type EachNode = Extract<Node, { type: "each" }>;
type IfNode = Extract<Node, { type: "if" }>;

/** One open block frame: the list nodes append into, and the block itself. */
interface Frame {
  list: Node[];
  block: EachNode | IfNode | null;
}

/** `{{join path "separator"}}` — the separator runs to the closing quote. */
const JOIN_SYNTAX = /^join\s+(\S+)\s+"(.*)"$/;
const EACH_SYNTAX = /^#each(?:\s+(.+))?$/;
const IF_SYNTAX = /^#if(?:\s+(.+))?$/;

/** HTML-escapes a value for `{{ }}` interpolation. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Splits the source into text and tag tokens, rejecting unterminated tags. */
function tokenize(template: string): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;
  while (cursor < template.length) {
    const open = template.indexOf("{{", cursor);
    if (open === -1) {
      tokens.push({ kind: "text", text: template.slice(cursor) });
      break;
    }
    if (open > cursor) {
      tokens.push({ kind: "text", text: template.slice(cursor, open) });
    }
    const triple = template.startsWith("{{{", open);
    const body = open + (triple ? 3 : 2);
    const close = template.indexOf(triple ? "}}}" : "}}", body);
    if (close === -1) {
      throw new Error("Template syntax error: unterminated tag");
    }
    const tag = template.slice(body, close).trim();
    cursor = close + (triple ? 3 : 2);
    if (triple) {
      tokens.push({ kind: "var", path: tag, raw: true });
      continue;
    }
    if (tag === "else") {
      tokens.push({ kind: "else" });
    } else if (tag === "/each") {
      tokens.push({ kind: "each-close" });
    } else if (tag === "/if") {
      tokens.push({ kind: "if-close" });
    } else if (EACH_SYNTAX.test(tag)) {
      tokens.push({ kind: "each-open", path: tag.match(EACH_SYNTAX)?.[1]?.trim() ?? "" });
    } else if (IF_SYNTAX.test(tag)) {
      tokens.push({ kind: "if-open", path: tag.match(IF_SYNTAX)?.[1]?.trim() ?? "" });
    } else {
      const join = tag.match(JOIN_SYNTAX);
      if (join !== null) {
        tokens.push({ kind: "join", path: join[1] ?? "", separator: join[2] ?? "" });
      } else if (tag.startsWith("#") || tag.startsWith("/")) {
        throw new Error(`Template syntax error: unknown tag "{{${tag}}}"`);
      } else {
        tokens.push({ kind: "var", path: tag, raw: false });
      }
    }
  }
  return tokens;
}

/** Nests the token stream into block nodes, rejecting mismatched tags. */
function buildTree(tokens: Token[]): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [{ list: root, block: null }];
  for (const token of tokens) {
    const top = stack[stack.length - 1];
    if (top === undefined) {
      throw new Error("Template syntax error: block stack underflow");
    }
    switch (token.kind) {
      case "text":
        top.list.push({ type: "text", text: token.text });
        break;
      case "var":
        top.list.push({ type: "var", path: token.path, raw: token.raw });
        break;
      case "join":
        top.list.push({ type: "join", path: token.path, separator: token.separator });
        break;
      case "each-open": {
        const node: EachNode = { type: "each", path: token.path, body: [] };
        top.list.push(node);
        stack.push({ list: node.body, block: node });
        break;
      }
      case "if-open": {
        const node: IfNode = { type: "if", path: token.path, body: [], elseBody: [] };
        top.list.push(node);
        stack.push({ list: node.body, block: node });
        break;
      }
      case "else": {
        if (top.block?.type !== "if") {
          throw new Error("Template syntax error: {{else}} outside {{#if}}");
        }
        top.list = top.block.elseBody;
        break;
      }
      case "each-close": {
        if (top.block?.type !== "each") {
          throw new Error("Template syntax error: mismatched {{/each}}");
        }
        stack.pop();
        break;
      }
      case "if-close": {
        if (top.block?.type !== "if") {
          throw new Error("Template syntax error: mismatched {{/if}}");
        }
        stack.pop();
        break;
      }
    }
  }
  if (stack.length > 1) {
    throw new Error(`Template syntax error: unclosed {{#${stack[stack.length - 1]?.block?.type}}}`);
  }
  return root;
}

/** One #each scope: the current item plus its iteration index. */
interface Scope {
  value: unknown;
  index: number | null;
}

/** The innermost scope (the stack always carries the root). */
function innermost(scopes: Scope[]): Scope {
  const scope = scopes[scopes.length - 1];
  if (scope === undefined) {
    throw new Error("Template syntax error: empty scope stack");
  }
  return scope;
}

/** Walks dot-path `segments` from `root`; a missing step resolves undefined. */
function walk(root: unknown, segments: string[]): unknown {
  let current: unknown = root;
  for (const segment of segments) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Resolves one template path against the scope stack. `this`-relative paths
 * (`this`, `this.field`, `./field`) read the innermost scope only; bare
 * paths walk outward through the enclosing scopes (root last) — the first
 * scope that defines the path wins. `@index` is the innermost #each index.
 */
function resolvePath(path: string, scopes: Scope[]): unknown {
  if (path === "@index") {
    for (let i = scopes.length - 1; i >= 0; i -= 1) {
      const scope = scopes[i];
      if (scope !== undefined && scope.index !== null) {
        return scope.index;
      }
    }
    return undefined;
  }
  const current = innermost(scopes);
  if (path === "this" || path === ".") {
    return current.value;
  }
  let remainder = path;
  let thisRelative = false;
  if (remainder.startsWith("this.")) {
    thisRelative = true;
    remainder = remainder.slice(5);
  } else if (remainder.startsWith("./") || remainder.startsWith(".")) {
    thisRelative = true;
    remainder = remainder.slice(remainder.startsWith("./") ? 2 : 1);
  }
  const segments = remainder.split(".").filter((segment) => segment !== "");
  if (thisRelative) {
    return walk(current.value, segments);
  }
  for (let i = scopes.length - 1; i >= 0; i -= 1) {
    const scope = scopes[i];
    if (scope === undefined) {
      continue;
    }
    const found = walk(scope.value, segments);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/** Stringifies an interpolated value; missing values render as "". */
function stringify(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object") {
    return JSON.stringify(value) ?? "";
  }
  return String(value);
}

/** #if truthiness: JS rules, plus empty arrays reading as falsy. */
function truthy(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

function renderNodes(nodes: Node[], scopes: Scope[]): string {
  let out = "";
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        out += node.text;
        break;
      case "var": {
        const value = stringify(resolvePath(node.path, scopes));
        out += node.raw ? value : escapeHtml(value);
        break;
      }
      case "join": {
        const value = resolvePath(node.path, scopes);
        out += Array.isArray(value)
          ? value.map((item) => stringify(item)).join(node.separator)
          : "";
        break;
      }
      case "each": {
        const value = resolvePath(node.path, scopes);
        if (!Array.isArray(value)) {
          break;
        }
        for (let i = 0; i < value.length; i += 1) {
          out += renderNodes(node.body, [...scopes, { value: value[i], index: i }]);
        }
        break;
      }
      case "if": {
        const branch = truthy(resolvePath(node.path, scopes)) ? node.body : node.elseBody;
        out += renderNodes(branch, scopes);
        break;
      }
    }
  }
  return out;
}

/**
 * Renders `template` with `data` as the root object. Throws
 * `Error("Template syntax error: …")` on malformed templates; unknown
 * paths render as empty strings.
 */
export function renderTemplate(template: string, data: unknown): string {
  if (template === "") {
    return "";
  }
  return renderNodes(buildTree(tokenize(template)), [{ value: data, index: null }]);
}
