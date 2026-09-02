/**
 * The verify worker's SHIPPED script, run where there is no document.
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
import * as esbuild from "esbuild";
import { createContext, runInContext } from "node:vm";
import { join } from "node:path";
import type { VerifyReply, VerifyRequest } from "../../webview/workers/protocol";
import { verifyWorkerBuildOptions } from "../../scripts/verifyWorkerBuild.mjs";

const webviewDir = join(__dirname, "..", "..", "webview");

describe("the verify worker's shipped script", () => {
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
        };
        scope.self = scope;
        scope.globalThis = scope;
        const context = createContext(scope);
        expect(runInContext("typeof document", context)).toBe("undefined");
        runInContext(script!.text, context, { filename: "verifyWorker.js" });

        const text = "# Notes\n\n- alpha\n    - beta\n\nProse with an &amp; entity and a [link](https://example.com).\n";
        // The fingerprint the page would send, from the parser the page uses.
        const { createHeadlessParser } = await import("../../webview/utils/headlessParser");
        const { markdownParse } = await import("../../webview/format/markdown/parse");
        const { fingerprintDoc } = await import("../../webview/plugins/fingerprints");
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
        const liveFp = fingerprintDoc(parser.parse(text)!);

        const ask = (request: VerifyRequest): void => {
            target.dispatchEvent(new MessageEvent("message", { data: request }));
        };
        ask({ type: "reopens", id: 1, text, liveFp });
        ask({ type: "reopens", id: 2, text: text.replace("\n    - beta", "\n- beta"), liveFp });
        for (let i = 0; i < 2000 && replies.length < 2; i++) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(replies).toEqual([
            { type: "verdict", id: 1, reopens: true },
            { type: "verdict", id: 2, reopens: false },
        ]);
        await parser.destroy();
    }, 60_000);
});
