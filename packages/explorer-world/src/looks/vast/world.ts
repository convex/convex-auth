/**
 * What the vast sample holds and where: the browser of a person signing in
 * to `examples/react-username-password`, as a territory in front of a
 * monumental screen. Content and positions only; how anything looks is up to
 * the look.
 *
 * Big things hold smaller things. The browser holds districts: the page
 * nearest the screen's foot; the client code in the middle (the app's code,
 * the Convex Auth client, the Convex client); storage on the left
 * (localStorage, cookies); the connections on the right, as long channels
 * running forward to plain exits at the browser's front edge. A district of code holds modules (source files), and a
 * module holds its functions; the page holds its elements; localStorage
 * holds keys, a key holds its value, and the token opens to its claims. The
 * names are the ones in the code. The values (the deployment URL, the
 * session id, the times) are a sample.
 *
 * Metres, y up. The screen stands at the back (-z); the browser lies in
 * front of it, toward the viewer; nothing stands behind it. Beyond the
 * exits, forward, the ground is empty, kept for servers and providers; most
 * of the ground is empty, on purpose: room for more things and more levels.
 * The layout follows the stage's (`src/stage/`) in the large.
 */
import { PAGE, type V3 } from "../layout.ts";
import type { PieceKind } from "../look.ts";

/** The height of the top of the browser's plate. */
export const PLATE_TOP = 0.3;
/** The height of a district's slab above the plate. */
export const SLAB = 1.6;
const DISTRICT_TOP = PLATE_TOP + SLAB;

export const SCREEN = {
  /** The center of the bottom edge of the body, on the ground. */
  position: [0, 0, -480] as V3,
  /** The page, in metres: as wide as a city block, as tall as a tower. */
  width: 640,
  height: 384,
  /** The bottom edge of the page above the ground. */
  pageLift: 40,
};

/** A point of the page on the screen, in the world: u, v from 0 to 1. */
export function onPage(u: number, v: number): V3 {
  const [x, y, z] = SCREEN.position;
  return [
    x + (u - 0.5) * SCREEN.width,
    y + SCREEN.pageLift + (1 - v) * SCREEN.height,
    z + 9.6,
  ];
}

/** The "Log in" button on the screen. */
export const SCREEN_BUTTON = onPage(
  PAGE.button.x + PAGE.button.w / 2,
  PAGE.button.y + PAGE.button.h / 2,
);

export const TERRITORY = {
  id: "browser",
  label: "Browser",
  note: "http://localhost:5173/login",
  /** The base: the center of its footprint on the ground. */
  position: [0, 0, -120] as V3,
  size: [760, PLATE_TOP, 440] as V3,
};

export type Piece = {
  kind: PieceKind;
  id: string;
  label: string;
  note?: string;
  /** The base, in the world. */
  position: V3;
  size: V3;
  children: Piece[];
};

export type District = {
  id: string;
  label: string;
  /** One line under the name: where it comes from. */
  note: string;
  position: V3;
  size: V3;
  children: Piece[];
};

const top = (p: { position: V3; size: V3 }) => p.position[1] + p.size[1];

/** Pieces in rows on top of `parent`, `cols` across, filling its top. */
function rows(
  parent: { position: V3; size: V3 },
  specs: Omit<Piece, "position" | "size" | "children">[],
  cols: number,
  height: (s: (typeof specs)[number], i: number) => number,
  margin: number,
  gap: number,
): Piece[] {
  const [px, , pz] = parent.position;
  const [w, , d] = parent.size;
  const n = Math.ceil(specs.length / cols);
  const cw = (w - 2 * margin - (cols - 1) * gap) / cols;
  const cd = (d - 2 * margin - (n - 1) * gap) / n;
  return specs.map((s, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    return {
      ...s,
      position: [
        px - w / 2 + margin + cw / 2 + c * (cw + gap),
        top(parent),
        pz - d / 2 + margin + cd / 2 + r * (cd + gap),
      ] as V3,
      size: [cw, height(s, i), cd] as V3,
      children: [],
    };
  });
}

type ModuleSpec = { file: string; items: string[] };

/** A district of code: its modules in a grid, each with its functions. */
function codeDistrict(
  d: Omit<District, "children">,
  cols: number,
  modules: ModuleSpec[],
): District {
  const ms = rows(
    d,
    modules.map((m) => ({
      kind: "module" as const,
      id: `${d.id}:${m.file}`,
      label: m.file,
    })),
    cols,
    (_, i) => 7 + modules[i].items.length * 2.2,
    12,
    14,
  );
  ms.forEach((m, i) => {
    const items = modules[i].items;
    m.children = rows(
      m,
      items.map((name) => ({
        kind: "function" as const,
        id: `${m.id}#${name}`,
        label: name,
      })),
      1,
      () => 1.3,
      1.8,
      1.4,
    );
    // A function is a pill, whatever room its module has.
    for (const f of m.children) f.size[2] = Math.min(f.size[2], 5.5);
  });
  return { ...d, children: ms };
}

