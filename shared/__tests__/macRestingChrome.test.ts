/**
 * What the Mac app puts away when a window is at rest, and how long it takes.
 *
 * The rule spans two toolkits. Swift fades the titlebar's own buttons and the
 * chevron beside the name (`TitleBarView.syncHoverChrome`,
 * `TitlebarActionsView.applyOffered`); CSS in the host page fades the bar's
 * trailing controls, the formatting row and the floating selection palette
 * (`mac/Resources/index.html`). They are one gesture, so they have to start
 * together and finish together, and nothing in either language can see the
 * other's number.
 *
 * The visible failure is a stagger: the band empties from one end, or the row
 * under the bar is still going when the buttons above it have gone. That reads
 * as a fault rather than as a window settling down, which is the whole thing
 * the treatment exists to avoid, and no test that measured one half could see
 * it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../..");
const page = readFileSync(resolve(root, "mac/Resources/index.html"), "utf8");
const swift = readFileSync(resolve(root, "mac/Sources/BirtaWriter/TitlebarActions.swift"), "utf8");

/** `TitlebarActionsView.chromeFadeSeconds`, in seconds. */
function swiftFadeSeconds(): number {
    const match = swift.match(/static let chromeFadeSeconds: TimeInterval = ([0-9.]+)/);
    if (!match?.[1]) { throw new Error("TitlebarActionsView.chromeFadeSeconds is no longer declared"); }
    return Number(match[1]);
}

/** The block of declarations `body.mac-resting` applies to the page's chrome. */
function restingRule(): string {
    const start = page.indexOf("body.mac-resting .editor-topbar .tb-zone--right,");
    if (start < 0) { throw new Error("the resting rule is no longer spelled this way"); }
    const end = page.indexOf("}", start);
    return page.slice(start, end);
}

describe("the Mac window's resting chrome", () => {
    it("the two files should still hold what this reads", () => {
        // Both parses, asserted before anything is compared: a rename in
        // either file would otherwise leave every assertion below running on
        // an empty string and agreeing with itself.
        expect(swiftFadeSeconds()).toBeGreaterThan(0);
        expect(restingRule()).toContain("opacity: 0");
    });

    it("every surface the window draws over the document should go at rest", () => {
        const rule = restingRule();
        // The bar's trailing controls, the formatting row, and the palette
        // over a selection. Any one of them left out is the case the user
        // reported: the titlebar clears and the editing chrome stays lit on a
        // window nobody is looking at.
        expect(rule).toContain(".tb-zone--right");
        expect(rule).toContain(".tb-dock");
        expect(rule).toContain(".sel-toolbar");
    });

    it("the fade should be one duration across both toolkits", () => {
        const seconds = swiftFadeSeconds();
        const durations = [...restingRule().matchAll(/([0-9.]+)s/g)].map((m) => Number(m[1]));
        // The zero-length visibility step is not a fade; every other number in
        // the rule is one, and each has to be the Swift side's.
        const fades = durations.filter((d) => d > 0);
        expect(fades.length).toBeGreaterThan(0);
        for (const fade of fades) { expect(fade).toBeCloseTo(seconds, 5); }
    });

    it("the chrome should come back at that duration too, not only go at it", () => {
        // The resting rule above is the way OUT. The way in is the base
        // transition on the same three selectors, and a different number there
        // staggers the reveal instead of the hide, which is the same defect
        // with the gesture reversed.
        const start = page.indexOf("  .editor-topbar .tb-zone--right,\n  .editor-topbar .tb-dock,");
        expect(start).toBeGreaterThan(0);
        const base = page.slice(start, page.indexOf("}", start));
        const fades = [...base.matchAll(/([0-9.]+)s/g)].map((m) => Number(m[1])).filter((d) => d > 0);
        expect(fades.length).toBeGreaterThan(0);
        for (const fade of fades) { expect(fade).toBeCloseTo(swiftFadeSeconds(), 5); }
    });
});
