#!/usr/bin/env node
/**
 * Enumerate every place the editor's own code reaches page state it shares with
 * whatever else is on the page, and give each occurrence a verdict about running
 * inline (mounted in a page a host also draws in) rather than in a page of its
 * own. `docs/PAGE_OWNERSHIP.md` is the write-up; this file is where its numbers
 * come from, so nothing there prints a count.
 *
 * Two halves, deliberately kept apart:
 *
 *   SCAN. Broad, and it knows nothing about the verdicts. It finds candidate
 *   sites by shape alone: any reference to `document`, `window`, `CSS.highlights`
 *   or viewport-anchored positioning in product TypeScript, and any CSS selector
 *   at the top level of a stylesheet plus any fixed/viewport-unit declaration.
 *
 *   RULES. A table keyed by the scan's `kind` plus a refinement (an event name,
 *   a classList operation, a selector shape). Whatever no rule recognizes is
 *   RESIDUE and is printed by name.
 *
 * The separation is the point. If the rules did the finding, "every occurrence
 * has a verdict" would be true by construction. Because the scan is broader than
 * the table, a new shape of page-ownership shows up as residue rather than being
 * quietly sorted into a bucket that was never asked about it. `--check` is what
 * holds that, and it also holds a floor on what the scan reached, because a
 * scanner that matched nothing would otherwise report a clean audit.
 *
 * Usage:
 *   node scripts/audit-page-ownership.mjs            report, grouped by verdict
 *   node scripts/audit-page-ownership.mjs --by-kind  report, grouped by kind
 *   node scripts/audit-page-ownership.mjs --list     every occurrence, one per line
 *   node scripts/audit-page-ownership.mjs --json     the whole thing as JSON
 *   node scripts/audit-page-ownership.mjs --check    exit nonzero on residue or a floor miss
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_DIR = join(ROOT, "webview");

// ─── Verdicts ────────────────────────────────────────────────────────────────

/**
 * PORTABLE   The occurrence behaves the same inline as it does in a page of its
 *            own, and imposes nothing on the host. A global READ, or a global
 *            listener that neither cancels the event nor changes anything
 *            outside the editor's own DOM, is portable however alarming it looks
 *            in a grep.
 *
 * SCOPE      Inline it works but reaches further than it should, and the fix is
 *            mechanical: re-root a selector, name a token, take the container
 *            from the host instead of assuming the page. No design decision is
 *            reopened by fixing one of these.
 *
 * OWNS_PAGE  The behaviour IS a claim on the page, so scoping it changes what it
 *            does. Freezing the page's scroll, anchoring chrome to the viewport,
 *            trusting every message the window receives. Running inline means
 *            deciding to give the claim up or to keep asking the host for it.
 */
const PORTABLE = "portable";
const SCOPE = "scope";
const OWNS_PAGE = "owns-page";
export const VERDICTS = [PORTABLE, SCOPE, OWNS_PAGE];

// ─── What the scan deliberately does not collect ─────────────────────────────

/**
 * Printed by the report so the universe is stated rather than implied.
 * Each line is a shape that a grep for `document.` finds and that owns nothing.
 */
const NOT_COLLECTED = [
    ["document factories", "createElement, createTextNode, createRange, createTreeWalker, createDocumentFragment, createComment, implementation. They return detached nodes and touch no shared state."],
    ["a document that is not the page's", "`view.document…` in webview/export/index.ts is the export window's document. The scan requires `document` not to be preceded by a dot, so those sites are out by construction rather than by an exception list."],
    ["listeners on the editor's own elements", "el.addEventListener on a node the editor made is scoped by the node. Only `document` and `window` registrations are page state."],
    ["nested CSS", "a selector below the top level of a stylesheet is already scoped by its parent. Only depth-0 selectors can match outside the editor's subtree."],
    ["comment-only lines", "a line whose trimmed form starts with //, /* or * is dropped before the TypeScript patterns run, so prose about `document.body` is not an occurrence."],
];

// ─── Scan: TypeScript ────────────────────────────────────────────────────────

/**
 * `document` not preceded by a dot, so `view.document` and `iframe.document` are
 * a document that is not the page's and are not occurrences. The spread operator
 * is the exception that has to be written out: `[...document.body.classList]` is
 * three dots rather than a property access, and rejecting it lost a real site.
 */
const DOC = String.raw`(?:(?<=\.\.\.)|(?<![.\w$]))document`;
const WIN = String.raw`(?:(?<=\.\.\.)|(?<![.\w$]))window`;

/**
 * Each entry: a kind, a regex, and how to read the refinement out of the match.
 * Order matters only where two patterns could claim one line; the first wins and
 * the rest are tried against the remainder of the line's matches independently,
 * so a line with two distinct shapes yields two occurrences.
 */
