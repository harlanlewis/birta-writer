/**
 * src/agentBridge/api.ts
 *
 * Types for the coding-agent bridge: the internal resolver every adapter is
 * built on, and the public API the extension returns from activate().
 */

import type * as vscode from "vscode";
import type { EditorSelectionContext } from "../../shared/agentContext";

/** The active Birta editor's file + live selection, as resolved by the provider. */
export interface ActiveEditorContext {
    uri: vscode.Uri;
    context: EditorSelectionContext;
}

/**
 * The single neutral source every adapter reads. One resolver, many adapters:
 * reaching a new agent means adding an adapter, never re-deriving state.
 * Resolves null when no Birta editor is active or it did not answer.
 */
export type ActiveContextResolver = () => Promise<ActiveEditorContext | null>;

// ── Public API (returned from activate()) ──────────────────────────────────
// Consumed by any extension:
//   const ext = vscode.extensions.getExtension('birtalabs.birta-writer');
//   const api = await ext?.activate() as BirtaApi | undefined;
//   const ctx = await api?.getActiveEditorContext();

/** A 0-indexed position, matching VS Code's own `Position` convention. */
export interface BirtaPosition {
    line: number;
    character: number;
}

/** What the user has open and selected in a Birta editor, VS Code-flavoured. */
export interface BirtaEditorContext {
    /** The document URI as `Uri.toString()`. */
    uri: string;
    /** The document filesystem path. */
    fsPath: string;
    /** Primary selection as an ordered range (start ≤ end), 0-indexed. */
    selection: { start: BirtaPosition; end: BirtaPosition };
    /** Plain text of the selection (markup stripped); empty for a bare caret. */
    selectedText: string;
    /** True when the selection is a bare caret. */
    isEmpty: boolean;
}

/**
 * The Birta Writer extension's public API. Lets any extension read the WYSIWYG
 * editor's live file + selection — the context VS Code's `activeTextEditor`
 * hides for a custom editor. Versioned so future additions stay compatible.
 */
export interface BirtaApi {
    readonly apiVersion: 1;
    /** The active Birta editor's file + selection, or null when none is active. */
    getActiveEditorContext(): Promise<BirtaEditorContext | null>;
}
