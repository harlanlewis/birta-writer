/**
 * components/graph/folderOverview.ts
 *
 * The folder as a whole (MAR-488): the files the reader has been working in
 * here, and under them a drawing of the notes around the one they opened most
 * recently. A row or a dot opens its note. It is opened on demand, by the
 * `showFolderOverview` command, and never by itself: opening a folder still
 * opens a note.
 *
 * Two layers. `createFolderOverview` builds an element and draws into it, asks
 * the host for nothing, and is handed the index and the recent files, so it can
 * be mounted in any surface. `openFolderOverview` is the one surface that
 * mounts it today, a fullscreen surface set in the document's area (under the
 * top bar, beside a docked file list: `inContent`), and is what asks.
 *
 * The lists come before the drawing. They are what the reader came for, a way
 * back into what they were doing; the drawing is a way to wander from there,
 * and drawn first it pushed the lists below the fold of any short window.
 *
 * The drawing centres on the most recently opened note here that links to
 * anything (`overviewCentre`), not on the folder's most connected note. A
 * hub is a fact about the folder's history, and in a vault of any age it is
 * one cluster of old notes that has nothing to do with today's work; the
 * recent list is the one signal of what today's work is. Only a host that
 * keeps no recent files list, or one with nothing opened here yet, falls back
 * to the hub, because it is then the only centre there is. The centre opens
 * like any other dot, unless it is the note already on screen.
 *
 * It is also the START VIEW, on a host that declares `fileLauncher`: the empty
 * state of a window holding no file, and the same buttons and recent files in
 * a folder's overview:
 *
 *     Folder name  (a folder)
 *     [New Note]  [Open…]
 *     In this folder  (a folder) the folder's own recent files
 *     Recent       the reader's recent files, app-wide
 *     Open Recent…
 *     (a folder)   the drawing
 *
 * A window with no folder draws the same view with no folder sections, pinned
 * (`openStartView`): a Mac window holding no file, which New Window and moving
 * the open note to the Trash leave. One view rather than one per kind of
 * window, so the two offer the same ways out in the same places.
 */
import { t } from "@/i18n";
import {
    FOLDER_INDEX_CHANGED,
    FOLDER_RECENTS_CHANGED,
    RECENT_FILES_CHANGED,
    SUBJECT_NAMES_ANSWERED,
    readFolderIndex,
    type FolderIndexState,
    type RecentFile,
} from "@/links/folderIndex";
import { hostHas } from "../../../shared/hostProfile";
import {
    notifyOpenRecentFile,
    notifyRequestFolderRecents,
    notifyRequestRecentFiles,
    notifyRequestSubjectNames,
    notifyStartAction,
} from "@/messaging";
import { bindActivate } from "@/ui/dom";
import { openFullscreenSurface } from "@/ui/fullscreenSurface";
import { requestIdle } from "@/utils/idle";
import { wireRoving } from "../sidePanel/keyboardNav";
import { folderHub } from "./folderGraph";
import { activityOf, DORMANT_BELOW, fadingNotes, folderSubjects, type FadingNote, type FolderSubject } from "./folderSignals";
import { buildLocalGraph, buildSubjectGraph, layoutRings, type LocalGraph } from "./localGraph";
import type { FolderIndex } from "../../../shared/folderIndex";
import { createRingStage, fill, fillLegend, RING_SIZE } from "./ringStage";
import { ensureLocalGraphStyles } from "./styles";

/** Most recent files the list shows. */
export const OVERVIEW_RECENTS = 8;

/** Most of the reader's recent files the start view lists before Open Recent…. */
export const START_RECENTS = 6;

/** Where the drawing centres, and why, for its caption. */
export interface OverviewCentre {
    graph: LocalGraph;
    /**
     * `active`: the note the reader has been working in most recently, by
     * what they opened and what they wrote (`activityOf`); `hub`: the
     * folder's most connected, when nothing about the reader's work is known.
     */
    reason: "active" | "hub";
}

/**
 * The note the overview's drawing centres on: the most active note that
 * links or is linked to, with its two rings. Activity is `activityOf`'s:
 * the recent files and how recently each note was written, so a note opened
 * a minute ago and a note saved this morning both count, and on a host with
 * no recent files list the dates alone still find today's work.
 *
 * The folder's hub only when nothing about the reader's work is known: no
 * recent files and no dates. Null when that work is known and none of it
 * links anywhere: the hub would be a drawing of somewhere else, which is the
 * one thing this view exists not to show.
 */
