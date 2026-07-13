/**
 * Width, in pixels from a task list item's left edge, of the checkbox column.
 * The checkbox is drawn in the item's left padding (see `li[data-item-type=
 * "task"]::before` in style.css); anything past this offset is the item's text.
 */
const CHECKBOX_COLUMN_WIDTH = 24;

/**
 * Decide whether a click on (or inside) a task list item should toggle its
 * checkbox.
 *
 * Only a click that lands on the checkbox itself toggles completion. Two kinds
 * of click must be treated as inert so they never mutate block content:
 *
 * - **The block handle / any gutter chrome.** The handle is a DOM descendant of
 *   the task `<li>` but renders out in the left margin, so a naive "is this
 *   inside the task item?" test would misclassify a handle click as a checkbox
 *   click and toggle the item. Clicking a block handle must only select the
 *   block, open the block menu, or start a drag — never change content.
 * - **A click in the item's text** (to the right of the checkbox column).
 *
 * This is a pure geometry/DOM decision so it can be unit-tested without a live
 * editor view; the caller performs the actual toggle.
 */
export function isTaskCheckboxClick(
    target: Element,
    taskItem: HTMLElement,
    clientX: number,
): boolean {
    // A click anywhere on the gutter (the block handle lives here) is never a
    // checkbox click, regardless of geometry.
    if (target.closest(".heading-fold-gutter")) {
        return false;
    }
    const rect = taskItem.getBoundingClientRect();
    const offsetX = clientX - rect.left;
    // Left of the item (offsetX < 0) is the gutter margin; right of the column
    // is the item's text. Only the column itself toggles.
    return offsetX >= 0 && offsetX <= CHECKBOX_COLUMN_WIDTH;
}
