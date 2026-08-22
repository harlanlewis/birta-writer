/**
 * The Font picker and everything it renders: font preset, content font size,
 * and content width. One module because the three share a menu and the same
 * write-through contract with the extension - each control applies its change
 * to the live document immediately, then writes the setting, and the
 * extension's echo lands back on the matching setter here. Optimistic apply
 * plus authoritative echo is why the state lives beside the DOM that shows it
 * rather than in the toolbar's own closure.
 */
import { IconChevronDown } from "@/ui/icons";
import { t } from "@/i18n";
import { withScrollAnchor } from "@/utils/scrollAnchor";
import { notifySetFontPreset, notifySetFontSize, notifySetContentWidth } from "@/messaging";
import { getEditorView } from "@/editor";
import { hostHas, hostArranges, type HostCapability } from "../../../shared/hostProfile";
import { createCheckItem, createMenuTrigger, makeSep, type CheckItem } from "./menuPrimitives";
import { wireHoverMenu } from "./hoverMenu";
import type { FontPreset, FontStacks } from "../../../shared/messages";
import {
    FONT_PRESET_STACKS,
    DEFAULT_FONT_PRESET,
    DEFAULT_FONT_SIZE_PERCENT,
    MIN_FONT_SIZE_PERCENT,
    MAX_FONT_SIZE_PERCENT,
    clampFontSizePercent,
    stepFontSizePercent,
    resolveFontFamily,
} from "../../../shared/fontPresets";
import {
    CONTENT_WIDTH_MODES,
    DEFAULT_CONTENT_WIDTH_MODE,
    DEFAULT_MAX_WIDTH_CH,
    normalizeContentWidthMode,
    clampMaxWidthCh,
    type ContentWidthMode,
} from "../../../shared/contentWidth";
import { type BlockHandlesMode } from "../../../shared/blockHandles";

export interface TypographyControl {
    /** The picker, ready to be placed in a toolbar zone. */
    el: HTMLElement;
    /** Repaint the active preset (and optional stack previews) from a settings echo. */
    setFontPreset: (preset: FontPreset, stacks?: FontStacks) => void;
    /** Repaint the size stepper from a settings echo. */
    setFontSize: (size: number) => void;
    /** Repaint the width segments from a settings echo, caching the resolved fixed width. */
    setContentWidth: (mode: ContentWidthMode, fixedCss?: string) => void;
    /** Settings-echo sink for `birta.blockHandles`; see setBlockHandlesActive. */
    setBlockHandles: (mode: BlockHandlesMode) => void;
    /**
     * The typography rows for a surface that puts them in the gear menu.
     * Empty on a surface that keeps the toolbar item, because the rows are
     * built once and live in whichever holder asked for them.
     */
    gearRows: (closeHolder: () => void) => HTMLElement[];
    /** Apply + persist a width, as the segments do (palette and slash menu). */
    chooseContentWidth: (mode: ContentWidthMode) => void;
    /** Apply + persist a preset, as the menu row does (palette and slash menu). */
    chooseFontPreset: (preset: FontPreset) => void;
    /** Step the size one notch, as the stepper does (palette and slash menu). */
    stepFontSize: (delta: 1 | -1) => void;
    /** Return the content font size to its default (View > Actual Size). */
    resetFontSize: () => void;
}

