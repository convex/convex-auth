import React from "react";
import { DocsThemeConfig, useConfig } from "nextra-theme-docs";
import { Details, Summary } from "./components/details";

const config: DocsThemeConfig = {
  logo: (
    <span style={{ fontWeight: "bold", fontSize: "1.5rem" }}>Convex Auth</span>
  ),
  banner: {
    key: "v2-docs",
    text: (
      <a href="https://docs.convex.dev/auth/convex-auth" target="_blank">
        These are the docs for Convex Auth v1. See the v2 docs →
      </a>
    ),
  },
  project: {
    link: "https://github.com/convex/convex-auth",
  },
  chat: {
    link: "https://www.convex.dev/community",
  },
  useNextSeoProps() {
    return {
      titleTemplate: "%s - Convex Auth",
    };
  },
  head: () => {
    const { frontMatter } = useConfig();
    return (
      <>
        <meta
          property="og:title"
          content={frontMatter.title || "Convex Auth"}
        />
        <meta
          property="og:description"
          content="Authentication library for your Convex backend"
        />
      </>
    );
  },
  docsRepositoryBase: "https://github.com/convex/convex-auth/tree/main/docs",
  gitTimestamp() {
    return <></>;
  },
  footer: {
    text: `Copyright © ${new Date().getFullYear()} Convex, Inc.`,
  },
  components: {
    details: Details,
    summary: Summary,
  },
};

export default config;
