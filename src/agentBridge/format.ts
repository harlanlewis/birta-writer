/**
 * src/agentBridge/format.ts
 *
 * Pure projections of the neutral EditorSelectionContext onto the forms each
 * adapter needs: an @-mention reference, a VS Code-style range, a ready-to-paste
 * block, and a model-facing description. No `vscode` runtime dependency, so
 * every projection is unit-testable in isolation — callers pass the
 * already-resolved workspace-relative path in.
 */

import type { EditorSelectionContext, DocSelection } from "../../shared/agentContext";
import { orderedRange, selectionLineSpan, lineRefSuffix } from "../../shared/agentContext";
import type { BirtaPosition } from "./api";

/** Selections carry a stripped-plain-text preview past this many chars. */
const MAX_SELECTION_CHARS = 20_000;

/** The primary selection (falls back to the first entry, then an empty caret). */
function primary(context: EditorSelectionContext): DocSelection {
    return (
        context.selections[context.primary] ??
        context.selections[0] ?? {
            anchor: { line: 1, column: 0 },
            active: { line: 1, column: 0 },
            text: "",
        }
    );
}

/**
 * An @-mention / file reference every major coding agent accepts:
 * `relative/path.md#L12-L20` (or `#L12` for a caret or single line). `relPath`
 * is already workspace-relative (resolved by the caller via asRelativePath).
 */
export function buildReference(relPath: string, context: EditorSelectionContext): string {
    const { startLine, endLine } = selectionLineSpan(primary(context));
    return `${relPath}${lineRefSuffix(startLine, endLine)}`;
}

/** The primary selection as an ordered, 0-indexed range for a `vscode.Selection`. */
export function toBirtaSelection(
    context: EditorSelectionContext,
): { start: BirtaPosition; end: BirtaPosition } {
    const { start, end } = orderedRange(primary(context));
    return {
        start: { line: start.line - 1, character: start.column },
        end: { line: end.line - 1, character: end.column },
    };
}

/**
 * Fence `content` as a markdown code block, with the fence long enough that no
 * backtick run inside the content can close it early.
 */
export function fenceMarkdown(content: string): string {
    const longestRun = content.match(/`+/g)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0;
    const fence = "`".repeat(Math.max(3, longestRun + 1));
    return `${fence}markdown\n${content}\n${fence}`;
}

/**
 * The selection's exact SOURCE fragment — the real markdown of the selected
 * range, structure intact (headings, list markers, links), which the
 * plain-text `sel.text` has stripped. Mid-line endpoints trim the first and
 * last lines: a user selecting three words is pointing AT those words, and
 * that signal must survive the copy. A column of 0 trims nothing — it means
 * either "the whole line" or "could not be mapped", and over-sharing a line
 * beats clipping real content. Undefined when the span can't be read (stale
 * coordinates against a shorter document).
 */
function sourceSpan(sel: DocSelection, sourceText: string | undefined): string | undefined {
    if (sourceText === undefined) { return undefined; }
    const { start, end } = orderedRange(sel);
    const { startLine, endLine } = selectionLineSpan(sel);
    const all = sourceText.split(/\r?\n/);
    if (startLine < 1 || startLine > all.length) { return undefined; }
    const lines = all.slice(startLine - 1, endLine);
    if (!lines.length) { return undefined; }
    const last = lines.length - 1;
    // End first, then start: both columns index the ORIGINAL lines, and the
    // end trim only removes a tail the start trim never reaches.
    if (end.line === startLine + last && end.column > 0) {
        lines[last] = lines[last]!.slice(0, end.column);
    }
    if (start.column > 0) {
        lines[0] = lines[0]!.slice(start.column);
    }
    return lines.join("\n") || undefined;
}

/** Truncate for the model when a selection is very long. */
function truncated(text: string): string {
    return text.length > MAX_SELECTION_CHARS
        ? `${text.slice(0, MAX_SELECTION_CHARS)}\n… [truncated ${text.length - MAX_SELECTION_CHARS} more characters]`
        : text;
}

/**
 * A ready-to-paste block for the clipboard commands: the reference alone for a
 * bare caret, or the reference followed by the selected lines QUOTED as a
 * fenced markdown block — pasted into an agent's chat, the document content
 * must read as quoted material, not as part of the user's own message. The
 * quoted content is the span's real source lines when `sourceText` (the
 * document's full text) is provided, falling back to the selection's plain
 * text otherwise.
 */
export function buildContextBlock(
    relPath: string,
    context: EditorSelectionContext,
    sourceText?: string,
): string {
    const ref = buildReference(relPath, context);
    const sel = primary(context);
    if (context.isEmpty) { return ref; }
    const content = sourceSpan(sel, sourceText) ?? sel.text;
    return content ? `${ref}\n\n${fenceMarkdown(content)}` : ref;
}

/**
 * A compact, model-facing description for the Language Model Tool: the file, the
 * location, the exact reference, and the selected content — real source lines
 * when `sourceText` is provided, fenced, and truncated if very long.
 */
export function describeForModel(
    relPath: string,
    context: EditorSelectionContext,
    sourceText?: string,
): string {
    const sel = primary(context);
    const { startLine, endLine } = selectionLineSpan(sel);
    const where = context.isEmpty
        ? `caret at line ${startLine}`
        : `lines ${startLine}–${endLine} selected`;

    const lines = [
        "Active Birta markdown editor (VS Code's activeTextEditor cannot see this WYSIWYG editor):",
        `File: ${relPath}`,
        `Location: ${where} (reference: ${buildReference(relPath, context)})`,
    ];
    if (!context.isEmpty) {
        const content = sourceSpan(sel, sourceText) ?? sel.text;
        if (content) {
            lines.push("Selected text:", fenceMarkdown(truncated(content)));
        }
    }
    return lines.join("\n");
}
