/** esbuild text-loader imports for the vendored Hunspell dictionary files */
declare module "*.aff" {
    const content: string;
    export default content;
}
declare module "*.dic" {
    const content: string;
    export default content;
}

/** Minimal typings for nspell (no official @types package) */
declare module "nspell" {
    export type NSpell = {
        correct(word: string): boolean;
        suggest(word: string): string[];
        add(word: string): NSpell;
    };
    export default function nspell(dictionary: { aff: string; dic: string }): NSpell;
}
