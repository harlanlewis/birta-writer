/**
 * The one live `/ai` composer, and the wiring around it.
 *
 * The panel component (components/agentPanel) is pure DOM and knows nothing
 * about messages, the editor, or the caret. This is the seam: it decides
 * where the panel opens, holds the capabilities the extension pushed, routes
 * attachment replies back to the chip that is waiting for one, and turns a
 * send into the same registered run a plain `/ai` produces, so the gutter
 * marker, the stop pill and the undo behaviour are identical either way.
 *
 * One at a time, deliberately. A second composer would have a second caret
 * to answer to, and the request is always about where the caret was when it
 * opened.
 */
import type { EditorView } from "./pm";
import type { HarnessCapabilities } from "../shared/messages";
import {
    notifyAgentAttachment,
    notifyAskAgentAdvanced,
    requestAgentCapabilities,
} from "./messaging";
import type { AgentPanelHandle, AgentPanelHost } from "./components/agentPanel";
import { beginAgentRun } from "./plugins/agentPending";

/**
 * The panel module loads on first use, never at launch: it is
 * invocation-only UI, so a static import would put its DOM, its menus and
 * its attachment handling into the eager bundle for every document that
 * never opens it. The `components/shortcutsHelp/loader.ts` pattern; a static
 * import of `./components/agentPanel` anywhere on the launch path undoes it,
 * and `pnpm perf:bundle` is what shows that it did.
 */
let modulePromise: Promise<typeof import("./components/agentPanel")> | null = null;
function loadAgentPanel(): Promise<typeof import("./components/agentPanel")> {
    return (modulePromise ??= import("./components/agentPanel"));
}

let panel: AgentPanelHandle | null = null;
/**
 * Bumped on every open and close. The module load is async, so a panel
 * dismissed while its chunk was still in flight would otherwise be mounted
 * by the resolution of a request the user has already abandoned.
 */
let openToken = 0;
let capabilities: HarnessCapabilities | undefined;
/** Dismiss listener, live only while a panel is. */
let onDocMousedown: ((e: MouseEvent) => void) | null = null;

/** Store what the extension found, and tell an open panel about it. */
export function setAgentCapabilities(caps: HarnessCapabilities | undefined): void {
    capabilities = caps;
    panel?.setCapabilities(caps);
}

/** The capabilities last pushed. Exported for tests. */
export function agentCapabilities(): HarnessCapabilities | undefined {
    return capabilities;
}

/** Route one attachment's write result to the chip waiting for it. */
export function resolveAgentAttachment(id: string, path: string | null): void {
    panel?.resolveAttachment(id, path);
}

/** Close without sending. Safe to call when nothing is open. */
export function closeAgentPanel(): void {
    // Bumped here too, so a close during the module load cancels the mount
    // rather than only tearing down a panel that does not exist yet.
    openToken++;
    panel?.destroy();
    panel = null;
    if (onDocMousedown) {
        document.removeEventListener("mousedown", onDocMousedown, true);
        onDocMousedown = null;
    }
}

/** Whether a composer is open. Exported for tests and for Escape layering. */
export function agentPanelOpen(): boolean {
    return panel !== null;
}

/** The caret rectangle to anchor against, or the viewport centre as a floor. */
function caretAnchor(view: EditorView | null): { left: number; top: number; bottom: number } {
    try {
        if (view) {
            const c = view.coordsAtPos(view.state.selection.from);
            return { left: c.left, top: c.top, bottom: c.bottom };
        }
    } catch {
        // jsdom, and any position the view cannot measure.
    }
    return { left: 80, top: 80, bottom: 100 };
}

/**
 * Open the composer at the caret. `initial` prefills it, which is how
 * `/ai-advanced write a summary` arrives with its text already in place.
 */
export function openAgentPanel(getEditorView: () => EditorView | null, initial?: string): void {
    closeAgentPanel();
    const view = getEditorView();
    // Ask again on open. Usually already cached and answered in the same
    // tick; the panel simply has no pickers until it lands, rather than
    // waiting on a process spawn before it can be typed into.
    requestAgentCapabilities();
    const token = ++openToken;

    const host: AgentPanelHost = {
            saveAttachment(id, name, bytes) {
                // Base64 because the message channel carries JSON. Chunked
                // conversion: a single String.fromCharCode over a megabyte of
                // bytes overflows the argument limit.
                const arr = new Uint8Array(bytes);
                let binary = "";
                for (let i = 0; i < arr.length; i += 0x8000) {
                    binary += String.fromCharCode(...arr.subarray(i, i + 0x8000));
                }
                notifyAgentAttachment(id, name, btoa(binary));
            },
            submit(request) {
                // Registered at the caret exactly as `/ai` does, so a
                // background run marks the same gutter and undoes the same way.
                let requestId = "";
                if (view) { requestId = beginAgentRun(view); }
                notifyAskAgentAdvanced({ ...request, requestId });
                closeAgentPanel();
                view?.focus();
            },
            dismiss() {
                closeAgentPanel();
                view?.focus();
            },
    };

    void loadAgentPanel()
        .then((m) => {
            // Abandoned while the chunk was loading: Escape, a click away, or
            // a second open. Mounting now would put a panel on screen for a
            // request that is over.
            if (token !== openToken) { return; }
            panel = m.createAgentPanel({ anchor: caretAnchor(view), initial, capabilities, host });
            // A click anywhere outside dismisses, the behaviour every other
            // transient surface here has. Capture phase, so it runs before a
            // handler that might stop propagation. Registered with the panel
            // rather than before it, or the click that opened it could close it.
            onDocMousedown = (e: MouseEvent) => {
                if (panel && !panel.el.contains(e.target as Node)) {
                    closeAgentPanel();
                }
            };
            document.addEventListener("mousedown", onDocMousedown, true);
        })
        .catch((e: unknown) => console.error("[birta] agent composer failed to load", e));
}