export function overviewCentre(index: FolderIndex, recents: readonly string[] | null,
                               activity: ReadonlyMap<string, number | null>): OverviewCentre | null {
    const drawable = (path: string): LocalGraph | null => {
        const graph = buildLocalGraph(index, path, 2);
        return graph && graph.nodes.length >= 2 ? graph : null;
    };
    const rank = new Map([...new Set(recents ?? [])].map((p, i) => [p, i]));
    // Only a note something references, or that references anything, can be
    // drawn: tried in order of activity, the first is drawable, where trying
    // the most active notes whatever their links could reach a cut-off
    // before reaching a note that links (a month of daily notes, say).
    const linked = new Set<string>();
    for (const e of index.edges) {
        if (e.to === e.from) { continue; }
        linked.add(e.from);
        if (e.to !== null) { linked.add(e.to); }
    }
    const known = [...activity.entries()]
        .filter((e): e is [string, number] => typeof e[1] === "number" && linked.has(e[0]))
        .sort((a, b) => b[1] - a[1] || (rank.get(a[0]) ?? Infinity) - (rank.get(b[0]) ?? Infinity) || a[0].localeCompare(b[0]));
    if ([...activity.values()].some((a) => typeof a === "number")) {
        for (const [path] of known) {
            const graph = drawable(path);
            if (graph) { return { graph, reason: "active" }; }
        }
        return null;
    }
    const hub = folderHub(index);
    const graph = hub !== null ? drawable(hub) : null;
    return graph ? { graph, reason: "hub" } : null;
}

/** A host that can name subjects better than their shared words can (`subjectNames`). */
export type SubjectNamer = (subjects: readonly FolderSubject[], index: FolderIndex) => Promise<ReadonlyMap<string, string>>;

/** "3 months ago", from the day a note was last written. */
export function sinceWritten(modified: number, now: number): string {
    const days = Math.max(0, Math.floor((now - modified) / 86_400_000));
    if (days < 60) { return fill(t("{0} days ago"), String(days)); }
    const months = Math.floor(days / 30.4);
    if (months < 24) { return fill(t("{0} months ago"), String(months)); }
    return fill(t("{0} years ago"), String(Math.floor(days / 365)));
}

/** The host's ways to a document, for the start view's buttons and rows. */
export interface StartLauncher {
    newNote: () => void;
    open: () => void;
    /** Open one of the recent files, by the path the host listed it under. */
    openRecent: (path: string) => void;
    /** Pop the host's Open Recent menu under `anchor`, in viewport coordinates. */
    openRecentMenu: (anchor: DOMRect) => void;
}

/**
 * The host's ways to a document, when it declares them (`fileLauncher`).
 * Here, in the lazy chunk, rather than beside the command that asks for it,
 * because nothing at launch needs it. The menu goes under the row that asked,
 * at its bottom-left corner, which is where a pop-up menu from a control is
 * placed on a Mac.
 */
export function hostLauncher(): StartLauncher | undefined {
    if (!hostHas("fileLauncher")) { return undefined; }
    return {
        newNote: () => notifyStartAction("newNote"),
        open: () => notifyStartAction("open"),
        openRecent: (path) => notifyOpenRecentFile(path),
        openRecentMenu: (anchor) => notifyStartAction("openRecentMenu", { x: anchor.left, y: anchor.bottom }),
    };
}

/** How many of a subject's notes a host is told the names of: its most bound in. */
export const NAMED_FROM_NOTES = 12;

/** How long a host has to name the subjects before the page stops listening for it. */
export const SUBJECT_NAMES_TIMEOUT_MS = 30_000;

let nextNamesRequest = 1;

/**
 * Names a host gave, by subject and members (`subjectKey`), and the subjects
 * it has been asked about, for the life of the page rather than of one view:
 * a host's model takes a moment per subject, and the same folder opened twice
 * is the same question twice. A subject whose members change is a new key.
 */
const hostNames = new Map<string, string>();
const askedNames = new Set<string>();
/** Forget every host name and question, for tests that each start from a page that asked nothing. */
export function resetSubjectNamesForTests(): void {
    hostNames.clear();
    askedNames.clear();
}

const subjectKey = (subject: FolderSubject): string => `${subject.id}\u0000${subject.members.join("\u0000")}`;

/**
 * The host's subject namer, when it declares one (`subjectNames`). What it is
 * told is the least a name can be made from: each subject's most bound-in
 * note NAMES and the tags its notes carry most, never a note's text. An
 * answer that never comes, after `SUBJECT_NAMES_TIMEOUT_MS`, is no names.
 */
