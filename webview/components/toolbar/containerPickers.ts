/**
 * The block-family dropdowns: Format (the text hierarchy), and the three
 * container pickers Lists, Code and Quote.
 *
 * Each is one trigger over one row per member of the family, and each answers
 * the same question the caret asks - which member am I in. That is why they
 * live together and why each hands the bar a `setActive` rather than exposing
 * its rows: the bar derives one active state and tells each picker about it,
 * and no caller reaches into a picker's DOM.
 *
 * The three container rows are TOGGLES rather than a select-one, because the
 * caret is usually in no such container at all. That is why the active row is
 * filled with the accent rather than checkmarked: a checkmark column would sit
 * empty in the common case and, next to the row icons, read as a broken
 * two-column layout. Format is a true select-one, so its rows use the fill
 * idiom for the same reason the segmented width control does.
 */
import { runEditorCommand, type GetEditor } from "@/editorCommands";
import {
    IconList,
    IconListOrdered,
    IconCheckSquare,
    IconArrowDownToLine,
    IconChevronDown,
    IconTerminal,
    IconNetwork,
    IconMath,
    IconQuote,
} from "@/ui/icons";
import { t } from "@/i18n";
import { CALLOUT_ICONS } from "../callout";
import type { CalloutKind } from "@/plugins/callouts";
import { isChecklistSinkEnabled, setChecklistSinkEnabled } from "@/editing/checklistSink";
import { appendRowChord, createFillItem, createMenuTrigger, createSwitchItem, makeSep, type FillItem } from "./menuPrimitives";
import type { EditorCommandId } from "../../../shared/editorCommands";
import { wireHoverMenu } from "./hoverMenu";

export interface ContainerPicker {
    /** The picker, ready to be placed in a toolbar zone. */
    el: HTMLElement;
    /** The trigger button, lit while the caret is inside any member of the family. */
    trigger: HTMLElement | null;
    /**
     * Fill the row for the member named by `current`, clearing every other
     * row. `applicable: false` greys the whole control and makes it inert,
     * the format picker's treatment: where the schema cannot hold this
     * family, every row would consume the click and change nothing.
     */
    setActive: (current: string | null, applicable?: boolean) => void;
}

export interface FormatPicker {
    /** The picker, ready to be placed in a toolbar zone. */
    el: HTMLElement;
    /**
     * Label the trigger with the caret's level and fill that row. Where the
     * text type can't become a heading (table cell / code block / a selected
     * atom) the control greys out and nothing is filled.
     */
    setActive: (applicable: boolean, headingLevel: number) => void;
}

export function createFormatMenu(getEditor: GetEditor): FormatPicker {
    // ── Block-type dropdown (opens on hover, same style as the floating toolbar) ──
    const fmtWrap = document.createElement("div");
    fmtWrap.className = "tb-fmt-wrap";

    const fmtBtn = createMenuTrigger({
        html: `<span class="tb-fmt-label">P</span>${IconChevronDown}`,
        ariaLabel: t("Format"),
    });

    const fmtMenu = document.createElement("div");
    fmtMenu.className = "tb-fmt-menu";
    fmtMenu.style.display = "none";

    // Glyph, name, command. The glyph is what the trigger wears and what the
    // active row is read back by; the name is what the row is called, and it is
    // the Mac menu's wording so the two surfaces agree (menuPrimitives.ts).
    const formats: [string, string, EditorCommandId][] = [
        ["P", t("Body"), "setParagraph"],
        ["H1", t("Heading 1"), "setHeading1"],
        ["H2", t("Heading 2"), "setHeading2"],
        ["H3", t("Heading 3"), "setHeading3"],
        ["H4", t("Heading 4"), "setHeading4"],
        ["H5", t("Heading 5"), "setHeading5"],
        ["H6", t("Heading 6"), "setHeading6"],
    ];

    const fmtItems: FillItem[] = [];
    formats.forEach(([glyph, label, command]) => {
        const item = createFillItem(glyph, label, command);
        item.el.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            runEditorCommand(command, getEditor);
            // Shared close (owns the Escape-layer unregister) — never a
            // direct hide, which would leak the layer entry.
            closeFmtMenu();
        });
        fmtMenu.appendChild(item.el);
        fmtItems.push(item);
    });

    const { close: closeFmtMenu } = wireHoverMenu(fmtWrap, fmtBtn, fmtMenu);

    fmtWrap.appendChild(fmtBtn);
    fmtWrap.appendChild(fmtMenu);

    return {
        el: fmtWrap,
        setActive: (applicable: boolean, headingLevel: number): void => {
            const labelEl = fmtBtn.querySelector(".tb-fmt-label");
            if (labelEl) {
                const labels = ["P", "H1", "H2", "H3", "H4", "H5", "H6"];
                labelEl.textContent = applicable ? (labels[headingLevel] ?? "P") : "—";
            }
            fmtWrap.classList.toggle("tb-fmt-wrap--disabled", !applicable);
            fmtItems.forEach((item, i) => {
                // i=0 → P (level 0), i=1..6 → H1..H6; nothing filled when N/A.
                item.setActive(applicable && (i === 0 ? headingLevel === 0 : i === headingLevel));
            });
        },
    };
}

