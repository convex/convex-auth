import { docs } from "collections/server";
import { loader, type LoaderPlugin } from "fumadocs-core/source";
import { lucideIconsPlugin } from "fumadocs-core/source/lucide-icons";
import type { ReactNode } from "react";
import { docsContentRoute, docsImageRoute, docsRoute } from "./shared";

const apiRoute = "/api/";

/** The last segment of an import path, for example `convex.config` for `components/anonymous/convex.config`. */
function lastSegment(name: ReactNode): ReactNode {
  return typeof name === "string"
    ? name.slice(name.lastIndexOf("/") + 1)
    : name;
}

/**
 * The title of an API reference page is the full import path. The sidebar
 * nests the pages by path, thus it shows only the last segment. The page
 * heading keeps the full path.
 */
const apiSidebarTitlesPlugin: LoaderPlugin = {
  name: "convex-auth:api-sidebar-titles",
  transformPageTree: {
    file(node) {
      if (!node.url.startsWith(apiRoute)) return node;
      return { ...node, name: lastSegment(node.name) };
    },
    folder(node) {
      if (!node.index?.url.startsWith(apiRoute)) return node;
      return { ...node, name: lastSegment(node.name) };
    },
  },
};

// See https://fumadocs.dev/docs/headless/source-api for more info
export const source = loader({
  baseUrl: docsRoute,
  source: docs.toFumadocsSource(),
  plugins: [lucideIconsPlugin(), apiSidebarTitlesPlugin],
});

export function getPageImage(page: (typeof source)["$inferPage"]) {
  const segments = [...page.slugs, "image.png"];

  return {
    segments,
    url: `${docsImageRoute}/${segments.join("/")}`,
  };
}

export function getPageMarkdownUrl(page: (typeof source)["$inferPage"]) {
  const segments = [...page.slugs, "content.md"];

  return {
    segments,
    url: `${docsContentRoute}/${segments.join("/")}`,
  };
}

export async function getLLMText(page: (typeof source)["$inferPage"]) {
  const processed = await page.data.getText("processed");

  return `# ${page.data.title} (${page.url})

${processed}`;
}
