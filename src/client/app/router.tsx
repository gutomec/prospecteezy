// Minimal history router: four flat views don't need a routing library.
import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from "react";
import { ROUTES, type RouteId } from "@/routes";

const NAVIGATE_EVENT = "app:navigate";

function subscribe(callback: () => void) {
  window.addEventListener("popstate", callback);
  window.addEventListener(NAVIGATE_EVENT, callback);
  return () => {
    window.removeEventListener("popstate", callback);
    window.removeEventListener(NAVIGATE_EVENT, callback);
  };
}

const getPath = () => window.location.pathname;

export function navigate(to: string, { replace = false } = {}) {
  if (to === window.location.pathname) return;
  if (replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
}

export function routeOf(path: string): RouteId | null {
  const clean = path.replace(/\/+$/, "") || "/";
  for (const [id, routePath] of Object.entries(ROUTES) as [RouteId, string][]) {
    if (clean === routePath) return id;
  }
  return null;
}

/** Current route id; unknown paths (and "/") resolve to Leads. */
export function useRoute(): RouteId {
  const path = useSyncExternalStore(subscribe, getPath, () => "/");
  return routeOf(path) ?? "leads";
}

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { to: string };

/** <a> that navigates client-side (modifier clicks still open new tabs). */
export function Link({ to, onClick, ...props }: LinkProps) {
  const handle = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(to);
  };
  return <a href={to} onClick={handle} {...props} />;
}
