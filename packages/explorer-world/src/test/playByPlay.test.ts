/**
 * The play-by-play list (`model/playByPlay.ts`) on the saved recording of
 * the page (`projects/convex-auth/recording-page.ndjson`), and on the live
 * fixture for what nobody asked for (the saved recording ran a scenario from
 * start to end, so nothing in it was done unasked).
 */
import { readFileSync } from "node:fs";
import { structure } from "@convex-dev/explorer-structure";
import { describe, expect, test } from "vitest";
import { parseNdjson, type Event } from "../adapters/convexRecording.ts";
import {
  allLines,
  lineAt,
  lineStop,
  newestPress,
  openSectionOf,
  phraseText,
  playByPlayOf,
  type PlayLine,
} from "../model/playByPlay.ts";
import { prepareProject, PROJECTS, worldFromEvents } from "../project.ts";

const project = prepareProject(PROJECTS["convex-auth"]);
const read = (url: URL) => parseNdjson(readFileSync(url, "utf8"));
const pageEvents = read(
  new URL("../../projects/convex-auth/recording-page.ndjson", import.meta.url),
);
const page = worldFromEvents(project, pageEvents, "page").world;
const sections = playByPlayOf(page);
const phrases = project.presentation.phrases!;

const said = (l: PlayLine) => [l.who, l.text, l.code ?? ""].join(" · ");

