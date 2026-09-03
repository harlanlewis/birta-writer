/**
 * ui/interactionShield.ts — THE transparent layer a pointer gesture puts over
 * the page while it owns the pointer: a block drag, a marquee.
 *
 * A gesture in flight wants three things from the page under the pointer: the
 * gesture's cursor everywhere, no hover chrome popping under the crossing
 * pointer, and no native text selection painting alongside it. Each of those
 * is one CSS property, and all three are INHERITED properties: `cursor`,
 * `pointer-events`, `user-select`. Written on the body or on the editor root,
 * an inherited property changing means every descendant's computed style
 * changes, so the class flip that started the gesture restyled the whole
 * document, and did it again when the gesture ended. On a long document that
 * recalc was most of what made picking a block up stall, and it was invisible
 * to every count gate because it is the browser's work rather than the
 * bundle's (bodyClassRestyle.test.ts holds the rules out of the stylesheets).
 *
 * A fixed, transparent element covering the viewport carries the three
 * properties itself, for a block drag, a marquee, and the outline panel's
 * resize drag alike. Hit testing lands on it, so the cursor is its cursor,
 * hover never reaches the content, and a selection cannot be extended into
 * it; the page's own styles do not change at all. The gesture's listeners
 * sit on `document` and read coordinates, so they see the same events they
 * always did. What the shield does NOT do is stop `posAtCoords`: ProseMirror
 * falls back to its own rect walk when the hit element is outside the editor,
 * which is also what it did while the editor was `pointer-events: none`.
 *
 * One node, reused (the ui/toast.ts convention), mounted on first use.
 */

export type ShieldMode = "drag" | "marquee" | "resize";

export interface ShieldOptions {
    /** The cursor for a mode whose spelling is decided by the caller (a resize). */
    cursor?: string;
    /**
     * Viewport rectangles the shield leaves OPEN, so the pointer still reaches
     * what is under them: a drop zone whose rows must take the release (an
     * in-place micro-drag on an outline row is a click the row must still
     * get, and the row is what the browser's click targets after the
     * release). Cut with an even-odd clip path, which hit testing honours in
     * both engines; the chrome inside a hole keeps its own cursor and hover,
     * and styles them under the gesture's body class with narrow rules.
     */
    holes?: readonly DOMRectReadOnly[];
}

let shield: HTMLElement | null = null;
// The clip path last WRITTEN. Compared against instead of the element's own
// style, whose read-back re-serializes lengths (`0` comes back `0px`) and so
// never equals the string that was written.
let writtenClipPath = "";

/** The even-odd polygon that is the viewport minus `holes`, or none. */
function clipPathFor(holes: readonly DOMRectReadOnly[]): string {
    const cut = holes.filter((r) => r.width > 0 && r.height > 0);
    if (cut.length === 0) return "";
    const px = (n: number): string => `${Math.round(n)}px`;
    const outer = "0 0, 100% 0, 100% 100%, 0 100%, 0 0";
    const inner = cut.map((r) =>
        `${px(r.left)} ${px(r.top)}, ${px(r.right)} ${px(r.top)}, ${px(r.right)} ${px(r.bottom)}, ${px(r.left)} ${px(r.bottom)}, ${px(r.left)} ${px(r.top)}`,
    );
    return `polygon(evenodd, ${[outer, ...inner].join(", ")})`;
}

/**
 * Put the shield up for `mode`; a second call changes the mode. A resize
 * names its own cursor, because the arrow's spelling is the platform's
 * (`col-resize` on macOS, `ew-resize` elsewhere) and is decided where the
 * handle is built; the other modes take theirs from the stylesheet.
 */
export function showInteractionShield(mode: ShieldMode, options: ShieldOptions = {}): void {
    if (!shield || !shield.isConnected) {
        shield = document.createElement("div");
        shield.className = "interaction-shield";
        shield.setAttribute("aria-hidden", "true");
        document.body.appendChild(shield);
    }
    shield.classList.toggle("interaction-shield--drag", mode === "drag");
    shield.classList.toggle("interaction-shield--marquee", mode === "marquee");
    shield.classList.toggle("interaction-shield--resize", mode === "resize");
    shield.style.cursor = options.cursor ?? "";
    writtenClipPath = clipPathFor(options.holes ?? []);
    shield.style.clipPath = writtenClipPath;
    shield.hidden = false;
}

/**
 * Move the holes of a shield already up, when a zone appears or moves
 * mid-gesture (the outline flying out under a hovered tab). Writes the clip
 * path only when it changed, so a pointer move that changed nothing costs no
 * style write.
 */
export function setInteractionShieldHoles(holes: readonly DOMRectReadOnly[]): void {
    if (!shield || shield.hidden) return;
    const next = clipPathFor(holes);
    if (next === writtenClipPath) return;
    writtenClipPath = next;
    shield.style.clipPath = next;
}

/** The clip path a shield with `holes` carries. Exported for tests. */
export function interactionShieldClipPath(holes: readonly DOMRectReadOnly[]): string {
    return clipPathFor(holes);
}

/** Take the shield down. Safe to call when none is up. */
export function hideInteractionShield(): void {
    if (shield) shield.hidden = true;
}

/** Whether a shield is up right now. Exported for tests. */
export function interactionShieldShown(): boolean {
    return !!shield && shield.isConnected && !shield.hidden;
}
