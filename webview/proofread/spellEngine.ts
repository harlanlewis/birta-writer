/**
 * The actual nspell instance with the bundled English dictionary.
 *
 * This module is ONLY loaded via dynamic import (see engine.ts) so the
 * ~550 KB dictionary lands in a lazily fetched chunk instead of webview.js.
 */
import nspell from "nspell";
import aff from "./dict/en.aff";
import dic from "./dict/en.dic";

const spell = nspell({ aff, dic });

export default spell;
