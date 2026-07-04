/**
 * inputUndo tests: local undo/redo stack for overlay text inputs.
 *
 * VS Code's Electron layer intercepts Cmd+Z / Ctrl+Z before native inputs
 * see it, so attachInputUndo maintains its own history per input. Typing is
 * simulated by setting value + selection and dispatching an `input` event;
 * time between edits is controlled with fake timers because bursts within
 * 300ms are coalesced into one undo step.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { attachInputUndo } from "../utils/inputUndo";

const BURST_GAP_MS = 400; // safely beyond the 300ms coalescing window

function createInput(initialValue = ""): HTMLInputElement {
    const input = document.createElement("input");
    input.type = "text";
    input.value = initialValue;
    document.body.appendChild(input);
    return input;
}

/** Simulate the user typing: set value + caret, then fire an input event. */
function typeValue(input: HTMLInputElement, value: string, caret = value.length): void {
    input.value = value;
    input.setSelectionRange(caret, caret);
    input.dispatchEvent(new Event("input", { bubbles: true }));
}

function pressKey(
    input: HTMLInputElement,
    key: string,
    mods: { meta?: boolean; ctrl?: boolean; shift?: boolean } = {},
): KeyboardEvent {
    const event = new KeyboardEvent("keydown", {
        key,
        metaKey: mods.meta ?? false,
        ctrlKey: mods.ctrl ?? false,
        shiftKey: mods.shift ?? false,
        bubbles: true,
        cancelable: true,
    });
    input.dispatchEvent(event);
    return event;
}

