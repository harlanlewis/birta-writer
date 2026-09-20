/**
 * The sync worker's entry (webview/workers/verifyWorker.ts), driven the way
 * a browser drives it: a message event on the global scope in, a
 * `postMessage` out, and no document anywhere. The scope here is Node's
 * global plus the one capability a worker scope has and Node lacks (an
 * EventTarget on the global, see headlessParserNoDom.test.ts), so a module
 * the entry pulls in that reaches for `window` fails this file before it
 * fails in a user's editor.
 */
import { describe, it, expect, beforeAll } from "vitest";
import type { RoundTripProtection } from "@birta/minimal-diff";
import type { Node as ProseNode } from "../../webview/pm";
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

/** A four-space outline: the serializer spells it at two, so a merge into it is really verified. */
const TEXT = "# Notes\n\n- alpha\n    - beta\n\nA paragraph with `code` and a [link](https://example.com).\n";

describe("the sync worker entry", () => {
    let parse: (text: string) => ProseNode;
    // The protection the page computes for this file and sends with every
    // merge: without it the merge has no model of the file's indentation and
    // writes the serializer's two spaces, which is the churn protection exists
    // to stop.
    let protection: RoundTripProtection | null;

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
        // The document the page would send, from the parser the page uses.
        const { createHeadlessParser } = await import("../../webview/utils/headlessParser");
        const { markdownParse } = await import("../../webview/format/markdown/parse");
        const { computeRoundTripProtection, markdownProfile } = await import("../../webview/utils/minimalDiff");
        const parser = await createHeadlessParser(markdownParse);
        parse = (text) => parser.parse(text)!;
        protection = computeRoundTripProtection(TEXT, parser.serialize(parse(TEXT)), markdownProfile);
    });

    it("a warm request should be acknowledged once the parser is built", async () => {
        send({ type: "warm", text: TEXT });
        const reply = await replyFor((r) => r.type === "warmed");
        expect(reply.type).toBe("warmed");
    });

    it("an unedited document should merge back to the saved bytes, keeping their own spelling", async () => {
        send({ type: "merge", id: 1, doc: parse(TEXT).toJSON(), saved: TEXT, protection });
        const reply = await replyFor((r) => r.type === "merged" && r.id === 1);
        expect(reply).toEqual({ type: "merged", id: 1, text: TEXT, canonical: false, reparses: 1 });
    });

    it("an edited document should merge into the saved bytes, changing only the edited region", async () => {
        const edited = TEXT.replace("A paragraph", "An edited paragraph");
        send({ type: "merge", id: 2, doc: parse(edited).toJSON(), saved: TEXT, protection });
        const reply = await replyFor((r) => r.type === "merged" && r.id === 2);
        // The four-space nesting is the SAVED file's, not the serializer's:
        // the merge ran and the verifier accepted it.
        expect(reply).toEqual({ type: "merged", id: 2, text: edited, canonical: false, reparses: 1 });
    });

    it("a document the schema cannot rebuild should be reported as a failure, not a verdict", async () => {
        send({ type: "merge", id: 3, doc: { type: "no-such-node" }, saved: TEXT, protection });
        const reply = await replyFor((r) => r.type === "failed" && r.id === 3);
        expect(reply.type).toBe("failed");
    });

    it("answers should come back in the order the questions were asked", async () => {
        const before = replies.length;
        const doc = parse(TEXT).toJSON();
        send({ type: "merge", id: 4, doc, saved: TEXT, protection });
        send({ type: "merge", id: 5, doc, saved: TEXT, protection });
        await replyFor((r) => r.type === "merged" && r.id === 5);
        const ids = replies.slice(before).map((r) => ("id" in r ? r.id : -1));
        expect(ids).toEqual([4, 5]);
    });
});