export function hostSubjectNamer(): SubjectNamer | undefined {
    if (!hostHas("subjectNames")) { return undefined; }
    return (subjects, index) => new Promise((resolve) => {
        const requestId = nextNamesRequest++;
        const nodes = new Map(index.nodes.map((n) => [n.path, n]));
        const payload = subjects.map((subject) => {
            const tagCount = new Map<string, number>();
            for (const m of subject.members) {
                for (const tag of nodes.get(m)?.tags ?? []) { tagCount.set(tag, (tagCount.get(tag) ?? 0) + 1); }
            }
            return {
                id: subject.id,
                notes: subject.members.slice(0, NAMED_FROM_NOTES).map((m) => nodes.get(m)?.name ?? m),
                tags: [...tagCount.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([tag]) => tag),
            };
        });
        const done = (names: ReadonlyMap<string, string>): void => {
            window.removeEventListener(SUBJECT_NAMES_ANSWERED, onAnswer);
            clearTimeout(timer);
            resolve(names);
        };
        const onAnswer = (e: Event): void => {
            const detail = (e as CustomEvent<{ requestId: number; names: Record<string, string> }>).detail;
            if (detail.requestId === requestId) { done(new Map(Object.entries(detail.names))); }
        };
        const timer = setTimeout(() => done(new Map()), SUBJECT_NAMES_TIMEOUT_MS);
        window.addEventListener(SUBJECT_NAMES_ANSWERED, onAnswer);
        notifyRequestSubjectNames(requestId, payload);
    });
}

export interface FolderOverviewHost {
    /** Open a note by its root-relative path. */
    openNote: (path: string) => void;
    /** Where Escape sends focus. */
    onEscape: () => void;
    /**
     * The host's ways to a document. Absent on a host that has none to give
     * (no `fileLauncher`), which draws neither the buttons nor the reader's
     * recent files.
     */
    launcher?: StartLauncher;
    /** Whether the view is of a folder: false draws no graph and no folder list. */
    folder?: boolean;
    /**
     * Whether a `null` recents list means NOT YET rather than never: the
     * drawing then waits for it, because the centre is chosen from it and a
     * drawing made without it would be the hub's, replaced a moment later.
     */
    recentsAwaited?: boolean;
    /** The clock the activity and fading answers are taken against; `Date.now` unless a test holds it. */
    now?: () => number;
    /** Better names for the subjects, from the host; absent, they keep the names their notes give them. */
    nameSubjects?: SubjectNamer;
    /**
     * Runs the subjects' finding once the view is on screen (`afterPaint`):
     * it is the one answer here that scales past a frame on a large folder,
     * and nothing on screen waits for it. A test runs it at once.
     */
    defer?: (run: () => void) => void;
}

/**
 * Run `run` after the next paint, in an idle slot: one animation frame, so
 * the frame that draws the overview goes first, then `requestIdle`, which on
 * WebKit (no `requestIdleCallback`) is a timeout past that frame.
 */
function afterPaint(run: () => void): void {
    const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => number }).requestAnimationFrame;
    if (raf) { raf(() => { requestIdle(run, 500); }); } else { requestIdle(run, 500); }
}

export interface FolderOverview {
    element: HTMLElement;
    /**
     * Draw the folder. `state` is the folder index (null while it has not
     * arrived; its `self`, the note on screen, is read only to draw that note
     * current should it be the centre). `recents` are root-relative paths,
     * most recent first, or null from a host that keeps no recent files list,
     * which draws no section for them at all.
     */
    render: (state: FolderIndexState | null, recents: readonly string[] | null,
             files?: readonly RecentFile[] | null) => void;
    /** Move keyboard focus onto the first recent file, else the graph. */
    focusFirst: () => void;
}

