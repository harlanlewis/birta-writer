/**
 * Lazy loader for the local graph (MAR-481).
 *
 * The Graph tab is one review tab among several and most readers never switch
 * to it, so its model, layout, drawing and stylesheet sit behind a cached
 * dynamic `import()` in a chunk of their own, fetched the first time the tab
 * is shown. Mirrors `katexLoader.ts` and `fileExplorerLoader.ts`; this module
 * is what the eager graph holds instead, and it imports only a type.
 *
 * A failed load is not cached, so the next showing of the tab tries again.
 */
import type * as LocalGraphModule from "../components/graph";

let loading: Promise<typeof LocalGraphModule> | null = null;

export function loadLocalGraph(): Promise<typeof LocalGraphModule> {
    if (!loading) {
        loading = import("../components/graph").catch((err) => {
            loading = null;
            throw err;
        });
    }
    return loading;
}
