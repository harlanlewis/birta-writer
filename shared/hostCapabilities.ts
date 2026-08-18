/**
 * shared/hostCapabilities.ts
 *
 * The registry of which features live in which surface (MAR-373, MAR-370).
 *
 * The contract: Jot ships zero behavior Birta lacks. Every surface runs the
 * same editor from the same bundle, and what differs between them is only the
 * chrome that names something the HOST provides. A capability is therefore
 * always a host-side thing (a text editor to switch to, a settings UI, a
 * proofreading engine with its review sidebar, an owner for read-only mode, a
 * TOC sidebar, an image store), never an editor feature. An editor feature is
 * gated by its own `birta.*` setting, not here.
 *
 * The host declares its capabilities in `window.__i18n.hostCapabilities`
 * (src/webviewHtml.ts bakes the full list for VS Code). ABSENT MEANS ALL, so
 * an existing page that never heard of the field keeps every item; an
 * explicit `[]` is a host with none. Consumers ask `hostHas(cap)` or
 * `hostHasCommand(id)` and never read the field directly, so the absent-means-
 * all rule has one home.
 *
 * Dependency-free (no vscode, no DOM types) so both the extension and the
 * webview import it; the read of the declaration goes through `globalThis`,
 * which is `window` in every webview.
 */
import { EDITOR_COMMANDS } from "./editorCommands";

export type HostCapability =
    /** A raw text editor to switch to (Edit Raw Markdown). */
    | "textEditor"
    /** A settings UI, a keybindings UI, and a release-notes page to open. */
    | "hostSettings"
    /** A proofreading engine and the review sidebar that shows its findings. */
    | "proofreading"
    /** An owner for read-only mode (the `birta.readOnly` seed and its toggle). */
    | "readOnlyMode"
    /** The table-of-contents / review sidebar. */
    | "toc"
    /** An image store the Insert Image panel can upload to and browse. */
    | "imageUpload"
    /** A coding agent to hand a prompt to (Ask Agent). */
    | "agent";

export const ALL_HOST_CAPABILITIES: readonly HostCapability[] = [
    "textEditor",
    "hostSettings",
    "proofreading",
    "readOnlyMode",
    "toc",
    "imageUpload",
    "agent",
];

/**
 * The named profiles, one per surface. VS Code declares everything; Jot v1
 * declares nothing, and grows an entry here the day its shell provides one.
 */
export const HOST_PROFILES = {
    vscode: ALL_HOST_CAPABILITIES,
    // Mirrored by hand in jot/Sources/BirtaJot/Preferences.swift
    // (`Prefs.bootConfig`), which cannot import this file: change both.
    jot: [] as readonly HostCapability[],
} as const satisfies Record<string, readonly HostCapability[]>;

interface HostDeclaration {
    __i18n?: { hostCapabilities?: readonly HostCapability[] };
}

/** Whether the host declares `cap`. An absent declaration is every capability. */
export function hostHas(cap: HostCapability): boolean {
    const declared = (globalThis as HostDeclaration).__i18n?.hostCapabilities;
    return declared === undefined || declared.includes(cap);
}

const COMMAND_CAPABILITY: ReadonlyMap<string, HostCapability> = new Map(
    EDITOR_COMMANDS.flatMap((meta) =>
        "hostCapability" in meta && meta.hostCapability
            ? [[meta.id, meta.hostCapability] as const]
            : []),
);

/**
 * Whether the host can honour editor command `id`: true for every command
 * that requires no capability, and for a gated one exactly when the host
 * declares its capability. The one predicate every surface that offers or
 * runs a command (toolbar, gear menu, slash menu, `runEditorCommand`) reads,
 * so a chord, a palette pick and a menu row can never disagree.
 */
export function hostHasCommand(id: string): boolean {
    const cap = COMMAND_CAPABILITY.get(id);
    return cap === undefined || hostHas(cap);
}
