/**
 * components/pathBar/icons.ts
 *
 * The path bar's three root icons, in the convention of the shared library
 * (`ui/icons.ts`, Lucide-style, 24-unit box) but kept in the bar's own lazy
 * chunk: the library is on the launch path, and only a page that draws a path
 * bar needs these.
 */
const attrs = `width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;

const svg = (content: string) => `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${content}</svg>`;

/** The home folder, iCloud Drive, and a volume: the places the Finder starts a path from. */
export const IconHome        = svg(`<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>`);
export const IconCloud       = svg(`<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>`);
export const IconHardDrive   = svg(`<line x1="22" x2="2" y1="12" y2="12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" x2="6.01" y1="16" y2="16"/><line x1="10" x2="10.01" y1="16" y2="16"/>`);
