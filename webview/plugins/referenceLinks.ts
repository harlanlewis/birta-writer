/**
 * Reference-style links, preserved instead of inlined.
 *
 * Stock Milkdown bundles `remark-inline-links`, which rewrites every
 * `[text][ref]` into an inline link and DELETES the `[ref]: url` definition
 * before the document ever reaches ProseMirror — so definitions silently
 * vanished from the editor and only the minimal-diff protection layer kept
 * them on disk. With that remark transform filtered out (see
 * `pureCommonmark` in ../serialization.ts), the three reference constructs
 * reach the transformer and are modeled here so they are visible in the
 * editor and serialize back to their original reference form:
 *
 * - `link_definition` (block, atom): `[label]: url "title"` — rendered as a
 *   dimmed read-only line, deletable as a block.
 * - `link_ref` (mark): `[text][ref]` / `[text][]` / `[text]` — text stays
 *   editable; the reference form (full/collapsed/shortcut) round-trips.
 * - `image_ref` (inline, atom): `![alt][ref]` — rendered as an inline chip.
 */
import type { Node as ProseNode } from "@milkdown/prose/model";
import { $markSchema, $nodeSchema } from "@milkdown/utils";

/** `[label]: url "title"` — a link reference definition block. */
export const linkDefinitionSchema = $nodeSchema("link_definition", () => ({
    group: "block",
    atom: true,
    selectable: true,
    marks: "",
    attrs: {
        identifier: { default: "" },
        label: { default: "" },
        url: { default: "" },
        title: { default: null },
    },
    parseDOM: [
        {
            tag: 'div[data-type="link-definition"]',
            getAttrs: (dom) => {
                const el = dom as HTMLElement;
                return {
                    identifier: el.dataset["identifier"] ?? "",
                    label: el.dataset["label"] ?? "",
                    url: el.dataset["url"] ?? "",
                    title: el.dataset["title"] ?? null,
                };
            },
        },
    ],
    toDOM: (node: ProseNode) => {
        const { identifier, label, url, title } = node.attrs;
        const text = `[${label || identifier}]: ${url}` + (title ? ` "${title}"` : "");
        return [
            "div",
            {
                "data-type": "link-definition",
                "data-identifier": identifier,
                "data-label": label,
                "data-url": url,
                ...(title ? { "data-title": title } : {}),
                class: "link-definition",
                contenteditable: "false",
            },
            text,
        ];
    },
    parseMarkdown: {
        match: ({ type }) => type === "definition",
        runner: (state, node, type) => {
            state.addNode(type, {
                identifier: (node["identifier"] as string) ?? "",
                label: (node["label"] as string) ?? (node["identifier"] as string) ?? "",
                url: (node["url"] as string) ?? "",
                title: (node["title"] as string | null) ?? null,
            });
        },
    },
    toMarkdown: {
        match: (node) => node.type.name === "link_definition",
        runner: (state, node) => {
            state.addNode("definition", undefined, undefined, {
                identifier: node.attrs["identifier"],
                label: node.attrs["label"],
                url: node.attrs["url"],
                title: node.attrs["title"],
            });
        },
    },
}));

/** `[text][ref]` — a link that points at a definition by identifier. */
export const linkRefSchema = $markSchema("link_ref", () => ({
    attrs: {
        identifier: { default: "" },
        label: { default: "" },
        /** mdast referenceType: "full" | "collapsed" | "shortcut". */
        referenceType: { default: "full" },
    },
    parseDOM: [
        {
            tag: 'a[data-type="link-ref"]',
            getAttrs: (dom) => {
                const el = dom as HTMLElement;
                return {
                    identifier: el.dataset["identifier"] ?? "",
                    label: el.dataset["label"] ?? "",
                    referenceType: el.dataset["referenceType"] ?? "full",
                };
            },
        },
    ],
    toDOM: (mark) => [
        "a",
        {
            "data-type": "link-ref",
            "data-identifier": mark.attrs["identifier"],
            "data-label": mark.attrs["label"],
            "data-reference-type": mark.attrs["referenceType"],
            class: "link-ref",
        },
    ],
    parseMarkdown: {
        match: (node) => node.type === "linkReference",
        runner: (state, node, markType) => {
            state.openMark(markType, {
                identifier: (node["identifier"] as string) ?? "",
                label: (node["label"] as string) ?? (node["identifier"] as string) ?? "",
                referenceType: (node["referenceType"] as string) ?? "full",
            });
            state.next(node.children as never);
            state.closeMark(markType);
        },
    },
    toMarkdown: {
        match: (mark) => mark.type.name === "link_ref",
        runner: (state, mark) => {
            state.withMark(mark, "linkReference", undefined, {
                identifier: mark.attrs["identifier"],
                label: mark.attrs["label"],
                referenceType: mark.attrs["referenceType"],
            });
        },
    },
}));

/** `![alt][ref]` — an image reference, rendered as an inline chip. */
export const imageRefSchema = $nodeSchema("image_ref", () => ({
    inline: true,
    group: "inline",
    atom: true,
    selectable: true,
    marks: "",
    attrs: {
        identifier: { default: "" },
        label: { default: "" },
        referenceType: { default: "full" },
        alt: { default: "" },
    },
    parseDOM: [
        {
            tag: 'span[data-type="image-ref"]',
            getAttrs: (dom) => {
                const el = dom as HTMLElement;
                return {
                    identifier: el.dataset["identifier"] ?? "",
                    label: el.dataset["label"] ?? "",
                    referenceType: el.dataset["referenceType"] ?? "full",
                    alt: el.dataset["alt"] ?? "",
                };
            },
        },
    ],
    toDOM: (node: ProseNode) => {
        const { identifier, label, alt } = node.attrs;
        return [
            "span",
            {
                "data-type": "image-ref",
                "data-identifier": identifier,
                "data-label": label,
                "data-reference-type": node.attrs["referenceType"],
                "data-alt": alt,
                class: "image-ref",
                contenteditable: "false",
            },
            `![${alt}][${label || identifier}]`,
        ];
    },
    parseMarkdown: {
        match: ({ type }) => type === "imageReference",
        runner: (state, node, type) => {
            state.addNode(type, {
                identifier: (node["identifier"] as string) ?? "",
                label: (node["label"] as string) ?? (node["identifier"] as string) ?? "",
                referenceType: (node["referenceType"] as string) ?? "full",
                alt: (node["alt"] as string) ?? "",
            });
        },
    },
    toMarkdown: {
        match: (node) => node.type.name === "image_ref",
        runner: (state, node) => {
            state.addNode("imageReference", undefined, undefined, {
                identifier: node.attrs["identifier"],
                label: node.attrs["label"],
                referenceType: node.attrs["referenceType"],
                alt: node.attrs["alt"],
            });
        },
    },
}));

/** All reference-link plugins, flattened for `Editor.use()`. */
export const referenceLinksPlugin = [
    ...linkDefinitionSchema,
    ...linkRefSchema,
    ...imageRefSchema,
].flat();
