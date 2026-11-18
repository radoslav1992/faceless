import { Fragment, jsxDEV as reactJsxDEV } from "react/jsx-dev-runtime";
import { translateProps } from "./translate";

// The development twin of jsx-runtime.ts.
export { Fragment };
export const jsxDEV: typeof reactJsxDEV = (type, props, key, isStatic, source, self) =>
  reactJsxDEV(type, translateProps(type, props), key, isStatic, source, self);
