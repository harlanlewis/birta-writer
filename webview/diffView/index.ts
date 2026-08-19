/**
 * webview/diffView/index.ts — the rendered-diff page (MAR-55).
 *
 * A second, much smaller webview entry (`dist/diffView.js`), built by its own
 * esbuild pass rather than as a fourth entry of the editor's. That is a build
 * decision with a runtime reason: the editor build sets `splitting: true`, so
 * adding an entry there redistributes shared modules into chunks and changes
 * how many resources the EDITOR fetches at launch. Launch is the thing this
 * repository measures hardest, and a diff panel nobody has opened must not be
 * able to move it. A separate pass costs a self-contained bundle and buys a
 * byte-identical `dist/webview.js`.
 *
 * The rendering reuses the editor's own markdown presets, so both sides are
 * parsed by the parser that owns this format, and both sides are drawn from
 * the schema that owns it. What it deliberately does NOT reuse is the
 * editor's NodeViews: those are editing chrome, and they carry the lazy
 * loaders for maths, diagrams and syntax highlighting. Two nodes get a
 * placeholder instead — an image renders as its path (the panel has no image
 * URI map, and fetching one would put a review surface on the network), and an
 * `html` node renders as its source (nothing here sanitizes, and a diff of raw
 * HTML is more useful read as source anyway).
 */
import {
    Editor,
    defaultValueCtx,
    editorViewCtx,
    editorViewOptionsCtx,
    parserCtx,
    rootCtx,
} from "@milkdown/core";
import { $prose } from "@milkdown/utils";
import { computeDocDiff } from "@milkdown/plugin-diff";
import { DecorationSet, Plugin, PluginKey } from "../pm";
import type { EditorView, Node as ProseNode, NodeViewConstructor } from "../pm";
import { gfmFidelity, pureCommonmark } from "../serialization";
import { t } from "../i18n";
import { vscodeHost } from "../vscodeHost";
import { buildDiffDecorations } from "./decorations";
import { planDiffHunks, stepHunk, type DiffHunk } from "./diffPlan";
import type {
    DiffBaseOrigin,
    FromDiffViewMessage,
    ToDiffViewMessage,
} from "../../shared/diffMessages";
import "./diffView.css";

/**
 * This page's typed funnel over the shared handle (webview/vscodeHost.ts).
 * The diff panel speaks its own protocol, so it must not post through
 * webview/messaging.ts, whose sends are typed as the EDITOR's messages.
 */
function post(msg: FromDiffViewMessage): void {
    vscodeHost.postMessage(msg);
}

const diffKey = new PluginKey<DecorationSet>("birta-diff");

/** Supplies the decoration set, replaced wholesale by a meta transaction. */
const diffDecorationPlugin = $prose(
    () =>
        new Plugin<DecorationSet>({
            key: diffKey,
            state: {
                init: () => DecorationSet.empty,
                apply(tr, value) {
                    const next = tr.getMeta(diffKey) as DecorationSet | undefined;
                    return next ?? value.map(tr.mapping, tr.doc);
                },
            },
            props: {
                decorations: (state) => diffKey.getState(state) ?? DecorationSet.empty,
            },
        }),
);

/** An image, as the path it points at: this page never fetches one. */
const imageRefView: NodeViewConstructor = (node) => {
    const dom = document.createElement("span");
    dom.className = "diff-image-ref";
    const src = typeof node.attrs.src === "string" ? node.attrs.src : "";
    const alt = typeof node.attrs.alt === "string" && node.attrs.alt !== "" ? node.attrs.alt : src;
    dom.textContent = alt === src ? src : `${alt} (${src})`;
    return { dom };
};

/** A raw HTML node, as its source: read, not run. */
const htmlSourceView: NodeViewConstructor = (node) => {
    const dom = document.createElement("code");
    dom.className = "diff-html-source";
    dom.textContent = typeof node.attrs.value === "string" ? node.attrs.value : "";
    return { dom };
};

// ── Page furniture ──────────────────────────────────────────────────────────

const root = document.getElementById("diff-root") as HTMLElement;
const header = document.createElement("header");
header.className = "diff-header";
const title = document.createElement("span");
title.className = "diff-title";
const summary = document.createElement("span");
summary.className = "diff-summary";
const position = document.createElement("span");
position.className = "diff-position";
const nav = document.createElement("span");
nav.className = "diff-nav";
const prevBtn = navButton(t("Previous change"), "↑");
const nextBtn = navButton(t("Next change"), "↓");
nav.append(prevBtn, nextBtn);
header.append(title, summary, position, nav);
const body = document.createElement("div");
body.className = "diff-body";
root.append(header, body);

function navButton(label: string, glyph: string): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.className = "ui-btn ui-btn--icon diff-nav-btn";
    btn.type = "button";
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.textContent = glyph;
    return btn;
}

// ── Render state ────────────────────────────────────────────────────────────

let editor: Editor | null = null;
let hunks: DiffHunk[] = [];
/** Which hunk the reader is on; -1 before the first step. */
let cursor = -1;

