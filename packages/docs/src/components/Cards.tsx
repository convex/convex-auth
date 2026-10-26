import type { ReactNode } from "react";
import styles from "./Cards.module.css";

/**
 * Shows a Markdown list of links as cards. Each item is a link to a page,
 * then a paragraph that describes it:
 *
 *   <Cards>
 *
 *   - [Getting Started](./getting-started.mdx)
 *
 *     Installing dependencies + initial set up.
 *
 *   </Cards>
 *
 * The links stay Markdown links to files, thus Docusaurus resolves them and
 * reports a broken one, wherever the docs are mounted.
 */
export function Cards({ children }: { children: ReactNode }) {
  return <div className={styles.cards}>{children}</div>;
}
