/**
 * src/utils/cappedRead.ts
 *
 * Size-bounded response-body reading for the extension's outbound fetches
 * (paste-unfurl's HTML, the embed-metadata oEmbed JSON). Streaming the body
 * and bailing early bounds the parse cost regardless of the page's real size;
 * the optional stop marker lets an HTML read finish at `</head>` — a title
 * lives there, near the top — while a JSON read just runs to the cap.
 */

/**
 * Read at most `maxBytes` of a fetch Response body as UTF-8 text, then stop.
 * When `stopMarker` is given, reading also stops once the marker has streamed
 * past (searched across chunk boundaries via a trailing window). Falls back to
 * a plain `.text()` when the body isn't a readable stream (e.g. a stubbed
 * Response in a unit test), slicing the result to the same budget.
 */
export async function readCappedText(
    res: Response,
    maxBytes: number,
    stopMarker?: string,
): Promise<string> {
    const reader = res.body?.getReader?.();
    if (!reader) {
        return (await res.text()).slice(0, maxBytes);
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    const decoder = new TextDecoder("utf-8");
    let tailText = "";
    try {
        while (total < maxBytes) {
            const { done, value } = await reader.read();
            if (done) { break; }
            if (value) {
                chunks.push(value);
                total += value.length;
                if (stopMarker) {
                    const text = tailText + decoder.decode(value, { stream: true });
                    if (text.includes(stopMarker)) { break; }
                    tailText = text.slice(-stopMarker.length);
                }
            }
        }
    } finally {
        // Stop the transfer once we have enough (or on any read error).
        try { await reader.cancel(); } catch { /* already closed */ }
    }
    const merged = new Uint8Array(Math.min(total, maxBytes));
    let offset = 0;
    for (const chunk of chunks) {
        if (offset >= merged.length) { break; }
        const take = Math.min(chunk.length, merged.length - offset);
        merged.set(chunk.subarray(0, take), offset);
        offset += take;
    }
    return new TextDecoder("utf-8").decode(merged);
}