/** The app's code: `examples/react-username-password/src`. */
export const APP_CODE = codeDistrict(
  {
    id: "appCode",
    label: "App code",
    note: "examples/react-username-password/src",
    position: [-108, DISTRICT_TOP - SLAB, -124],
    size: [96, SLAB, 104],
  },
  2,
  [
    { file: "main.tsx", items: ["convex"] },
    { file: "App.tsx", items: ["App", "RequireAuth", "RequireNoAuth"] },
    { file: "routes/logIn.tsx", items: ["LogIn"] },
    { file: "routes/signUp.tsx", items: ["SignUp"] },
    { file: "routes/dashboard.tsx", items: ["Dashboard"] },
    {
      file: "PasswordSettings.tsx",
      items: ["PasswordSettings", "errorMessage"],
    },
  ],
);

/** The Convex Auth client: `@convex-dev/auth`, `packages/core/src`. */
export const AUTH_CLIENT = codeDistrict(
  {
    id: "authClient",
    label: "Convex Auth client",
    note: "@convex-dev/auth  ·  packages/core/src",
    position: [42, DISTRICT_TOP - SLAB, -124],
    size: [150, SLAB, 104],
  },
  4,
  [
    {
      file: "react/index.tsx",
      items: ["ConvexAuthProvider", "useAuthActions", "useAuthToken"],
    },
    {
      file: "react/client.tsx",
      items: ["AuthProvider", "useAuth", "SessionWatcher", "useAuthSignInApi"],
    },
    {
      file: "methods/username-password/react.tsx",
      items: [
        "useSignInWithUsernamePassword",
        "useSignUpWithUsernamePassword",
        "usePasswordFlow",
      ],
    },
    { file: "browser/mutex.ts", items: ["runWithMutex"] },
    {
      file: "browser/sessionManager.ts",
      items: [
        "AuthClient.init",
        "AuthClient.setSession",
        "AuthClient.signOut",
        "AuthClient.fetchAccessToken",
        "AuthClient.getAccessToken",
      ],
    },
    {
      file: "browser/storage.ts",
      items: ["NamespacedStorage.set", "defaultStorage", "InMemoryStorage"],
    },
    { file: "browser/keyedStore.ts", items: ["KeyedStore"] },
    { file: "browser/retry.ts", items: ["retryOnNetworkError"] },
  ],
);

/** The sample deployment, as the namespace of the storage keys. */
export const DEPLOYMENT_URL = "http://127.0.0.1:3210";
const NAMESPACE = DEPLOYMENT_URL.replace(/[^a-zA-Z0-9]/g, "");

/** The claims of the access token (`component/public.ts`), sample values. */
export const CLAIMS: { name: string; value: string }[] = [
  { name: "sub", value: "jd7f2k9q…" },
  { name: "iss", value: `${DEPLOYMENT_URL}/components/auth` },
  { name: "aud", value: "convex-auth" },
  { name: "iat", value: "1764212400" },
  { name: "exp", value: "1764216000" },
];

const LS = {
  position: [-252, DISTRICT_TOP - SLAB, -150] as V3,
  size: [84, SLAB, 80] as V3,
};

/** A key of localStorage, with its value on it. */
function key(
  name: string,
  value: string,
  x: number,
  claims: typeof CLAIMS,
): Piece {
  const k: Piece = {
    kind: "key",
    id: `localStorage:${name}`,
    label: name,
    position: [LS.position[0] + x, top(LS), LS.position[2] + 4],
    size: [34, 2.2, 52],
    children: [],
  };
  const v: Piece = {
    kind: "value",
    id: `${k.id}=`,
    label: value,
    position: [k.position[0], top(k), k.position[2] - 14],
    size: [28, 1.6, 7],
    children: [],
  };
  k.children.push(v);
  if (claims.length)
    k.children.push(
      ...rows(
        {
          position: [k.position[0], top(k), k.position[2] + 8],
          size: [32, 0, 26],
        },
        claims.map((c) => ({
          kind: "claim" as const,
          id: `${v.id}.${c.name}`,
          label: c.name,
          note: c.value,
        })),
        1,
        () => 0.5,
        1,
        0.7,
      ),
    );
  return k;
}

/** The keys the Auth client writes (`browser/storage.ts`), namespaced. */
export const JWT_KEY = key(
  `__convexAuthJWT_${NAMESPACE}`,
  "eyJhbGciOiJSUzI1NiIs…",
  -20,
  CLAIMS,
);
export const REFRESH_KEY = key(
  `__convexAuthRefreshToken_${NAMESPACE}`,
  "k97c3m1x…|1",
  20,
  [],
);