export function createFolderOverview(host: FolderOverviewHost): FolderOverview {
    ensureLocalGraphStyles();
    const element = document.createElement("div");
    element.className = "fo";
    const folder = host.folder !== false;
    const launcher = host.launcher;

    const stage = createRingStage({ openNote: host.openNote, onEscape: host.onEscape, centreIsCurrent: false });
    // The folder's name, in the column rather than in a pill over it: the
    // pill floated in the corner the Mac app's titlebar controls sit in.
    const title = document.createElement("h2");
    title.className = "fo-title";
    const caption = document.createElement("div");
    caption.className = "lg-caption fo-caption";
    const legend = document.createElement("div");
    legend.className = "lg-legend";

    const recentHead = document.createElement("div");
    recentHead.className = "ui-heading ui-menu-heading fo-heading";
    // Beside the reader's own recent files, the folder's list is named for
    // where it is rather than for when.
    recentHead.textContent = launcher ? t("In this folder") : t("Recent files");
    const recentList = document.createElement("div");
    recentList.className = "fo-recents";
    recentList.setAttribute("role", "group");
    recentList.setAttribute("aria-label", t("Recent files"));
    const recentEmpty = document.createElement("div");
    recentEmpty.className = "fo-empty";
    recentEmpty.textContent = t("Nothing in this folder has been opened yet");

    // The start view's: the two buttons above everything, and the reader's
    // recent files, closed by Open Recent…, below everything.
    const actions = document.createElement("div");
    actions.className = "fo-actions";
    const newButton = launchButton(t("New Note"), "ui-btn--primary", () => launcher?.newNote());
    const openButton = launchButton(t("Open…"), "ui-btn--secondary", () => launcher?.open());
    actions.append(newButton, openButton);
    const filesHead = document.createElement("div");
    filesHead.className = "ui-heading ui-menu-heading fo-heading";
    filesHead.textContent = t("Recent");
    const filesList = document.createElement("div");
    filesList.className = "fo-recents fo-files";
    filesList.setAttribute("role", "group");
    filesList.setAttribute("aria-label", t("Recent"));
    const moreRow = document.createElement("button");
    moreRow.className = "ui-menu-row fg-row fo-more";
    moreRow.tabIndex = -1;
    moreRow.textContent = t("Open Recent…");
    bindActivate(moreRow, () => launcher?.openRecentMenu(moreRow.getBoundingClientRect()));

    // What the folder is about, as groups that cross its folders, and what
    // it has moved past: ./folderSignals.ts. A subject row draws the subject
    // in the square under it, which is why the list sits right above it.
    const subjectsHead = document.createElement("div");
    subjectsHead.className = "ui-heading ui-menu-heading fo-heading";
    subjectsHead.textContent = t("Subjects");
    const subjectsList = document.createElement("div");
    subjectsList.className = "fo-recents fo-subjects";
    subjectsList.setAttribute("role", "group");
    subjectsList.setAttribute("aria-label", t("Subjects"));
    // Who named them, whenever a host's model did (AI_ASSISTANCE's rule that
    // an advisory says who is speaking): a name the notes give needs no
    // credit, and one a model gave must not pass for the notes' own.
    const subjectsCredit = document.createElement("div");
    subjectsCredit.className = "fo-empty fo-credit";
    subjectsCredit.textContent = t("Named by the on-device model, from note names and tags");
    subjectsCredit.hidden = true;
    const fadingHead = document.createElement("div");
    fadingHead.className = "ui-heading ui-menu-heading fo-heading";
    fadingHead.textContent = t("Fading");
    const fadingList = document.createElement("div");
    fadingList.className = "fo-recents fo-fading-list";
    fadingList.setAttribute("role", "group");
    fadingList.setAttribute("aria-label", t("Fading"));

    if (folder) { element.append(title); }
    if (launcher) { element.append(actions); }
    if (folder) { element.append(recentHead, recentList, recentEmpty); }
    if (launcher) { element.append(filesHead, filesList); }
    if (folder) { element.append(subjectsHead, subjectsList, subjectsCredit, stage.element, caption, legend, fadingHead, fadingList); }

    const recentRoving = wireRoving({
        container: recentList,
        items: () => [...recentList.querySelectorAll<HTMLElement>(".fo-row")],
        onEscape: host.onEscape,
    });
    const filesRoving = wireRoving({
        container: filesList,
        items: () => [...filesList.querySelectorAll<HTMLElement>(".fo-file, .fo-more")],
        onEscape: host.onEscape,
    });
    const subjectsRoving = wireRoving({
        container: subjectsList,
        items: () => [...subjectsList.querySelectorAll<HTMLElement>(".fo-subject")],
        onEscape: host.onEscape,
    });
    const fadingRoving = wireRoving({
        container: fadingList,
        items: () => [...fadingList.querySelectorAll<HTMLElement>(".fo-fading")],
        onEscape: host.onEscape,
    });

    const now = host.now ?? Date.now;
    // What was last drawn from, so a subject row can redraw the square on its
    // own, and what the signals were computed for, so a redraw that changed
    // neither the index nor the recent files does not compute them again.
    let lastState: FolderIndexState | null = null;
    let lastRecents: readonly string[] | null = null;
    let signals: { index: FolderIndex; recents: readonly string[] | null; activity: Map<string, number | null>;
        subjects: FolderSubject[] | null; fading: FadingNote[] } | null = null;
    const defer = host.defer ?? afterPaint;
    /** The subject drawn in the square, by id; null for the reader's own work. */
    let chosenSubject: string | null = null;
    const nameKey = subjectKey;

    /**
     * Activity and fading at once, since the drawing's centre and the Fading
     * list read them and both are a walk of the references. Subjects later,
     * after the view has painted (`defer`): finding communities is the one
     * cost here that grows past a frame on a folder at the index's cap, and
     * only the Subjects list waits for it, which appears when it lands.
     */
    function signalsFor(index: FolderIndex, recents: readonly string[] | null) {
        if (signals && signals.index === index && signals.recents === recents) { return signals; }
        const activity = activityOf(index, recents, now());
        // The last answer's subjects stay up while this one's are found: a
        // folder that changes under an open overview would otherwise blank
        // its Subjects list, and drop the focus and the choice held in it.
        const mine = { index, recents, activity, subjects: signals?.subjects ?? null, fading: fadingNotes(index, recents, now()) };
        signals = mine;
        defer(() => {
            // Superseded meanwhile (a newer index or list has its own on the
            // way), or the view has gone: nothing is left to draw it into.
            if (signals !== mine || !element.isConnected) { return; }
            mine.subjects = folderSubjects(index, activity);
            askNames(mine.subjects, index);
            drawSubjects();
            if (chosenSubject !== null) { redrawGraph(); }
        });
        return signals;
    }

    /** Ask the host, once per subject as it stands, for names; draw them as they come. */
    function askNames(subjects: readonly FolderSubject[], index: FolderIndex): void {
        const fresh = subjects.filter((s) => !askedNames.has(nameKey(s)));
        if (!host.nameSubjects || fresh.length === 0) { return; }
        fresh.forEach((s) => askedNames.add(nameKey(s)));
        void host.nameSubjects(fresh, index).then((names) => {
            let changed = false;
            for (const s of fresh) {
                const name = names.get(s.id)?.trim();
                if (name) { hostNames.set(nameKey(s), name); changed = true; }
            }
            if (changed && signals?.index === index) { drawSubjects(); redrawGraph(); }
        }, () => {
            // A namer that failed leaves the names the notes give: nothing to
            // tell the reader, since those names were already on screen.
        });
    }

    const subjectName = (subject: FolderSubject): string => hostNames.get(nameKey(subject)) ?? subject.name;

    /** A row's place, as the run its cell elides from the start (./styles.ts). */
    function where(text: string): HTMLSpanElement {
        const span = document.createElement("span");
        span.textContent = text;
        return span;
    }

    function launchButton(label: string, kind: string, run: () => void): HTMLButtonElement {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `ui-btn ${kind} fo-action`;
        btn.textContent = label;
        bindActivate(btn, run);
        return btn;
    }

    function redrawGraph(): void { drawGraph(lastState, lastRecents); }

    function drawGraph(state: FolderIndexState | null, recents: readonly string[] | null): void {
        stage.clear();
        legend.replaceChildren();
        title.textContent = state?.index?.rootName ?? "";
        title.hidden = !state?.index;
        if (!state) {
            signals = null;
            stage.element.hidden = true;
            caption.textContent = t("Reading the folder…");
            return;
        }
        if (recents === null && host.recentsAwaited) {
            signals = null;
            stage.element.hidden = true;
            caption.textContent = "";
            return;
        }
        if (!state.index) {
            signals = null;
            stage.element.hidden = true;
            caption.textContent = t("This folder has no notes to draw");
            return;
        }
        const { activity, subjects } = signalsFor(state.index, recents);
        const subject = subjects?.find((s) => s.id === chosenSubject) ?? null;
        // A chosen subject the folder no longer has goes; one whose subjects
        // are still being found stays chosen and is drawn when they land.
        if (chosenSubject !== null && subjects !== null && !subject) { chosenSubject = null; }
        const centre = subject
            ? { graph: buildSubjectGraph(state.index, subject.core, [...subject.members, ...subject.also], subject.nearCore)!, reason: "subject" as const }
            : overviewCentre(state.index, recents, activity);
        if (!centre) {
            stage.element.hidden = true;
            caption.textContent = recents !== null && recents.length > 0
                ? t("None of the notes you opened here links to another")
                : t("No note in this folder links to another");
            return;
        }
        stage.element.hidden = false;
        const laid = layoutRings(centre.graph, RING_SIZE);
        laid.nodes.forEach((n) => { n.activity = activity.get(n.id) ?? null; });
        stage.draw(laid, laid.nodes[0]!.id === state.self);
        const notes = [centre.reason === "subject"
            ? fill(t("{0}: {1} notes, around {2}"), subjectName(subject!), String(subject!.members.length), laid.nodes[0]!.label)
            : fill(centre.reason === "active"
                ? t("Around {0}, where you have been working")
                : t("Centred on {0}, the most connected note here"), laid.nodes[0]!.label)];
        if (laid.omitted > 0) {
            notes.push(fill(t("{0} more not shown"), String(laid.omitted)));
        }
        if (laid.nodes.some((n) => n.activity !== null && n.activity !== undefined && n.activity < DORMANT_BELOW)) {
            notes.push(t("Faded dots have not been touched in months"));
        }
        if (state.index.truncated) {
            notes.push(t("This folder has more notes than its index reads"));
        }
        caption.textContent = notes.join(". ");
        fillLegend(legend, laid);
    }

    /**
     * The subjects, liveliest first. A row draws its subject in the square
     * below and says so (`aria-pressed`); pressing it again, or the row of the
     * subject already drawn, goes back to the reader's own work.
     */
    function drawSubjects(): void {
        // The rows are rebuilt, so the one holding focus is found again by
        // its subject rather than dropped to the body with the arrows and
        // Escape going nowhere.
        const held = document.activeElement instanceof HTMLElement && subjectsList.contains(document.activeElement)
            ? document.activeElement.dataset["subject"] ?? null : null;
        const subjects = signals?.subjects ?? [];
        subjectsHead.hidden = subjects.length === 0;
        subjectsList.hidden = subjects.length === 0;
        const rows = subjects.map((subject) => {
            const btn = document.createElement("button");
            btn.className = "ui-menu-row fg-row fo-subject";
            btn.tabIndex = -1;
            btn.dataset["subject"] = subject.id;
            btn.setAttribute("aria-pressed", String(subject.id === chosenSubject));
            const label = document.createElement("span");
            label.className = "fg-row-label";
            label.textContent = subjectName(subject);
            const detail = document.createElement("span");
            detail.className = "fg-row-detail";
            const dormant = subject.activity !== null && subject.activity < DORMANT_BELOW;
            detail.textContent = dormant
                ? fill(t("{0} notes, quiet"), String(subject.members.length))
                : fill(t("{0} notes"), String(subject.members.length));
            btn.title = subject.members.slice(0, 6).join("\n");
            btn.append(label, detail);
            bindActivate(btn, () => {
                chosenSubject = chosenSubject === subject.id ? null : subject.id;
                drawSubjects();
                redrawGraph();
            });
            return btn;
        });
        subjectsList.replaceChildren(...rows);
        subjectsCredit.hidden = !subjects.some((subject) => hostNames.has(nameKey(subject)));
        subjectsRoving.refresh();
        if (held !== null) {
            rows.find((row) => row.dataset["subject"] === held)?.focus();
        }
    }

    /** The notes the folder has moved past: a row opens its note. */
    function drawFading(index: FolderIndex | null): void {
        const fading = signals?.fading ?? [];
        fadingHead.hidden = fading.length === 0;
        fadingList.hidden = fading.length === 0;
        const names = new Map(index?.nodes.map((n) => [n.path, n.name]) ?? []);
        const rows = fading.map((note) => {
            const btn = document.createElement("button");
            btn.className = "ui-menu-row fg-row fo-fading";
            btn.tabIndex = -1;
            btn.title = note.path;
            btn.dataset["fading"] = note.path;
            const label = document.createElement("span");
            label.className = "fg-row-label";
            label.textContent = names.get(note.path) ?? note.path;
            const detail = document.createElement("span");
            detail.className = "fg-row-detail";
            detail.textContent = fill(t("{0} links, written {1}"), String(note.degree), sinceWritten(note.modified, now()));
            btn.append(label, detail);
            bindActivate(btn, () => host.openNote(note.path));
            return btn;
        });
        fadingList.replaceChildren(...rows);
        fadingRoving.refresh();
    }

    function drawRecents(state: FolderIndexState | null, recents: readonly string[] | null): void {
        recentHead.hidden = recents === null;
        if (recents === null) {
            recentList.replaceChildren();
            recentList.hidden = true;
            recentEmpty.hidden = true;
            recentRoving.refresh();
            return;
        }
        const names = new Map(state?.index?.nodes.map((n) => [n.path, n.name]) ?? []);
        const rows = [...new Set(recents)].slice(0, OVERVIEW_RECENTS).map((path) => {
            const parts = path.split("/");
            const file = parts.pop()!;
            const btn = document.createElement("button");
            btn.className = "ui-menu-row fg-row fo-row";
            btn.tabIndex = -1;
            btn.title = path;
            btn.dataset["path"] = path;
            const label = document.createElement("span");
            label.className = "fg-row-label";
            label.textContent = names.get(path) ?? file;
            btn.append(label);
            // Where it is, when it is not at the root: two notes called
            // "index" in two folders are otherwise one row twice.
            if (parts.length > 0) {
                const detail = document.createElement("span");
                detail.className = "fg-row-detail fo-row-where";
                detail.append(where(parts.join("/")));
                btn.append(detail);
            }
            bindActivate(btn, () => host.openNote(path));
            return btn;
        });
        recentList.replaceChildren(...rows);
        recentList.hidden = rows.length === 0;
        recentEmpty.hidden = rows.length > 0;
        recentRoving.refresh();
    }

    /**
     * The reader's recent files, at most `START_RECENTS`, then Open Recent…,
     * which is drawn even before the list arrives and with nothing in it: it
     * is the way to everything past the six, and to the host's own menu.
     */
    function drawFiles(files: readonly RecentFile[] | null): void {
        const rows = (files ?? []).slice(0, START_RECENTS).map((file) => {
            const btn = document.createElement("button");
            btn.className = "ui-menu-row fg-row fo-file";
            btn.tabIndex = -1;
            btn.title = file.path;
            btn.dataset["file"] = file.path;
            const label = document.createElement("span");
            label.className = "fg-row-label";
            label.textContent = file.name;
            btn.append(label);
            if (file.detail) {
                const detail = document.createElement("span");
                detail.className = "fg-row-detail fo-row-where";
                detail.append(where(file.detail));
                btn.append(detail);
            }
            bindActivate(btn, () => launcher?.openRecent(file.path));
            return btn;
        });
        filesList.replaceChildren(...rows, moreRow);
        filesRoving.refresh();
    }

    return {
        element,
        render: (state, recents, files = null) => {
            if (folder) {
                lastState = state;
                lastRecents = recents;
                drawGraph(state, recents);
                drawRecents(state, recents);
                drawSubjects();
                drawFading(state?.index ?? null);
            }
            if (launcher) { drawFiles(files); }
        },
        focusFirst: () => {
            if (folder && !recentList.hidden) { recentRoving.focusFirst(); return; }
            if (folder && !stage.element.hidden) { stage.focusFirst(); return; }
            if (launcher) { newButton.focus(); return; }
            stage.focusFirst();
        },
    };
}

