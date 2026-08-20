/**
 * The find bar under `nativeFindBar` (shared/hostProfile.ts): the arrangement
 * that draws the platform's search field instead of VS Code's find widget.
 *
 * The claim this file has to hold is that it IS an arrangement — the same
 * controls, running the same code, in different holders. So every assertion
 * here is about WHERE something is, and the control set is asserted to be
 * unchanged against the same bar built without the declaration. A version of
 * these tests that only checked the native page would pass just as well if the
 * arrangement had quietly dropped a toggle, which is exactly the failure the
 * capability/arrangement distinction exists to prevent.
 *
 * Its own file rather than a block in findBar.test.ts, because the declaration
 * has to be in place BEFORE `initFindBar` runs (the arrangement is read at
 * build time, since it decides which holder each button is built into) and
 * that suite's `setup` is shared by ninety-odd cases that must keep seeing the
 * VS Code bar.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Schema, EditorState, type EditorView, type Transaction } from "../pm";
import { createEventManager } from "../eventManager";
import { initFindBar } from "../components/findBar";
import { closeTopmostLayer } from "../ui/escapeLayers";

const schema = new Schema({
    nodes: {
        doc: { content: "block+" },
        paragraph: { group: "block", content: "inline*" },
        text: { group: "inline" },
    },
});

type Declared = { __i18n?: { host?: { arrangements?: string[] } } };
const g = globalThis as Declared;

let disposeEvents: (() => void) | null = null;

/** Mount a find bar, with or without the arrangement declared. */
function mount(native: boolean): HTMLElement {
    document.body.innerHTML = "";
    if (native) {
        g.__i18n = { host: { arrangements: ["nativeFindBar"] } };
    } else {
        delete g.__i18n;
    }
    const editor = document.createElement("div");
    editor.id = "editor";
    document.body.appendChild(editor);

    const doc = schema.node("doc", null, [
        schema.node("paragraph", null, [schema.text("alpha beta alpha")]),
    ]);
    let state = EditorState.create({ schema, doc });
    const view = {
        get state() { return state; },
        dispatch: (tr: Transaction) => { state = state.apply(tr); },
        dom: document.createElement("div"),
        focus: () => { /* unused */ },
        domAtPos: () => { throw new Error("no DOM"); },
        nodeDOM: () => null,
        coordsAtPos: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    } as unknown as EditorView;

    const events = createEventManager();
    disposeEvents = () => events.dispose();
    initFindBar(() => view, () => "", events);
    return document.querySelector(".find-bar") as HTMLElement;
}

/** Every control on the bar, by the accessible name that identifies it. */
function controlNames(bar: HTMLElement): string[] {
    return [...bar.querySelectorAll<HTMLElement>("button, input")]
        .map((el) => el.getAttribute("aria-label") ?? "")
        .filter(Boolean)
        .sort();
}

const OPTIONS = ["Match Case", "Match Whole Word", "Use Regular Expression", "Find in Selection"];

