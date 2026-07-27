/**
 * src/agentBridge/publicApi.ts
 *
 * The extension-interop adapter: the object activate() returns, so any
 * cooperating extension (open-source agents, future first-party bridges) can
 * read the Birta editor's live file + selection through a stable, versioned
 * seam instead of reaching into internals.
 */

import type { ActiveContextResolver, BirtaApi, BirtaEditorContext } from "./api";
import { toBirtaSelection } from "./format";

/** Build the public API over the neutral active-context resolver. */
export function createBirtaApi(getActive: ActiveContextResolver): BirtaApi {
    return {
        apiVersion: 1,
        async getActiveEditorContext(): Promise<BirtaEditorContext | null> {
            const active = await getActive();
            if (!active) { return null; }
            const { context, uri } = active;
            const sel = context.selections[context.primary] ?? context.selections[0];
            return {
                uri: uri.toString(),
                fsPath: uri.fsPath,
                selection: toBirtaSelection(context),
                selectedText: sel?.text ?? "",
                isEmpty: context.isEmpty,
            };
        },
    };
}
