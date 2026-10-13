// makeBaileysDownloader: WhatsApp's CDN answers 403 for expired media URLs,
// which Baileys does not treat as reupload-worthy (only 404/410). The wrapper
// must request a reupload on 403 and retry once; other statuses propagate.
import { describe, expect, test } from "bun:test";
import { httpStatusOf, makeBaileysDownloader } from "../media.ts";

function fakeDownload(failStatus: number | null, calls: string[]) {
  return (async (msg: { key: { id: string } }) => {
    calls.push(String(msg.key.id));
    if (failStatus !== null && msg.key.id === "old") {
      throw Object.assign(new Error("Failed to fetch stream from https://mmg.whatsapp.net/x?sig=secret"), {
        output: { statusCode: failStatus },
      });
    }
    return (async function* () {
      yield new Uint8Array([1, 2, 3]);
    })();
  }) as never;
}

describe("makeBaileysDownloader", () => {
  test("403 triggers one reupload and retries with the refreshed message", async () => {
    const calls: string[] = [];
    let reuploads = 0;
    const download = makeBaileysDownloader(fakeDownload(403, calls));
    const stream = await download({ key: { id: "old" } } as never, {
      reuploadRequest: async () => {
        reuploads += 1;
        return { key: { id: "fresh" } } as never;
      },
    });
    const chunks: number[] = [];
    for await (const c of stream) chunks.push(...c);
    expect(reuploads).toBe(1);
    expect(calls).toEqual(["old", "fresh"]);
    expect(chunks).toEqual([1, 2, 3]);
  });

  test("other HTTP statuses propagate without a reupload", async () => {
    let reuploads = 0;
    const download = makeBaileysDownloader(fakeDownload(500, []));
    await expect(
      download({ key: { id: "old" } } as never, {
        reuploadRequest: async (m) => {
          reuploads += 1;
          return m;
        },
      }),
    ).rejects.toThrow();
    expect(reuploads).toBe(0);
  });

  test("DNS failure on a placeholder host retries on the default media host", async () => {
    const hosts: Array<string | undefined> = [];
    const download = makeBaileysDownloader((async (_msg: unknown, _type: unknown, options: { host?: string }) => {
      hosts.push(options?.host);
      if (!options?.host) throw Object.assign(new Error("getaddrinfo ENOTFOUND a.whatsapp.net"), { code: "ENOTFOUND" });
      return (async function* () {
        yield new Uint8Array([9]);
      })();
    }) as never);
    const stream = await download({ key: { id: "s" } } as never, { reuploadRequest: async (m) => m });
    const chunks: number[] = [];
    for await (const c of stream) chunks.push(...c);
    expect(hosts).toEqual([undefined, "mmg.whatsapp.net"]);
    expect(chunks).toEqual([9]);
  });

  test("httpStatusOf reads Boom output and plain status", () => {
    expect(httpStatusOf({ output: { statusCode: 403 } })).toBe(403);
    expect(httpStatusOf({ status: 410 })).toBe(410);
    expect(httpStatusOf(new Error("x"))).toBeNull();
  });
});
