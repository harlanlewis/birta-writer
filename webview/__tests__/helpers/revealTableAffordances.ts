/**
 * A table's overlay affordances — the row/column grips and the insert bars —
 * are not built at mount (components/table/tableView.ts, MAR-317), so a test
 * that reaches for `.mw-grip` straight after building the NodeView finds
 * nothing, exactly as a reader who has never moved the pointer over the table
 * would.
 *
 * Drive the production trigger rather than reaching past it: `pointermove`
 * over the wrapper is what the pointer arriving over the table actually
 * fires, and it is the same event the `.mw-near` reveal already keys off.
 *
 * The OTHER build trigger — a CellSelection arriving with no pointer at all,
 * which Shift+arrow produces — deliberately has no helper. It is reached by
 * dispatching the selection and nothing else, and a test that wants to prove
 * the keyboard path works must not touch this function.
 */
export function revealTableAffordances(
    wrapper: HTMLElement,
    coords: { clientX: number; clientY: number } = { clientX: 0, clientY: 0 },
): void {
    // MouseEvent, not PointerEvent: the handler reads only clientX/clientY,
    // and jsdom's PointerEvent support has been uneven across versions.
    wrapper.dispatchEvent(
        new MouseEvent("pointermove", { bubbles: true, ...coords }),
    );
}
