// The most recent campaign started from this browser, so its progress can be
// reopened from the WhatsApp view after closing the composer (campaigns keep
// running on the server). Persisted per viewer in localStorage.
import { useSyncExternalStore } from "react";

const KEY = "prospecteezy-wa-last-campaign";
const listeners = new Set<() => void>();

function read(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setLastCampaign(jobId: string | null) {
  try {
    if (jobId) localStorage.setItem(KEY, jobId);
    else localStorage.removeItem(KEY);
  } catch {
    /* storage blocked: the id only lives for this session */
  }
  memory = jobId;
  for (const fn of listeners) fn();
}

let memory: string | null = typeof window === "undefined" ? null : read();

export function useLastCampaign(): string | null {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => memory,
    () => null,
  );
}
