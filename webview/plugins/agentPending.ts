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
 *     removed. Clicking it cancels the run.
 *
 *   - THE CORNER NOTICE (MAR-464). While a run is live, a quiet line in the
 *     corner says what is happening: the harness, what it is doing where the
 *     host can read that (`agentProgress`), and how long it has been going
 *     once that becomes a question worth answering. It updates in place on
 *     the one toast surface, never stacks, never takes focus, and goes when
 *     the run does. The marker remains the only control; the notice offers
 *     nothing to click, which is what keeps it advisory.
 *
 *     A host that cannot read its harness's output sends no line and the
 *     notice is the page's own clock, which is the floor rather than a
 *     failure. It does not say a run is thinking rather than waiting, which
 *     only the harness's own events can; it says the run is still there and
 *     how long it has been, which is what somebody deciding whether to keep
 *     waiting has to go on. It costs the host nothing.
 *
 *     It shows a RUNNING run and nothing else. A failure is news rather than
 *     a control: there is nothing left to stop, the reason is a sentence that
 *     does not fit in a gutter, and a marker that has to be clicked away is a
 *     chore left behind by something that already went wrong. So a failed run
 *     leaves the state entirely, and WHO says why is the host's to decide:
 *     see `failAgentRun`.
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
import { closeHistory, Decoration, DecorationSet, Mapping, Plugin, PluginKey } from "@/pm";
import type { EditorView, Node as ProseNode } from "@/pm";
import { t } from "../i18n";
import { notifyAgentCancel } from "../messaging";
import { hostHas } from "../../shared/hostProfile";
import { hide, showToast } from "../ui/toast";
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
    /** The harness running it (`claude`, `codex`), for the tooltip; unknown until `running`. */
    harness?: string;
    /** When the extension confirmed it as running, which is what the notice counts from. */
    startedAt?: number;
    /** The last thing the host said this run was doing, if it says at all. */
    line?: string;
}

interface AgentPendingState {
    readonly runs: readonly AgentRun[];
    readonly decorations: DecorationSet;
}

type AgentAction =
    | { kind: "begin"; id: string; pos: number; base: ProseNode }
    | { kind: "running"; id: string; harness?: string }
    | { kind: "progress"; id: string; line: string }
    | { kind: "settle"; id: string };

function markerWidget(run: AgentRun): HTMLElement {
    const el = document.createElement("span");
    el.className = "agent-pending";
    el.setAttribute("aria-live", "polite");
    el.setAttribute("role", "button");
    el.tabIndex = -1;
    const who = run.harness ?? t("Your agent");
    el.title = `${who} ${t("is working on this request. Click to stop it.")}`;
    // A filled pill carrying a stop square, which is the marker's one verb.
    // It draws in the theme's own button ink, so it reads at a glance on any
    // theme.
    const glyph = document.createElement("span");
    glyph.className = "agent-pending__glyph agent-pending__glyph--stop";
    glyph.setAttribute("aria-hidden", "true");
    el.append(glyph);
    // The marker is chrome: its click is not a document edit and must not
    // move the caret or enter the undo history.
    el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        notifyAgentCancel(run.id);
    });
    return el;
}

function buildDecorations(runs: readonly AgentRun[], view: EditorView | null, doc: ProseNode): DecorationSet {
    if (runs.length === 0 || !view) { return DecorationSet.empty; }
    const live = runs
        // An armed run has not been confirmed as one the editor can follow.
        .filter((r) => r.status === "running")
        .filter((r) => r.pos >= 0 && r.pos <= doc.content.size);
    const decos = live.map((r) => Decoration.widget(r.pos, () => markerWidget(r), {
        side: -1,
        key: `${r.id}:${r.status}:${r.harness ?? ""}`,
    }));
    // Mark the block the marker sits beside, so its gutter can stand down for
    // the run's duration. The pill occupies the marker's own column rather
    // than a slot of its own (agentPending.css), and a grab handle appearing
    // there on hover would draw straight over it. A class rather than a style:
    // what the gutter does about it is the stylesheet's business.
    for (const r of live) {
        const $pos = doc.resolve(Math.min(r.pos, doc.content.size));
        // The INNERMOST block, not the top-level one. A gutter belongs to the
        // block that owns it, and the CSS suppresses a direct child, so marking
        // the outermost ancestor would miss a request typed inside a callout or
        // a list item: the pill would land in the inner block's column with
        // that block's handle still free to appear on hover.
        // depth 0 is the doc itself, which has no gutter to suppress.
        if ($pos.depth < 1) { continue; }
        const from = $pos.before($pos.depth);
        decos.push(Decoration.node(from, from + $pos.node($pos.depth).nodeSize, {
            class: "agent-pending-host",
        }));
    }
    return DecorationSet.create(doc, decos);
}