export interface FolderOverviewSurfaceHost {
    /** Open a note by its root-relative path, in this window. */
    openNote: (path: string) => void;
    /** Where focus goes once the overview is dismissed without opening a note. */
    onDismiss: () => void;
    /** The host's ways to a document; see `FolderOverviewHost.launcher`. */
    launcher?: StartLauncher;
    /** The host's subject namer; see `FolderOverviewHost.nameSubjects`. */
    nameSubjects?: SubjectNamer;
    /**
     * The start view of a window with no file: no folder sections, no way to
     * dismiss it, and the title says the window holds nothing.
     */
    empty?: boolean;
}

export interface FolderOverviewHandle {
    /** Close it, as Escape does. */
    close: () => void;
    /** Bring keyboard focus back into it, to the first recent file or dot. */
    focus: () => void;
    /** Whether it is still up: false from the first moment of its close. */
    isOpen: () => boolean;
}

/**
 * Open the overview in place of the document, on the fullscreen surface the
 * whole-folder graph uses, set in the document's area (`inContent`) so the top
 * bar and a docked file list stay usable beside it. Escape, Close or a click
 * on the ground puts the page back as it was; a dot or a row closes it and opens that note. It asks the host for the
 * index (once per page, as every view of it does) and for the recent files
 * (every opening), and redraws as either arrives.
 */
