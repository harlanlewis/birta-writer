/**
 * webview/plugins/reparseHazard.ts (MAR-120, refuse lane)
 *
 * The save-survival check for block moves: would this document, serialized
 * and reparsed — a save followed by a reopen — still hold the same content?
 *
 * Two container-fence reparse hazards motivated it, both verified to corrupt
 * (F destroys bytes on disk one save cycle later; B permanently flattens a
 * directive on the second cycle):
 *
 *   (B) fence re-pairing — a closed directive/aside moved below raw
 *       unclosed `:::` prose (or an unpaired `<aside>` html atom) lets that
 *       stray opener pair with the moved node's close fence on reparse,
 *       swallowing everything between them;
 *   (F) aside nesting — a notion_callout moved inside another aside or a
 *       directive is outside Notion's own grammar: CommonMark HTML-block
 *       parsing ends the outer `<aside>` at the blank line before the inner
 *       one, and the pairing breaks.
 *
 * Fixing these needs parser-level fence-scope work; refusing the move is the
 * chosen lane (maintainer decision 2026-07-15, see MAR-120): the gesture
 * becomes a quiet no-op with a notice, exactly like a content-guard veto.
 *
 * The check OBSERVES rather than predicts: it does not enumerate hazard
 * mechanics, it serializes the post-move document with the real (fidelity)
 * serializer, reparses with the real parser, and fingerprint-compares — the
 * same oracle the corpus gate asserts (`reparseDelta`). Enumerating hazard
 * shapes was tried and under-fired on its first adversarial review (an
 * aside-degradation reassembly and a lazy-continuation flatten both slipped
 * a B/F-specific gate), so the structural gate is deliberately COARSE: any
 * fence/aside machinery in the document at all buys the round-trip. What
 * keeps that affordable is that the oracle is memoized per doc node
 * (ProseMirror docs are immutable), so the pre-move document — the same node
 * across consecutive gestures — is re-judged for free.
 *
 * A gesture is refused only when it CHANGES the round-trip damage: a
 * document that is already broken (dirty before the move, identically dirty
 * after) is never refused — the move didn't cause the damage, and vetoing
 * every gesture in such a document would trap the user rather than protect
 * them. Comparing the damage itself (not just its presence) closes the
 * doc-global hole where one stray hand-typed `:::` line would otherwise
 * disarm refusals for unrelated corruption elsewhere.
 */
import { Plugin, PluginKey, type EditorState } from "@milkdown/prose/state";
import type { Node as ProseNode, Schema } from "@milkdown/prose/model";
import { parserCtx, serializerCtx } from "@milkdown/core";
import { $prose } from "@milkdown/utils";
import { diffFingerprints, fingerprintDoc, formatFingerprintDiff } from "./contentGuard";

// ── The pipeline registry ───────────────────────────────────────────────────

interface ReparsePipeline {
    serialize(doc: ProseNode): string;
    parse(markdown: string): ProseNode | null;
}

/**
 * Serializer/parser access per editor, keyed by its (per-instance) Schema so
 * both a view holder (moveBlocks) and a filterTransaction (contentGuard) can
 * resolve it. Registered by `reparseHazardPlugin`, which rides
 * `pureCommonmark` — the one preset every editor-construction site
 * (production and test factories) loads, so no editor can silently lack it
 * (the MAR-143 bundling argument). ctx reads are lazy: serializerCtx /
 * parserCtx are only populated after editor creation, long before the first
 * gesture.
 */
const pipelines = new WeakMap<Schema, ReparsePipeline>();

const reparseHazardKey = new PluginKey("reparse-hazard-registry");

export const reparseHazardPlugin = $prose(
    (ctx) =>
        new Plugin({
            key: reparseHazardKey,
            state: {
                init(_config, state: EditorState) {
                    pipelines.set(state.schema, {
                        serialize: (doc) => ctx.get(serializerCtx)(doc),
                        parse: (markdown) => {
                            const parsed = ctx.get(parserCtx)(markdown);
                            return typeof parsed === "string" ? null : (parsed as ProseNode);
                        },
                    });
                    return null;
                },
                apply: (_tr, value) => value,
            },
        }),
);