const TS_PATTERNS = [
    { kind: "doc-listener", re: new RegExp(DOC + String.raw`\.addEventListener\(\s*["'](\w+)["']`, "g"), refine: (m) => m[1] },
    { kind: "win-listener", re: new RegExp(WIN + String.raw`\.addEventListener\(\s*["'](\w+)["']`, "g"), refine: (m) => m[1] },
    { kind: "body-class", re: new RegExp(DOC + String.raw`\.body\.classList(?:\.(\w+))?`, "g"), refine: (m) => m[1] ?? "spread" },
    { kind: "body-style", re: new RegExp(DOC + String.raw`\.body\.style\.(\w+)`, "g"), refine: (m) => m[1] },
    { kind: "body-child", re: new RegExp(DOC + String.raw`\.body\.(appendChild|removeChild|insertBefore|append|prepend|replaceChildren|contains)`, "g"), refine: (m) => m[1] },
    { kind: "root-custom-prop", re: new RegExp(DOC + String.raw`\.documentElement\.style\.(setProperty|removeProperty)`, "g"), refine: (m) => m[1] },
    { kind: "root-style", re: new RegExp(DOC + String.raw`\.documentElement\.style(?!\.(?:setProperty|removeProperty))(?:\.(\w+))?`, "g"), refine: (m) => m[1] ?? "handle" },
    { kind: "root-attr", re: new RegExp(DOC + String.raw`\.documentElement\.(classList|lang|dir|dataset|setAttribute)`, "g"), refine: (m) => m[1] },
    { kind: "viewport-metric", re: new RegExp(DOC + String.raw`\.documentElement\.(client\w+|scroll\w+|offset\w+)`, "g"), refine: (m) => m[1] },
    { kind: "head-inject", re: new RegExp(DOC + String.raw`\.head(?:\.(\w+))?`, "g"), refine: (m) => m[1] ?? "probe" },
    { kind: "highlight-registry", re: /(?<![.\w])CSS\.highlights\.(\w+)/g, refine: (m) => m[1] },
    { kind: "doc-query", re: new RegExp(DOC + String.raw`\.(getElementById|querySelector|querySelectorAll|getElementsBy\w+)`, "g"), refine: (m) => m[1] },
    { kind: "doc-focus", re: new RegExp(DOC + String.raw`\.(activeElement|hasFocus)`, "g"), refine: (m) => m[1] },
    { kind: "doc-misc", re: new RegExp(DOC + String.raw`\.(elementFromPoint|elementsFromPoint|execCommand|visibilityState|styleSheets|dispatchEvent|getSelection|title|referrer|cookie|write|open|close)`, "g"), refine: (m) => m[1] },
    { kind: "win-global", re: new RegExp(WIN + String.raw`\.(parent|top|opener|location|frameElement|focus|name|postMessage|__i18n|getSelection|print|close|open)`, "g"), refine: (m) => m[1] },
    { kind: "fixed-position-js", re: /\.position\s*=\s*["']fixed["']|position:\s*fixed/g, refine: () => "fixed" },
];

/** A line that is only a comment cannot be an occurrence. Conservative: it never drops code. */
function isCommentLine(line) {
    const t = line.trim();
    return t.startsWith("//") || t.startsWith("/*") || t.startsWith("*") || t.startsWith("*/");
}

function scanTypeScript(file, text) {
    const out = [];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (isCommentLine(line)) continue;
        for (const p of TS_PATTERNS) {
            p.re.lastIndex = 0;
            let m;
            while ((m = p.re.exec(line)) !== null) {
                out.push({
                    file,
                    line: i + 1,
                    kind: p.kind,
                    refinement: p.refine(m),
                    text: line.trim().slice(0, 160),
                });
            }
        }
    }
    return out;
}

// ─── Scan: CSS ───────────────────────────────────────────────────────────────

function stripCssComments(text) {
    // Replace comment bodies with spaces so line numbers and offsets survive.
    return text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
}

/**
 * Walk braces, tracking how deep inside STYLE rules we are. At-rules open a
 * block without adding selector nesting, so `body {}` inside `@media` is still
 * top level. `@keyframes` contents are skipped: its children are percentages,
 * not selectors.
 */
function scanCss(file, raw) {
    const text = stripCssComments(raw);
    const out = [];
    const stack = [];
    let styleDepth = 0;
    let keyframeDepth = -1;
    let buf = "";
    let bufStartLine = 1;
    let line = 1;
    let selectorAtDepth0 = null;

    const startBuf = () => { buf = ""; bufStartLine = line; };

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === "{") {
            const prelude = buf.trim().replace(/\s+/g, " ");
            if (prelude.startsWith("@")) {
                stack.push({ at: true });
                if (/^@keyframes/i.test(prelude) && keyframeDepth < 0) keyframeDepth = stack.length;
            } else {
                stack.push({ at: false });
                if (keyframeDepth < 0) {
                    if (styleDepth === 0) {
                        selectorAtDepth0 = { selector: prelude, line: bufStartLine };
                        out.push({ file, line: bufStartLine, kind: "css-selector", refinement: selectorShape(prelude), text: prelude.slice(0, 160) });
                    }
                    styleDepth++;
                }
            }
            startBuf();
            continue;
        }
        if (ch === "}") {
            const f = stack.pop();
            if (f && !f.at && keyframeDepth < 0) {
                styleDepth--;
                if (styleDepth === 0) selectorAtDepth0 = null;
            }
            if (keyframeDepth >= 0 && stack.length < keyframeDepth) keyframeDepth = -1;
            startBuf();
            continue;
        }
        if (ch === ";") {
            recordDeclaration(out, file, bufStartLine, buf, selectorAtDepth0);
            startBuf();
            continue;
        }
        if (ch === "\n") {
            line++;
            if (buf.trim() === "") bufStartLine = line;
        }
        buf += ch;
    }
    return out;
}

