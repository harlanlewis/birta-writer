/**
 * webview/format/mdx/attributes.ts — the attribute structure of a JSX flow
 * element, carried beside its verbatim source, and the in-place splice that
 * edits one string attribute without touching any other byte (MAR-350).
 *
 * The structure is captured at parse time by `remarkMdxRawify` (index.ts),
 * the one place the structured `mdxJsxFlowElement` is in hand before it is
 * replaced by its raw slice. Every attribute keeps its source range RELATIVE
 * to the island's own start, so an edit is a splice into `value` at known
 * offsets and the offsets of everything after it shift by the size delta.
 * The mdast positions make this exact even for an island whose slice carries
 * container prefixes (`> ` inside a blockquote): the slice is a literal
 * substring of the file, and the attribute ranges are literal substrings of
 * the slice.
 *
 * The canonicalization trade, stated once here and enforced by
 * `spliceAttributeValue`: an edit rewrites ONLY the quoted literal of the one
 * attribute edited (from its opening quote to its closing quote). The
 * element name, every other attribute, the whitespace around `=`, the inner
 * content, and the closing tag are the file's bytes. The edited literal keeps
 * its original quote character; a new value containing that character spells
 * it as a character reference (`&quot;` or `&#39;`), and an `&` that would
 * otherwise start a character reference is spelled `&amp;`. Nothing else in
 * the value is encoded, so the value's other bytes are exactly what the user
 * typed. Boolean attributes (no value), expression values (`{expr}`) and
 * spread attributes (`{...rest}`) are carried for display and are never
 * rewritten: editing them means editing code, and the file's code is never
 * evaluated or regenerated here.
 *
 * There is no component registry. Slice 1 shipped none because a registry
 * with no entries is a speculative shape; the splice makes one unnecessary
 * for this layer, because rewriting one string literal in place is safe for
 * ANY element regardless of what the component does with the prop. A
 * registry earns its existence when a component wants a typed editor (an
 * enum, a color, a number), which is a later slice's evidence to bring.
 */

/** One attribute of a JSX flow element, as the file spells it. */
export interface JsxAttribute {
    /** Attribute name; `null` for a spread (`{...rest}`). */
    name: string | null;
    /**
     * `string`: a quoted literal (editable). `boolean`: a bare name, no
     * value. `expression`: `name={expr}`. `spread`: `{...expr}`.
     */
    kind: "string" | "boolean" | "expression" | "spread";
    /** The decoded literal for `string`; the source expression otherwise; `null` for `boolean`. */
    value: string | null;
    /** Source range of the whole attribute (`name="value"`), relative to the island's start. */
    start: number;
    end: number;
}

/** The parsed shape of one JSX flow element island. */
export interface JsxStructure {
    /** Component or tag name; `null` for a fragment (`<>`). */
    name: string | null;
    attributes: JsxAttribute[];
}

/** The parts of an mdast `mdxJsxFlowElement` this module reads. */
interface MdastPosition {
    start?: { offset?: number };
    end?: { offset?: number };
}
interface MdastJsxAttribute {
    type: string;
    name?: string;
    value?: string | null | { type: string; value: string };
    position?: MdastPosition;
}
interface MdastJsxElement {
    name?: string | null;
    attributes?: MdastJsxAttribute[];
    position?: MdastPosition;
}

/**
 * Read a `mdxJsxFlowElement`'s name and attributes into a JsxStructure with
 * island-relative offsets. Returns `null` when any attribute lacks a source
 * position (a positionless attribute cannot be spliced, so the whole island
 * stays inert rather than half-editable).
 */
export function extractJsxStructure(node: MdastJsxElement): JsxStructure | null {
    const islandStart = node.position?.start?.offset;
    if (typeof islandStart !== "number") {
        return null;
    }
    const attributes: JsxAttribute[] = [];
    for (const attr of node.attributes ?? []) {
        const start = attr.position?.start?.offset;
        const end = attr.position?.end?.offset;
        if (typeof start !== "number" || typeof end !== "number") {
            return null;
        }
        const range = { start: start - islandStart, end: end - islandStart };
        if (attr.type === "mdxJsxExpressionAttribute") {
            attributes.push({ name: null, kind: "spread", value: String(attr.value ?? ""), ...range });
            continue;
        }
        const name = attr.name ?? "";
        const value = attr.value;
        if (value == null) {
            attributes.push({ name, kind: "boolean", value: null, ...range });
        } else if (typeof value === "string") {
            attributes.push({ name, kind: "string", value, ...range });
        } else {
            attributes.push({ name, kind: "expression", value: String(value.value ?? ""), ...range });
        }
    }
    return { name: node.name ?? null, attributes };
}

