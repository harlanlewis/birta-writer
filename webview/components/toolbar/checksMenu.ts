/**
 * The Checks menu: the proofreading gate, its domain and style sub-checks, and
 * the in-text note-marker highlight that sits beside them.
 *
 * Two of its rules are easy to break from outside and are the reason the menu
 * owns its own state. Visibility is by DETACHING a container, never by dimming
 * or `display:none`, because hoverMenu's keyboard walk skips a row only by that
 * row's own inline display and would otherwise focus rows the user cannot see.
 * And the gate never rewrites the domain switches, so turning proofreading back
 * on restores exactly what was enabled before.
 */
import { IconStyleCheck, IconChevronDown } from "@/ui/icons";
import { t } from "@/i18n";
import { STYLE_CATEGORIES, STYLE_SECTIONS } from "@/utils/styleCategories";
import { getProofreadConfig, setProofreadConfig } from "@/plugins";
import { getEditorView } from "@/editor";
import { notifySetProofreadOption } from "@/messaging";
import { NOTE_HIGHLIGHT_EVENT, noteMarkersEnabled, setNoteMarkersEnabled } from "@/plugins/noteMarkers";
import { createMenuTrigger, createSwitchItem, makeSep, type CheckItem } from "./menuPrimitives";
import { wireHoverMenu } from "./hoverMenu";
import { commandAvailable } from "../../../shared/commandAvailability";
import type { ProofreadConfig, ProofreadOptionKey } from "../../../shared/messages";

export interface ChecksControl {
    /** The control, ready to be placed in a toolbar zone. */
    el: HTMLElement;
    /** Flip one proofread toggle - shared with the palette and the slash menu. */
    toggleProofread: (key: ProofreadOptionKey) => void;
    /** Flip the in-text note-marker highlight - shared with the Notes tab and the palette. */
    toggleNoteHighlights: () => void;
}

/**
 * `onShowProofreading`, when given, adds the "Show issues" row that reveals the
 * review sidebar's Proofreading list.
 */
