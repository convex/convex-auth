// Adds components to the scope of every page, as https://docs.convex.dev does,
// so the pages use them without an import and move there unchanged. See
// https://docusaurus.io/docs/markdown-features/react#mdx-component-scope
import MDXComponents from "@theme-original/MDXComponents";
import { CardLink, DocCardList } from "@site/src/components/DocCardList";
import { Step, StepByStep } from "@site/src/components/StepByStep";

export default {
  ...MDXComponents,
  CardLink,
  DocCardList,
  Step,
  StepByStep,
};