async function render(msg: Extract<ToDiffViewMessage, { type: "diffContent" }>): Promise<void> {
    title.textContent = msg.label;
    const scrollTop = body.scrollTop;

    if (editor) {
        await editor.destroy();
        editor = null;
    }
    body.textContent = "";
    const mount = document.createElement("div");
    mount.className = "diff-doc";
    body.appendChild(mount);

    editor = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, mount);
            ctx.set(defaultValueCtx, msg.working);
            ctx.update(editorViewOptionsCtx, (prev) => ({
                ...prev,
                editable: () => false,
                nodeViews: { ...prev.nodeViews, image: imageRefView, html: htmlSourceView },
            }));
        })
        .use(pureCommonmark)
        .use(gfmFidelity)
        .use(diffDecorationPlugin)
        .create();

    editor.action((ctx) => {
        const view: EditorView = ctx.get(editorViewCtx);
        const parse = ctx.get(parserCtx);
        // BOTH sides are raw parses, and that symmetry is the whole point.
        // The view's document is this same parse with the editor's plugins
        // having run over it, and several of them write attributes a parse
        // does not have — a heading gets its slug id, a list its numbering.
        // Diffing the view against a parse therefore reports a change for
        // every heading in a file nobody touched. Comparing parse to parse
        // makes attribute drift structurally impossible rather than
        // enumerating the attributes to forgive, which is a list that grows
        // silently every time a plugin learns a new one.
        const baseDoc: ProseNode = parse(msg.base) as ProseNode;
        const workingDoc: ProseNode = parse(msg.working) as ProseNode;
        // Those plugins change attributes, never structure, so the parse and
        // the view agree on every position. If that ever stops being true the
        // decorations would land in the wrong places and nothing would say so,
        // hence the check rather than the assumption.
        if (workingDoc.content.size !== view.state.doc.content.size) {
            throw new Error("the rendered document does not match its own parse");
        }
        hunks = planDiffHunks(workingDoc, computeDocDiff(baseDoc, workingDoc));
        view.dispatch(
            view.state.tr.setMeta(diffKey, buildDiffDecorations(baseDoc, view.state.doc, hunks)),
        );
    });

    cursor = -1;
    paintPosition();
    body.scrollTop = scrollTop;
    summary.textContent = summaryText(msg.baseOrigin, hunks.length);
    const empty = hunks.length === 0;
    prevBtn.disabled = empty;
    nextBtn.disabled = empty;
}

/**
 * The header line. An untracked file is called out because "everything is new"
 * and "nothing changed" look alike to a reader who does not know whether git
 * has ever seen the file.
 */
function summaryText(origin: DiffBaseOrigin, count: number): string {
    const changes = count === 1 ? t("1 change") : `${count} ${t("changes")}`;
    return origin === "untracked"
        ? `${changes} · ${t("not yet in git")}`
        : `${changes} · ${t("since HEAD")}`;
}

function showMessage(text: string): void {
    body.textContent = "";
    const notice = document.createElement("p");
    notice.className = "diff-notice";
    notice.textContent = text;
    body.appendChild(notice);
    hunks = [];
    cursor = -1;
    paintPosition();
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    summary.textContent = "";
}

// ── Hunk navigation ─────────────────────────────────────────────────────────

/**
 * Where the reader is in the run of changes, once they have started stepping.
 *
 * Without it, j and k only scroll, and a document whose changes all fit on one
 * screen gives no sign that anything happened — the reader cannot tell a step
 * from a key that did nothing, nor that they have reached the last change.
 * Blank until the first step, because "1 of 3" before anyone has moved would
 * claim a position the reader has not taken.
 */
function paintPosition(): void {
    position.textContent =
        cursor === -1 ? "" : `${cursor + 1} / ${hunks.length}`;
}

function goToHunk(direction: 1 | -1): void {
    const next = stepHunk(cursor, direction, hunks.length);
    if (next === -1 || next === cursor) { return; }
    cursor = next;
    paintPosition();
    editor?.action((ctx) => {
        const view: EditorView = ctx.get(editorViewCtx);
        const node = view.domAtPos(hunks[cursor].working.from).node;
        const element =
            node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement;
        element?.scrollIntoView({ block: "center" });
    });
}

prevBtn.addEventListener("click", () => goToHunk(-1));
nextBtn.addEventListener("click", () => goToHunk(1));
window.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) { return; }
    if (event.key === "j") { goToHunk(1); } else if (event.key === "k") { goToHunk(-1); } else { return; }
    event.preventDefault();
});

// ── Protocol ────────────────────────────────────────────────────────────────

window.addEventListener("message", (event: MessageEvent<ToDiffViewMessage>) => {
    const msg = event.data;
    if (msg?.type === "diffContent") {
        void render(msg).catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            showMessage(t("This file could not be rendered as a diff."));
            post({ type: "diffFailed", message });
        });
    } else if (msg?.type === "diffUnavailable") {
        showMessage(msg.reason);
    }
});

post({ type: "diffReady" });
