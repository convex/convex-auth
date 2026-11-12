import path from "node:path";
import { themes } from "prism-react-renderer";
import type { Config } from "@docusaurus/types";
import type { Options as PresetClassicOptions } from "@docusaurus/preset-classic";
import type { ThemeConfig } from "@docusaurus/preset-classic";
import { resolveCodeIncludes } from "./src/codeInclude.mjs";

const repoRoot = path.resolve(__dirname, "../..");

const github = {
  repo: "https://github.com/convex/convex-auth",
  branch: "main",
};

const config: Config = {
  future: {
    v4: true,
  },
  title: "Convex Auth",
  tagline: "The best way to add authentication to your Convex app.",
  // The preview deployment. The docs are published at
  // https://docs.convex.dev/auth/convex-auth, and `vercel.json` redirects this
  // host there. The pull request previews still serve this site.
  url: "https://auth-v2.previews.convex.dev",
  baseUrl: "/",
  // Only the pull request previews serve this site. Do not let search engines
  // index them.
  noIndex: true,

  onBrokenLinks: "throw",
  onBrokenAnchors: "throw",
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: "throw",
    },
    // Fills the code blocks that name a file of the repository, see
    // `src/codeInclude.mjs`.
    preprocessor: ({ filePath, fileContent }) =>
      resolveCodeIncludes(fileContent, { rootDir: repoRoot, filePath }),
  },

  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },

  presets: [
    [
      "classic",
      {
        docs: {
          routeBasePath: "/",
          sidebarPath: "./sidebars.ts",
          // The API reference is generated at build time and not in the
          // repository.
          editUrl: ({ docPath }) =>
            docPath.startsWith("api/")
              ? undefined
              : `${github.repo}/blob/${github.branch}/packages/docs/docs/${docPath}`,
        },
        blog: false,
        pages: false,
        sitemap: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
      } satisfies PresetClassicOptions,
    ],
  ],

  plugins: [
    [
      "@signalwire/docusaurus-plugin-llms-txt",
      {
        siteTitle: "Convex Auth",
        siteDescription:
          "The best way to add authentication to your Convex app.",
        content: {
          enableLlmsFullTxt: true,
        },
        onRouteError: "throw",
      },
    ],
  ],

  themeConfig: {
    colorMode: {
      respectPrefersColorScheme: true,
    },
    docs: {
      sidebar: {
        autoCollapseCategories: false,
      },
    },
    navbar: {
      title: "Convex Auth",
      items: [
        {
          type: "docSidebar",
          sidebarId: "docs",
          position: "left",
          label: "Convex Auth v2",
        },
        {
          href: "https://labs.convex.dev/auth",
          label: "Convex Auth v1",
          position: "left",
        },
        {
          href: "https://docs.convex.dev/",
          label: "Convex docs",
          position: "left",
        },
        {
          href: `${github.repo}/tree/${github.branch}`,
          label: "GitHub",
          position: "right",
        },
      ],
    },
    prism: {
      theme: themes.github,
      darkTheme: themes.oneDark,
      additionalLanguages: ["bash"],
    },
  } satisfies ThemeConfig,
};

export default config;