/**
 * A viewport length is two different things depending on the property it is in,
 * and lumping them together overstated the audit's first run. A cap (`max-width:
 * calc(100vw - 32px)`) says a popup may not grow past the screen, which is right
 * for fixed-positioned chrome wherever the editor is mounted. A size (`min-
 * height: 100vh`) says the editor's own box IS the viewport, which inline is
 * false. The property name is what tells them apart.
 */
function viewportUnitRole(property, value, unitIndex) {
    if (property.startsWith("--")) return "fallback";
    if (/^(max-width|max-height|max-block-size|max-inline-size)$/.test(property)) return "cap";
    // `width: min(560px, calc(100vw - 32px))` is a cap wearing a sizing
    // property's name: the viewport term only ever lowers the result. A `max()`
    // is the opposite and stays a size.
    if (enclosingFunctions(value, unitIndex).includes("min")) return "cap";
    return "size";
}

/** The CSS function names whose parentheses contain `index`, outermost first. */
function enclosingFunctions(value, index) {
    const open = [];
    for (let i = 0; i < index && i < value.length; i++) {
        if (value[i] === "(") {
            const name = (value.slice(0, i).match(/([a-zA-Z-]+)$/) ?? [, ""])[1];
            open.push(name.toLowerCase());
        } else if (value[i] === ")") {
            open.pop();
        }
    }
    return open;
}

