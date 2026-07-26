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
 * A ready-to-paste block for the clipboard commands: the reference alone for a
 * bare caret, or the reference followed by the selected text.
 */
export function buildContextBlock(relPath: string, context: EditorSelectionContext): string {
    const ref = buildReference(relPath, context);
    const sel = primary(context);
    return context.isEmpty || !sel.text ? ref : `${ref}\n\n${sel.text}`;
}

/**
 * A compact, model-facing description for the Language Model Tool: the file, the
 * location, the exact reference, and the selected text (truncated if very long).
 */
export function describeForModel(relPath: string, context: EditorSelectionContext): string {
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
    if (!context.isEmpty && sel.text) {
        const text =
            sel.text.length > MAX_SELECTION_CHARS
                ? `${sel.text.slice(0, MAX_SELECTION_CHARS)}\n… [truncated ${
                      sel.text.length - MAX_SELECTION_CHARS
                  } more characters]`
                : sel.text;
        lines.push("Selected text:", text);
    }
    return lines.join("\n");
}
