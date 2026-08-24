/**
 * A minimal XML property-list reader, for guards that read `jot/Resources/Info.plist`.
 *
 * The existing plist guards match one flat `<key>` and the `<string>` after it
 * with a regex, which is right for a scalar at the top level and cannot reach
 * `CFBundleDocumentTypes`: an array of dictionaries, each holding another array.
 * A regex over nesting like that is a check whose failures are its own, so the
 * structure is parsed instead.
 *
 * Deliberately small. It reads the subset a bundle's Info.plist actually uses
 * (dict, array, string, integer, real, true, false) and throws on anything
 * else, rather than guessing. Throwing is what keeps a silent misread from
 * looking like a value that is simply absent.
 */

export type PlistValue = string | number | boolean | PlistValue[] | PlistDict;
export interface PlistDict {
    [key: string]: PlistValue;
}

const ENTITIES: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
};

function decode(text: string): string {
    return text.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, body: string) => {
        if (body.startsWith("#x") || body.startsWith("#X")) {
            return String.fromCodePoint(parseInt(body.slice(2), 16));
        }
        if (body.startsWith("#")) return String.fromCodePoint(parseInt(body.slice(1), 10));
        const named = ENTITIES[body];
        if (named === undefined) throw new Error(`unknown XML entity ${whole}`);
        return named;
    });
}

/** A cursor over the document, so the recursive reads share one position. */
class Cursor {
    constructor(
        private readonly xml: string,
        private at = 0,
    ) {}

    /** Whitespace, comments and the prolog are never values. */
    private skip(): void {
        for (;;) {
            const before = this.at;
            while (this.at < this.xml.length && /\s/.test(this.xml[this.at]!)) this.at++;
            for (const [open, close] of [
                ["<?", "?>"],
                ["<!--", "-->"],
                ["<!DOCTYPE", ">"],
            ] as const) {
                if (this.xml.startsWith(open, this.at)) {
                    const end = this.xml.indexOf(close, this.at);
                    if (end < 0) throw new Error(`unterminated ${open}`);
                    this.at = end + close.length;
                }
            }
            if (this.at === before) return;
        }
    }

    /** The next tag, consumed. */
    private tag(): { name: string; closing: boolean; empty: boolean } {
        this.skip();
        const match = /^<(\/?)([A-Za-z]+)[^>]*?(\/?)>/.exec(this.xml.slice(this.at));
        if (!match) throw new Error(`expected a tag at ${this.xml.slice(this.at, this.at + 40)}`);
        this.at += match[0].length;
        return { name: match[2]!, closing: match[1] === "/", empty: match[3] === "/" };
    }

    /** The next tag, NOT consumed. */
    private peek(): { name: string; closing: boolean } {
        const mark = this.at;
        const tag = this.tag();
        this.at = mark;
        return tag;
    }

    /** Text up to the matching close tag, which is consumed with it. */
    private text(name: string): string {
        const close = `</${name}>`;
        const end = this.xml.indexOf(close, this.at);
        if (end < 0) throw new Error(`unterminated <${name}>`);
        const body = this.xml.slice(this.at, end);
        this.at = end + close.length;
        return decode(body);
    }

    value(): PlistValue {
        const tag = this.tag();
        if (tag.closing) throw new Error(`unexpected </${tag.name}>`);
        if (tag.empty) {
            switch (tag.name) {
                case "true": return true;
                case "false": return false;
                case "string": return "";
                case "array": return [];
                case "dict": return {};
                default: throw new Error(`unsupported empty <${tag.name}/>`);
            }
        }
        switch (tag.name) {
            case "true":
            case "false": {
                this.text(tag.name);
                return tag.name === "true";
            }
            case "string":
            case "date":
            case "data":
                return this.text(tag.name);
            case "integer":
            case "real":
                return Number(this.text(tag.name));
            case "array": {
                const items: PlistValue[] = [];
                while (!this.peek().closing) items.push(this.value());
                this.tag();
                return items;
            }
            case "dict": {
                const dict: PlistDict = {};
                while (!this.peek().closing) {
                    const key = this.tag();
                    if (key.name !== "key") throw new Error(`expected <key>, saw <${key.name}>`);
                    dict[this.text("key")] = this.value();
                }
                this.tag();
                return dict;
            }
            default:
                throw new Error(`unsupported <${tag.name}>`);
        }
    }

    /** The document's single root value, inside `<plist>`. */
    root(): PlistValue {
        const plist = this.tag();
        if (plist.name !== "plist") throw new Error(`expected <plist>, saw <${plist.name}>`);
        return this.value();
    }
}

/** The root dictionary of an XML property list. */
export function parsePlist(xml: string): PlistDict {
    const root = new Cursor(xml).root();
    if (typeof root !== "object" || Array.isArray(root)) {
        throw new Error("the property list's root is not a dictionary");
    }
    return root;
}

/**
 * One value at a path, typed by the caller's expectation and throwing when it
 * is not there or not that shape.
 *
 * A guard that reads a missing key as `undefined` and compares it to another
 * missing key passes, which is the failure mode this exists to remove.
 */
export function plistArray(dict: PlistDict, key: string): PlistValue[] {
    const value = dict[key];
    if (!Array.isArray(value)) throw new Error(`${key} is not an array`);
    return value;
}

export function plistDicts(dict: PlistDict, key: string): PlistDict[] {
    return plistArray(dict, key).map((item, index) => {
        if (typeof item !== "object" || Array.isArray(item)) {
            throw new Error(`${key}[${index}] is not a dictionary`);
        }
        return item;
    });
}

export function plistStrings(dict: PlistDict, key: string): string[] {
    return plistArray(dict, key).map((item, index) => {
        if (typeof item !== "string") throw new Error(`${key}[${index}] is not a string`);
        return item;
    });
}