describe("the find bar under nativeFindBar", () => {
    beforeEach(() => { while (closeTopmostLayer()) { /* drain */ } });
    afterEach(() => {
        disposeEvents?.();
        disposeEvents = null;
        delete g.__i18n;
        document.body.innerHTML = "";
    });

    it("an undeclared host should get the bar it has always had", () => {
        const bar = mount(false);
        expect(bar.classList.contains("find-bar--native")).toBe(false);
        expect(bar.querySelector(".find-bar__field")).toBeNull();
        expect(bar.querySelector(".find-bar__options")).toBeNull();
        // The four toggles sit in the find row itself, beside the field.
        for (const name of OPTIONS) {
            const btn = bar.querySelector(`button[aria-label="${name}"]`);
            expect(btn, name).toBeTruthy();
            expect(btn!.closest(".find-bar__options"), name).toBeNull();
        }
    });

    it("a declaring host should get the capsule field, with the input and count inside it", () => {
        const bar = mount(true);
        expect(bar.classList.contains("find-bar--native")).toBe(true);
        const field = bar.querySelector(".find-bar__field");
        expect(field).toBeTruthy();
        expect(field!.querySelector('input[aria-label="Find"]')).toBeTruthy();
        expect(field!.querySelector(".find-bar__count")).toBeTruthy();
        expect(field!.querySelector(".find-bar__glyph")).toBeTruthy();
    });

    // The magnifier is decoration. The input beside it already carries the
    // accessible name, and a second announcement is noise on the way to it.
    it("the magnifier should be hidden from assistive tech", () => {
        const bar = mount(true);
        expect(bar.querySelector(".find-bar__glyph")!.getAttribute("aria-hidden")).toBe("true");
    });

    it("the four options should move into the popover, and nothing else should", () => {
        const bar = mount(true);
        const menu = bar.querySelector(".find-bar__options");
        expect(menu).toBeTruthy();
        const inMenu = [...menu!.querySelectorAll("button")]
            .map((el) => el.getAttribute("aria-label"));
        expect(inMenu.sort()).toEqual([...OPTIONS].sort());
    });

    // THE claim that makes this an arrangement rather than a capability: no
    // search control is added or taken away, and only their holders differ.
    //
    // The native bar carries exactly one control the other does not, and it is
    // the ⋯ that opens the popover: a HOLDER, which exists only because the
    // options moved into one. Naming it as the single permitted difference is
    // what keeps this assertion sharp — a second addition, or any subtraction,
    // fails. Compared against the real undeclared bar rather than a list
    // written here, which a dropped control would not have joined either.
    it("the two surfaces should differ by the popover opener and nothing else", () => {
        const plain = controlNames(mount(false));
        disposeEvents?.();
        const native = controlNames(mount(true));
        expect(native).toEqual([...plain, "Search Options"].sort());
        // A floor, so the comparison is not two empty lists agreeing.
        expect(plain.length).toBeGreaterThanOrEqual(OPTIONS.length + 2);
    });

    it("Close should be a Done button rather than a square icon", () => {
        const bar = mount(true);
        const close = bar.querySelector('button[aria-label="Close"]') as HTMLButtonElement;
        expect(close.textContent).toBe("Done");
        // `ui-btn--icon`'s fixed square would clip the word.
        expect(close.classList.contains("ui-btn--icon")).toBe(false);
        expect(close.classList.contains("find-bar__done")).toBe(true);
    });

    it("Close should stay an icon button on the surface that did not declare it", () => {
        const bar = mount(false);
        const close = bar.querySelector('button[aria-label="Close"]') as HTMLButtonElement;
        expect(close.classList.contains("ui-btn--icon")).toBe(true);
        expect(close.querySelector("svg")).toBeTruthy();
    });

    describe("the options popover", () => {
        function parts(bar: HTMLElement) {
            return {
                button: bar.querySelector(".find-bar__options-btn") as HTMLButtonElement,
                menu: bar.querySelector(".find-bar__options") as HTMLElement,
            };
        }
        function press(target: HTMLElement): void {
            target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
            target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        }

        it("should start closed", () => {
            const { menu, button } = parts(mount(true));
            expect(menu.hidden).toBe(true);
            expect(button.getAttribute("aria-expanded")).toBe("false");
        });

        it("a press on the button should open it, and another should close it", () => {
            const { menu, button } = parts(mount(true));
            press(button);
            expect(menu.hidden).toBe(false);
            expect(button.getAttribute("aria-expanded")).toBe("true");
            press(button);
            expect(menu.hidden).toBe(true);
            expect(button.getAttribute("aria-expanded")).toBe("false");
        });

        it("a press outside should close it", () => {
            const bar = mount(true);
            const { menu, button } = parts(bar);
            press(button);
            expect(menu.hidden).toBe(false);
            press(document.getElementById("editor")!);
            expect(menu.hidden).toBe(true);
        });

        it("a press on a toggle inside should leave it open", () => {
            const bar = mount(true);
            const { menu, button } = parts(bar);
            press(button);
            press(bar.querySelector('button[aria-label="Match Case"]') as HTMLElement);
            expect(menu.hidden).toBe(false);
        });

        it("a toggle inside should still toggle", () => {
            const bar = mount(true);
            const { button } = parts(bar);
            press(button);
            const btnCase = bar.querySelector('button[aria-label="Match Case"]') as HTMLButtonElement;
            expect(btnCase.getAttribute("aria-pressed")).toBe("false");
            btnCase.click();
            expect(btnCase.getAttribute("aria-pressed")).toBe("true");
        });

        it("closing should leave no Escape layer behind", () => {
            const bar = mount(true);
            const { button } = parts(bar);
            press(button);
            press(document.getElementById("editor")!);
            // A leaked entry would swallow the next Escape the bar was owed.
            expect(closeTopmostLayer()).toBe(false);
        });
    });
});