export function createListMenu(getEditor: GetEditor): ContainerPicker {
    // ── Lists dropdown (bullet / ordered / task) ──
    // One hover-menu picker with an icon+label row per list type. Each row is a
    // TOGGLE (clicking the active one again lifts out of the list), not a
    // select-one, and the caret is often in no list at all — so the active list
    // is marked with a filled/accent row (the toolbar's "on" idiom, like the
    // segmented width control) rather than a leading checkmark. A checkmark would
    // reserve an empty gutter in the common "not in a list" case and, beside the
    // row icons, read as a broken two-column layout. onSelectionChange refreshes
    // which row (if any) is active. The three standalone list buttons collapsed
    // into this to slim the default bar.
    type ListType = "bullet" | "ordered" | "task";
    const listRows: { type: ListType; setActive: (on: boolean) => void }[] = [];
    // Trigger refs for the container dropdowns, so onSelectionChange can light up
    // the bar button when the caret is inside that container (like the mark
    // buttons). The menu row shows WHICH one; the trigger shows THAT one.
    let listTriggerBtn: HTMLElement | null = null;
    function createListPicker(): HTMLElement {
        const listWrap = document.createElement("div");
        listWrap.className = "tb-fmt-wrap";

        const listBtn = createMenuTrigger({
            html: IconList + IconChevronDown,
            ariaLabel: t("Lists"),
        });
        listTriggerBtn = listBtn;

        const listMenu = document.createElement("div");
        listMenu.className = "tb-fmt-menu tb-list-menu";
        listMenu.style.display = "none";
        listMenu.setAttribute("role", "menu");

        const choices: { type: ListType; icon: string; label: string; command: EditorCommandId }[] = [
            { type: "bullet", icon: IconList, label: t("Bullet List"), command: "toggleBulletList" },
            { type: "ordered", icon: IconListOrdered, label: t("Ordered List"), command: "toggleOrderedList" },
            { type: "task", icon: IconCheckSquare, label: t("Task List"), command: "toggleTaskList" },
        ];
        for (const { type, icon, label, command } of choices) {
            const row = document.createElement("button");
            row.type = "button";
            row.className = "ui-menu-row tb-fmt-item tb-list-item";
            row.setAttribute("role", "menuitemcheckbox");
            row.setAttribute("aria-checked", "false");
            const iconEl = document.createElement("span");
            iconEl.className = "tb-list-item-icon";
            iconEl.innerHTML = icon;
            const labelEl = document.createElement("span");
            labelEl.className = "tb-list-item-label";
            labelEl.textContent = label;
            row.append(iconEl, labelEl);
            appendRowChord(row, command);
            row.addEventListener("mousedown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                runEditorCommand(command, getEditor);
                closeListMenu(); // shared close — owns the Escape-layer unregister
            });
            listMenu.appendChild(row);
            listRows.push({
                type,
                setActive: (on: boolean): void => {
                    row.classList.toggle("tb-list-item--on", on);
                    row.setAttribute("aria-checked", on ? "true" : "false");
                },
            });
        }

        // ── Task-list behavior switch, below a divider (MAR-175) ──
        // "Move checked tasks to bottom" flips birta.checklist.sinkChecked in
        // place: a persistent preference, not an insert and not a container the
        // caret is inside, so it wears the switch idiom (like the Checks menu)
        // rather than the rows' accent fill. It re-renders its own state and
        // leaves the menu open, so the user sees the flip land.
        listMenu.appendChild(makeSep());
        const sinkItem = createSwitchItem(t("Move checked tasks to bottom"), IconArrowDownToLine);
        sinkItem.el.title = t("Checking a task moves it below the unchecked items (birta.checklist.sinkChecked)");
        const renderSinkState = (): void => sinkItem.setChecked(isChecklistSinkEnabled());
        renderSinkState();
        sinkItem.el.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            setChecklistSinkEnabled(!isChecklistSinkEnabled());
            renderSinkState();
        });
        listMenu.appendChild(sinkItem.el);

        // Repaint on open: the same setting is flippable from the task-list
        // block menu and by a settings echo (featureGateChanged), either of
        // which would otherwise leave this switch showing a stale state.
        const { close: closeListMenu } = wireHoverMenu(listWrap, listBtn, listMenu, {
            onOpen: renderSinkState,
        });

        listWrap.appendChild(listBtn);
        listWrap.appendChild(listMenu);
        return listWrap;
    }

    const el = createListPicker();
    return {
        el,
        trigger: listTriggerBtn,
        setActive: (current: string | null, applicable = true): void => {
            el.classList.toggle("tb-fmt-wrap--disabled", !applicable);
            for (const { type, setActive } of listRows) {
                setActive(applicable && type === current);
            }
        },
    };
}

