/**
 * The guard in `setup.ts` that keeps `pnpm test` from failing at random
 * (MAR-298), and the upstream leak it exists for.
 *
 * `Editor.create()` starts a `Timer` per plugin timing, and `@milkdown/ctx`
 * arms each one with a `setTimeout(…, 3000)` that nothing clears — not
 * resolving the timer, not `editor.destroy()`. When one fires it calls the bare
 * global `removeEventListener`, so a timer outliving its file's jsdom teardown
 * throws `ReferenceError: removeEventListener is not defined`. Vitest counts
 * that as an unhandled error and exits non-zero with EVERY TEST PASSING and no
 * failing test named.
 *
 * The assertion below is deliberately pointed AT THE LEAK rather than at the
 * workaround. If Milkdown starts clearing its own timeouts, this test fails —
 * which is the signal to delete the `setup.ts` wrapper rather than carry it
 * forever. A test asserting "the wrapper is installed" would pass either way
 * and would never tell anyone the workaround had become dead weight.
 *
 * That only works because `setup.ts` wraps `clearTimeout` as well as
 * `setTimeout`. Tracking only `setTimeout` would drop an entry solely when a
 * timer FIRED, so a fixed `@milkdown/ctx` — one that keeps its handles and
 * cancels them — would still grow the count by nine and this test would still
 * pass, quietly outliving its purpose.
 */
import { describe, it, expect } from "vitest";
import { pendingTimeoutCount } from "./setup";
import { makeCorpusEditor } from "./helpers/moveFuzz";

describe("Milkdown's ctx Timer leaks timeouts that outlive destroy() (MAR-298)", () => {
    it("creating and destroying one editor should leave timeouts for the guard to clear", async () => {
        const before = pendingTimeoutCount();

        const editor = await makeCorpusEditor("hello\n");
        await editor.destroy();

        // Measured at 9 on @milkdown/ctx 7.21.2. Asserting ">" rather than a
        // count keeps this about the leak existing, not about how many timings
        // the plugin stack happens to register.
        expect(
            pendingTimeoutCount(),
            "destroy() should have cleared these; when it does, delete the setup.ts wrapper",
        ).toBeGreaterThan(before);
    });
});
