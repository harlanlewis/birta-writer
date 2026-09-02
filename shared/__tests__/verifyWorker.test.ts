/**
 * The verify worker's entry (webview/workers/verifyWorker.ts), driven the way
 * a browser drives it: a message event on the global scope in, a
 * `postMessage` out, and no document anywhere. The scope here is Node's
 * global plus the one capability a worker scope has and Node lacks (an
 * EventTarget on the global, see headlessParserNoDom.test.ts), so a module
 * the entry pulls in that reaches for `window` fails this file before it
 * fails in a user's editor.
 */
import { describe, it, expect, beforeAll } from "vitest";
import type { VerifyReply, VerifyRequest } from "../../webview/workers/protocol";

const replies: VerifyReply[] = [];

function send(request: VerifyRequest): void {
    globalThis.dispatchEvent(new MessageEvent("message", { data: request }));
}

async function replyFor(predicate: (r: VerifyReply) => boolean): Promise<VerifyReply> {
    for (let i = 0; i < 2000; i++) {
        const found = replies.find(predicate);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`no reply matched; replies so far: ${JSON.stringify(replies)}`);
}

const TEXT = "# Notes\n\n- alpha\n    - beta\n\nA paragraph with `code` and a [link](https://example.com).\n";

describe("the verify worker entry", () => {
    let fingerprint: (text: string) => ReadonlyMap<string, number>;

    beforeAll(async () => {
        expect(typeof document).toBe("undefined");
        const target = new EventTarget();
        Object.assign(globalThis, {
            addEventListener: target.addEventListener.bind(target),
            removeEventListener: target.removeEventListener.bind(target),
            dispatchEvent: target.dispatchEvent.bind(target),
            postMessage: (reply: VerifyReply) => { replies.push(reply); },
        });
        // Imported AFTER the scope exists: the entry registers its listener
        // as it loads, which is what a worker does.
        await import("../../webview/workers/verifyWorker");
        // The fingerprint the page would send: the same function over the
        // same parser, built here as the page builds its own.
        const { createHeadlessParser } = await import("../../webview/utils/headlessParser");
        const { markdownParse } = await import("../../webview/format/markdown/parse");
        const { fingerprintDoc } = await import("../../webview/plugins/fingerprints");
        const parser = await createHeadlessParser(markdownParse);
        fingerprint = (text) => fingerprintDoc(parser.parse(text)!);
    });

    it("a warm request should be acknowledged once the parser is built", async () => {
        send({ type: "warm", text: TEXT });
        const reply = await replyFor((r) => r.type === "warmed");
        expect(reply.type).toBe("warmed");
    });

    it("a text that reopens as the fingerprint should be answered true", async () => {
        send({ type: "reopens", id: 1, text: TEXT, liveFp: fingerprint(TEXT) });
        const reply = await replyFor((r) => r.type === "verdict" && r.id === 1);
        expect(reply).toEqual({ type: "verdict", id: 1, reopens: true });
    });

    it("a text that reopens as something else should be answered false", async () => {
        // The nested item flattened: one fewer list, and the oracle must see it.
        const damaged = TEXT.replace("\n    - beta", "\n- beta");
        send({ type: "reopens", id: 2, text: damaged, liveFp: fingerprint(TEXT) });
        const reply = await replyFor((r) => r.type === "verdict" && r.id === 2);
        expect(reply).toEqual({ type: "verdict", id: 2, reopens: false });
    });

    it("answers should come back in the order the questions were asked", async () => {
        const before = replies.length;
        send({ type: "reopens", id: 3, text: TEXT, liveFp: fingerprint(TEXT) });
        send({ type: "reopens", id: 4, text: TEXT, liveFp: fingerprint(TEXT) });
        await replyFor((r) => r.type === "verdict" && r.id === 4);
        const ids = replies.slice(before).map((r) => (r.type === "verdict" ? r.id : -1));
        expect(ids).toEqual([3, 4]);
    });
});
