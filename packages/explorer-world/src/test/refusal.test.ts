import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { parseNdjson, type Event } from "../adapters/convexRecording.ts";
import { prepareProject, PROJECTS, worldFromEvents } from "../project.ts";

const project = prepareProject(PROJECTS["convex-auth"]);
const read = (url: URL) => parseNdjson(readFileSync(url, "utf8"));

test("a refusal keeps the client's error code, and no message text", () => {
  const { world } = worldFromEvents(
    project,
    read(
      new URL(
        "../../projects/convex-auth/recording-page.ndjson",
        import.meta.url,
      ),
    ),
    "page",
  );
  const codes = world.recording.runs
    .flatMap((r) => [...r.before, ...r.after])
    .flatMap((i) => (i.code ? [i.code] : []));
  expect(codes).toContain("INVALID_CREDENTIALS");
  for (const c of codes) expect(c).toMatch(/^[A-Z][A-Z0-9_]+$/);
});

test("a refused operation turns red, with its code, at the step that came back", () => {
  const events = read(
    new URL("./fixtures/live-actions.ndjson", import.meta.url),
  );
  // The last sign-in, as if the backend had refused it.
  const last = events.findLast(
    (e) => e.kind === "step" && e.step === "signIn.return",
  )!;
  const refused: Event[] = events.map((e) =>
    e === last
      ? {
          ...e,
          detail: {
            ...(e.detail as object),
            status: "error",
            error: "INVALID_CREDENTIALS",
          },
        }
      : e,
  );
  const { world } = worldFromEvents(project, refused, "refused");
  const op = world.timeline.ops.find((o) => o.code)!;
  expect(op.code).toBe("INVALID_CREDENTIALS");
  expect(op.tone).toBe("error");
  // Not red before the refusal came back.
  expect(op.errorAt).toBeGreaterThan(op.points[0].at);
});

test("a message is never taken for a code", () => {
  const events = read(
    new URL("./fixtures/live-actions.ndjson", import.meta.url),
  );
  const last = events.findLast(
    (e) => e.kind === "step" && e.step === "signIn.return",
  )!;
  const { world } = worldFromEvents(
    project,
    events.map((e) =>
      e === last
        ? {
            ...e,
            detail: {
              ...(e.detail as object),
              status: "error",
              error: "Invalid password for user x",
            },
          }
        : e,
    ),
    "message",
  );
  expect(world.timeline.ops.some((o) => o.code)).toBe(false);
});