export function openFolderOverview(host: FolderOverviewSurfaceHost): FolderOverviewHandle {
    let openingNote = false;
    let open = true;
    // This opening's answer, null until it comes: a host that keeps no list
    // never answers, and the section is then never drawn.
    let recents: readonly string[] | null = null;
    // The reader's recent files, likewise this opening's answer.
    let files: readonly RecentFile[] | null = null;
    const empty = host.empty === true;
    // What the region is called, for a screen reader: the folder's own name
    // is drawn in the column, and the window's title already says a window
    // holding nothing is Birta Writer.
    const labelFor = (state: FolderIndexState | null): string => empty
        ? t("No File Open")
        : state?.index
            ? fill(t("Folder: {0}"), state.index.rootName)
            : t("Folder");
    const surface = openFullscreenSurface({
        ground: "canvas",
        className: "fo-surface",
        pinned: empty,
        inContent: true,
        onClose: () => {
            open = false;
            window.removeEventListener(FOLDER_INDEX_CHANGED, redraw);
            window.removeEventListener(FOLDER_RECENTS_CHANGED, onRecents);
            window.removeEventListener(RECENT_FILES_CHANGED, onFiles);
            if (!openingNote) { host.onDismiss(); }
        },
    });
    surface.overlay.setAttribute("aria-label", labelFor(readFolderIndex()));
    surface.setCanvasColor("var(--vscode-editor-background)");
    // A button that goes somewhere else leaves the view as a row does: a new
    // note or an opened file is the next thing on screen, and the view would
    // only be in its way. The Open panel and the Open Recent menu can be
    // cancelled, so the view stays under them. Pinned, nothing closes it:
    // the window is rebound, which reloads the page.
    const leaving = (run: () => void) => () => {
        if (!empty) { surface.close(); }
        run();
    };
    const launcher: StartLauncher | undefined = host.launcher && {
        newNote: leaving(host.launcher.newNote),
        open: host.launcher.open,
        openRecent: (path) => leaving(() => host.launcher!.openRecent(path))(),
        openRecentMenu: host.launcher.openRecentMenu,
    };
    const view = createFolderOverview({
        openNote: (path) => {
            openingNote = true;
            surface.close();
            host.openNote(path);
        },
        onEscape: () => { if (!empty) { surface.close(); } },
        ...(launcher ? { launcher } : {}),
        folder: !empty,
        // A host with a launcher keeps the reader's recent files, so it
        // answers this opening's request; one without may never answer.
        recentsAwaited: !empty && launcher !== undefined,
        ...(host.nameSubjects ? { nameSubjects: host.nameSubjects } : {}),
    });
    surface.content.append(view.element);

    // Focus follows what has arrived (the first recent file, else the first
    // dot) until the reader touches the overview, and then is never moved
    // again. The index and the recent files arrive in either order, so a rule
    // that placed focus once would land on the graph whenever the index won.
    let touched = false;
    const touch = (): void => { touched = true; };
    surface.overlay.addEventListener("keydown", touch, true);
    surface.overlay.addEventListener("mousedown", touch, true);
    function redraw(): void {
        const state = readFolderIndex();
        surface.overlay.setAttribute("aria-label", labelFor(state));
        // A redraw rebuilds every row and dot, so the one holding focus is
        // found again by what it names rather than dropped to the body.
        const held = document.activeElement instanceof HTMLElement && view.element.contains(document.activeElement)
            ? document.activeElement : null;
        // Each kind of row names itself by its own attribute; a control that
        // is never rebuilt (a button, Open Recent…) keeps focus by itself.
        const attr = held ? ["data-path", "data-id", "data-file", "data-subject", "data-fading"].find((a) => held.hasAttribute(a)) ?? null : null;
        const heldName = attr ? held!.getAttribute(attr) : null;
        view.render(state, recents, files);
        if (!touched) {
            view.focusFirst();
        } else if (attr !== null && heldName !== null) {
            const again = [...view.element.querySelectorAll<HTMLElement>(`[${attr}]`)]
                .find((el) => el.getAttribute(attr) === heldName);
            if (again) { again.focus(); } else { view.focusFirst(); }
        }
    }
    window.addEventListener(FOLDER_INDEX_CHANGED, redraw);
    function onRecents(e: Event): void {
        recents = (e as CustomEvent<string[]>).detail;
        redraw();
    }
    window.addEventListener(FOLDER_RECENTS_CHANGED, onRecents);
    function onFiles(e: Event): void {
        files = (e as CustomEvent<RecentFile[]>).detail;
        redraw();
    }
    window.addEventListener(RECENT_FILES_CHANGED, onFiles);
    if (!empty) { notifyRequestFolderRecents(); }
    if (launcher) { notifyRequestRecentFiles(); }
    redraw();
    return {
        close: () => surface.close(),
        focus: () => view.focusFirst(),
        isOpen: () => open,
    };
}
