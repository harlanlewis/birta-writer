/**
 * webview/format/parseError.ts — reading a format parser's failure.
 *
 * A fatal parse (MDX only; markdown has none) is reported to the extension so
 * it can surface the reason and fall back to the text editor. Remark throws a
 * `VFileMessage`, and the position the author actually needs is NOT in
 * `.message`: that property holds the bare reason, while the position lives in
 * `.place`, or is embedded in the reason's own text for the unclosed-tag
 * family, or survives only as the `line:column` string in `.name`. Sending
 * `.message` alone therefore drops the position entirely for most failures.
 *
 * Eagerly importable by design. It knows nothing about mdx and static-imports
 * nothing, so the entry can call it from its catch block without pulling the
 * lazy mdx chunk onto the launch graph (format/loader.ts owns that rule).
 */

export interface ParsePosition {
    /** 1-based, in the coordinates of the text the parser was given. */
    line: number;
    /** 1-based. */
    column: number;
}

export interface ParseFailure {
    /** Human-readable reason, with any position text removed. */
    reason: string;
    /** Where the parser stopped, when it said. */
    at?: ParsePosition;
}

type MaybePoint = { line?: unknown; column?: unknown };
type MaybePlace = MaybePoint & { start?: MaybePoint };

function toPosition(point: MaybePoint | undefined): ParsePosition | undefined {
    const line = point?.line;
    const column = point?.column;
    if (typeof line !== "number" || typeof column !== "number") {
        return undefined;
    }
    return { line, column };
}

/**
 * A trailing `(3:1-3:6)` or `(3:1)`: the unclosed-tag errors put their
 * position in the reason instead of in `place`, and it is the accurate one
 * there (`name` reports the start of the containing construct).
 */
const TRAILING_POSITION = /\s*\((\d+):(\d+)(?:-\d+:\d+)?\)\s*$/;

/** `name` on a VFileMessage: `line:column`, or `file:line:column`. */
const NAME_POSITION = /(?:^|:)(\d+):(\d+)$/;

/** Split a thrown parser error into the reason and the position it named. */
export function describeParseFailure(error: unknown): ParseFailure {
    const raw = error instanceof Error ? error.message : String(error);
    const place = (error as { place?: MaybePlace } | null)?.place;
    const fromPlace = toPosition(place?.start) ?? toPosition(place);
    if (fromPlace) {
        return { reason: raw, at: fromPlace };
    }

    const trailing = TRAILING_POSITION.exec(raw);
    if (trailing) {
        return {
            reason: raw.slice(0, trailing.index),
            at: { line: Number(trailing[1]), column: Number(trailing[2]) },
        };
    }

    const named = NAME_POSITION.exec(
        typeof (error as { name?: unknown } | null)?.name === "string"
            ? (error as { name: string }).name
            : "",
    );
    if (named) {
        return { reason: raw, at: { line: Number(named[1]), column: Number(named[2]) } };
    }
    return { reason: raw };
}
