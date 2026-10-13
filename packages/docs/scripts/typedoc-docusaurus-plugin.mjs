// Adapts typedoc-plugin-markdown output to Docusaurus. The page title lives in
// frontmatter. The title of a module page is its full import path, for
// example `methods/username-password/react`; the sidebar nests the pages by
// path, thus it shows only the last segment. Links stay relative links to `.md`
// files, which Docusaurus resolves wherever the docs are mounted.
import { MarkdownPageEvent } from "typedoc-plugin-markdown";

export function load(app) {
  app.renderer.on(MarkdownPageEvent.BEGIN, (page) => {
    const model = page.model;
    const title = model.isProject() ? "API reference" : model.name;
    const sidebarLabel = title.slice(title.lastIndexOf("/") + 1);
    page.frontmatter = {
      title,
      ...(sidebarLabel !== title && { sidebar_label: sidebarLabel }),
      ...page.frontmatter,
    };
  });

  // The property tables anchor each row with `<a id="…"></a>`. MDX renders a
  // literal `<a>` as is, thus Docusaurus does not see the id and reports
  // every link to it as a broken anchor. `Link` registers its `id`.
  app.renderer.on(MarkdownPageEvent.END, (page) => {
    if (!page.contents?.includes('<a id="')) return;
    const body = page.contents.replace(
      /<a id="([^"]+)"><\/a>/g,
      '<Link id="$1" />',
    );
    const importLine = 'import Link from "@docusaurus/Link";\n\n';
    const frontmatter = /^---\n[\s\S]*?\n---\n\n?/.exec(body)?.[0] ?? "";
    page.contents = frontmatter + importLine + body.slice(frontmatter.length);
  });
}
