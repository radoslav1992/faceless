import { t } from "../../shared/i18n";

// What the translating JSX runtime changes: the text an element is given to show (its string children) and the words
// in the attributes people read or hear. Components get the same treatment as HTML elements, because a library's
// component (a router link, say) builds its own element out of our sight; translating a text twice changes nothing.
const ATTRIBUTES = ["placeholder", "title", "aria-label", "alt"] as const;
/** Elements whose text is not prose. */
const VERBATIM = new Set(["script", "style", "code", "pre", "textarea", "title"]);
const text = (child: unknown) => (typeof child === "string" ? t(child) : child);

/**
 * The props of an element with its words translated. An element marked `translate="no"` (the HTML attribute: names,
 * titles and other words people typed) keeps its own text.
 */
export function translateProps<P>(type: unknown, props: P): P {
  if (!props || typeof props !== "object") return props;
  const given = props as Record<string, unknown>;
  if (given.translate === "no" || (typeof type === "string" && VERBATIM.has(type))) return props;
  let next: Record<string, unknown> | null = null;
  const set = (name: string, value: unknown) => { if (value !== given[name]) (next ??= { ...given })[name] = value; };
  const { children } = given;
  if (typeof children === "string") set("children", t(children));
  else if (Array.isArray(children)) {
    const said = children.map(text);
    if (said.some((child, i) => child !== children[i])) set("children", said);
  }
  for (const name of ATTRIBUTES) if (typeof given[name] === "string") set(name, t(given[name] as string));
  return (next ?? props) as P;
}