export function createCodeMenu(getEditor: GetEditor): ContainerPicker {
    // ── Code dropdown (plain code block + Mermaid diagram + Math block) ──
    // Mermaid and a math block are both just fenced code blocks with a set
    // language, so they live in one "Code" family dropdown alongside the plain
    // block — mirroring the Quote picker. The top row inserts a plain code
    // block; below a separator, Mermaid and Math Block bake in their fence
    // language. All three are also in the slash menu.
    type CodeRowKey = "code" | "mermaid" | "math";
    const codeRows: { key: CodeRowKey; setActive: (on: boolean) => void }[] = [];
    let codeTriggerBtn: HTMLElement | null = null;
    function createCodePicker(): HTMLElement {
        const codeWrap = document.createElement("div");
        codeWrap.className = "tb-fmt-wrap";

        const codeBtn = createMenuTrigger({
            html: IconTerminal + IconChevronDown,
            ariaLabel: t("Code Block"),
        });
        codeTriggerBtn = codeBtn;

        const codeMenu = document.createElement("div");
        codeMenu.className = "tb-fmt-menu tb-callout-menu";
        codeMenu.style.display = "none";
        codeMenu.setAttribute("role", "menu");

        // `key` matches computeToolbarActiveState().code so onSelectionChange can
        // fill the row for the code block you're inside.
        // `command` only where the row IS that command with no argument. The
        // Mermaid and Math rows run insertCodeBlock with a language, which is
        // not what the chord does, so printing it there would name a key that
        // produces a different block.
        const addRow = (key: CodeRowKey, icon: string, label: string, run: () => void, command?: EditorCommandId): void => {
            const row = document.createElement("button");
            row.type = "button";
            row.className = "ui-menu-row tb-fmt-item tb-callout-item";
            row.setAttribute("role", "menuitemcheckbox");
            row.setAttribute("aria-checked", "false");
            row.innerHTML = icon;
            const name = document.createElement("span");
            name.textContent = label;
            row.appendChild(name);
            if (command !== undefined) appendRowChord(row, command);
            row.addEventListener("mousedown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                run();
                closeCodeMenu(); // shared close — owns the Escape-layer unregister
            });
            codeMenu.appendChild(row);
            codeRows.push({
                key,
                setActive: (on: boolean): void => {
                    row.classList.toggle("tb-callout-item--on", on);
                    row.setAttribute("aria-checked", on ? "true" : "false");
                },
            });
        };

        // Plain code block first — the common case and the dropdown's identity.
        addRow("code", IconTerminal, t("Code Block"), () => runEditorCommand("insertCodeBlock", getEditor), "insertCodeBlock");

        codeMenu.appendChild(makeSep());

        // Language-typed blocks (same insertCodeBlock command, fence language baked in).
        addRow("mermaid", IconNetwork, t("Mermaid Diagram"), () => runEditorCommand("insertCodeBlock", getEditor, "mermaid"));
        addRow("math", IconMath, t("Math Block"), () => runEditorCommand("insertCodeBlock", getEditor, "LaTeX"));

        const { close: closeCodeMenu } = wireHoverMenu(codeWrap, codeBtn, codeMenu);

        codeWrap.appendChild(codeBtn);
        codeWrap.appendChild(codeMenu);
        return codeWrap;
    }

    const el = createCodePicker();
    return {
        el,
        trigger: codeTriggerBtn,
        setActive: (current: string | null, applicable = true): void => {
            el.classList.toggle("tb-fmt-wrap--disabled", !applicable);
            for (const { key, setActive } of codeRows) {
                setActive(applicable && key === current);
            }
        },
    };
}

