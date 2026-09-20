/**
 * The sync worker's SHIPPED script, run where there is no document.
 *
 * `verifyWorker.test.ts` drives the entry through Vitest's module graph, and
 * that graph resolves packages the way Node does. esbuild resolves them the
 * way a browser does, and a package can send a browser build to a file that
 * creates an element while it loads; the first one found was
 * `decode-named-character-reference`, and every Node test of the same
 * modules was green while the worker threw on its first line of it. So this
 * builds the worker with the build's own configuration
 * (scripts/verifyWorkerBuild.mjs) and evaluates the result in a vm context
 * holding what a worker scope holds and nothing a document would: no
 * `document`, no `window`, an EventTarget on the global, `postMessage`, and
 * the runtime's own intrinsics. A module that reaches for the DOM at load
 * fails here, before it fails in a user's editor.
 */
import { describe, it, expect } from "vitest";
import { budget } from "../../webview/__tests__/helpers/testBudget";
import * as esbuild from "esbuild";
import { createContext, runInContext } from "node:vm";
import { join } from "node:path";
import type { VerifyReply, VerifyRequest } from "../../webview/workers/protocol";
import { verifyWorkerBuildOptions } from "../../scripts/verifyWorkerBuild.mjs";

const webviewDir = join(__dirname, "..", "..", "webview");

describe("the sync worker's shipped script", () => {
    it("should load and answer in a scope with no document", async () => {
        const result = await esbuild.build({
            ...verifyWorkerBuildOptions({ production: false, webviewDir }),
            metafile: false,
        });
        const script = result.outputFiles.find((f) => f.path.endsWith(".js"));
        expect(script, "the build produced no script").toBeDefined();

        // What a DedicatedWorkerGlobalScope offers of what the script needs.
        const target = new EventTarget();
        const replies: VerifyReply[] = [];
        const scope: Record<string, unknown> = {
            addEventListener: target.addEventListener.bind(target),
            removeEventListener: target.removeEventListener.bind(target),
            dispatchEvent: target.dispatchEvent.bind(target),
            postMessage: (reply: VerifyReply) => { replies.push(reply); },
            console,
            setTimeout,
            clearTimeout,
            setInterval,
            clearInterval,
            queueMicrotask,
            performance,
            structuredClone,
            TextEncoder,
            TextDecoder,
            URL,
            URLSearchParams,
            Event,
            CustomEvent,
            EventTarget,
            crypto,
            navigator: { userAgent: "worker" },
            // A real `postMessage` structured-clones, so the protection's
            // maps arrive as the receiving realm's own; nothing clones across
            // a vm context, so the script is given this realm's `Map` and the
            // profile's `instanceof Map` shape check answers as it does in a
            // browser. Without it the merge would run with no baseline facts,
            // which is a different question than this one asks.
            Map,
        };
        scope.self = scope;
        scope.globalThis = scope;
        const context = createContext(scope);
        expect(runInContext("typeof document", context)).toBe("undefined");
        expect(runInContext("new Map()", context)).toBeInstanceOf(Map);
        runInContext(script!.text, context, { filename: "verifyWorker.js" });

        // A four-space outline the serializer spells at two, carrying the
        // entity whose decoder is the reason this file exists. The merge has
        // to come back holding the file's own indentation, which it can only
        // do if the protection crossed and the verifying reparse ran.
        const saved = "# Notes\n\n- alpha\n    - beta\n\nProse with an &amp; entity and a [link](https://example.com).\n";
        const { createHeadlessParser } = await import("../../webview/utils/headlessParser");
        const { markdownParse } = await import("../../webview/format/markdown/parse");
        const { computeRoundTripProtection, markdownProfile } = await import("../../webview/utils/minimalDiff");
        // This test's own global needs the same one capability for the
        // parser built here (headlessParserNoDom.test.ts says why), on a
        // target of its own so the two scopes never hear each other's timers.
        const outer = new EventTarget();
        Object.assign(globalThis, {
            addEventListener: outer.addEventListener.bind(outer),
            removeEventListener: outer.removeEventListener.bind(outer),
            dispatchEvent: outer.dispatchEvent.bind(outer),
        });
        const parser = await createHeadlessParser(markdownParse);
        const protection = computeRoundTripProtection(saved, parser.serialize(parser.parse(saved)!), markdownProfile);
        // The heading, so the entity line stays untouched and its saved
        // spelling is the merge keeping bytes rather than the serializer
        // reproducing them.
        const edited = saved.replace("# Notes", "# Notes and more");

        const ask = (request: VerifyRequest): void => {
            target.dispatchEvent(new MessageEvent("message", { data: request }));
        };
        ask({ type: "merge", id: 1, doc: parser.parse(saved)!.toJSON(), saved, protection });
        ask({ type: "merge", id: 2, doc: parser.parse(edited)!.toJSON(), saved, protection });
        for (let i = 0; i < 2000 && replies.length < 2; i++) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(replies).toEqual([
            { type: "merged", id: 1, text: saved, canonical: false, reparses: 1 },
            { type: "merged", id: 2, text: edited, canonical: false, reparses: 1 },
        ]);
        await parser.destroy();
    }, budget(60_000));
});