export const LOCAL_STORAGE: District = {
  id: "localStorage",
  label: "localStorage",
  note: "origin http://localhost:5173",
  ...LS,
  children: [JWT_KEY, REFRESH_KEY],
};

export const COOKIES: District = {
  id: "cookies",
  label: "Cookies",
  note: "none: this app keeps its tokens in localStorage",
  position: [-252, DISTRICT_TOP - SLAB, -62],
  size: [84, SLAB, 44],
  children: [],
};

/** The page: the elements of `routes/logIn.tsx` in use. */
const PAGE_D = {
  position: [-24, DISTRICT_TOP - SLAB, -282] as V3,
  size: [212, SLAB, 38] as V3,
};
const FORM: Piece = {
  kind: "element",
  id: "page:form",
  label: "<form>",
  position: [PAGE_D.position[0] - 22, top(PAGE_D), PAGE_D.position[2]],
  size: [150, 1.4, 26],
  children: [],
};
FORM.children = rows(
  FORM,
  [
    { kind: "element", id: "page:h1", label: "<h1>", note: "Log in" },
    {
      kind: "element",
      id: "page:username",
      label: '<input id="username">',
      note: "ada",
    },
    {
      kind: "element",
      id: "page:password",
      label: '<input id="password">',
      note: "••••••••••",
    },
    {
      kind: "element",
      id: "page:submit",
      label: '<button type="submit">',
      note: "Log in",
    },
  ],
  4,
  () => 1.2,
  4,
  4,
);
const SIGNUP_LINK: Piece = {
  kind: "element",
  id: "page:signup",
  label: '<a href="/signup">',
  note: "Sign up",
  position: [PAGE_D.position[0] + 76, top(PAGE_D), PAGE_D.position[2]],
  size: [34, 1.4, 18],
  children: [],
};
export const PAGE_DISTRICT: District = {
  id: "page",
  label: "Page",
  note: "the elements in use  ·  routes/logIn.tsx",
  ...PAGE_D,
  children: [FORM, SIGNUP_LINK],
};

/** The Convex client (`convex/react`), which the Auth client calls through. */
export const CONVEX_CLIENT = codeDistrict(
  {
    id: "convexClient",
    label: "Convex client",
    note: "convex/react",
    position: [176, DISTRICT_TOP - SLAB, -124],
    size: [64, SLAB, 104],
  },
  1,
  [
    {
      file: "ConvexReactClient",
      items: [
        "ConvexReactClient.mutation",
        "ConvexReactClient.action",
        "ConvexReactClient.setAuth",
        "ConvexReactClient.clearAuth",
      ],
    },
  ],
);

/** The connections out: long channels running forward to the front edge. */
const CHANNEL = { z0: -210, z1: 84 };
const channel = (x: number) => ({
  position: [x, DISTRICT_TOP - SLAB, (CHANNEL.z0 + CHANNEL.z1) / 2] as V3,
  size: [18, SLAB, CHANNEL.z1 - CHANNEL.z0] as V3,
});
export const WEBSOCKET: District = {
  id: "websocket",
  label: "WebSocket",
  note: "ws://127.0.0.1:3210",
  ...channel(250),
  children: [],
};
export const HTTP: District = {
  id: "http",
  label: "HTTP",
  note: "GET /login, the scripts",
  ...channel(316),
  children: [],
};

export const DISTRICTS: District[] = [
  PAGE_DISTRICT,
  APP_CODE,
  AUTH_CLIENT,
  CONVEX_CLIENT,
  LOCAL_STORAGE,
  COOKIES,
  WEBSOCKET,
  HTTP,
];

/**
 * The plain exits at the browser's front edge, where each connection leaves
 * for a server. No interior; the ground beyond is kept for the servers.
 */
export const GATES = [
  {
    id: "convexBackend",
    label: "To the Convex backend",
    position: [250, 0, CHANNEL.z1 + 14] as V3,
    width: 40,
    height: 34,
  },
  {
    id: "pageServer",
    label: "To the page server",
    position: [316, 0, CHANNEL.z1 + 14] as V3,
    width: 40,
    height: 34,
  },
];

/** Every piece, depth first. */
export function allPieces(): Piece[] {
  const out: Piece[] = [];
  const walk = (p: Piece) => {
    out.push(p);
    p.children.forEach(walk);
  };
  for (const d of DISTRICTS) d.children.forEach(walk);
  return out;
}

export function piece(id: string): Piece {
  const p = allPieces().find((x) => x.id === id);
  if (!p) throw new Error(`No piece ${id}`);
  return p;
}

/** The top center of a piece or district. */
export function topOf(p: { position: V3; size: V3 }): V3 {
  return [p.position[0], top(p), p.position[2]];
}
