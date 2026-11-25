/**
 * The guard in `setup.ts` that keeps `pnpm test` from failing at random
 * (MAR-298), and the upstream leak it exists for.
 *
 * `Editor.create()` starts a `Timer` per plugin timing, and `@milkdown/ctx`
 * arms each one with a `setTimeout(…, 3000)`. Since 7.22.2 a timer that
 * settles clears its own timeout, so an editor that is created and destroyed
 * leaves nothing behind. A timer that never settles still keeps it: when
 * `Editor.create()` throws part way (a fatal parse, as the MDX format raises
 * on invalid input), the timings after the throw are never done, and
 * `destroy()` is never reached. When one of those fires it calls the bare
 * global `removeEventListener`, so a timer outliving its file's jsdom teardown
 * throws `ReferenceError: removeEventListener is not defined`. Vitest counts
 * that as an unhandled error and exits non-zero with EVERY TEST PASSING and no
 * failing test named.
 *
 * The assertions below are deliberately pointed AT THE LEAK rather than at the
 * workaround. If Milkdown starts clearing an unsettled timer too, the second
 * test fails, which is the signal to delete the `setup.ts` wrapper rather than
 * carry it forever. A test asserting "the wrapper is installed" would pass
 * either way and would never tell anyone the workaround had become dead
 * weight.
 *
 * That only works because `setup.ts` wraps `clearTimeout` as well as
 * `setTimeout`. Tracking only `setTimeout` would drop an entry solely when a
 * timer FIRED, so a fixed `@milkdown/ctx`, one that keeps its handles and
 * cancels them, would still grow the count and this test would still pass,
 * quietly outliving its purpose. The first test is the proof that the
 * tracking sees a cancel.
 */
import { describe, it, expect } from "vitest";
import { pendingTimeoutCount } from "./setup";
import { makeCorpusEditor } from "./helpers/moveFuzz";
import { mdxFormat } from "../format/mdx";

describe("Milkdown's ctx Timer leaks timeouts that outlive destroy() (MAR-298)", () => {
    it("an editor created and destroyed should leave no timeouts behind", async () => {
        const before = pendingTimeoutCount();

        const editor = await makeCorpusEditor("hello\n");
        await editor.destroy();

        // Every timing settled, so @milkdown/ctx cleared every timeout it armed.
        expect(pendingTimeoutCount()).toBe(before);
    });

    it("an editor whose create throws should leave timeouts for the guard to clear", async () => {
        const before = pendingTimeoutCount();

        let threw = false;
        try {
            // An unclosed MDX expression is a fatal parse inside Editor.create().
            const editor = await makeCorpusEditor("first line\n\nsecond {unclosed\n", [], mdxFormat);
            await editor.destroy();
        } catch {
            threw = true;
        }

        // The case has to reach its subject: a create that succeeded would
        // settle every timer and pass the line below for the wrong reason.
        expect(threw).toBe(true);
        expect(
            pendingTimeoutCount(),
            "an unsettled timer should have kept its timeout; when it does not, delete the setup.ts wrapper",
        ).toBeGreaterThan(before);
    });
});