export function createChecksMenu(onShowProofreading?: () => void): ChecksControl {
    // ── Checks menu (spelling, grammar, style + per-check toggles) ───────────
    // One toolbar button opens a menu of checkmarkable items: the three masters
    // up top, then the style sub-checks grouped under headers. Every row toggles
    // one option live (webview state) and persists it (settings). The menu opens
    // on hover, like the font picker; the button itself is just its anchor.
    // The chevron signals it opens a menu; aria-label names it for assistive tech.
    const checksBtn = createMenuTrigger({
        html: `${IconStyleCheck}${IconChevronDown}`,
        ariaLabel: t("Checks"),
    });

    // Every option key except the gate maps 1:1 to a boolean ProofreadConfig
    // field (the gate's key "proofreading" ↔ field "proofreadingEnabled"), so the
    // domain rows use this narrowed key and index the config directly.
    type DomainCheckKey = Exclude<ProofreadOptionKey, "proofreading">;
    type CheckRow = { key: DomainCheckKey; item: CheckItem };
    const checkRows: CheckRow[] = [];
    // Two levels of show/hide, both by *detaching* the container (not dimming):
    //   • the whole body (domain masters + style sub-checks) is detached when the
    //     master Proofreading gate is off, so the menu collapses to just the gate;
    //   • the style sub-checks are detached when Check style is off.
    // Detaching (not display:none) also keeps hidden rows out of keyboard focus,
    // since hoverMenu.rows() only skips a row by its own inline display, not an
    // ancestor's. All refs are assigned when the menu is built.
    let checksMenuEl: HTMLElement | null = null;
    // Assigned once the checks hover-menu is wired; the "Show issues" item calls
    // it so picking the action dismisses the menu (the sidebar takes over).
    let closeChecksMenu: (() => void) | null = null;
    let bodyEl: HTMLElement | null = null;
    let styleChildrenEl: HTMLElement | null = null;
    // The master "Proofreading" gate switch (handled separately from checkRows
    // because its config field name differs from its option key).
    let masterItem: CheckItem | null = null;
    // The "Highlight note markers" switch — a sibling of the master gate,
    // leading the menu, governed by nothing (see where it is built).
    let notesHighlightItem: CheckItem | null = null;

    /** Attach `child` into `parent` iff `show`, else detach it. */
    const setAttached = (parent: HTMLElement, child: HTMLElement, show: boolean): void => {
        if (show && !child.isConnected) { parent.appendChild(child); }
        else if (!show && child.isConnected) { child.remove(); }
    };

    const repaintChecks = (cfg: ProofreadConfig): void => {
        for (const { key, item } of checkRows) {
            item.setChecked(Boolean(cfg[key]));
        }
        masterItem?.setChecked(cfg.proofreadingEnabled);
        // The button carries no state of its own. It is an anchor for a menu
        // whose first row already says whether the gate is on, and a dimmed
        // control in a bar of live ones reads as unavailable rather than as
        // off, which is a different claim from the one it would be making.
        //
        // Gate: the whole body shows only while the master switch is on. It is
        // the menu's last child, so a re-attach appends it straight back.
        if (checksMenuEl && bodyEl) {
            setAttached(checksMenuEl, bodyEl, cfg.proofreadingEnabled);
        }
        // Nested: style sub-checks show only while Check style is on (and, since
        // they live inside the body, only when the gate is on too).
        if (bodyEl && styleChildrenEl) {
            setAttached(bodyEl, styleChildrenEl, cfg.styleCheck);
        }
        // Deliberately NOT the notes row: it is not part of `cfg`, and it has
        // exactly one paint path (the NOTE_HIGHLIGHT_EVENT listener below).
    };

    /** Flip one proofread toggle — shared by the Checks rows and slash menu. */
    function toggleProofread(key: ProofreadOptionKey): void {
        // The gate is a special case (its field name differs); everything else is
        // a boolean field keyed by its own name.
        if (key === "proofreading") { toggleProofreadingGate(); return; }
        const view = getEditorView();
        if (!view) { return; }
        const cfg = getProofreadConfig(view);
        const field = key as DomainCheckKey;
        const value = !cfg[field];
        setProofreadConfig(view, { ...cfg, [field]: value });
        notifySetProofreadOption(field, value);
    }

    /**
     * Flip the master proofreading gate. Unlike the domain rows, its config field
     * (`proofreadingEnabled`) differs from its option key (`proofreading`), and it
     * never touches the per-domain switches — so turning it back on restores
     * exactly what was enabled before. Mirrors the `toggleProofreading` command.
     */
    function toggleProofreadingGate(): void {
        const view = getEditorView();
        if (!view) { return; }
        const cfg = getProofreadConfig(view);
        const value = !cfg.proofreadingEnabled;
        setProofreadConfig(view, { ...cfg, proofreadingEnabled: value });
        notifySetProofreadOption("proofreading", value);
    }

    /**
     * Flip the in-text editor-note highlight — shared by the Checks menu's Notes
     * row, the review sidebar's Notes tab, the palette, and the slash menu. The
     * plugin owns the gate (it applies the flip in this webview and persists it);
     * every mirroring switch repaints off the event it fires.
     */
    function toggleNoteHighlights(): void {
        setNoteMarkersEnabled(getEditorView(), !noteMarkersEnabled());
    }

    function createChecksControl(): HTMLElement {
        const wrapEl = document.createElement("div");
        wrapEl.className = "tb-fmt-wrap tb-checks-wrap";
        wrapEl.appendChild(checksBtn);

        const menu = document.createElement("div");
        menu.className = "tb-fmt-menu tb-checks-menu";
        menu.style.display = "none";
        menu.setAttribute("role", "menu");
        checksMenuEl = menu;

        const addRow = (parent: HTMLElement, key: DomainCheckKey, label: string): void => {
            const item = createSwitchItem(label);
            item.el.addEventListener("mousedown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                toggleProofread(key);
                // Menu stays open so several checks can be toggled in a row.
            });
            parent.appendChild(item.el);
            checkRows.push({ key, item });
        };
        const addHeader = (parent: HTMLElement, title: string): void => {
            const header = document.createElement("div");
            header.className = "ui-heading ui-menu-heading tb-fmt-header";
            header.textContent = title;
            parent.appendChild(header);
        };

        // ── "Highlight note markers" (birta.notes.highlightMarkers) ─────────
        // The in-text chips on `[TK]`, `TODO:`, `FIXME:` and custom markers.
        //
        // It names the MARKERS rather than the notes, because three other
        // things in this editor answer to a shorter label: `==highlight==` is
        // an inline mark with its own "Highlight" command, a footnote and a
        // `> [!NOTE]` callout are both notes, and in a menu whose other half is
        // Proofreading, "editor notes" reads as the editor's notes about your
        // prose — the exact opposite of what this switch governs. "Marker" is
        // already the vocabulary the settings teach (birta.notes.customMarkers
        // lists "text markers"), and the marker is literally what gets tinted:
        // never its line, never the note's prose.
        // It leads the menu as a SIBLING of the Proofreading gate below — same
        // rank, same emphasis, governing nothing but itself. Sibling rather than
        // child because the two are independent: proofreading findings are the
        // editor's opinion about your prose, and turning them off must not take
        // away the markers you left yourself, which are your own content. A
        // separator, not a header, carries that — a header would read as a
        // section the gate opens.
        notesHighlightItem = createSwitchItem(t("Highlight note markers"));
        notesHighlightItem.el.classList.add("tb-checks-master");
        notesHighlightItem.setChecked(noteMarkersEnabled());
        notesHighlightItem.el.title = t("Mark [TK], TODO:, FIXME: and your custom markers where they sit in the text (birta.notes.highlightMarkers)");
        notesHighlightItem.el.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            toggleNoteHighlights();
        });
        menu.appendChild(notesHighlightItem.el);
        menu.appendChild(makeSep());

        // Master "Proofreading" gate — the top-level switch that governs
        // everything below. Flipping it off silences spelling, grammar, and style
        // at once and hides the rest of the menu; flipping it on brings back
        // exactly what was enabled before (it never rewrites the domain switches).
        // It's emphasized (tb-checks-master) but otherwise the same switch idiom.
        masterItem = createSwitchItem(t("Proofreading"));
        masterItem.el.classList.add("tb-checks-master");
        masterItem.el.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            toggleProofreadingGate();
        });
        menu.appendChild(masterItem.el);

        // The body holds everything the gate governs. A leading separator sits
        // inside it so that when the gate is off and the body is detached, the
        // menu collapses cleanly to just the master switch (no dangling divider).
        const body = document.createElement("div");
        body.className = "tb-checks-body";
        bodyEl = body;

        // "Show issues" — reveal the review sidebar's Proofreading list. It's the
        // FIRST thing in the gated body, so it sits directly under the master
        // Proofreading switch (the 2nd item) and shows only while that switch is
        // on. It's an action, not a check, so no toggle.
        if (onShowProofreading) {
            const showItem = document.createElement("div");
            showItem.className = "ui-menu-row tb-fmt-item tb-checks-action";
            showItem.setAttribute("role", "menuitem");
            showItem.tabIndex = -1;
            showItem.textContent = t("Show issues");
            showItem.addEventListener("mousedown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                onShowProofreading();
                closeChecksMenu?.();
            });
            body.appendChild(showItem);
        }

        body.appendChild(makeSep());

        // Domain masters. Two of the three are filtered rather than always
        // drawn, which is what the item's own ungated place in the bar costs:
        // spelling and grammar are lints the page posts OUT and draws whatever
        // the host answers, so on a host with no engine the row would be a
        // switch with nothing behind it. Style check is computed here, so it is
        // unconditional and so is everything indented under it.
        if (commandAvailable("toggleSpellCheck")) { addRow(body, "spellCheck", t("Check spelling")); }
        if (commandAvailable("toggleGrammarCheck")) { addRow(body, "grammarCheck", t("Check grammar")); }
        addRow(body, "styleCheck", t("Check style"));

        // Style sub-checks live in their own indented container (a left rail ties
        // them to the "Check style" master above), shown only while it's on.
        const children = document.createElement("div");
        children.className = "tb-checks-children";
        styleChildrenEl = children;

        // Derived from the shared canonical category list so the menu, the review
        // sidebar's grouping, and the in-text chips can never drift apart.
        const groups: { title: string; opts: [DomainCheckKey, string][] }[] = STYLE_SECTIONS.map((section) => ({
            title: t(section),
            opts: STYLE_CATEGORIES
                .filter((d) => d.section === section)
                .map((d) => [d.category as DomainCheckKey, t(d.label)]),
        }));
        for (const group of groups) {
            addHeader(children, group.title);
            for (const [key, label] of group.opts) { addRow(children, key, label); }
        }
        body.appendChild(children); // repaintChecks detaches it when Check style is off
        menu.appendChild(body); // repaintChecks detaches it when the gate is off

        closeChecksMenu = wireHoverMenu(wrapEl, checksBtn, menu, {
            onOpen: () => {
                // Proofread state lives in the editor's plugin state, so it is
                // read fresh on open. The notes row is not repainted here: it
                // is already correct (see its listener below), and a defensive
                // repaint on open would hide a missing announcement in this one
                // surface while the sidebar's pill went quietly stale.
                const view = getEditorView();
                if (view) { repaintChecks(getProofreadConfig(view)); }
            },
        }).close;

        wrapEl.appendChild(menu);
        return wrapEl;
    }
    const checksControl = createChecksControl();

    window.addEventListener("proofread-config-changed", (e) => {
        repaintChecks((e as CustomEvent<ProofreadConfig>).detail);
    });
    // THE paint path for the notes row, and the only one after the row is built.
    // The gate is flippable from three other places (the Notes tab, the
    // palette/slash command, and the Settings UI in any window) and every one of
    // them lands on the plugin's re-gate, which announces — so this keeps the row
    // truthful even while the menu is already open, without polling and without a
    // second site that could disagree with the sidebar's pill.
    window.addEventListener(NOTE_HIGHLIGHT_EVENT, () => {
        notesHighlightItem?.setChecked(noteMarkersEnabled());
    });
    {
        // Paint the initial state if the editor already exists at build time.
        const view = getEditorView();
        if (view) { repaintChecks(getProofreadConfig(view)); }
    }

    return { el: checksControl, toggleProofread, toggleNoteHighlights };
}