/**
 * Spell `value` for the inside of a `quote`-delimited JSX string literal so
 * that the parser decodes it back to exactly `value`. Only the two things
 * that would change the parse are encoded: the quote character itself, and
 * an `&` that would otherwise read as a character reference (a bare `&` is
 * literal in JSX, and stays literal here).
 */
export function encodeAttributeValue(value: string, quote: '"' | "'"): string {
    const quoteRef = quote === '"' ? "&quot;" : "&#39;";
    return value
        .replace(/&(?=#[0-9]+;|#[xX][0-9a-fA-F]+;|[A-Za-z][A-Za-z0-9]*;)/g, "&amp;")
        .split(quote)
        .join(quoteRef);
}

/**
 * Rewrite one string attribute's literal inside `raw`, returning the new
 * island bytes and the structure re-offset to match. Returns `null` when the
 * attribute is not an editable string literal or its spelling in `raw` is
 * not the `name = "..."` shape the offsets promise (which would mean the
 * structure and the bytes have drifted; declining beats corrupting).
 */
export function spliceAttributeValue(
    raw: string,
    structure: JsxStructure,
    index: number,
    newValue: string,
): { value: string; jsx: JsxStructure } | null {
    const attr = structure.attributes[index];
    if (!attr || attr.kind !== "string") {
        return null;
    }
    const attrText = raw.slice(attr.start, attr.end);
    const eq = attrText.indexOf("=");
    if (eq < 0) {
        return null;
    }
    const open = attrText.slice(eq + 1).search(/["']/);
    if (open < 0) {
        return null;
    }
    const quoteAt = eq + 1 + open;
    const quote = attrText[quoteAt] as '"' | "'";
    if (attrText[attrText.length - 1] !== quote || attrText.length - 1 <= quoteAt) {
        return null;
    }
    const literal = quote + encodeAttributeValue(newValue, quote) + quote;
    const newAttrText = attrText.slice(0, quoteAt) + literal;
    const delta = newAttrText.length - attrText.length;
    const value = raw.slice(0, attr.start) + newAttrText + raw.slice(attr.end);
    const attributes = structure.attributes.map((a, i) => {
        if (i < index) {
            return a;
        }
        if (i === index) {
            return { ...a, value: newValue, end: a.end + delta };
        }
        return { ...a, start: a.start + delta, end: a.end + delta };
    });
    return { value, jsx: { name: structure.name, attributes } };
}

/**
 * Read a JsxStructure back from its JSON spelling (the `data-jsx` attribute
 * the block's toDOM writes, which is how a copied island keeps its form
 * through the clipboard). Anything malformed reads as "no structure": the
 * island then renders inert, never half-editable.
 */
export function parseJsxStructure(json: string | null | undefined): JsxStructure | null {
    if (!json) {
        return null;
    }
    try {
        const parsed = JSON.parse(json) as unknown;
        if (!isJsxStructure(parsed)) {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

function isJsxStructure(x: unknown): x is JsxStructure {
    if (typeof x !== "object" || x === null) {
        return false;
    }
    const s = x as Record<string, unknown>;
    if (s["name"] !== null && typeof s["name"] !== "string") {
        return false;
    }
    if (!Array.isArray(s["attributes"])) {
        return false;
    }
    return (s["attributes"] as unknown[]).every((a) => {
        if (typeof a !== "object" || a === null) {
            return false;
        }
        const r = a as Record<string, unknown>;
        return (
            (r["name"] === null || typeof r["name"] === "string") &&
            (r["kind"] === "string" || r["kind"] === "boolean" || r["kind"] === "expression" || r["kind"] === "spread") &&
            (r["value"] === null || typeof r["value"] === "string") &&
            typeof r["start"] === "number" &&
            typeof r["end"] === "number"
        );
    });
}