// ── The structural gate ─────────────────────────────────────────────────────

/**
 * Does `doc` contain any fence/aside machinery at all — a container
 * directive, a Notion aside, an `<aside`-bearing html atom (the parser's
 * degradation output for aside shapes it kept as raw bytes), or raw
 * fence-shaped prose (`:::…` that parsed as a paragraph = an unpaired fence
 * line)? Only such documents can have order/pairing-sensitive reparses, so
 * only they buy the round-trip. Code blocks are excluded from the prose
 * check: fence bytes inside them are fenced content and can never pair.
 *
 * Deliberately coarse — see the module header. Over-firing costs one
 * (memoized) serialize+parse on a gesture, never a false refusal.
 */
function fenceMachineryPresent(doc: ProseNode): boolean {
    let present = false;
    doc.descendants((node: ProseNode) => {
        if (present) {
            return false;
        }
        const name = node.type.name;
        if (name === "container_directive" || name === "notion_callout") {
            present = true;
            return false;
        }
        if (name === "html" && String(node.attrs["value"] ?? "").includes("<aside")) {
            present = true;
            return false;
        }
        if (node.isTextblock && !node.type.spec.code && node.textContent.startsWith(":::")) {
            present = true;
            return false;
        }
        return true;
    });
    return present;
}

// ── The check ───────────────────────────────────────────────────────────────

/**
 * Round-trip damage per doc node: null for a clean round-trip, otherwise a
 * stable description (the formatted fingerprint delta — a position-
 * independent multiset, so two docs holding the SAME damage in different
 * places compare equal — or a thrown/empty-reparse sentinel). ProseMirror
 * docs are immutable, so the verdict is cached per node: the pre-move doc
 * repeats across consecutive gestures and is re-judged for free.
 */
const damageCache = new WeakMap<ProseNode, string | null>();

function roundTripDamage(pipeline: ReparsePipeline, doc: ProseNode): string | null {
    if (damageCache.has(doc)) {
        return damageCache.get(doc) ?? null;
    }
    let damage: string | null;
    let reparsed: ProseNode | null;
    try {
        reparsed = pipeline.parse(pipeline.serialize(doc));
    } catch {
        reparsed = null;
    }
    if (!reparsed) {
        // The hardest failure: F's nested aside can make the parser throw
        // outright.
        damage = "reparse threw or produced no document";
    } else {
        const delta = diffFingerprints(fingerprintDoc(doc), fingerprintDoc(reparsed));
        damage =
            delta.lost.size === 0 && delta.gained.size === 0
                ? null
                : formatFingerprintDiff(delta);
    }
    damageCache.set(doc, damage);
    return damage;
}

/**
 * Should this move/drop be refused because it CHANGES the document's
 * round-trip damage? Returns the violation for the caller to report, or
 * null to allow.
 *
 * `preDoc` is the document before the gesture, `postDoc` the transaction's
 * result. Cost: zero unless the post-move document carries fence/aside
 * machinery; one memoized round-trip per distinct doc when it does.
 */
export function reparseRefusal(preDoc: ProseNode, postDoc: ProseNode): string | null {
    if (!fenceMachineryPresent(postDoc)) {
        return null;
    }
    const pipeline = pipelines.get(postDoc.type.schema);
    if (!pipeline) {
        // Every construction site loads pureCommonmark, so this is a wiring
        // bug, not a runtime condition — say so rather than silently waving
        // hazardous moves through.
        console.warn("[reparseHazard] no pipeline registered for this editor — check skipped");
        return null;
    }
    const postDamage = roundTripDamage(pipeline, postDoc);
    if (postDamage === null) {
        return null;
    }
    // Identical damage before and after: the gesture didn't cause it —
    // allow, or every move in an already-broken document would be trapped.
    // Damage that GREW or CHANGED is the gesture's, however broken the
    // document already was elsewhere.
    if (roundTripDamage(pipeline, preDoc) === postDamage) {
        return null;
    }
    return `document would not survive save+reopen: ${postDamage}`;
}
