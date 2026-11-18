// Loaded first on Реч БГ only (vite.config.ts adds it to src/main.tsx): what the site needs besides its words.
// The display font of Hookstreak has no Cyrillic letters, so headings use Manrope, with its Bulgarian letterforms.
import "@fontsource-variable/manrope";
import "./rechbg.css";
import { untranslated } from "../../shared/i18n";

document.documentElement.lang = "bg";
// For scripts/untranslated.mjs: the texts shown so far that have no translation.
(window as unknown as { __untranslated?: () => string[] }).__untranslated = untranslated;
