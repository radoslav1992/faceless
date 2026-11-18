import { Fragment, jsx as reactJsx, jsxs as reactJsxs } from "react/jsx-runtime";
import { translateProps } from "./translate";

// Реч БГ's JSX runtime (vite.config.ts sets it as the JSX import source for that site only): React's own, with the
// text of every element translated on the way in. Hookstreak is built with React's runtime and never loads this.
export { Fragment };
export const jsx: typeof reactJsx = (type, props, key) => reactJsx(type, translateProps(type, props), key);
export const jsxs: typeof reactJsxs = (type, props, key) => reactJsxs(type, translateProps(type, props), key);
