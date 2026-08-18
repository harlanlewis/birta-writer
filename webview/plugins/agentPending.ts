/**
 * plugins/agentPending.ts (MAR-376): the life of an `/ai` request inside the
 * editor, from the moment it is handed to the extension to the moment the
 * agent's edit lands.
 *
 * Three jobs, all view state, nothing in the file:
 *
 *   - THE GUTTER MARKER. While a background run is live, a small marker sits
 *     in the gutter beside the block the request was typed in. It is a widget
 *     decoration at a document position mapped through every transaction, so
 *     it rides along as the user types above it and goes when its block does
 *     (the imageUploadProgress idiom). It lives in the gutter, not the
 *     content, because a placeholder in the text is something you would type
 *     into and around, and the request's own line has usually just been
 *     removed. Clicking it cancels the run. A failure turns it into an error
 *     marker with the reason on hover, dismissed by a click.
 *
 *   - THE UNDO POLICY. An agent's write reaches the editor as an external
 *     change (VS Code reloads the file), which the sync path keeps OUT of the
 *     undo history: git checkouts and side-by-side edits must not become
 *     phantom undo steps. But an edit the user asked for at the caret is
 *     theirs, and by the principle of least surprise it undoes like a paste,
 *     which is what every editor with an inline AI action does (Notion AI's
 *     inserted blocks, Copilot's inline edits). So while a run is live for
 *     this document, external sync records into history (`recordsExternalIn
 *     History`), and Cmd+Z removes the agent's insertion in one step; the
 *     ordinary sync then writes that back to the file.
 *
 *   - THE DIRTY-DOCUMENT MERGE. If the user typed while the agent worked, VS
 *     Code refuses to reload the file and the extension hands the disk text
 *     over instead. The run kept the document as it was at hand-off (`base`)
 *     and the position mapping accumulated since; the agent's changes are
 *     the doc diff base→agent, each range mapped through that mapping into
 *     the live document and applied as one normal, undoable transaction. A
 *     change whose range the user has since deleted is a conflict and is
 *     skipped, reported on the marker rather than guessed at.
 */
import { $prose } from "@milkdown/utils";
import { computeDocDiff } from "@milkdown/plugin-diff";
import { Decoration, DecorationSet, Mapping, Plugin, PluginKey } from "@/pm";
import type { EditorView, Node as ProseNode } from "@/pm";
import { t } from "../i18n";
import { notifyAgentCancel } from "../messaging";
import "./agentPending.css";

export const agentPendingKey = new PluginKey<AgentPendingState>("birta-agent-pending");

/** One request, from hand-off to landing. */
export interface AgentRun {
    readonly id: string;
    /** Document position of the request; mapped through every step. */
    pos: number;
    /** The document at hand-off, the merge base for a dirty-document result. */
    readonly base: ProseNode;
    /** Every position map since hand-off, so base ranges land in the live doc. */
    readonly mapping: Mapping;
    /** `armed` until the extension confirms a background run; then `running`. */
    status: "armed" | "running";
    /** Set once the run fails; the marker switches to an error until dismissed. */
    error?: string;
}

interface AgentPendingState {
    readonly runs: readonly AgentRun[];
    readonly decorations: DecorationSet;
}

type AgentAction =
    | { kind: "begin"; id: string; pos: number; base: ProseNode }
    | { kind: "running"; id: string }
    | { kind: "settle"; id: string }
    | { kind: "fail"; id: string; error: string };

function markerWidget(run: AgentRun, view: EditorView): HTMLElement {
    const el = document.createElement("span");
    el.className = "agent-pending" + (run.error ? " agent-pending--error" : "");
    el.setAttribute("aria-live", "polite");
    el.setAttribute("role", "button");
    el.tabIndex = -1;
    el.title = run.error
        ? t("Agent request failed: ") + run.error + " " + t("(click to dismiss)")
        : t("Your agent is working on this request (click to cancel)");
    const dot = document.createElement("span");
    dot.className = "agent-pending__dot";
    el.append(dot);
    // The marker is chrome: its click is not a document edit and must not
    // move the caret or enter the undo history.
    el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (run.error) {
            settleAgentRun(view, run.id);
        } else {
            notifyAgentCancel(run.id);
        }
    });
    return el;
}

function buildDecorations(runs: readonly AgentRun[], view: EditorView | null, doc: ProseNode): DecorationSet {
    if (runs.length === 0 || !view) { return DecorationSet.empty; }
    const decos = runs
        // An armed run has not been confirmed as one the editor can follow.
        .filter((r) => r.status === "running" || r.error !== undefined)
        .filter((r) => r.pos >= 0 && r.pos <= doc.content.size)
        .map((r) => Decoration.widget(r.pos, () => markerWidget(r, view), {
            side: -1,
            key: `${r.id}:${r.status}:${r.error ?? ""}`,
        }));
    return DecorationSet.create(doc, decos);
}