export const agentPendingPlugin = $prose(() => {
    let liveView: EditorView | null = null;
    return new Plugin<AgentPendingState>({
        key: agentPendingKey,
        view(view) {
            liveView = view;
            const notice = new AgentNotice(view);
            notice.sync();
            return {
                update() { notice.sync(); },
                destroy() { notice.stop(); liveView = null; },
            };
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
                    runs = runs.map((r) => (r.id === action.id
                        ? { ...r, status: "running", harness: action.harness ?? r.harness, startedAt: r.startedAt ?? Date.now() }
                        : r));
                } else if (action?.kind === "progress") {
                    // A line for a run that has already settled is dropped
                    // here, which is the only place that knows which runs are
                    // still live.
                    if (runs.some((r) => r.id === action.id)) {
                        const next = runs.map((r) => (r.id === action.id ? { ...r, line: action.line } : r));
                        // The marker does not draw the line, so the decorations
                        // it already has are still the right ones. Rebuilding
                        // them is a walk of the document for a corner message.
                        if (!tr.docChanged) { return { runs: next, decorations: prev.decorations }; }
                        runs = next;
                    }
                } else if (action?.kind === "settle") {
                    runs = runs.filter((r) => r.id !== action.id);
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

export function markAgentRunning(view: EditorView, id: string, harness?: string): void {
    dispatchIfLive(view, { kind: "running", id, harness });
}

/**
 * What the host says this run is doing now, for the corner notice. View
 * state and nothing else: it is never serialized, never put in the state bag,
 * and a run that ends takes its line with it.
 */
export function reportAgentProgress(view: EditorView, id: string, line: string): void {
    const text = line.trim();
    if (!text) { return; }
    dispatchIfLive(view, { kind: "progress", id, line: text });
}

export function settleAgentRun(view: EditorView, id: string): void {
    dispatchIfLive(view, { kind: "settle", id });
}

/**
 * The surface class both agent messages are drawn on: the editor's bottom
 * trailing corner. Where exactly, and why it is held clear of the window's
 * own bottom edge, is `agentPending.css`.
 *
 * ONE surface for the live line and the failure, which is what makes "never
 * stacks" structural rather than a rule to remember: a surface is one node,
 * so the two cannot be on screen at once and cannot collide. What they need
 * from each other is that a failure, which is read once and gone, is not
 * overwritten by the next tick of a notice about some other run; see
 * `failureHoldingCorner`.
 */
export const AGENT_TOAST_SURFACE = "agent-toast";

/**
 * How often the notice re-reads its own clock. Coarse on purpose: a corner
 * line whose seconds count up one by one is motion where the rule asks for
 * quiet, and nothing a reader decides turns on five seconds.
 */
const NOTICE_TICK_MS = 5000;

/**
 * How long a run goes before the notice says how long it has been going.
 * Until then the elapsed time answers a question nobody has asked yet, and
 * "0:03" in the corner is noise; past it, it is the whole difference between
 * a run that is working and one that is stuck.
 */
const NOTICE_ELAPSED_AFTER_MS = 10000;

/**
 * Whether a failure is holding the corner right now.
 *
 * Asked of the surface itself rather than kept as a deadline beside it. One
 * node carries both messages, so the node is what knows which one it is
 * showing, and a second clock running alongside the toast's own could only
 * ever disagree with it. While a failure is up the notice stands down, and it
 * takes the corner back on its next tick once the dwell has run out.
 */
function failureHoldingCorner(): boolean {
    if (typeof document === "undefined") { return false; }
    const el = document.querySelector(`.${AGENT_TOAST_SURFACE}`);
    return el !== null
        && el.classList.contains(`${AGENT_TOAST_SURFACE}--visible`)
        && el.classList.contains("ui-notice--error");
}

function elapsedLabel(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * What the corner should say about `runs` at `now`, or null for nothing.
 *
 * Separated from the drawing so the sentence can be asked for without a
 * document, a view or a clock: every rule about what it says (which run it
 * names, when the elapsed time appears, what stands in for a host that says
 * nothing) is decided here.
 */
export function agentNoticeText(runs: readonly AgentRun[], now: number): string | null {
    const live = runs.filter((r) => r.status === "running");
    if (live.length === 0) { return null; }
    // The OLDEST run's clock. With more than one live, the interesting number
    // is how long the longest one has been going.
    const oldest = live.reduce((a, b) => ((a.startedAt ?? now) <= (b.startedAt ?? now) ? a : b));
    const age = now - (oldest.startedAt ?? now);
    const elapsed = age >= NOTICE_ELAPSED_AFTER_MS ? ` · ${elapsedLabel(age)}` : "";
    if (live.length > 1) {
        // The number inside the sentence, not glued to the front of it: a
        // translator has to be able to put it where the language puts it.
        return `${t("{0} agents working").replace("{0}", String(live.length))}${elapsed}`;
    }
    const run = live[0];
    const who = run.harness ?? t("Your agent");
    return `${who} · ${run.line ?? t("working")}${elapsed}`;
}

/**
 * Draws that sentence on the toast surface and keeps it current.
 *
 * The clock runs only while something is live, so a document with no run
 * costs nothing at all. Redundant writes are skipped, because the editor
 * updates on every keystroke and the sentence changes on neither of them.
 */
class AgentNotice {
    private timer: ReturnType<typeof setInterval> | undefined;
    private shown: string | undefined;

    constructor(private readonly view: EditorView) {}

    sync(): void {
        if (this.view.isDestroyed) { this.stop(); return; }
        const runs = agentPendingKey.getState(this.view.state)?.runs ?? [];
        const text = agentNoticeText(runs, Date.now());
        if (text === null) {
            this.stop();
            return;
        }
        this.timer ??= setInterval(() => this.sync(), NOTICE_TICK_MS);
        if (failureHoldingCorner()) {
            // Forget what was drawn, so the sentence is written again when
            // the corner comes back.
            this.shown = undefined;
            return;
        }
        if (text === this.shown) { return; }
        this.shown = text;
        showToast(text, {
            surface: AGENT_TOAST_SURFACE,
            persist: true,
            // It rewrites itself on a clock; see ui/toast.ts on why that must
            // not be announced. The marker announced the run when it started.
            announce: false,
        });
    }

    stop(): void {
        clearInterval(this.timer);
        this.timer = undefined;
        if (this.shown === undefined) { return; }
        this.shown = undefined;
        hide(AGENT_TOAST_SURFACE);
    }
}

/**
 * How long a failure stays. Longer than an ordinary notice, because this one
 * carries a reason somebody has to read and act on rather than an
 * acknowledgement they already expected.
 */
export const AGENT_TOAST_DWELL_MS = 9000;

/**
 * End a run that failed, and say why.
 *
 * The run leaves the state rather than staying in it as an error, so nothing
 * is left in the gutter to dismiss and `recordsExternalInHistory` stops
 * counting it the moment it stops running.
 *
 * WHO says why depends on the host. A host with a notification surface of its
 * own has already spoken by the time this runs (VS Code raises an error
 * notification carrying a Show Output action the page cannot offer), so a
 * message in the corner beside it would be the same event reported twice.
 * Where the host has no such surface, the corner is the only place the reason
 * can appear at all, and this is it.
 */
export function failAgentRun(view: EditorView, id: string, error: string,
                             harness?: string): void {
    // The REPORT's harness first, then the run's. A request that never reached
    // `running` has no harness in state, which is exactly the case a failure
    // is most likely to be: a command that is not installed fails before the
    // editor is ever told what is running it. Read BEFORE the settle below,
    // which takes the run out of state.
    const who = harness ?? agentRun(view, id)?.harness ?? t("Your agent");
    dispatchIfLive(view, { kind: "settle", id });
    if (hostHas("notifications")) { return; }
    const reason = error.trim();
    // The corner is one surface, and this claims it: while an error message
    // is up, the live-run notice stands down rather than overwriting a reason
    // on its next tick. See `failureHoldingCorner`.
    showToast(reason ? `${who}: ${reason}` : `${who}: ${t("request failed")}`, {
        surface: AGENT_TOAST_SURFACE,
        tone: "error",
        dwellMs: AGENT_TOAST_DWELL_MS,
        dismissible: true,
    });
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
    return agentPendingKey.getState(view.state)?.runs.some((r) => r.status === "running") ?? false;
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
): AgentMergeOutcome {
    const run = agentRun(view, id);
    if (!run) { return "conflict"; }
    const agentDoc = parse(agentText);
    if (!agentDoc) { return "conflict"; }
    // The diff runs against the base the run kept, so its ranges are
    // positions in that base, which the mapping carries into the live doc.
    // The base is the live document as it was, post-parse attributes (a
    // heading's stamped id) and all; the content diff does not see those,
    // and a guard that compared the two docs whole refused every document
    // with a heading (the corpus sweep below is what pins that).
    const changes = computeDocDiff(run.base, agentDoc);
    if (changes.length === 0) { return "unchanged"; }
    let tr = view.state.tr;
    let skipped = 0;
    for (let i = changes.length - 1; i >= 0; i--) {
        const change = changes[i];
        const from = run.mapping.mapResult(change.fromA, -1);
        const to = run.mapping.mapResult(change.toA, 1);
        // The user's edits reached into this range, deleting part of it or
        // typing inside it (a mapped range that grew): not ours to overwrite.
        if (from.deleted || to.deleted || from.pos > to.pos
            || to.pos - from.pos !== change.toA - change.fromA) { skipped++; continue; }
        try {
            tr = tr.replace(from.pos, to.pos, agentDoc.slice(change.fromB, change.toB));
        } catch {
            // The slice no longer fits where the user's edits left the
            // structure (a range that now straddles a block boundary).
            skipped++;
        }
    }
    if (skipped === changes.length) { return "conflict"; }
    // One undo step of its own: never grouped with the keystroke before or
    // after it, so Cmd+Z removes exactly the agent's edit.
    view.dispatch(closeHistory(tr));
    return skipped > 0 ? "partial" : "applied";
}
