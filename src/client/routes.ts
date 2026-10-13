// Client-side (history API) routes. Server-safe: no React/DOM imports, so
// src/server.ts and preview.ts can import APP_PATHS to serve index.html on
// each of them (explicit paths, never a "/*" catch-all that would shadow /api).
export const ROUTES = {
  leads: "/leads",
  whatsapp: "/whatsapp",
  settings: "/configuracoes",
} as const;

export type RouteId = keyof typeof ROUTES;

/** Every path that must return the SPA's index.html ("/" redirects client-side to /leads). */
export const APP_PATHS = ["/", ...Object.values(ROUTES)] as const;
