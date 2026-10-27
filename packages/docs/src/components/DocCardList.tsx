import type { ReactNode } from "react";
import Link from "@docusaurus/Link";
import { useDocById } from "@docusaurus/plugin-content-docs/client";
import styles from "./DocCardList.module.css";

type Item = {
  type?: "link";
  /** The id of the page, whose `description` the card shows. */
  docId?: string;
  href: string;
  label: string;
  icon?: ReactNode;
  invertIcon?: true;
};

/**
 * A grid of links as cards, with the same name and props as the component of
 * https://docs.convex.dev, so the pages move there unchanged:
 *
 *   <DocCardList
 *     items={[
 *       {
 *         type: "link",
 *         href: "/getting-started",
 *         docId: "getting-started",
 *         label: "Getting Started",
 *       },
 *     ]}
 *   />
 *
 * Each card shows the `description` from the frontmatter of the page that
 * `docId` names. An unknown `docId` fails the build, and so does a broken
 * `href`.
 */
export function DocCardList({ items }: { items: Item[] }) {
  return (
    <ul className={styles.cards}>
      {items.map((item, index) => (
        <li key={index}>
          <CardLink item={item} />
        </li>
      ))}
    </ul>
  );
}

export function CardLink({
  className,
  item,
}: {
  className?: string;
  item: Item;
}) {
  const doc = useDocById(item.docId);
  return (
    <Link href={item.href} className={`${styles.card} ${className ?? ""}`}>
      {item.icon}
      <div>
        <div className={styles.title}>{item.label}</div>
        {doc?.description && (
          <p className={styles.description}>{doc.description}</p>
        )}
      </div>
    </Link>
  );
}
