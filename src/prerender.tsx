import { prerender } from "react-dom/static";
import { StaticRouter } from "react-router-dom";
import { App } from "./App";
import { ToastProvider } from "./ui";
import { publicPages } from "../shared/seo";

// The public pages rendered to HTML at build (scripts/prerender.mjs), so crawlers that run no JavaScript read their
// words; the browser then takes over the same markup (main.tsx). Rendered as before anyone is signed in.

/** The public pages' paths. */
export const routes = Object.keys(publicPages);

/** The HTML inside #root for `url`, lazy pages included (prerender waits for them). */
export async function render(url: string): Promise<string> {
  const { prelude } = await prerender(
    <StaticRouter location={url}>
      <ToastProvider>
        <App />
      </ToastProvider>
    </StaticRouter>,
  );
  return new Response(prelude).text();
}