describe("the lines of a sign-up", () => {
  const signUp = sections.find((s) => s.title === "Sign up")!;

  test("read in the order it happened", () => {
    expect(signUp.kind).toBe("press");
    const texts = signUp.lines.map((l) => l.text);
    const order = [
      "types into username",
      "types into password",
      "submits the form",
      "calls auth:signUpWithUsernamePassword",
      "sends the mutation signUpWithUsernamePassword, with password, redacted",
      "signUpWithUsernamePassword runs, 154 ms",
      "the usernamePassword method starts",
      "calls getUserIdByUsername",
      "issues a session to the new user",
      "the usernamePassword method is done: complete",
      "writes usernames",
      "the answer comes back, with access token, refresh token",
      "auth:signUpWithUsernamePassword answered: complete",
      "takes the new session",
      "writes __convexAuthJWT",
      "writes __convexAuthRefreshToken",
      "now signed in",
    ];
    const at = order.map((t) => texts.indexOf(t));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  test("say who did each thing, with the step's code name beside it", () => {
    const line = (text: string) => signUp.lines.find((l) => l.text === text)!;
    expect(said(line("takes the new session"))).toBe(
      "session manager · takes the new session · session.set",
    );
    expect(said(line("calls auth:signUpWithUsernamePassword"))).toBe(
      "React binding · calls auth:signUpWithUsernamePassword · signIn.call",
    );
    expect(line("issues a session to the new user").code).toBe(
      "session.issued",
    );
    // A run's steps and writes sit under the run.
    const run = signUp.lines.findIndex((l) => l.mark === "run");
    const issued = signUp.lines.findIndex((l) => l.code === "session.issued");
    expect(signUp.lines[issued].depth).toBe(signUp.lines[run].depth + 1);
    expect(signUp.lines[issued].inRun).toBe(signUp.lines[run].target?.id);
  });

  test("a refusal says so, with its error code", () => {
    const wrong = sections.find(
      (s) => s.title === "Sign in with a wrong password",
    )!;
    const answer = wrong.lines.find((l) => l.mark === "answer")!;
    expect(answer.text).toBe("the answer comes back: refused");
    expect(answer.code).toBe("INVALID_CREDENTIALS");
    expect(answer.tone).toBe("error");
  });
});

describe("the navigations", () => {
  const navigations = (events: Event[]) =>
    playByPlayOf(worldFromEvents(project, events, "page").world).flatMap((s) =>
      s.lines
        .filter((l) => l.who === "page" && /^(goes to|finishes)/.test(l.text))
        .map((l) => l.text),
    );
  const header = pageEvents[0];
  const page = (n: number, event: string, path: string, extra = {}) =>
    ({
      kind: "page",
      id: `p1#${n}`,
      time: (header.time ?? 0) + n,
      pageId: "p1",
      event,
      url: `http://localhost:5173${path}`,
      ...extra,
    }) as Event;

  test("each shows once in a recording made before the recorder told them apart", () => {
    // That recorder also reported React Router's history update on start,
    // at the URL the page had just loaded.
    const open = sections.find((s) => s.title === "Open the sign-up page")!;
    expect(
      open.lines
        .filter((l) => l.who === "page" && /^(goes to|finishes)/.test(l.text))
        .map((l) => l.text),
    ).toEqual(["goes to /signup", "finishes loading /signup"]);
  });

  test("an old recording drops a history update that kept the URL", () => {
    expect(
      navigations([
        header,
        page(1, "navigated", "/"),
        page(2, "load", "/"),
        page(3, "navigated", "/"),
        page(4, "navigated", "/login"),
        page(5, "navigated", "/login"),
        page(6, "navigated", "/login"),
        page(7, "load", "/login"),
      ]),
    ).toEqual([
      "goes to /",
      "finishes loading /",
      "goes to /login",
      // Folded with the one before, as any repeat in a row: that recorder
      // reported a reload as it reported a history update.
      "finishes loading /login",
    ]);
  });

  test("a recording that tells them apart is read as it is", () => {
    // A reload that the recording ended before it loaded.
    expect(
      navigations([
        header,
        page(1, "navigated", "/", { sameDocument: false }),
        page(2, "load", "/"),
        page(3, "navigated", "/login", { sameDocument: true }),
        page(4, "navigated", "/login", { sameDocument: false }),
      ]),
    ).toEqual([
      "goes to /",
      "finishes loading /",
      "goes to /login",
      "goes to /login",
    ]);
  });
});

describe("the phrases", () => {
  test("every place in the source that reports a step has one", () => {
    const missing = structure.steps
      .filter(
        (s) =>
          !phraseText(phrases.steps?.[s.step], s.detailLiterals ?? undefined),
      )
      .map((s) => `${s.step} (${s.location.file}:${s.location.line})`);
    expect(structure.steps.length).toBe(48);
    expect(missing).toEqual([]);
  });

  test("places the recording tells apart read differently", () => {
    const texts = (step: string) =>
      new Set(
        structure.steps
          .filter((s) => s.step === step)
          .map((s) =>
            phraseText(phrases.steps?.[step], s.detailLiterals ?? undefined),
          ),
      );
    expect(texts("session.issued").size).toBe(2);
    expect(texts("sessions.revoked").size).toBe(2);
    expect(texts("state").size).toBe(2);
  });

  test("every step the recording holds has a line with words", () => {
    const lines = allLines(sections).filter((l) => l.code);
    const recorded = new Set(
      pageEvents
        .filter((e) => e.kind === "step" && e.step !== "return")
        .map((e) => String(e.step)),
    );
    for (const step of recorded) {
      const of = lines.filter((l) => l.code!.split(" · ")[0] === step);
      expect(of.length, step).toBeGreaterThan(0);
      expect(
        of.every((l) => l.text.length > 0),
        step,
      ).toBe(true);
    }
  });
});

test("no line holds a value, only names and labels", () => {
  // Every value of the recording that is not a name: what was typed, row
  // ids and fields, user ids in step details, a token's claims.
  // Words a row holds as a state ("issued") are names; ids, hashes and
  // what was typed are values.
  const values = new Set<string>();
  const take = (v: unknown) => {
    if (typeof v === "string" && v.length >= 10 && /\d/.test(v)) values.add(v);
    else if (v && typeof v === "object") Object.values(v).forEach(take);
  };
  for (const e of pageEvents as (Event & Record<string, unknown>)[]) {
    if (e.kind === "input" && typeof e.value === "string") values.add(e.value);
    if (e.kind === "write") {
      take(e.documentId);
      take(e.value);
    }
    if (e.kind === "secret") {
      take(e.claims);
      take(e.header);
    }
    if (e.kind === "secretLink") take(e.documentId);
    if (e.kind === "step") take((e.detail as { userId?: unknown })?.userId);
  }
  expect(values.size).toBeGreaterThan(10);
  const lines = sections.flatMap((s) => [s.title, ...s.lines.map(said)]);
  const leaks = lines.filter(
    (l) =>
      [...values].some((v) => l.includes(v)) ||
      /eyJ[\w-]{8,}/.test(l) ||
      // An id or a hash: long, with digits (names of functions have none).
      /(?=[A-Za-z_-]*\d)[A-Za-z0-9_-]{24,}/.test(l),
  );
  expect(leaks).toEqual([]);
  // What was carried is named by its label: never a recorder's secret id.
  expect(lines.some((l) => /\bs\d+\b/.test(l))).toBe(false);
});

describe("what nobody asked for", () => {
  const live = worldFromEvents(
    project,
    read(new URL("./fixtures/live-actions.ndjson", import.meta.url)),
    "live",
  ).world;
  const liveSections = playByPlayOf(live);

  test("folds into a faint section of its own, named by what was done", () => {
    const unasked = liveSections.filter((s) => s.kind === "unasked");
    expect(unasked.length).toBeGreaterThan(0);
    for (const s of unasked) {
      expect(s.title).toBe("Not asked for: Convex asks for the access token");
      // It starts with something the client did by itself.
      expect(s.lines[0].mark).toBe("op");
    }
    // The refreshes after the sign-in, one after another, are one section.
    const last = liveSections.at(-1)!;
    expect(last.kind).toBe("unasked");
    expect(last.lines.filter((l) => l.code === "refresh.start").length).toBe(3);
  });

  test("the open section: the last press, or the viewer's choice until a newer press", () => {
    const presses = liveSections.filter((s) => s.kind === "press");
    const [signUp, signOut, signIn] = presses;
    const open = liveSections[0];
    expect(openSectionOf(liveSections, 0)).toBeNull();
    expect(openSectionOf(liveSections, signOut.at + 0.5)).toBe(signOut.id);
    // In what nobody asked for, after a press: that press stays open.
    const unasked = liveSections.find(
      (s) => s.kind === "unasked" && s.at > signOut.at,
    )!;
    expect(openSectionOf(liveSections, unasked.at + 0.1)).toBe(signOut.id);
    // The viewer opens "On open" (say, by selecting something in it): it
    // stays open while no newer press comes, wherever the playhead is.
    const chosen = { section: open.id, under: newestPress(liveSections) };
    expect(openSectionOf(liveSections, signIn.at + 1, chosen)).toBe(open.id);
    // Chosen while Sign out was the newest press: Sign in, pressed after,
    // takes the list to it, whatever was selected.
    const before = { section: open.id, under: signOut.id };
    expect(openSectionOf(liveSections, signIn.at + 1, before)).toBe(signIn.id);
    expect(openSectionOf(liveSections, signUp.at + 1, before)).toBe(signUp.id);
  });

  test("an operation's steps stay in its block, under its line", () => {
    for (const s of liveSections)
      for (const l of s.lines.filter((x) => x.mark === "op")) {
        const block = s.lines.filter((x) => x.block === l.block);
        expect(block[0]).toBe(l);
        expect(block.slice(1).every((x) => x.depth > 1)).toBe(true);
      }
  });
});

describe("the line at a time", () => {
  const lines = allLines(sections);
  const call = lines.find((l) => l.code === "signIn.call")!;

  test("is the latest line that has happened", () => {
    expect(lineAt(sections, call.at)).toBe(call);
    expect(lineAt(sections, call.at + 0.01)?.id).toBe(call.id);
    expect(lineAt(sections, 0)).toBeNull();
    const next = lines
      .filter((l) => l.at > call.at)
      .sort((a, b) => a.at - b.at)[0];
    expect(lineAt(sections, next.at)?.at).toBe(next.at);
  });

  test("a step goes to the next line, or back to the one before", () => {
    const next = lineStop(sections, call.at, 1)!;
    expect(next).toBeGreaterThan(call.at);
    expect(lines.some((l) => l.at === next)).toBe(true);
    expect(lineStop(sections, next, -1)).toBe(call.at);
    expect(lineStop(sections, Infinity, 1)).toBeNull();
  });
});
