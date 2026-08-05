/**
 * Wrap `serializerCtx` with a format-supplied whole-document post-pass.
 *
 * A `toMarkdown` handler only ever sees one node. Some corrections need the
 * WHOLE serialized document — markdown's org-cookie unescape has to see every
 * `[label]:` definition and every fence before it can tell a cookie from a
 * link label (MAR-131), and the autolink backslash unescape is the same shape
 * (MAR-218). This is the one point where that document exists.
 *
 * The pass is a parameter rather than an import so this file carries no
 * format-specific dependency: markdown's preset instantiates it with its own
 * pass in `serialization.ts`, which is the single source of truth for the
 * binding (see the FormatModule charter in `webview/format/types.ts`).
 *
 * Consumers must read the slice at call time — `getMarkdown()` does; see
 * `webview/editor.ts` for the listener wiring. A listener that captures the
 * serializer in a closure at `SerializerReady` may still hold the unwrapped
 * one.
 *
 * ## What this replaced
 *
 * Until Milkdown 7.22.0 this was a whole vendored copy of Milkdown's
 * `SerializerState` (`fidelitySerializer.ts`, ~520 lines kept byte-honest
 * against upstream by a SHA-256 drift test), carrying three fidelity deltas:
 * links had to open outermost so a formatted link serialized as one link
 * rather than several adjacent ones repeating the URL (MAR-33); edge-space
 * trimming had to be deferred until after adjacent mark segments merged, for
 * the same reason; and list `spread` had to be coerced to a real boolean or
 * tight lists round-tripped loose (MAR-48, MAR-124).
 *
 * Upstream fixed all three — the first two structurally, by keeping marks open
 * across adjacent nodes instead of closing and re-merging them (#2405), and
 * the third at the source, in the list parse runners (#2419, #2423). The
 * regression tests for MAR-33, MAR-48 and MAR-124 pass against stock 7.22.0,
 * so the fork is gone and only its injection point survives, here.
 */
import type { Editor } from "@milkdown/core";
import { SerializerReady, serializerCtx } from "@milkdown/core";

type MilkdownPlugin = Exclude<Parameters<Editor["use"]>[0], unknown[]>;

export function createSerializerPostPassPlugin(
    postSerialize: (serialized: string) => string,
): MilkdownPlugin {
    return (ctx) => async () => {
        await ctx.wait(SerializerReady);
        const stock = ctx.get(serializerCtx);
        ctx.set(serializerCtx, (content) => postSerialize(stock(content)));
    };
}
