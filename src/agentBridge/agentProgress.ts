/**
 * src/agentBridge/agentProgress.ts (MAR-464): what a live `/ai` run is doing,
 * as one short line, read out of whatever the harness is already printing.
 *
 * The line is advisory and transient (docs/DESIGN_PRINCIPLES.md, "annotation
 * is advisory, reversible, and quiet"): it never reaches the document, never
 * reaches the view-state bag, and it dies with the run that produced it.
 *
 * Harnesses are told apart by the SHAPE of what they print, never by name.
 * Two structured shapes are recognized, each captured from a real run
 * (`agentProgress.test.ts` carries the captures and their provenance), and
 * anything else falls back to the last plain line. A vendor list is the thing
 * `harnessCapabilities.ts` exists to avoid, and a shape recognizer serves
 * every CLI that speaks one of these formats without naming any of them.
 *
 * REASONING CONTENT IS NEVER RENDERED. A harness's thinking may be private by
 * policy, and the one shape here that carries thinking blocks at all sends
 * them with the text removed and a signature in its place, so there is
 * nothing to show even where it is offered. What a thinking step gets is the
 * word alone: that the harness is thinking. The corner is not a transcript.
 *
 * Both streams feed one reader, each with its own line remainder, because a
 * chunk boundary falls anywhere. Once a recognized event has been seen, plain
 * lines stop being displayed: a harness printing events on one stream and a
 * progress bar on the other must not flip between the two.
 */
import * as vscode from "vscode";

/** A display line is a glance, not a transcript. */
export const PROGRESS_LINE_MAX = 72;

/**
 * The harness's own last words, kept for the reports that quote them. Matches
 * the stream tail `askAgent` keeps for the same purpose.
 */
const SAID_MAX = 400;

/** A stream that never sends a newline is not buffered without bound. */
const MAX_PENDING = 64 * 1024;

/** Which stream a chunk came from; each keeps its own partial line. */
export type AgentStream = "stdout" | "stderr";