export const agentPendingPlugin = $prose(() => {
    let liveView: EditorView | null = null;
    return new Plugin<AgentPendingState>({
        key: agentPendingKey,
        view(view) {
            liveView = view;
            return { destroy() { liveView = null; } };
        },
        state: {
            init: () => ({ runs: [], decorations: DecorationSet.empty }),
            apply(tr, prev, _old, newState) {
                const action = tr.getMeta(agentPendingKey) as AgentAction | undefined;
                let runs = prev.runs;
                if (tr.docChanged) {
                    runs = runs.map((r) => {
                        // The mapping is the run's own accumulator; a fresh
                        // Mapping per step keeps the previous state immutable
                        // for anyone still holding it.
                        const mapping = new Mapping([...r.mapping.maps]);
                        mapping.appendMapping(tr.mapping);
                        return { ...r, pos: tr.mapping.map(r.pos, -1), mapping };
                    });
                }
                if (action?.kind === "begin") {
                    runs = [...runs, { id: action.id, pos: action.pos, base: action.base, mapping: new Mapping(), status: "armed" }];
                } else if (action?.kind === "running") {
                    runs = runs.map((r) => (r.id === action.id ? { ...r, status: "running" } : r));
                } else if (action?.kind === "settle") {
                    runs = runs.filter((r) => r.id !== action.id);
                } else if (action?.kind === "fail") {
                    runs = runs.map((r) => (r.id === action.id ? { ...r, status: "running", error: action.error } : r));
                }
                if (runs === prev.runs && !tr.docChanged) { return prev; }
                return { runs, decorations: buildDecorations(runs, liveView, newState.doc) };
            },
        },
        props: {
            decorations(state) { return agentPendingKey.getState(state)?.decorations; },
        },
    });
});

let counter = 0;

function dispatchIfLive(view: EditorView, action: AgentAction): void {
    if (view.isDestroyed) { return; }
    view.dispatch(view.state.tr.setMeta(agentPendingKey, action));
}

/**
 * Register a request at the caret's block and return its id. The marker does
 * not show until the extension reports the run as `running`; a route the
 * editor cannot follow reports `handedOff` and the run is dropped.
 */
export function beginAgentRun(view: EditorView): string {
    const id = `ai${++counter}`;
    dispatchIfLive(view, { kind: "begin", id, pos: view.state.selection.from, base: view.state.doc });
    return id;
}

export function markAgentRunning(view: EditorView, id: string): void {
    dispatchIfLive(view, { kind: "running", id });
}

export function settleAgentRun(view: EditorView, id: string): void {
    dispatchIfLive(view, { kind: "settle", id });
}

export function failAgentRun(view: EditorView, id: string, error: string): void {
    dispatchIfLive(view, { kind: "fail", id, error });
}

/** The run with this id, or null once it has settled. */
export function agentRun(view: EditorView, id: string): AgentRun | null {
    return agentPendingKey.getState(view.state)?.runs.find((r) => r.id === id) ?? null;
}

/**
 * Whether an inbound external change should enter the undo history: yes
 * while a background run is live for this document, because that change is
 * the agent's answer to a request the user made here.
 */
export function recordsExternalInHistory(view: EditorView): boolean {
    return agentPendingKey.getState(view.state)?.runs.some((r) => r.status === "running" && !r.error) ?? false;
}

export type AgentMergeOutcome = "applied" | "partial" | "conflict" | "unchanged";

/**
 * Merge an agent's result (the file's bytes at exit) into a live document the
 * user has edited since the hand-off. `parse` is the format's parser.
 *
 * The base the run kept is the editor's own document, and the base the diff
 * needs is the same content as PARSED from its serialization, since that is
 * the space the agent's text is parsed in. When the two disagree (a
 * construct the round trip respells), positions would not line up, and the
 * merge refuses rather than guess: `conflict`, with nothing applied.
 */
export function applyAgentResult(
    view: EditorView,
    id: string,
    agentText: string,
    parse: (markdown: string) => ProseNode | null,
    serialize: (doc: ProseNode) => string,
): AgentMergeOutcome {
    const run = agentRun(view, id);
    if (!run) { return "conflict"; }
    const agentDoc = parse(agentText);
    if (!agentDoc) { return "conflict"; }
    // Nothing typed since hand-off: the live doc IS the base, so a plain
    // diff-and-replace against it is exact (the external-sync shape, but
    // recorded in history and echoed to the file like a user edit).
    const untouched = run.mapping.maps.length === 0 || view.state.doc.eq(run.base);
    const baseParsed = untouched ? run.base : parse(serialize(run.base));
    if (!baseParsed || !baseParsed.eq(run.base)) { return "conflict"; }
    const changes = computeDocDiff(run.base, agentDoc);
    if (changes.length === 0) { return "unchanged"; }
    let tr = view.state.tr;
    let skipped = 0;
    for (let i = changes.length - 1; i >= 0; i--) {
        const change = changes[i];
        const from = run.mapping.mapResult(change.fromA, -1);
        const to = run.mapping.mapResult(change.toA, 1);
        // The user's edits reached into this range: not ours to overwrite.
        if (from.deleted || to.deleted || from.pos > to.pos) { skipped++; continue; }
        try {
            tr = tr.replace(from.pos, to.pos, agentDoc.slice(change.fromB, change.toB));
        } catch {
            // The slice no longer fits where the user's edits left the
            // structure (a range that now straddles a block boundary).
            skipped++;
        }
    }
    if (skipped === changes.length) { return "conflict"; }
    view.dispatch(tr);
    return skipped > 0 ? "partial" : "applied";
}
