import { Children, type ReactNode } from "react";
import styles from "./StepByStep.module.css";

/**
 * A numbered list of steps, with the same name and props as the component of
 * https://docs.convex.dev, so the pages move there unchanged:
 *
 *   <StepByStep>
 *   <Step title="Install Convex Auth">
 *
 *   Add the Convex Auth package to your project.
 *
 *   ```sh
 *   npm i @convex-dev/auth@beta
 *   ```
 *
 *   </Step>
 *   </StepByStep>
 *
 * Like there, on wide screens the last child of a step goes in a column on the
 * right of the others, and the list widens over the table of contents. Thus
 * end each step with its one code block (or `<Tabs>` of code blocks), and keep
 * the other code blocks out of it.
 */
export function StepByStep({ children }: { children: ReactNode }) {
  return <ol className={styles.steps}>{children}</ol>;
}

export function Step({
  children,
  title,
}: {
  children: ReactNode;
  title: ReactNode;
}) {
  const childArray = Children.toArray(children);
  const description = childArray.slice(0, -1);
  const code = childArray.slice(-1)[0];

  return (
    <li className={styles.step}>
      <div className={styles.columns}>
        <div>
          <div className={styles.title}>{title}</div>
          {description}
        </div>
        <div>{code}</div>
      </div>
    </li>
  );
}
