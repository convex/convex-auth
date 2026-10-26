import type { ReactNode } from "react";
import styles from "./Steps.module.css";

/**
 * A numbered list of steps. Each `<Step>` starts with a `###` heading, which
 * gets the step number and shows up in the table of contents.
 */
export function Steps({ children }: { children: ReactNode }) {
  return <div className={styles.steps}>{children}</div>;
}

export function Step({ children }: { children: ReactNode }) {
  return <div className={styles.step}>{children}</div>;
}