export function createTypographyControl(): TypographyControl {
    // ── Font picker state ──
    // The active preset is echoed back from the extension after a settings
    // write, which updates the checkmark via setFontPreset() on the controller.
    // A host with no editor font of its own cannot honour the "editor" preset,
    // and a stored one predates the host learning that. Fall back rather than
    // show a checkmark against a row that is not offered.
    const storedPreset: FontPreset = window.__i18n?.fontPreset ?? DEFAULT_FONT_PRESET;
    let currentFontPreset: FontPreset =
        storedPreset === "editor" && !hostHas("editorFont") ? "serif" : storedPreset;
    // Effective per-preset stacks (user's fontFamilySans/Serif/Mono overrides
    // applied by the extension) — used for the row previews and button glyph.
    let currentFontStacks: FontStacks = window.__i18n?.fontStacks ?? FONT_PRESET_STACKS;
    const fontEntries: { preset: FontPreset; item: CheckItem }[] = [];
    // The picker button's "A" glyph, rendered in the active preset's stack so
    // the control previews its own choice.
    let fontLabelEl: HTMLElement | null = null;
    // The "editor" preset has no stack of its own — previews render in the
    // VS Code editor font it inherits.
    const EDITOR_FONT = "var(--vscode-editor-font-family, monospace)";
    /**
     * Put the family on the document. Applied here rather than only on the
     * host's echo: a host that does not answer `setFontPreset` (Jot, which
     * persists the choice in its own defaults) would otherwise move the
     * checkmark and change nothing. The echo re-applies the same value, which
     * is the size stepper's arrangement exactly.
     *
     * Anchored: swapping the family changes every glyph's metrics, so the
     * document rewraps and re-heights. Keep the top visible line stable.
     */
    function applyFontFamily(preset: FontPreset, stacks: FontStacks): void {
        withScrollAnchor(getEditorView(), () => {
            const root = document.documentElement;
            const family = resolveFontFamily(preset, stacks);
            if (family) {
                root.style.setProperty("--content-font-family", family);
            } else {
                // The "editor" preset: unset, so the CSS falls back to the
                // host's own editor font.
                root.style.removeProperty("--content-font-family");
            }
        });
    }

    function setFontActive(preset: FontPreset, stacks?: FontStacks): void {
        currentFontPreset = preset;
        if (stacks) {
            currentFontStacks = stacks;
        }
        applyFontFamily(preset, currentFontStacks);
        for (const { preset: p, item } of fontEntries) {
            item.setChecked(p === preset);
            item.label.style.fontFamily = p === "editor" ? EDITOR_FONT : currentFontStacks[p];
        }
        if (fontLabelEl) {
            fontLabelEl.style.fontFamily =
                preset === "editor" ? EDITOR_FONT : currentFontStacks[preset];
        }
    }
    // ── Font size state ──
    // Percent of the VS Code editor font size (100 = same). Like the preset,
    // the persisted value is echoed back by the extension after the settings
    // write, which re-syncs the stepper via setFontSize() on the controller.
    let currentFontSize: number = clampFontSizePercent(
        window.__i18n?.fontSize ?? DEFAULT_FONT_SIZE_PERCENT,
    );
    let sizeValueEl: HTMLElement | null = null;
    let sizeDecBtn: HTMLButtonElement | null = null;
    let sizeIncBtn: HTMLButtonElement | null = null;
    function setFontSizeActive(size: number): void {
        currentFontSize = clampFontSizePercent(size);
        if (sizeValueEl) {
            sizeValueEl.textContent = `${currentFontSize}%`;
        }
        if (sizeDecBtn) {
            sizeDecBtn.disabled = currentFontSize <= MIN_FONT_SIZE_PERCENT;
        }
        if (sizeIncBtn) {
            sizeIncBtn.disabled = currentFontSize >= MAX_FONT_SIZE_PERCENT;
        }
    }
    function pickFontSize(size: number): void {
        if (size === currentFontSize) {
            return;
        }
        setFontSizeActive(size);
        // Apply immediately so repeated clicks give live feedback; the settings
        // round-trip re-broadcasts the same value to every open editor.
        // Anchored: a scale change re-heights and rewraps every line — keep the
        // top visible line the top visible line (the echo re-applies the same
        // value a round trip later, an anchored no-op).
        withScrollAnchor(getEditorView(), () => {
            document.documentElement.style.setProperty(
                "--content-font-scale",
                String(currentFontSize / 100),
            );
        });
        notifySetFontSize(currentFontSize);
    }

    // ── Content width state ──
    // Full Width (fills the pane) / Fixed (capped at the maxContentWidth ch
    // setting), chosen via a segmented control. The active mode echoes back
    // from the extension after the settings write, re-syncing the segments.
    // Without a measure to choose, the answer is always full: the host's own
    // window is the measure, and a stored "fixed" from a host that had the
    // control would otherwise cap the text at a width nothing can change.
    let currentContentWidth: ContentWidthMode = hostHas("contentMeasure")
        ? normalizeContentWidthMode(window.__i18n?.contentWidth ?? DEFAULT_CONTENT_WIDTH_MODE)
        : "full";
    // Kept in sync with the extension's authoritative resolution so the
    // optimistic apply on a Fixed click never flashes a stale width after the
    // setting changes elsewhere.
    let fixedWidthCss = `${clampMaxWidthCh(window.__i18n?.maxContentWidth ?? DEFAULT_MAX_WIDTH_CH)}ch`;
    const widthSegments = new Map<ContentWidthMode, HTMLButtonElement>();
    function setContentWidthActive(mode: ContentWidthMode): void {
        currentContentWidth = normalizeContentWidthMode(mode);
        for (const [m, btnEl] of widthSegments) {
            const on = m === currentContentWidth;
            btnEl.classList.toggle("tb-seg-btn--on", on);
            btnEl.setAttribute("aria-checked", on ? "true" : "false");
        }
    }
    // Apply the max-width to the live document optimistically; the settings
    // round-trip re-broadcasts the resolved value to every open editor.
    function applyContentWidthLive(): void {
        document.documentElement.style.setProperty(
            "--editor-max-width",
            currentContentWidth === "fixed" ? fixedWidthCss : "none",
        );
        document.body.classList.toggle("editor-width-auto", currentContentWidth === "full");
    }
    function pickContentWidth(mode: ContentWidthMode): void {
        if (mode === currentContentWidth) {
            return;
        }
        setContentWidthActive(mode);
        // Anchored: the flip rewraps the whole document — keep the top
        // visible line the top visible line (the settings echo re-applies the
        // same values a round trip later, an anchored no-op).
        withScrollAnchor(getEditorView(), applyContentWidthLive);
        notifySetContentWidth(mode);
    }

    // Block handles have no menu rows anymore (the trio read as too prominent
    // for a rarely-changed preference) — the `birta.blockHandles` SETTING and
    // its settings-echo path remain; setBlockHandles is a deliberate no-op so
    // the echo contract holds.
    function setBlockHandlesActive(_mode: BlockHandlesMode): void { /* no menu rows to repaint */ }

    /**
     * The rows themselves: width segments, size stepper, font presets. Built
     * ONCE and mounted wherever the surface wants them, because a DOM node has
     * one parent and two builders would be two behaviours to keep in step.
     *
     * `closeHolder` is whatever menu ends up holding them, called after a pick
     * that should dismiss. The picker below passes its own hover menu's close;
     * a host that puts these rows in the gear menu passes the gear's.
     */
    function buildTypographyRows(closeHolder: () => void): HTMLElement[] {

        // ── Content width: Full Width / Fixed segmented control ──
        // Full Width (default) fills the pane; Fixed caps the content at the
        // maxContentWidth ch setting and centers it. Clicks keep the menu open.
        const widthRow = document.createElement("div");
        widthRow.className = "tb-seg-row";
        widthRow.setAttribute("role", "radiogroup");
        widthRow.setAttribute("aria-label", t("Content width"));
        const widthLabels: Record<ContentWidthMode, { label: string; title: string }> = {
            full: { label: t("Full Width"), title: t("Full width — fill the pane") },
            fixed: { label: t("Fixed"), title: t("Fixed — cap at the configured max content width") },
        };
        for (const mode of CONTENT_WIDTH_MODES) {
            const segBtn = document.createElement("button");
            segBtn.type = "button";
            segBtn.className = "ui-btn ui-btn--secondary tb-seg-btn";
            segBtn.setAttribute("role", "radio");
            segBtn.textContent = widthLabels[mode].label;
            segBtn.title = widthLabels[mode].title;
            segBtn.setAttribute("aria-label", widthLabels[mode].title);
            segBtn.addEventListener("mousedown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                pickContentWidth(mode);
            });
            widthRow.appendChild(segBtn);
            widthSegments.set(mode, segBtn);
        }

        // ── Size stepper: A− <percent> A+ ──
        // Scales the document content (and frontmatter) relative to the VS Code
        // editor font size; clicking the percent resets to the default. Clicks
        // keep the menu open, like the checks menu, so steps can be repeated.
        const sizeRow = document.createElement("div");
        sizeRow.className = "tb-font-size-row";
        const sizeBtn = (
            cls: string,
            label: string,
            onPick: () => void,
        ): HTMLButtonElement => {
            const b = document.createElement("button");
            b.type = "button";
            b.className = `ui-btn tb-font-size-btn ${cls}`;
            b.textContent = "A";
            b.title = label;
            b.setAttribute("aria-label", label);
            b.addEventListener("mousedown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                onPick();
            });
            return b;
        };
        sizeDecBtn = sizeBtn("tb-font-size-btn--dec", t("Decrease font size"), () =>
            pickFontSize(stepFontSizePercent(currentFontSize, -1)),
        );
        sizeIncBtn = sizeBtn("tb-font-size-btn--inc", t("Increase font size"), () =>
            pickFontSize(stepFontSizePercent(currentFontSize, 1)),
        );
        sizeValueEl = document.createElement("button");
        sizeValueEl.setAttribute("type", "button");
        sizeValueEl.className = "ui-btn tb-font-size-value";
        sizeValueEl.title = t("Reset font size");
        sizeValueEl.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            pickFontSize(DEFAULT_FONT_SIZE_PERCENT);
        });
        sizeRow.append(sizeDecBtn, sizeValueEl, sizeIncBtn);

        // ── Font family presets ──
        // "Editor font" (the default) follows the VS Code editor font; the
        // other presets use their stack, user-customizable via the
        // fontFamilySans/Serif/Mono settings. Each row previews its own font.
        // Each choice DECLARES what it needs and the list is filtered once,
        // rather than each gated one being spread in behind its own ternary.
        // The next gated preset adds a `needs` and nothing else; the shape of
        // the list does not change and no new branch appears.
        type FontChoice = {
            preset: FontPreset; label: string; stack: string; needs?: HostCapability;
        };
        const choices: FontChoice[] = ([
            { preset: "editor", label: t("Editor font"), stack: EDITOR_FONT, needs: "editorFont" },
            { preset: "sans", label: t("Sans serif"), stack: currentFontStacks.sans },
            { preset: "serif", label: t("Serif"), stack: currentFontStacks.serif },
            { preset: "mono", label: t("Monospace"), stack: currentFontStacks.mono },
        ] satisfies FontChoice[]).filter((c) => c.needs === undefined || hostHas(c.needs));
        const fontItemEls: HTMLElement[] = [];
        for (const { preset, label, stack } of choices) {
            const item = createCheckItem(label);
            item.el.classList.add("tb-font-item");
            if (stack) {
                item.label.style.fontFamily = stack; // preview the font on its own label
            }
            item.el.addEventListener("mousedown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                // Shared close, never a direct hide: it owns the Escape-layer
                // unregister (a direct hide leaks the entry and the next
                // editor-focused Escape dies on it) and the aria state.
                closeHolder();
                setFontActive(preset);
                notifySetFontPreset(preset);
            });
            fontItemEls.push(item.el);
            fontEntries.push({ preset, item });
        }

        // Assemble top→bottom: content width, font size, the family presets —
        // each group separated by a divider (width first — maintainer,
        // 2026-07-28). (Block handles and the font-stack settings live in
        // Settings only — the menu holds the frequent moves.)
        // Paint the rows just built. The DOCUMENT-level effects are not here:
        // they run at construction, below, because a page whose font or width
        // depends on someone asking for menu rows is a page that is wrong
        // until a menu is built.
        setFontActive(currentFontPreset);
        setFontSizeActive(currentFontSize);
        setContentWidthActive(currentContentWidth);

        // Same shape for the rows: what each group needs, filtered once. The
        // width segments only where a measure is a real choice; without them
        // the list opens on the size stepper and needs no leading rule.
        const groups: { rows: HTMLElement[]; needs?: HostCapability }[] = [
            { rows: [widthRow], needs: "contentMeasure" },
            { rows: [sizeRow] },
            { rows: fontItemEls },
        ];
        return groups
            .filter((g) => g.needs === undefined || hostHas(g.needs))
            .flatMap((g, i) => (i === 0 ? g.rows : [makeSep(), ...g.rows]));
    }

    /** The rows in a toolbar item of their own: an "A" trigger over a hover menu. */
    function createFontPicker(): HTMLElement {
        const fontWrap = document.createElement("div");
        fontWrap.className = "tb-fmt-wrap";

        const fontBtn = createMenuTrigger({
            html: `<span class="tb-fmt-label tb-fmt-label--font">A</span>${IconChevronDown}`,
            ariaLabel: t("Font"),
        });
        fontLabelEl = fontBtn.querySelector(".tb-fmt-label--font");

        const fontMenu = document.createElement("div");
        fontMenu.className = "tb-fmt-menu tb-font-menu";
        fontMenu.style.display = "none";
        // The rows close over `closeFontMenu`, which wireHoverMenu returns
        // below; they only ever run after that, since the menu must be open to
        // click a row.
        let closeFontMenu = (): void => {};
        fontMenu.append(...buildTypographyRows(() => closeFontMenu()));

        ({ close: closeFontMenu } = wireHoverMenu(fontWrap, fontBtn, fontMenu));

        fontWrap.appendChild(fontBtn);
        fontWrap.appendChild(fontMenu);
        return fontWrap;
    }

    // The document's own state, applied once and independently of any menu.
    applyFontFamily(currentFontPreset, currentFontStacks);
    if (!hostHas("contentMeasure")) {
        // Such a host has no control to set it later and its boot page carries
        // no width style, so full width has to be put on the document here.
        applyContentWidthLive();
    }

    // WHERE the rows live is the surface's choice, and it is exclusive: a DOM
    // node has one parent, so the item and the gear rows can never both exist.
    // Everything else about the control is identical either way, which is what
    // keeps the palette and slash-menu commands working unchanged: they call
    // the methods below and never touch the DOM.
    const inGear = hostArranges("typographyInGearMenu");
    let cachedGearRows: HTMLElement[] = [];
    const el = inGear
        ? (() => {
            const empty = document.createElement("div");
            empty.className = "tb-fmt-wrap";
            empty.hidden = true;
            return empty;
        })()
        : createFontPicker();

    return {
        el,
        /**
         * The rows, for a surface that mounts them in the gear menu instead.
         * Empty otherwise, so a caller that always asks gets nothing rather
         * than a second copy of the picker's rows.
         */
        gearRows(closeHolder: () => void): HTMLElement[] {
            if (!inGear) { return []; }
            if (cachedGearRows.length === 0) {
                cachedGearRows = buildTypographyRows(closeHolder);
            }
            return cachedGearRows;
        },
        setFontPreset: (preset: FontPreset, stacks?: FontStacks): void => {
            setFontActive(preset, stacks);
        },
        setFontSize: (size: number): void => {
            setFontSizeActive(size);
        },
        setContentWidth: (mode: ContentWidthMode, fixedCss?: string): void => {
            if (mode === "fixed" && fixedCss) { fixedWidthCss = fixedCss; }
            setContentWidthActive(mode);
        },
        setBlockHandles: (mode: BlockHandlesMode): void => {
            setBlockHandlesActive(mode);
        },
        chooseContentWidth: (mode: ContentWidthMode): void => {
            pickContentWidth(mode);
        },
        chooseFontPreset: (preset: FontPreset): void => {
            setFontActive(preset);
            notifySetFontPreset(preset);
        },
        stepFontSize: (delta: 1 | -1): void => {
            pickFontSize(stepFontSizePercent(currentFontSize, delta));
        },
        resetFontSize: (): void => {
            pickFontSize(DEFAULT_FONT_SIZE_PERCENT);
        },
    };
}