/** CSI and OSC sequences, which a harness drawing a progress bar emits freely. */
const ANSI = /\u001B\[[0-9;?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g;
/** C0 controls other than tab, which survive the ANSI strip as mojibake. */
const CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

/**
 * The inputs a tool call is named by, in the order a caller would read them.
 * Generic key names rather than a tool list: nothing here knows what tools a
 * harness has, only that a call naming a file is best said as that file.
 */
const PATH_KEYS = ["file_path", "path"] as const;
const PHRASE_KEYS = ["command", "pattern", "url", "query"] as const;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** One line of prose, with the terminal's own drawing taken out. */
export function plainLine(raw: string): string {
    return raw.replace(ANSI, "").replace(CONTROLS, "").trim();
}

/** `text`, cut to `max` with an ellipsis when it does not fit. */
function clamp(text: string, max: number): string {
    const collapsed = text.replace(/\s+/g, " ").trim();
    return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1).trimEnd()}…`;
}

/** The last path segment, so a corner line says the file rather than the tree. */
function basename(path: string): string {
    return path.split(/[\\/]/).filter((p) => p !== "").pop() ?? path;
}

/** The first line of a block of prose: a narration's opening is what it is about. */
function opening(text: string): string {
    return text.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "") ?? "";
}

/** What a tool call is named by: its own name, plus the input that identifies it. */
function toolLine(name: string, input: unknown): string {
    if (!isObject(input)) { return name; }
    for (const key of PATH_KEYS) {
        const value = str(input[key]);
        if (value) { return `${name} ${basename(value)}`; }
    }
    for (const key of PHRASE_KEYS) {
        const value = str(input[key]);
        if (value) { return `${name} ${value}`; }
    }
    return name;
}

/**
 * The two shapes, and what each event of them is worth saying.
 *
 * `recognized` is deliberately separate from `display`: an event whose shape
 * we know but whose content says nothing (a session opening, a turn ending)
 * still proves the stream is structured, and that is what silences the plain
 * fallback. Conflating the two would let one incidental JSON line from a
 * prose-printing harness silence it forever.
 */
interface Shape {
    recognized(event: Json): boolean;
    display(event: Json, said: (text: string) => void): string | undefined;
}

/**
 * Content-block streams: an envelope per message, each carrying `content`
 * blocks of `text`, `tool_use` or `thinking`, every event stamped with the
 * session it belongs to. Captured from Claude Code 2.1.278
 * (`--output-format stream-json --verbose`), 2026-09-20.
 */
const CONTENT_BLOCK_SHAPE: Shape = {
    recognized: (event) => typeof event.type === "string" && typeof event.session_id === "string",
    display(event, said) {
        if (event.type === "system") {
            // The only system event worth a line is the one that says a model
            // is thinking. Its token count is not shown: a number nobody can
            // act on spends the corner's one line.
            return event.subtype === "thinking_tokens" ? vscode.l10n.t("Thinking") : undefined;
        }
        if (event.type !== "assistant" || !isObject(event.message)) { return undefined; }
        const content = event.message.content;
        if (!Array.isArray(content)) { return undefined; }
        let line: string | undefined;
        for (const block of content) {
            if (!isObject(block)) { continue; }
            if (block.type === "thinking") {
                // The word, never the content. See this module's header.
                line = vscode.l10n.t("Thinking");
            } else if (block.type === "text") {
                const text = str(block.text);
                if (!text) { continue; }
                said(text);
                line = clamp(opening(text), PROGRESS_LINE_MAX);
            } else if (block.type === "tool_use") {
                const name = str(block.name);
                if (name) { line = clamp(toolLine(name, block.input), PROGRESS_LINE_MAX); }
            }
        }
        return line;
    },
};

/**
 * Item streams: a flat event per thread, turn and item, the item carrying its
 * own kind. Captured from Codex 0.149.0 (`codex exec --json`), 2026-09-20.
 *
 * That run emitted no reasoning item, so none is reduced here: a shape this
 * reader has not seen is not one it guesses at.
 */
const ITEM_SHAPE: Shape = {
    recognized: (event) => typeof event.type === "string"
        && /^(item|turn|thread)\./.test(event.type),
    display(event, said) {
        if (!isObject(event.item)) { return undefined; }
        const item = event.item;
        if (item.type === "agent_message") {
            const text = str(item.text);
            if (!text) { return undefined; }
            said(text);
            return clamp(opening(text), PROGRESS_LINE_MAX);
        }
        if (item.type === "command_execution") {
            const command = str(item.command);
            return command
                ? clamp(vscode.l10n.t("Running {0}", command), PROGRESS_LINE_MAX)
                : undefined;
        }
        if (item.type === "file_change" && Array.isArray(item.changes)) {
            const paths = item.changes
                .map((c) => (isObject(c) ? str(c.path) : undefined))
                .filter((p): p is string => p !== undefined);
            if (paths.length === 0) { return undefined; }
            // One sentence per arm rather than a count glued to a noun: a
            // translator has to be able to put the number where the language
            // puts it.
            return paths.length === 1
                ? clamp(vscode.l10n.t("Editing {0}", basename(paths[0])), PROGRESS_LINE_MAX)
                : vscode.l10n.t("Editing {0} files", String(paths.length));
        }
        return undefined;
    },
};

const SHAPES = [CONTENT_BLOCK_SHAPE, ITEM_SHAPE];

/**
 * Reduces one run's output to the newest line worth showing.
 *
 * Fed every chunk of both streams; answers with a line when the chunk said
 * something new, and undefined when it did not. Intermediate lines inside one
 * chunk are dropped rather than queued: the corner shows what is happening
 * now, so the newest line is the only one that matters.
 */
export class AgentProgressReader {
    private readonly pending: Record<AgentStream, string> = { stdout: "", stderr: "" };
    private structured = false;
    private said: string | undefined;

    /** Whether this run printed events in a shape this reader knows. */
    get isStructured(): boolean { return this.structured; }

    /**
     * The harness's own last words, when the stream carried them. What the
     * reports quote instead of a tail of JSON.
     */
    get lastSaid(): string | undefined { return this.said; }

    read(chunk: string, stream: AgentStream): string | undefined {
        const buffer = this.pending[stream] + chunk;
        // A bare CR is a redraw rather than a continuation, so a progress bar
        // becomes one line per frame instead of one line forever.
        const parts = buffer.split(/\r\n|[\r\n]/);
        const remainder = parts.pop() ?? "";
        this.pending[stream] = remainder.length > MAX_PENDING ? "" : remainder;
        let latest: string | undefined;
        for (const raw of parts) {
            const line = this.reduce(raw);
            if (line !== undefined) { latest = line; }
        }
        return latest;
    }

    private reduce(raw: string): string | undefined {
        const text = plainLine(raw);
        if (text === "") { return undefined; }
        if (text.startsWith("{")) {
            const event = parse(text);
            if (event) {
                const shape = SHAPES.find((s) => s.recognized(event));
                if (shape) {
                    this.structured = true;
                    return shape.display(event, (t) => { this.said = clamp(t, SAID_MAX); });
                }
            }
        }
        return this.structured ? undefined : clamp(text, PROGRESS_LINE_MAX);
    }
}

function parse(text: string): Json | undefined {
    try {
        const value: unknown = JSON.parse(text);
        return isObject(value) ? value : undefined;
    } catch {
        // Not JSON, or a JSON line split across chunks we never rejoined.
        // Either way it is prose as far as this reader is concerned.
        return undefined;
    }
}
