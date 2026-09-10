/**
 * The one CSP grant the verify worker needs, declared by every surface that
 * serves the page under a policy (MAR-430).
 *
 * The worker starts from a Blob URL (webview/utils/verifyOracle.ts says why),
 * and a policy with `default-src 'none'` refuses a Blob worker unless
 * `worker-src` says otherwise. A host that dropped the grant would not fail:
 * the oracle retires itself and every sync runs on the main thread, which is
 * the previous behaviour exactly, so the only signal would be a large
 * document that hitches again. This holds the grant where it has to be
 * written, in the two hosts and in the harness pages that mirror them, so the
 * nightly's `mainReparses` ceiling is the second guard and not the first.
 *
 * The declarers were a hand-written list of seven until `cspDeclarers.ts`
 * replaced it, and the reason for the change is the same absence this file
 * exists to catch, one level up. An unlisted page was an unchecked page, and
 * unchecked is green: a harness page added after this guard was written could
 * drop the grant, run its own suite on the main thread, and report nothing.
 * The guard was only ever as complete as somebody's memory of it.
 */
import { describe, it, expect } from "vitest";
import { cspDeclarers, assertReached } from "./cspDeclarers";

describe("the verify worker's CSP grant", () => {
    const found = cspDeclarers();

    it("should have found the shipped hosts and the harness pages", () => {
        assertReached(found, expect);
    });

    it.each(found.map((d) => [d.file, d] as const))(
        "%s should declare a policy, so the grant below is load-bearing",
        (_file, declarer) => {
            expect(declarer.source).toContain("default-src 'none'");
        },
    );

    it.each(found.map((d) => [d.file, d] as const))(
        "%s should grant a Blob worker and nothing wider",
        (file, declarer) => {
            const grants = declarer.source.match(/worker-src[^;"']*/g) ?? [];
            expect(grants.length, `${file} declares no worker-src`).toBeGreaterThan(0);
            for (const grant of grants) {
                expect(grant.trim()).toBe("worker-src blob:");
            }
        },
    );
});
