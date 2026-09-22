/**
 * The `/ai` advanced panel: an ephemeral composer at the caret.
 *
 * `/ai <request>` stays exactly what it was, a line of text and Enter. This
 * is the other half, for a request that needs more than a line: a textarea
 * that grows, files attached by paste, drop or button, and the two controls
 * that decide what actually runs. Reached by `/ai-advanced`, or by `/ai`
 * with nothing typed, which used to open a native input box that could hold
 * neither a file nor a model.
 *
 * Ephemeral is the contract. It owns no document state, writes nothing, and
 * on Escape or a click outside it leaves no trace; the caret is exactly
 * where it was. Nothing here is a preference: the model and effort it sends
 * apply to one request and `birta.agent.command` is never written, because a
 * choice made for one edit is not a setting.
 *
 * WHAT IT MAY OFFER is decided by the harness, never by this file. The
 * extension probes the configured binary's own `--help` and sends what it
 * found (`shared/messages.ts` HarnessCapabilities); a harness documenting no
 * `--model` gets no model control, and one documenting no `--effort` gets no
 * effort control. Nothing here contains a model name, an effort value, or a
 * flag. The panel opening before the probe lands is normal and shows the
 * textarea alone, gaining its controls when the answer arrives.
 *
 * The model list deserves its own warning, because it is the one place this
 * design can be misread into a lie. What the probe returns is whatever the
 * help gave, which for every harness surveyed is names quoted as EXAMPLES
 * rather than a catalog; a model absent from them works exactly as well. So
 * the list is offered as suggestions with free text always reachable, and
 * never as the set of models that exist. Removing that free entry because
 * the list looks complete would be the bug.
 *
 * The effort list is the opposite and the two must not be made uniform. It
 * is an enumeration read off the flag's own documented values, and the
 * formatters that print one reject anything outside it, so free text beside
 * a published scale offers a rung that fails rather than one that differs.
 * Free text is therefore offered for effort only where the harness published
 * NO scale, which is a real case (a flag that names itself and documents no
 * values) and, without the row, is a menu holding nothing but the default
 * the user already had.
 */
import { t } from "@/i18n";
import { IconArrowUp, IconPaperclip, IconX } from "@/ui/icons";
import type { AgentSkill, HarnessCapabilities } from "../../../shared/messages";
import { displayEffort, displayModel } from "../../agentRoute";

/** One file on its way to becoming a path the agent can read. */
export interface PanelAttachment {
    /** Correlates the save request with its reply. */
    id: string;
    name: string;
    /** An object URL for an image preview, or undefined for anything else. */
    previewUrl?: string;
    /** The path the extension wrote it to; undefined until the reply lands. */
    path?: string;
    /** The save failed and the chip is showing it, so send must not use it. */
    failed?: boolean;
    /** Refused on size before any byte was read, which the chip says plainly. */
    tooLarge?: boolean;
}

export interface AgentPanelHost {
    /** Hand `bytes` to the extension to write; the reply resolves the path. */
    saveAttachment(id: string, name: string, bytes: ArrayBuffer): void;
    /** Send the composed request. */
    submit(request: {
        prompt: string;
        model?: string;
        effort?: string;
        /** A skill name to run under, by name; absent means none. */
        skill?: string;
        attachments: readonly string[];
    }): void;
    /** The panel closed without sending. */
    dismiss(): void;
}

export interface AgentPanelHandle {
    el: HTMLElement;
    /** Apply capabilities that arrived after the panel opened. */
    setCapabilities(caps: HarnessCapabilities | undefined): void;
    /** Apply a skill list that arrived after the panel opened. */
    setSkills(skills: readonly AgentSkill[] | undefined): void;
    /** Resolve one pending attachment (path, or null when the write failed). */
    resolveAttachment(id: string, path: string | null): void;
    destroy(): void;
}

let attachmentSeq = 0;

/**
 * Largest file that may be attached, checked BEFORE anything is read.
 *
 * `File.size` is known without touching the bytes, which is the whole point:
 * a cap applied to the result would mean a multi-gigabyte drop had already
 * been read into webview memory and base64-expanded by a third onto a
 * postMessage before anything noticed it was too big. The bound has to sit
 * on the reading, not on what the reading produced.
 */
const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024;