function recordDeclaration(out, file, line, decl, topSelector) {
    const d = decl.trim();
    if (!d) return;
    if (/^position\s*:\s*fixed$/i.test(d)) {
        out.push({ file, line, kind: "css-fixed", refinement: topSelector ? "in-rule" : "loose", text: d.slice(0, 160) });
    }
    const vp = d.match(/[\d.]+(dvh|dvw|svh|svw|lvh|lvw|vh|vw|vmin|vmax)\b/);
    if (vp) {
        const colon = d.indexOf(":");
        const property = d.slice(0, colon < 0 ? 0 : colon).trim().toLowerCase();
        const value = d.slice(colon + 1);
        out.push({
            file,
            line,
            kind: "css-viewport-unit",
            refinement: viewportUnitRole(property, value, vp.index - colon - 1),
            text: d.slice(0, 160),
        });
    }
    if (/::highlight\(/.test(d)) {
        out.push({ file, line, kind: "css-highlight", refinement: "declaration", text: d.slice(0, 160) });
    }
}

/**
 * What a top-level selector can reach. The question is whether it can match an
 * element the editor did not make.
 */
/** Split on commas that are not inside brackets, so `:is(a, b)` stays one part. */
function splitTopLevel(text, sep = ",") {
    const parts = [];
    let depth = 0;
    let cur = "";
    for (const ch of text) {
        if (ch === "(" || ch === "[") depth++;
        else if (ch === ")" || ch === "]") depth--;
        if (ch === sep && depth === 0) { parts.push(cur); cur = ""; continue; }
        cur += ch;
    }
    parts.push(cur);
    return parts.map((s) => s.trim()).filter(Boolean);
}

/** The first compound of a complex selector, respecting brackets. */
function firstCompound(part) {
    let depth = 0;
    for (let i = 0; i < part.length; i++) {
        const ch = part[i];
        if (ch === "(" || ch === "[") depth++;
        else if (ch === ")" || ch === "]") depth--;
        else if (depth === 0 && /[\s>+~]/.test(ch)) return part.slice(0, i);
    }
    return part;
}

const FUNCTIONAL_PSEUDO = /^:(is|where|not|has|matches|-webkit-any)\(/;

function shapesOf(selectorList, shapes = new Set()) {
    for (const part of splitTopLevel(selectorList)) {
        const head = firstCompound(part);
        if (FUNCTIONAL_PSEUDO.test(head)) {
            // `:is(button, .x)` reaches as far as its most reaching argument, so
            // look inside rather than calling the whole thing a pseudo-class.
            const inner = head.slice(head.indexOf("(") + 1, head.lastIndexOf(")"));
            shapesOf(inner, shapes);
            continue;
        }
        if (/^\*/.test(head)) shapes.add("universal");
        else if (/^:root/.test(head)) shapes.add("root");
        else if (/^html\b/.test(head)) shapes.add("html");
        else if (/^body\b/.test(head)) shapes.add("body");
        else if (/^[.#]/.test(head)) shapes.add("class-or-id");
        else if (/^&/.test(head)) shapes.add("nesting-ref");
        else if (/^\[/.test(head)) shapes.add("attribute");
        else if (/^:/.test(head)) shapes.add("pseudo");
        else if (/^[a-zA-Z][\w-]*/.test(head)) shapes.add("bare-element");
        else shapes.add("other");
    }
    return shapes;
}

function selectorShape(selector) {
    if (/::highlight\(/.test(selector)) return "highlight";
    const shapes = shapesOf(selector);
    // A selector list is as reaching as its most reaching part.
    for (const s of ["universal", "html", "root", "body", "bare-element", "attribute", "other", "pseudo", "nesting-ref", "class-or-id"]) {
        if (shapes.has(s)) return s;
    }
    return "other";
}

// ─── Rules ───────────────────────────────────────────────────────────────────

/**
 * A rule is [kind, refinement predicate, verdict, why, file?]. `refinement` may
 * be a string, an array of strings, or "*"; `file` is an optional regex that the
 * occurrence's path must match, which is how one site gets a verdict its family
 * does not share. The first matching rule wins, so specific rules are written
 * above the family's default.
 *
 * The `why` is the whole content of this file. It is written to be read next to
 * the occurrence, not summarized: `docs/PAGE_OWNERSHIP.md` quotes the arguments,
 * never the counts.
 */
const RULES = [
    // ── one site whose verdict differs from its family's ─────────────────────
    ["doc-listener", ["keydown", "mousedown", "paste", "drop", "cut", "compositionstart", "beforeinput"],
        SCOPE,
        "setupInteractionTracking in webview/editor.ts. These seven listeners are the sole gate between a doc-changing transaction and a dirty document: until one of them fires, no sync is requested, which is what keeps merely OPENING a file from serializing and posting a save. The question the gate means to ask is whether the reader has touched THE EDITOR, and at the document it is answered by the reader touching anything on the page. Inline, a keystroke in the host's own field lifts the gate, and the next normalization a plugin performs on the freshly opened document would then be posted as the reader's edit. The fix is mechanical, a listener on the editor's own root, and this is the sharpest case in the audit of a site whose family verdict is wrong for it: five of these events appear nowhere else, and the other two are portable everywhere else they are registered.",
        /^webview\/editor\.ts$/],

    // ── document listeners ───────────────────────────────────────────────────
    ["doc-listener", ["mousemove", "mouseup", "pointermove", "pointerup", "pointercancel"],
        PORTABLE,
        "A gesture in flight. The listener is added when a drag or resize starts and removed when it ends, and listening at the document is how a pointer that leaves the element is still followed. Inline it sees the host's pointer too, which is what following a drag means; it cancels nothing and writes nothing outside the editor."],
    ["doc-listener", ["mousedown", "pointerdown", "click"],
        PORTABLE,
        "Outside-press dismissal. It has to hear a press anywhere on the page, and inline that includes the host's chrome, which is the behaviour a reader wants: clicking the host's toolbar should close the editor's menu. The handler tests containment and otherwise does nothing."],
    ["doc-listener", ["keydown", "keyup"],
        SCOPE,
        "A key claimed at the document. Most registrations here are transient and modal (a lightbox, a drag, an open menu), which bounds the claim to a surface the reader opened; two are permanent, and the permanent ones are the Cmd-held tracking in components/pathLink/index.ts, which only decorates the editor's own links and cancels nothing. What makes the family a scope change rather than portable is that a capturing document keydown gets the key before the host does, so inline the editor answers Escape and the arrows while the reader is in the host's own field. The fix is a containment guard on the event's target, not a redesign."],
    ["doc-listener", "copy",
        SCOPE,
        "The copy event at the document reaches a copy made anywhere on the page. Inline, the editor would rewrite the clipboard for a copy out of the host's own text. Guarding on whether the selection is inside the editor is the fix."],
    ["doc-listener", "visibilitychange",
        PORTABLE,
        "A read of the page's visibility. Every occupant of a page shares it and none of them can change it."],
    ["doc-listener", ["paste", "drop", "cut", "compositionstart", "beforeinput"],
        SCOPE,
        "An input event claimed at the document. These are registered only by the interaction gate today; the rule stands in case another module reaches for one, because an input event at the document is an input event of the host's."],

    // ── window listeners ─────────────────────────────────────────────────────
    ["win-listener", "scroll",
        PORTABLE,
        "Capturing scroll at the window, because scroll does not bubble and the editor's scroller is not the window. Inline this keeps working and keeps being right: chrome anchored to an element has to reposition when ANY ancestor scrolls, the host's included. The listeners are passive and reposition only."],
    ["win-listener", "resize",
        SCOPE,
        "The window resizing stands in for the editor's box changing size. Inline that is the wrong signal in both directions: the host can resize the editor without the window moving, and the window can move without the editor's box changing. A ResizeObserver on the mount is the fix, and the editor already uses one in plugins/visibleRange.ts beside this listener."],
    ["win-listener", "blur",
        SCOPE,
        "Window blur stands in for the editor losing focus, which is true when the editor owns the page and false inline, where focus moving to the host's field leaves the window focused. The editor would hold state (a modifier as held, a popup as live) that the reader has moved away from. A focusout on the mount is the fix."],
    ["win-listener", "pagehide",
        PORTABLE,
        "A last chance to flush before the page goes. Inline the editor's bytes are the host's anyway, and listening costs the host nothing."],
    ["win-listener", "message",
        OWNS_PAGE,
        "The host protocol arrives as a message event on the editor's own window, and the editor applies what arrives. That is safe exactly because the window is the editor's: inside VS Code only the extension can post to it. Inline the window is the host's and any script on the page can post the editor a document, a read-only flip or an external update. Scoping does not fix it, because there is nothing narrower than the window to listen on; the transport has to change, to a MessagePort handed over at boot. docs/HOSTING.md already says the frame page is inside the host's trust boundary, and inline there is no boundary left to be inside."],
    ["win-listener", "*",
        SCOPE,
        "A window event with no rule of its own. Read the registration before trusting this verdict."],

    // ── body as a state channel ──────────────────────────────────────────────
    ["body-class", ["add", "remove", "toggle", "spread"],
        SCOPE,
        "Body classes are the editor's state channel by design: a module writes one, a stylesheet in another module reads it, and a third module reads it back. Inline, the class lands in the host's namespace under names as generic as read-only, toolbar-hidden and files-open, and the selectors that read it still match because the editor's DOM is under the body either way. So it works and it pollutes. The fix is mechanical and it is one fix, not one per site: give the editor a root element and move the channel onto it. What makes it more than a rename is that the editor has no such element today, because the toolbar and the document are siblings and the popups are portalled elsewhere."],
    ["body-class", "contains",
        SCOPE,
        "The read half of the same channel. It moves with the write half and is worth counting separately only because it shows how far the channel reaches."],
    ["body-style", "overflow",
        OWNS_PAGE,
        "lockBodyScroll in webview/utils.ts freezes the page's scrolling while a fullscreen surface is up. Inline that is a claim on the host's page, and scoping it to the editor's own box would not do what it is for: the surface covers the viewport, so what must not scroll is the viewport. Either the host grants it or the surface stops being fullscreen."],
    ["body-style", "*",
        SCOPE,
        "A write to the host's body style with no rule of its own. Read the site before trusting this verdict."],
    ["body-child", ["appendChild", "insertBefore", "append", "prepend", "replaceChildren"],
        SCOPE,
        "A portal. Menus, tooltips, toasts and lightboxes are appended to the body so they escape the clipping and the stacking contexts of whatever they are anchored to. Inline the body is the host's, so the editor's chrome becomes a sibling of the host's chrome and is subject to the host's z-index, while escaping any clipping the host meant to apply to the editor's box. The fix is a portal container the host provides, and it comes with a constraint the host has to meet: the container must not sit inside an ancestor with overflow, transform, filter or contain, or a fixed-position popup is clipped or re-anchored."],
    ["body-child", ["removeChild", "contains"],
        PORTABLE,
        "Taking back or testing for a node the editor put there. It reaches no further than the portal it pairs with."],

    // ── the root element ─────────────────────────────────────────────────────
    ["root-custom-prop", ["setProperty", "removeProperty"],
        SCOPE,
        "A custom property on the document root, which is how a value set in script reaches stylesheets by inheritance. Inline it defines names like --editor-max-width and --content-font-scale on the host's root, where the host's own CSS can read them and a second editor on the page would fight over them. Moving them to a root element of the editor's own fixes the collision and narrows the restyle they cause, which AGENTS.md prices as proportional to the document. It needs that element to exist and to be an ancestor of the toolbar as well as the document."],
    ["root-style", "*",
        SCOPE,
        "Reading or holding the root's style declaration in order to write custom properties through it. Same fix as the writes."],
    ["root-attr", "*",
        SCOPE,
        "An attribute on the host's html element. Inline it belongs on the editor's own root."],
    ["viewport-metric", "*",
        SCOPE,
        "The viewport's size read off the document element, used as the editor's available size. Inline the editor's box is not the viewport, so the number is wrong whenever the host gives the editor less than the whole window. The mount's own rect is the fix."],

    // ── the head ─────────────────────────────────────────────────────────────
    ["head-inject", ["appendChild", "append", "insertBefore", "prepend"],
        SCOPE,
        "A stylesheet injected at first use, which AGENTS.md requires for ::highlight() rules and which the lazily-built panels follow. Inline it adds rules to the host's document. The editor's own sheets are written under its class names and would not repaint the host's page, but they are global and unversioned, and the KaTeX sheet is a third party's. Injecting into a root the host names, or into a shadow root, is the fix, and the ::highlight() rules cannot follow it (see css-highlight)."],
    ["head-inject", "probe",
        PORTABLE,
        "A test for whether a head exists at all, which is how these modules stay loadable with no document. It writes nothing."],

    // ── document-scoped registries and reads ─────────────────────────────────
    ["highlight-registry", ["set", "delete", "clear"],
        SCOPE,
        "CSS.highlights is a registry on the document, and the editor registers global names: find-highlight, find-scope, find-highlight-current. Inline the names are in the host's namespace and two editors on one page would overwrite each other's ranges. Instance-scoped names are the fix. The registry itself cannot be scoped at all, which is the concrete reason shadow DOM is not the escape it looks like: a highlight registered from inside a shadow root is still registered on the document, and the ::highlight() rule that paints it still has to be a document rule."],
    ["doc-query", ["getElementById", "querySelector", "querySelectorAll"],
        SCOPE,
        "A query rooted at the document, most visibly the hardcoded getElementById(\"editor\") that finds the mount. Inline the id is in the host's namespace, a second editor has nowhere to go, and a query for the editor's own chrome can find the host's element of the same shape. Taking the mount as an argument and querying within it is the fix, and it is the one place where the port has a natural first step."],
    ["doc-focus", ["activeElement", "hasFocus"],
        PORTABLE,
        "Reading where focus is. It is a page-wide read by nature and there is no scoped equivalent that answers the same question; inline it goes on answering correctly, and callers that want \"is focus inside me\" already test containment against their own node."],
    ["doc-misc", ["elementFromPoint", "elementsFromPoint"],
        PORTABLE,
        "Hit-testing a point against the page, used to find what a pointer is over. Inline it returns the host's element when the pointer is over the host, which is the true answer."],
    ["doc-misc", "execCommand",
        PORTABLE,
        "The deprecated clipboard and formatting path, applied to the current selection, which is the editor's when the editor called it."],
    ["doc-misc", ["visibilityState", "getSelection"],
        PORTABLE,
        "A read of shared page state that every occupant shares and none can claim."],
    ["doc-misc", "styleSheets",
        SCOPE,
        "Walking the document's stylesheets finds the host's as well as the editor's. Inline it should be looking at a known sheet rather than at everything the page has loaded."],
    ["doc-misc", "dispatchEvent",
        SCOPE,
        "An event dispatched at the document is delivered to every listener on the page, the host's included. Dispatching at the editor's own root keeps the same delivery for the editor's own listeners."],
    ["doc-misc", "*",
        SCOPE,
        "A document-level call with no rule of its own. Read the site before trusting this verdict."],
    ["win-global", ["focus"],
        OWNS_PAGE,
        "init ends in window.focus(). In a frame that takes the frame, which docs/HOSTING.md records as differing by engine. Inline it takes the whole page, so opening a document pulls the caret out of whatever field the reader was in. There is no scoped form of it that means the same thing: focusing the editor's own node is a different act with a different outcome, and deciding between them is a design decision the embed API has to make."],
    ["win-global", ["parent", "top", "opener", "frameElement", "postMessage"],
        OWNS_PAGE,
        "Addressing the window that contains this one, which is the protocol's other end. Inline there is no other end: the host is in the same window, and the message has nowhere to go that is not also where it came from."],
    ["win-global", "__i18n",
        SCOPE,
        "The boot blob, read directly off the window wherever a setting is wanted. It is one decision and many edits, which is the pair worth keeping apart when this family's number is read: the host has to give up one global name, and the port has to touch every read site, because there is no seam between them today. docs/HOSTING.md already names this key as what a page declares, and a mount API would take the same object as an argument instead."],
    ["win-global", ["location", "name", "print", "close", "open", "getSelection"],
        SCOPE,
        "A window-level global read or write. Inline it is the host's window."],
    ["win-global", "*",
        SCOPE,
        "A window global with no rule of its own. Read the site before trusting this verdict."],
    ["fixed-position-js", "*",
        PORTABLE,
        "Chrome positioned against the viewport in script. This looks like a page claim and is not one: an anchored popup is placed from its anchor's getBoundingClientRect, which is in viewport coordinates wherever the anchor sits, so fixed positioning travels to an inline mount unchanged. What it depends on is the portal, which is where the scope change actually is, and on the host not putting the portal container inside an element with transform, filter, perspective or contain, any of which makes a fixed descendant position against that element instead of the viewport."],

    // ── CSS ──────────────────────────────────────────────────────────────────
    ["css-selector", "universal",
        OWNS_PAGE,
        "A universal rule at the top level of a stylesheet, which is `* { box-sizing: border-box }` in webview/style.css. Inline it restyles every element on the host's page, the host's own chrome included, and it is load-bearing for the editor's own layout, so it cannot simply be dropped. Confining it to the editor's subtree changes which elements it reaches, which is the point and is also a change to the editor's own box model that has to be measured rather than assumed."],
    ["css-selector", ["html", "root"],
        SCOPE,
        "A rule on the document root, which is where the design tokens live: the --ui-* scale in webview/ui/chrome.css, the content scale in webview/style.css, and the whole --vscode-* palette in webview/ui/hostPalette.css. Inline the editor defines those names on the host's root, visible to the host's own CSS and collidable with it. The palette is the sharper half and is a rule the architecture takes on purpose: AGENTS.md requires every colour in the tree to be a --vscode-* variable with no literal fallback, so the variables have to be defined somewhere an editor stylesheet can see, and today that somewhere is :root. Moving them to the editor's root is mechanical for the declarations and is a two-file change per variable by hostPalette.test.ts."],
    ["css-selector", "body",
        SCOPE,
        "The read end of the body-class channel. `body.toc-open .tb-dock` works inline unchanged, because the editor's DOM is under the body there too; what it costs is that the state lives in the host's class list. It moves when the write end moves, and the two must move together or the channel breaks silently, with the class still written and nothing reading it."],
    ["css-selector", "bare-element",
        SCOPE,
        "A top-level rule on an element name, which matches the host's elements of that name as well as the editor's. Most of the tree's element rules are nested under an editor class and are not collected; these are the ones that are not."],
    ["css-selector", "attribute",
        OWNS_PAGE,
        "The global `[hidden]` rule at the top of webview/ui/chrome.css, which AGENTS.md makes a deliberate architectural rule: the attribute is honoured once, globally, and never restated per element. Inline it applies to the host's hidden elements too. It is in this bucket rather than the previous one because narrowing it to the editor's subtree reopens the decision the rule was made to settle, and because the failure it prevents is silent: an element set hidden that goes on taking its width."],
    ["css-selector", "highlight",
        SCOPE,
        "A ::highlight() rule, which has to be a document rule because the registry is on the document. The name is what can be scoped; the rule's reach cannot be."],
    ["css-selector", ["pseudo", "class-or-id", "nesting-ref", "other"],
        PORTABLE,
        "A top-level selector whose first compound is the editor's own class, id or a pseudo-class of one, so it can only match an element carrying a name the editor chose. This is where most of the tree's CSS is, and it is the good news in the audit. One thing it does not settle: a class name is a global name, so a host with its own .toolbar or .card is reached by the editor's rule and reaches the editor's element with its own. Judging that per class name would be a guess about hosts that do not exist, so it is left as a named hazard in docs/PAGE_OWNERSHIP.md rather than as a verdict here."],
    ["css-fixed", "*",
        PORTABLE,
        "Chrome anchored to the viewport in a stylesheet. Same reasoning as the script half: fixed coordinates and anchor rects are both viewport coordinates, so the pair travels, and the portal underneath it is where the change is."],
    ["css-viewport-unit", "cap",
        PORTABLE,
        "A viewport length in a max- property, which says a popup may not grow past the screen. That is the right cap for body-portalled, fixed-positioned chrome wherever the editor is mounted, and it is most of the tree's viewport units."],
    ["css-viewport-unit", "size",
        OWNS_PAGE,
        "A viewport length that SIZES something, which says the editor's own box is the viewport. This is the quiet half of page ownership and it is in the layout rather than in the chrome: the document's scroller takes min-height 100vh and half a viewport of overscroll past the last block, and the docked side panel takes the viewport height less the toolbar. Inline, a host that gives the editor a card gets a document at least a screen tall inside it and a panel taller than its container. Container query units ask the same question about the mount and are the shape of the fix, which makes it a change to the editor's layout model rather than a re-rooting, and the overscroll band in particular is a deliberate reading affordance whose argument is written beside it in webview/style.css."],
    ["css-viewport-unit", "fallback",
        SCOPE,
        "A viewport length as the fallback of a custom property whose real value is measured and published by script (initPaneWidthVar). The fallback is the ownership assumption written down, and the measured value already answers correctly for any box; what is needed inline is for the fallback to stop being the viewport."],
    ["css-highlight", "*",
        SCOPE,
        "A ::highlight() declaration. See the selector rule."],
];

function matchesRefinement(rule, refinement) {
    const spec = rule[1];
    if (spec === "*") return true;
    if (Array.isArray(spec)) return spec.includes(refinement);
    return spec === refinement;
}

export function classify(occ) {
    for (const rule of RULES) {
        if (rule[0] !== occ.kind) continue;
        if (!matchesRefinement(rule, occ.refinement)) continue;
        if (rule[4] && !rule[4].test(occ.file)) continue;
        return { verdict: rule[2], why: rule[3] };
    }
    return null;
}

// ─── Floors ──────────────────────────────────────────────────────────────────

/**
 * A scanner that matched nothing would report a clean audit, so the run asserts
 * what it reached before anything it found is worth reading. These are floors on
 * the instrument, not budgets on the code: they are set well below the tree's
 * real numbers and only fire when the scan has stopped working.
 */
const FLOORS = {
    tsFiles: 200,
    cssFiles: 20,
    anchors: ["doc-listener", "win-listener", "body-class", "body-child", "root-custom-prop", "head-inject", "highlight-registry", "doc-query", "css-selector", "css-fixed"],
};

/**
 * Occurrences no rule is expected to recognize. Empty on purpose: residue is the
 * signal this script exists to raise, so anything landing here should be given a
 * rule and a paragraph in docs/PAGE_OWNERSHIP.md rather than an entry.
 */
const RESIDUE_ALLOW = [];

// ─── Driver ──────────────────────────────────────────────────────────────────

function walk(dir, out = []) {
    for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        const st = statSync(p);
        if (st.isDirectory()) {
            if (entry === "__tests__" || entry === "node_modules") continue;
            walk(p, out);
        } else {
            out.push(p);
        }
    }
    return out;
}

export function collect() {
    const files = walk(SCAN_DIR);
    const ts = files.filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"));
    const css = files.filter((f) => f.endsWith(".css"));
    const occurrences = [];
    for (const f of ts) occurrences.push(...scanTypeScript(relative(ROOT, f), readFileSync(f, "utf8")));
    for (const f of css) occurrences.push(...scanCss(relative(ROOT, f), readFileSync(f, "utf8")));
    for (const occ of occurrences) {
        const r = classify(occ);
        occ.verdict = r ? r.verdict : "residue";
        occ.why = r ? r.why : "No rule recognized this shape.";
    }
    return { tsFiles: ts.length, cssFiles: css.length, occurrences };
}

function tally(occurrences, key) {
    const m = new Map();
    for (const o of occurrences) m.set(o[key], (m.get(o[key]) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function report(data, { byKind, list }) {
    const { occurrences, tsFiles, cssFiles } = data;
    const residue = occurrences.filter((o) => o.verdict === "residue");
    console.log(`Scanned ${tsFiles} TypeScript files and ${cssFiles} stylesheets under webview/, tests excluded.`);
    console.log(`${occurrences.length} occurrences, ${occurrences.length - residue.length} with a verdict, ${residue.length} residue.\n`);

    console.log("By verdict");
    for (const [v, n] of tally(occurrences, "verdict")) console.log(`  ${String(n).padStart(4)}  ${v}`);
    console.log("");

    console.log("By kind");
    for (const [k, n] of tally(occurrences, "kind")) {
        const byVerdict = tally(occurrences.filter((o) => o.kind === k), "verdict").map(([v, c]) => `${v} ${c}`).join(", ");
        console.log(`  ${String(n).padStart(4)}  ${k.padEnd(20)} ${byVerdict}`);
    }
    console.log("");

    if (byKind || list) {
        const groups = new Map();
        for (const o of occurrences) {
            const key = list ? `${o.kind}/${o.refinement}` : (byKind ? o.kind : o.verdict);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(o);
        }
        for (const [key, items] of [...groups.entries()].sort()) {
            console.log(`── ${key} (${items.length})`);
            for (const o of items) console.log(`   ${o.file}:${o.line}  [${o.verdict}] ${o.refinement}  ${o.text}`);
            console.log("");
        }
    }

    if (residue.length) {
        console.log("Residue, by name:");
        for (const o of residue) console.log(`  ${o.file}:${o.line}  ${o.kind}/${o.refinement}  ${o.text}`);
        console.log("");
    }

    console.log("Not collected, and why:");
    for (const [what, why] of NOT_COLLECTED) console.log(`  ${what}: ${why}`);
}

/**
 * The residue check is worth nothing unless the classifier can actually decline
 * to classify. Every occurrence in the tree has a rule today, so "residue is
 * empty" would otherwise be satisfied by a classifier that returned a verdict
 * for anything at all, which is the shape AGENTS.md calls a tautology. These
 * three probes make it discriminate: two shapes that must come back unclassified
 * and one that must come back with a verdict.
 */
export function probeClassifier() {
    const problems = [];
    const unknownKind = classify({ kind: "not-a-kind", refinement: "x", file: "webview/x.ts" });
    if (unknownKind) problems.push("the classifier gave a verdict to an unknown kind, so residue cannot be trusted");
    const unknownEvent = classify({ kind: "doc-listener", refinement: "not-an-event", file: "webview/x.ts" });
    if (unknownEvent) problems.push("the classifier gave a verdict to an unknown document event, so a new listener shape would be sorted rather than raised");
    const known = classify({ kind: "body-class", refinement: "toggle", file: "webview/x.ts" });
    if (!known) problems.push("the classifier declined a shape it has a rule for, so the table is not being read");
    return problems;
}

export function check(data) {
    const problems = probeClassifier();
    if (data.tsFiles < FLOORS.tsFiles) problems.push(`scanned ${data.tsFiles} TypeScript files, floor is ${FLOORS.tsFiles} — the scan is not reaching the tree`);
    if (data.cssFiles < FLOORS.cssFiles) problems.push(`scanned ${data.cssFiles} stylesheets, floor is ${FLOORS.cssFiles} — the scan is not reaching the tree`);
    const kinds = new Set(data.occurrences.map((o) => o.kind));
    for (const a of FLOORS.anchors) {
        if (!kinds.has(a)) problems.push(`no occurrence of kind ${a} — a pattern that used to match has stopped matching`);
    }
    const residue = data.occurrences.filter((o) => o.verdict === "residue" && !RESIDUE_ALLOW.includes(`${o.kind}/${o.refinement}`));
    for (const o of residue) problems.push(`unclassified: ${o.file}:${o.line} ${o.kind}/${o.refinement} — ${o.text}`);
    for (const o of data.occurrences) {
        if (o.verdict !== "residue" && !VERDICTS.includes(o.verdict)) problems.push(`bad verdict ${o.verdict} at ${o.file}:${o.line}`);
    }
    return problems;
}

// The CLI runs only when this file is the entry point, so a test can import
// `collect` and `check` without a scan and a report happening on import.
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) main();

function main() {
    const argv = process.argv.slice(2);
    const data = collect();
    if (argv.includes("--json")) {
        console.log(JSON.stringify({ tsFiles: data.tsFiles, cssFiles: data.cssFiles, occurrences: data.occurrences }, null, 2));
        return;
    }
    if (argv.includes("--check")) {
        const problems = check(data);
        if (problems.length) {
            console.error("audit-page-ownership --check failed:");
            for (const p of problems) console.error(`  ${p}`);
            process.exit(1);
        }
        console.log(`audit-page-ownership: ${data.occurrences.length} occurrences, all with a verdict.`);
        return;
    }
    report(data, { byKind: argv.includes("--by-kind"), list: argv.includes("--list") });
}
