/** JSON helpers shared by the settings and AI route modules (same shapes as server.ts). */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export function errorJson(message: string, status: number): Response {
  return json({ error: message }, status);
}

/** Parsed JSON body, or undefined when it is not valid JSON. */
export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

export const INVALID_BODY = "Corpo inválido. Envie JSON.";
