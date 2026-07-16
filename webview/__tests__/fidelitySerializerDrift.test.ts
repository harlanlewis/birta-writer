/**
 * Vendoring drift check for `webview/plugins/fidelitySerializer.ts`.
 *
 * That file carries a patched copy of Milkdown's `SerializerState` (plus the
 * unexported `SerializerStackElement`), vendored from
 * `@milkdown/transformer@7.21.2` with three documented behavioral deltas (see
 * its header). The copy is the single riskiest coupling in the round-trip
 * layer: a Milkdown upgrade that changes the upstream serializer would
 * silently diverge from the vendored code while everything still compiles.
 *
 * This test pins the SHA-256 of the exact upstream sources the copy was
 * taken from. When it fails, do NOT just update the hashes: re-diff
 * `fidelitySerializer.ts` against the new upstream files, port whatever
 * changed (keeping the documented deltas), and only then record the new
 * hashes here. (Scope note recorded on MAR-39.)
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const VENDORED_FROM: Record<string, string> = {
    "node_modules/@milkdown/transformer/src/serializer/state.ts":
        "0b59f18958a72c3c4cc9de475341b3679db9bf3dcfb17307cbf851247121a0f3",
    "node_modules/@milkdown/transformer/src/serializer/stack-element.ts":
        "1bb0f6db98afe3fbc6b863b5a98ffca5d7e6be91fb91daf65b5e331363fcc59f",
};

describe("fidelitySerializer vendoring", () => {
    for (const [file, expected] of Object.entries(VENDORED_FROM)) {
        it(`an upstream change to ${file.split("/").pop()} should be caught before it silently diverges`, () => {
            const bytes = readFileSync(resolve(__dirname, "../..", file));
            const actual = createHash("sha256").update(bytes).digest("hex");
            expect(
                actual,
                `${file} changed upstream — re-diff webview/plugins/fidelitySerializer.ts against it, ` +
                    "port the change (keeping the documented deltas), then update this hash.",
            ).toBe(expected);
        });
    }
});