export function createQuoteMenu(getEditor: GetEditor): ContainerPicker {
    // ── Quote dropdown (plain blockquote + GitHub callout types) ──
    // A callout is a typed blockquote, so the two live in one "Quote" family
    // dropdown: the top row toggles a plain blockquote; below a separator, one
    // row per callout type inserts a callout of that kind (insertCallout takes a
    // kind arg). Folding the two together frees a toolbar slot and surfaces the
    // callout types on the default (visible) bar, where the standalone Callouts
    // dropdown used to ship hidden.
    const quoteRows: { key: string; setActive: (on: boolean) => void }[] = [];
    let quoteTriggerBtn: HTMLElement | null = null;
    function createQuotePicker(): HTMLElement {
        const quoteWrap = document.createElement("div");
        quoteWrap.className = "tb-fmt-wrap";

        const quoteBtn = createMenuTrigger({
            html: IconQuote + IconChevronDown,
            ariaLabel: t("Quote"),
        });
        quoteTriggerBtn = quoteBtn;

        const quoteMenu = document.createElement("div");
        quoteMenu.className = "tb-fmt-menu tb-callout-menu";
        quoteMenu.style.display = "none";
        quoteMenu.setAttribute("role", "menu");

        // `key` matches computeToolbarActiveState().quote ("blockquote" or a
        // callout kind) so onSelectionChange can fill the row you're inside.
        // `command` only where the row IS that command with no argument: every
        // callout row runs toggleCallout with a different kind, so a shared
        // chord would claim each of them does what one of them does.
        const addRow = (key: string, icon: string, label: string, run: () => void, command?: EditorCommandId): void => {
            const row = document.createElement("button");
            row.type = "button";
            row.className = "ui-menu-row tb-fmt-item tb-callout-item";
            row.setAttribute("role", "menuitemcheckbox");
            row.setAttribute("aria-checked", "false");
            row.innerHTML = icon;
            const name = document.createElement("span");
            name.textContent = label;
            row.appendChild(name);
            if (command !== undefined) appendRowChord(row, command);
            // mousedown (not click): wireHoverMenu activates rows via a
            // synthetic mousedown.
            row.addEventListener("mousedown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                run();
                closeQuoteMenu(); // shared close — owns the Escape-layer unregister
            });
            quoteMenu.appendChild(row);
            quoteRows.push({
                key,
                setActive: (on: boolean): void => {
                    row.classList.toggle("tb-callout-item--on", on);
                    row.setAttribute("aria-checked", on ? "true" : "false");
                },
            });
        };

        // Plain blockquote first — the common case, and the dropdown's identity.
        addRow("blockquote", IconQuote, t("Blockquote"), () => runEditorCommand("toggleBlockquote", getEditor), "toggleBlockquote");

        quoteMenu.appendChild(makeSep());

        const calloutKinds: [CalloutKind, string][] = [
            ["note", t("Note")],
            ["tip", t("Tip")],
            ["important", t("Important")],
            ["warning", t("Warning")],
            ["caution", t("Caution")],
        ];
        for (const [kind, label] of calloutKinds) {
            // toggleCallout keeps the checkbox honest: the checked kind
            // lifts out, another kind retypes in place, outside wraps —
            // insertCallout itself now always nests (slash/block menus).
            addRow(kind, CALLOUT_ICONS[kind], label, () => runEditorCommand("toggleCallout", getEditor, kind));
        }

        const { close: closeQuoteMenu } = wireHoverMenu(quoteWrap, quoteBtn, quoteMenu);

        quoteWrap.appendChild(quoteBtn);
        quoteWrap.appendChild(quoteMenu);
        return quoteWrap;
    }

    const el = createQuotePicker();
    return {
        el,
        trigger: quoteTriggerBtn,
        setActive: (current: string | null): void => {
            for (const { key, setActive } of quoteRows) { setActive(key === current); }
        },
    };
}