/** Whether a file is worth drawing a thumbnail for. */
function isImage(file: File): boolean {
    return file.type.startsWith("image/");
}

/**
 * Build the panel. `anchor` is the caret rectangle it positions itself
 * against; `initial` prefills the textarea, which is how
 * `/ai-advanced write a summary` arrives with its text already in place.
 */
export function createAgentPanel(opts: {
    anchor: { left: number; top: number; bottom: number };
    initial?: string;
    capabilities?: HarnessCapabilities;
    /**
     * The skills the host found, or undefined on a host that scans none.
     * A list, even an empty one, draws the picker; undefined draws nothing.
     */
    skills?: readonly AgentSkill[];
    host: AgentPanelHost;
}): AgentPanelHandle {
    const { host } = opts;
    let caps = opts.capabilities;
    let skills = opts.skills;
    let model: string | undefined;
    let effort: string | undefined;
    let skill: string | undefined;
    const attachments: PanelAttachment[] = [];

    const root = document.createElement("div");
    root.className = "agent-panel";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", t("Ask Agent"));

    // ── The composer ────────────────────────────────────────────
    const chips = document.createElement("div");
    chips.className = "agent-panel-chips";

    const textarea = document.createElement("textarea");
    textarea.className = "agent-panel-input";
    textarea.rows = 1;
    textarea.placeholder = t("What should the agent do here?");
    textarea.value = opts.initial ?? "";

    /** Grow with the text rather than scrolling a one-line box. */
    const autoGrow = (): void => {
        textarea.style.height = "auto";
        textarea.style.height = `${Math.min(textarea.scrollHeight, 320)}px`;
    };

    // ── The controls row ────────────────────────────────────────
    const controls = document.createElement("div");
    controls.className = "agent-panel-controls";

    const attachBtn = document.createElement("button");
    attachBtn.type = "button";
    attachBtn.className = "ui-btn ui-btn--icon agent-panel-attach";
    attachBtn.innerHTML = IconPaperclip;
    attachBtn.title = t("Attach files");
    attachBtn.setAttribute("aria-label", t("Attach files"));

    const filePicker = document.createElement("input");
    filePicker.type = "file";
    filePicker.multiple = true;
    filePicker.className = "agent-panel-file-input";

    const spec = document.createElement("div");
    spec.className = "agent-panel-spec";

    const submit = document.createElement("button");
    submit.type = "button";
    submit.className = "ui-btn ui-btn--icon ui-btn--primary agent-panel-submit";
    submit.innerHTML = IconArrowUp;
    submit.title = t("Send");
    submit.setAttribute("aria-label", t("Send"));

    controls.append(attachBtn, filePicker, spec, submit);
    root.append(chips, textarea, controls);

    // ── Attachments ─────────────────────────────────────────────
    function renderChips(): void {
        chips.textContent = "";
        chips.classList.toggle("agent-panel-chips--empty", attachments.length === 0);
        for (const a of attachments) {
            const chip = document.createElement("div");
            chip.className = "agent-panel-chip";
            if (a.failed) { chip.classList.add("agent-panel-chip--failed"); }
            if (a.previewUrl) {
                const img = document.createElement("img");
                img.src = a.previewUrl;
                img.alt = "";
                chip.appendChild(img);
            }
            const label = document.createElement("span");
            label.className = "agent-panel-chip-name";
            label.textContent = a.tooLarge
                ? t("{0} is too large to attach").replace("{0}", a.name)
                : a.failed
                    ? t("could not attach {0}").replace("{0}", a.name)
                    : a.name;
            chip.appendChild(label);
            const remove = document.createElement("button");
            remove.type = "button";
            remove.className = "ui-btn ui-btn--icon agent-panel-chip-remove";
            remove.innerHTML = IconX;
            remove.title = t("Remove");
            remove.setAttribute("aria-label", t("Remove"));
            remove.addEventListener("click", () => {
                const i = attachments.indexOf(a);
                if (i >= 0) {
                    if (a.previewUrl) { URL.revokeObjectURL(a.previewUrl); }
                    attachments.splice(i, 1);
                    renderChips();
                    syncSubmitState();
                }
            });
            chip.appendChild(remove);
            chips.appendChild(chip);
        }
    }

    function addFiles(files: readonly File[]): void {
        for (const file of files) {
            const id = `att-${++attachmentSeq}`;
            const name = file.name || t("pasted image");
            if (file.size > MAX_ATTACHMENT_BYTES) {
                // Refused before a byte is read, and shown as a failed chip
                // rather than dropped: the user dragged it in and is owed an
                // answer about where it went.
                attachments.push({ id, name, failed: true, tooLarge: true });
                continue;
            }
            const entry: PanelAttachment = {
                id,
                name,
                previewUrl: isImage(file) ? URL.createObjectURL(file) : undefined,
            };
            attachments.push(entry);
            void file.arrayBuffer()
                .then((bytes) => host.saveAttachment(id, entry.name, bytes))
                .catch(() => { entry.failed = true; renderChips(); syncSubmitState(); });
        }
        renderChips();
        syncSubmitState();
    }

    // ── The model and effort controls ───────────────────────────
    /**
     * The one line naming what will run. Rendered from capabilities, so a
     * harness offering neither flag renders nothing at all rather than an
     * empty menu the user can open and find nothing in.
     */
    function renderSpec(): void {
        spec.textContent = "";
        if (caps?.supportsModel) {
            spec.appendChild(makeMenuButton(
                model ? displayModel(model) : t("Default model"),
                () => modelMenuItems(),
            ));
        }
        if (caps?.supportsEffort) {
            spec.appendChild(makeMenuButton(
                effort ? displayEffort(effort) : t("Default effort"),
                () => effortMenuItems(),
            ));
        }
        // The skill picker rests on the host's scan, not on the harness's
        // help, so it is drawn whenever a list arrived, capabilities or not.
        if (skills !== undefined) {
            spec.appendChild(makeMenuButton(
                skill ? `/${skill}` : t("No skill"),
                () => skillMenuItems(),
            ));
        }
    }

    interface MenuItem {
        label: string;
        /** A group heading rather than a choice: drawn, never picked. */
        heading?: boolean;
        /** Drawn under the label as the row's own text (a skill's description). */
        detail?: string;
        checked?: boolean;
        /**
         * Opens a text field in the menu instead of picking a value, and
         * carries everything that field needs. The alternative was a boolean
         * and a branch per control reading the right variable, which is the
         * shape that leaves the second control half wired: an effort row
         * that drew a field prefilled with the model and committed to it.
         */
        freeText?: {
            placeholder: string;
            /** What the field opens with, so editing a choice is not retyping it. */
            current: string | undefined;
            /** Undefined means "let the harness decide", as the default row does. */
            commit(value: string | undefined): void;
        };
        onPick(): void;
    }

    function modelMenuItems(): MenuItem[] {
        const pick = (value: string | undefined) => () => { model = value; renderSpec(); };
        const items: MenuItem[] = [
            // Absent is a real choice and the default one: it means the
            // harness decides, which is what happens with no flag at all.
            { label: t("Default model"), checked: model === undefined, onPick: pick(undefined) },
            ...(caps?.modelExamples ?? []).map((m) => ({
                label: displayModel(m),
                checked: model === m,
                onPick: pick(m),
            })),
        ];
        // Always reachable, because the suggestions above are examples from
        // help text and never the set of models the harness accepts.
        //
        // An inline field rather than `window.prompt`, which Electron does
        // not implement: it returns without asking, so the row would have
        // looked live and done nothing at all.
        items.push({
            label: t("Other model…"),
            freeText: {
                placeholder: t("model name, as your harness spells it"),
                current: model,
                commit: (value) => { model = value; },
            },
            onPick: () => {},
        });
        return items;
    }

    function effortMenuItems(): MenuItem[] {
        const pick = (value: string | undefined) => () => { effort = value; renderSpec(); };
        const rungs = caps?.efforts ?? [];
        const items: MenuItem[] = [
            { label: t("Default effort"), checked: effort === undefined, onPick: pick(undefined) },
            ...rungs.map((e) => ({
                label: displayEffort(e),
                checked: effort === e,
                onPick: pick(e),
            })),
        ];
        // Free text only where the harness published no scale, which is the
        // one asymmetry with the model menu above and is not an oversight.
        // A model list is EXAMPLES, so a name missing from it may work; an
        // effort list is an enumeration read off the flag's own documented
        // values, and the formatters that print one (clap's `possible
        // values`, yargs' `choices`) reject anything else, so a typed rung
        // beside a real scale is a command that fails rather than a request
        // that differs. Where there is no scale it is the only way in, and
        // without it this menu holds nothing but the default the user
        // already had.
        if (rungs.length === 0) {
            items.push({
                label: t("Other effort…"),
                freeText: {
                    placeholder: t("effort level, as your harness spells it"),
                    current: effort,
                    commit: (value) => { effort = value; },
                },
                onPick: () => {},
            });
        }
        return items;
    }

    /**
     * No skill, then the scan's findings grouped by where they came from,
     * then free text. The list is what the scan reached and never the set
     * of skills the harness can see (a plugin's, a synced one), so free text
     * is always reachable, as it is for the model menu; and a name typed
     * here that the harness does not know falls through to the plain
     * request, which is a safer floor than the flag pickers have.
     */
    function skillMenuItems(): MenuItem[] {
        const pick = (value: string | undefined) => () => { skill = value; renderSpec(); };
        const items: MenuItem[] = [
            { label: t("No skill"), checked: skill === undefined, onPick: pick(undefined) },
        ];
        const groups: Array<[AgentSkill["scope"], string]> = [["project", t("This project")], ["user", t("Your machine")]];
        for (const [scope, title] of groups) {
            const rows = (skills ?? []).filter((s) => s.scope === scope);
            if (rows.length === 0) { continue; }
            items.push({ label: title, heading: true, onPick: () => {} });
            for (const s of rows) {
                items.push({ label: `/${s.name}`, detail: s.description, checked: skill === s.name, onPick: pick(s.name) });
            }
        }
        items.push({
            label: t("Other skill…"),
            freeText: {
                placeholder: t("skill name, as your harness spells it"),
                current: skill,
                commit: (value) => { skill = value?.replace(/^\//, "") || undefined; },
            },
            onPick: () => {},
        });
        return items;
    }

    let openMenu: HTMLElement | null = null;
    function closeMenu(): void {
        openMenu?.remove();
        openMenu = null;
    }

    function makeMenuButton(label: string, items: () => MenuItem[]): HTMLElement {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ui-btn agent-panel-spec-btn";
        btn.textContent = label;
        btn.setAttribute("aria-haspopup", "menu");
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            if (openMenu) { closeMenu(); return; }
            const menu = document.createElement("div");
            menu.className = "agent-panel-menu";
            menu.setAttribute("role", "menu");
            for (const item of items()) {
                if (item.heading) {
                    const head = document.createElement("div");
                    head.className = "ui-heading ui-menu-heading agent-panel-menu-heading";
                    head.textContent = item.label;
                    menu.appendChild(head);
                    continue;
                }
                const row = document.createElement("button");
                row.type = "button";
                row.className = "ui-menu-row agent-panel-menu-row";
                row.setAttribute("role", "menuitemradio");
                row.setAttribute("aria-checked", String(item.checked ?? false));
                row.textContent = item.label;
                if (item.detail) {
                    // textContent, never markup: the detail is a file's own text.
                    const detail = document.createElement("span");
                    detail.className = "agent-panel-menu-detail";
                    detail.textContent = item.detail;
                    row.appendChild(detail);
                }
                if (item.checked) { row.classList.add("agent-panel-menu-row--checked"); }
                row.addEventListener("click", (ev) => {
                    // The panel closes any open menu on a click, which is
                    // right for a click beside one and wrong for a click ON a
                    // row: the free-text row builds a field and the bubbling
                    // click then tore it straight back down.
                    ev.stopPropagation();
                    const free = item.freeText;
                    if (free) {
                        // Swap the menu for a field, in place. Escape returns
                        // to the panel; Enter commits whatever was typed, and
                        // an empty field means "let the harness decide",
                        // which is the same as picking the default row.
                        menu.textContent = "";
                        const field = document.createElement("input");
                        field.type = "text";
                        field.className = "agent-panel-menu-input";
                        field.placeholder = free.placeholder;
                        field.value = free.current ?? "";
                        field.addEventListener("keydown", (ev) => {
                            ev.stopPropagation();
                            if (ev.key === "Enter") {
                                free.commit(field.value.trim() || undefined);
                                renderSpec();
                                closeMenu();
                            } else if (ev.key === "Escape") {
                                closeMenu();
                                textarea.focus();
                            }
                        });
                        menu.appendChild(field);
                        field.focus();
                        return;
                    }
                    item.onPick();
                    closeMenu();
                });
                menu.appendChild(row);
            }
            root.appendChild(menu);
            const r = btn.getBoundingClientRect();
            const rootRect = root.getBoundingClientRect();
            menu.style.left = `${r.left - rootRect.left}px`;
            menu.style.bottom = `${rootRect.bottom - r.top + 6}px`;
            openMenu = menu;
        });
        return btn;
    }

    // ── Sending ─────────────────────────────────────────────────
    /** An attachment whose bytes have not reached disk yet. */
    const pending = (): boolean => attachments.some((a) => a.path === undefined && !a.failed);

    /**
     * Send is refused while a write is still in flight. The alternative was
     * to filter the unresolved ones out, which sends a request quietly
     * missing the file the user attached it for: they watched the chip
     * appear, so silence reads as success. Refusing is visible, and the wait
     * is a disk write.
     */
    function syncSubmitState(): void {
        const blocked = pending();
        submit.disabled = blocked;
        submit.title = blocked ? t("Waiting for attachments…") : t("Send");
    }

    function send(): void {
        const prompt = textarea.value.trim();
        if (!prompt || pending()) { return; }
        host.submit({
            prompt,
            model,
            effort,
            skill,
            // Only what actually reached disk. A chip whose write failed is
            // showing that it failed, and sending its path would point the
            // agent at nothing.
            attachments: attachments.filter((a) => a.path !== undefined && !a.failed).map((a) => a.path!),
        });
    }

    // ── Wiring ──────────────────────────────────────────────────
    textarea.addEventListener("input", autoGrow);
    textarea.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            // Enter sends and Shift+Enter breaks the line: the panel exists
            // for requests longer than one line, so the line break has to be
            // reachable, and Enter is what the slash row already means.
            e.preventDefault();
            send();
            return;
        }
        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            if (openMenu) { closeMenu(); return; }
            host.dismiss();
        }
    });
    textarea.addEventListener("paste", (e) => {
        const files = [...(e.clipboardData?.files ?? [])];
        if (files.length === 0) { return; }
        // Only when the clipboard actually carries files: a normal text
        // paste must stay a text paste.
        e.preventDefault();
        addFiles(files);
    });
    root.addEventListener("dragover", (e) => {
        e.preventDefault();
        root.classList.add("agent-panel--dropping");
    });
    root.addEventListener("dragleave", () => root.classList.remove("agent-panel--dropping"));
    root.addEventListener("drop", (e) => {
        e.preventDefault();
        root.classList.remove("agent-panel--dropping");
        addFiles([...(e.dataTransfer?.files ?? [])]);
    });
    attachBtn.addEventListener("click", () => filePicker.click());
    filePicker.addEventListener("change", () => {
        addFiles([...(filePicker.files ?? [])]);
        filePicker.value = "";
    });
    submit.addEventListener("click", send);
    root.addEventListener("click", () => { if (openMenu) { closeMenu(); } });

    renderChips();
    syncSubmitState();
    renderSpec();
    document.body.appendChild(root);
    // Positioned after mounting, so the measured height is the real one.
    const rect = root.getBoundingClientRect();
    const top = opts.anchor.bottom + rect.height + 8 > window.innerHeight
        ? Math.max(8, opts.anchor.top - rect.height - 8)
        : opts.anchor.bottom + 8;
    root.style.left = `${Math.max(8, Math.min(opts.anchor.left, window.innerWidth - rect.width - 8))}px`;
    root.style.top = `${top}px`;
    textarea.focus();
    autoGrow();

    return {
        el: root,
        setCapabilities(next) { caps = next; renderSpec(); },
        setSkills(next) { skills = next; renderSpec(); },
        resolveAttachment(id, path) {
            const entry = attachments.find((a) => a.id === id);
            if (!entry) { return; }
            if (path === null) { entry.failed = true; } else { entry.path = path; }
            renderChips();
            syncSubmitState();
        },
        destroy() {
            closeMenu();
            for (const a of attachments) {
                if (a.previewUrl) { URL.revokeObjectURL(a.previewUrl); }
            }
            root.remove();
        },
    };
}