describe("attachInputUndo", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Explicit start time: keeps the very first edit outside the
        // coalescing window regardless of the fake clock's default origin
        vi.useFakeTimers({ now: 1_000_000 });
        document.body.innerHTML = "";
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe("undo", () => {
        it("typing then Meta-Z should restore the previous value and selection", () => {
            // Arrange
            const input = createInput();
            attachInputUndo(input);
            typeValue(input, "ab");
            vi.advanceTimersByTime(BURST_GAP_MS);
            typeValue(input, "abc");

            // Act
            pressKey(input, "z", { meta: true });

            // Assert
            expect(input.value).toBe("ab");
            expect(input.selectionStart).toBe(2);
            expect(input.selectionEnd).toBe(2);
        });

        it("Ctrl-Z should undo like Meta-Z (either modifier is accepted)", () => {
            // Arrange
            const input = createInput();
            attachInputUndo(input);
            typeValue(input, "hello");

            // Act
            pressKey(input, "z", { ctrl: true });

            // Assert
            expect(input.value).toBe("");
        });

        it("repeated undo should walk back through distinct edits", () => {
            // Arrange
            const input = createInput();
            attachInputUndo(input);
            typeValue(input, "a");
            vi.advanceTimersByTime(BURST_GAP_MS);
            typeValue(input, "ab");
            vi.advanceTimersByTime(BURST_GAP_MS);
            typeValue(input, "abc");

            // Act
            pressKey(input, "z", { meta: true });
            pressKey(input, "z", { meta: true });

            // Assert
            expect(input.value).toBe("a");
        });

        it("undo with an empty history should leave the value unchanged", () => {
            // Arrange
            const input = createInput("stable");
            attachInputUndo(input);

            // Act
            pressKey(input, "z", { meta: true });

            // Assert
            expect(input.value).toBe("stable");
        });
    });

    describe("redo", () => {
        it("undo then Meta-Shift-Z should re-apply the undone value and selection", () => {
            // Arrange
            const input = createInput();
            attachInputUndo(input);
            typeValue(input, "ab");
            vi.advanceTimersByTime(BURST_GAP_MS);
            typeValue(input, "abc");
            pressKey(input, "z", { meta: true });

            // Act
            pressKey(input, "z", { meta: true, shift: true });

            // Assert
            expect(input.value).toBe("abc");
            expect(input.selectionStart).toBe(3);
            expect(input.selectionEnd).toBe(3);
        });

        it("undo then Ctrl-Y should redo", () => {
            // Arrange
            const input = createInput();
            attachInputUndo(input);
            typeValue(input, "hello");
            pressKey(input, "z", { ctrl: true });

            // Act
            pressKey(input, "y", { ctrl: true });

            // Assert
            expect(input.value).toBe("hello");
        });

        it("typing after an undo should clear the redo stack", () => {
            // Arrange
            const input = createInput();
            attachInputUndo(input);
            typeValue(input, "abc");
            pressKey(input, "z", { meta: true });
            vi.advanceTimersByTime(BURST_GAP_MS);
            typeValue(input, "xyz");

            // Act
            pressKey(input, "z", { meta: true, shift: true });

            // Assert: redo has nothing to re-apply
            expect(input.value).toBe("xyz");
        });
    });

    describe("event behavior", () => {
        it("undo should dispatch a synthetic bubbling input event", () => {
            // Arrange
            const input = createInput();
            attachInputUndo(input);
            typeValue(input, "abc");
            const onInput = vi.fn();
            input.addEventListener("input", onInput);

            // Act
            pressKey(input, "z", { meta: true });

            // Assert
            expect(onInput).toHaveBeenCalledTimes(1);
            expect(onInput.mock.calls[0][0].bubbles).toBe(true);
        });

        it("undo keydown should be preventDefault-ed and stopPropagation-ed", () => {
            // Arrange
            const input = createInput();
            attachInputUndo(input);
            typeValue(input, "abc");
            const onDocumentKeydown = vi.fn();
            document.addEventListener("keydown", onDocumentKeydown);

            // Act
            const event = pressKey(input, "z", { meta: true });

            // Assert: swallowed even from VS Code / editor listeners upstream
            expect(event.defaultPrevented).toBe(true);
            expect(onDocumentKeydown).not.toHaveBeenCalled();
            document.removeEventListener("keydown", onDocumentKeydown);
        });

        it("a plain keydown without the undo modifier should not be intercepted", () => {
            // Arrange
            const input = createInput();
            attachInputUndo(input);

            // Act
            const event = pressKey(input, "z");

            // Assert
            expect(event.defaultPrevented).toBe(false);
        });
    });

    describe("coalescing", () => {
        it("a rapid typing burst should undo as a single step", () => {
            // Arrange: three input events with no time between them
            const input = createInput();
            attachInputUndo(input);
            typeValue(input, "a");
            typeValue(input, "ab");
            typeValue(input, "abc");

            // Act
            pressKey(input, "z", { meta: true });

            // Assert: the whole burst is undone at once
            expect(input.value).toBe("");
        });

        it("history should be capped at 100 entries", () => {
            // Arrange: 105 separate edits (each outside the coalescing window)
            const input = createInput();
            attachInputUndo(input);
            for (let i = 1; i <= 105; i++) {
                vi.advanceTimersByTime(BURST_GAP_MS);
                typeValue(input, "x".repeat(i));
            }

            // Act: undo more times than the cap
            for (let i = 0; i < 150; i++) {
                pressKey(input, "z", { meta: true });
            }

            // Assert: the 5 oldest states (lengths 0-4) were dropped
            expect(input.value).toBe("x".repeat(5));
        });
    });

    describe("programmatic changes", () => {
        it("a programmatic value change then undo should not restore stale content", () => {
            // Arrange: overlay reuse pattern — value replaced without input events
            const input = createInput();
            attachInputUndo(input);
            typeValue(input, "old link text");
            input.value = "new link text";
            input.dispatchEvent(new FocusEvent("focus"));

            // Act
            pressKey(input, "z", { meta: true });

            // Assert: history from the previous content was discarded
            expect(input.value).toBe("new link text");
        });

        it("typing after a programmatic value change while focused should undo to the programmatic value", () => {
            // Arrange: value replaced while focused (no focus/input events),
            // then the user keeps typing. The keydown resync must run BEFORE
            // the edit lands, otherwise the stale pre-change snapshot gets
            // pushed and undo restores "hello" instead of "world".
            const input = createInput();
            attachInputUndo(input);
            typeValue(input, "hello");
            input.value = "world";
            vi.advanceTimersByTime(BURST_GAP_MS);

            // Act: real typing fires keydown first (value still "world"),
            // then the input event with the edited value
            pressKey(input, "s");
            typeValue(input, "worlds");
            pressKey(input, "z", { meta: true });

            // Assert
            expect(input.value).toBe("world");
        });

        it("undo right after a programmatic change plus typing should never resurrect pre-change history", () => {
            // Arrange
            const input = createInput();
            attachInputUndo(input);
            typeValue(input, "hello");
            input.value = "world";
            vi.advanceTimersByTime(BURST_GAP_MS);
            pressKey(input, "s");
            typeValue(input, "worlds");

            // Act: undo twice — past the programmatic baseline
            pressKey(input, "z", { meta: true });
            pressKey(input, "z", { meta: true });

            // Assert: pre-change history ("hello", "") was dropped
            expect(input.value).toBe("world");
        });
    });

    describe("double attach", () => {
        it("attaching twice should return the same detach and keep undo working", () => {
            // Arrange
            const input = createInput();
            const detach1 = attachInputUndo(input);
            const detach2 = attachInputUndo(input);
            typeValue(input, "abc");

            // Act
            pressKey(input, "z", { meta: true });

            // Assert: a single instance handled the chord (two stacked
            // instances would fight over restores and synthetic events)
            expect(detach2).toBe(detach1);
            expect(input.value).toBe("");

            // Redo still works through the same single history
            pressKey(input, "z", { meta: true, shift: true });
            expect(input.value).toBe("abc");
        });

        it("detaching once after a double attach should fully remove handling", () => {
            // Arrange
            const input = createInput();
            const detach = attachInputUndo(input);
            attachInputUndo(input);
            typeValue(input, "abc");

            // Act
            detach();
            const event = pressKey(input, "z", { meta: true });

            // Assert
            expect(input.value).toBe("abc");
            expect(event.defaultPrevented).toBe(false);
        });
    });

    describe("detach", () => {
        it("after detach Meta-Z should no longer be handled", () => {
            // Arrange
            const input = createInput();
            const detach = attachInputUndo(input);
            typeValue(input, "abc");

            // Act
            detach();
            const event = pressKey(input, "z", { meta: true });

            // Assert
            expect(input.value).toBe("abc");
            expect(event.defaultPrevented).toBe(false);
        });

        it("after detach input events should not be recorded", () => {
            // Arrange
            const input = createInput();
            const detach = attachInputUndo(input);
            typeValue(input, "abc");
            detach();
            vi.advanceTimersByTime(BURST_GAP_MS);
            typeValue(input, "abcdef");

            // Act: re-attach and undo — the post-detach edit was never recorded
            attachInputUndo(input);
            pressKey(input, "z", { meta: true });

            // Assert: nothing to undo on the fresh attachment
            expect(input.value).toBe("abcdef");
        });
    });
});
