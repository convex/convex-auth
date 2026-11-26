import { Component, type ReactNode } from "react";
import { reportProblem, useProblems } from "../problems.ts";

/** What failed, on screen. */
export function Problems() {
  const list = useProblems((s) => s.list);
  if (!list.length) return null;
  return (
    <div className="problems panel" role="alert">
      {list.map((p) => (
        <p key={p}>{p}</p>
      ))}
    </div>
  );
}

/** Keeps an error in the scene from taking the page with it, and says what it was. */
export class SceneBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    reportProblem(
      `The 3D scene stopped on an error: ${error instanceof Error ? error.message : String(error)}. The panels still work.`,
    );
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}
