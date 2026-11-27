/**
 * The insides of Convex Auth's parts, from the structure map: what each
 * module exports (`modules`), what it holds (`holds`), and the places in its
 * code that report steps (`steps`); and, for a recorded step, the places
 * that can have reported it (`stepSites`). Every line of text is the
 * source's own, copied by the structure package.
 */
import {
  stepSites,
  type ConvexAuthStructure,
  type StepSite,
} from "@convex-dev/explorer-structure";
import type {
  Holding,
  PartInside,
  Place,
  ProjectInside,
  Site,
} from "../../src/model/inside.ts";

const TYPE_ONLY = new Set(["interface", "type"]);

const siteId = (s: StepSite) =>
  `${s.location.file}:${s.location.line}:${s.step}`;

/** Where a site sits: the deepest public member around it, else its export. */
function placeOf(s: StepSite, places: Place[]): string | null {
  if (!s.export) return null;
  for (let i = s.within.length - 1; i > 0; i--) {
    const id = `${s.export}.${s.within[i]}`;
    if (places.some((p) => p.id === id)) return id;
  }
  return places.some((p) => p.id === s.export) ? s.export : null;
}

/**
 * The line for a module without a doc comment of its own: its main export's,
 * where there is one plainly. The one class among the exports that do
 * something, else the only such export, with a summary.
 */
function mainExport(places: Place[]): Place | undefined {
  const runtime = places.filter(
    (p) => !p.of && !p.typeOnly && !p.from && !p.part && p.kind !== "all",
  );
  const classes = runtime.filter((p) => p.kind === "class");
  const main =
    classes.length === 1
      ? classes[0]
      : runtime.length === 1
        ? runtime[0]
        : null;
  return main?.summary ? main : undefined;
}

export function insideOf(model: ConvexAuthStructure): ProjectInside {
  const parts: Record<string, PartInside> = {};
  const sitesByPart = new Map<string, StepSite[]>();
  for (const s of model.steps)
    if (s.part)
      sitesByPart.set(s.part, [...(sitesByPart.get(s.part) ?? []), s]);

  for (const [id, m] of Object.entries(model.modules ?? {})) {
    const places: Place[] = [];
    for (const e of m.exports) {
      places.push({
        id: e.name,
        name: e.name,
        kind: e.kind,
        line: e.line,
        ...(e.summary ? { summary: e.summary } : {}),
        ...(e.part ? { part: e.part } : {}),
        ...(e.from ? { from: e.from } : {}),
        ...(TYPE_ONLY.has(e.kind) ? { typeOnly: true } : {}),
      });
      for (const member of e.members ?? [])
        places.push({
          id: `${e.name}.${member.name}`,
          name: member.name,
          kind: member.kind,
          line: member.line,
          of: e.name,
          ...(member.summary ? { summary: member.summary } : {}),
        });
      // A hook is described once, as a part: its line is its export's.
      if (e.part && e.summary)
        parts[e.part] = {
          summary: { text: e.summary },
          places: [],
          holds: [],
          sites: [],
        };
    }
    const holds: Holding[] = [];
    const held = model.holds[id];
    for (const k of held?.storage ?? [])
      holds.push({ kind: "key", name: k.key, detail: k.ops.join(", ") });
    for (const l of held?.locks ?? [])
      holds.push({
        kind: "lock",
        name: l.storageKey ?? l.code,
        ...(l.storageKey ? { detail: l.storageKey } : {}),
      });
    for (const st of m.state)
      holds.push({
        kind: "state",
        name: st.name,
        ...(st.class ? { place: st.class } : {}),
      });
    const sites: Site[] = (sitesByPart.get(id) ?? []).map((s) => ({
      id: siteId(s),
      step: s.step,
      place: placeOf(s, places),
      line: s.location.line,
      file: s.location.file,
    }));
    const main = m.summary ? undefined : mainExport(places);
    parts[id] = {
      ...(m.summary
        ? { summary: { text: m.summary } }
        : main
          ? { summary: { text: main.summary!, from: main.name } }
          : {}),
      places,
      holds,
      sites,
    };
  }

  // The server's sites, on the method or setup function around them.
  for (const [id, list] of sitesByPart) {
    if (parts[id]) continue;
    parts[id] = {
      places: [],
      holds: [],
      sites: list.map((s) => ({
        id: siteId(s),
        step: s.step,
        place: null,
        line: s.location.line,
        file: s.location.file,
      })),
    };
  }

  return {
    parts,
    sitesOf: (report) =>
      stepSites(model, {
        step: report.step,
        runsIn: report.runsIn ?? null,
        part: report.part ?? null,
        ...(report.detail ? { detail: report.detail } : {}),
      }).map((s) => ({ site: siteId(s), part: s.part })),
  };
}
