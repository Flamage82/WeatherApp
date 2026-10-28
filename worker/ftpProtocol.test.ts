import { describe, expect, it } from "vitest";
import { ReplyReader, parsePasv, expectReply, startSession } from "./ftpProtocol";

const enc = new TextEncoder();

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

describe("parsePasv", () => {
  it("extracts the port", () => {
    expect(parsePasv("227 Entering Passive Mode (134,178,253,145,195,80).")).toEqual({
      port: 195 * 256 + 80,
    });
  });
  it("throws on non-PASV text", () => {
    expect(() => parsePasv("500 nope")).toThrow();
  });
});

describe("ReplyReader", () => {
  it("handles multi-line replies split mid-line", async () => {
    const r = new ReplyReader(streamOf(["220-Welcome\r\n220-to BOM\r", "\n220 ready\r\n331 Send pass\r\n"]));
    expect(await r.next()).toEqual({ code: 220, text: "Welcome\nto BOM\nready" });
    expect(await r.next()).toEqual({ code: 331, text: "Send pass" });
  });

  it("handles a CR and its LF arriving in separate chunks, one char at a time", async () => {
    const text = "220-Welcome\r\n220 ready\r\n";
    const r = new ReplyReader(streamOf([...text]));
    expect(await r.next()).toEqual({ code: 220, text: "Welcome\nready" });
  });

  it("returns two replies delivered in one chunk, one per next()", async () => {
    const r = new ReplyReader(streamOf(["226 done\r\n250 ok\r\n"]));
    expect(await r.next()).toEqual({ code: 226, text: "done" });
    expect(await r.next()).toEqual({ code: 250, text: "ok" });
  });

  it("throws when the stream closes early", async () => {
    const r = new ReplyReader(streamOf(["220-partial\r\n"]));
    await expect(r.next()).rejects.toThrow(/closed/);
  });

  it("times out when the server never sends", async () => {
    const hung = new ReadableStream<Uint8Array>({ start() {} });
    const r = new ReplyReader(hung, 50);
    await expect(r.next()).rejects.toThrow(/timeout/i);
  });
});

describe("expectReply", () => {
  it("returns the reply when the class matches", () => {
    expect(expectReply("USER", { code: 331, text: "x" }, 3)).toEqual({ code: 331, text: "x" });
  });
  it("throws FTP <cmd>: <code> <text> otherwise", () => {
    expect(() => expectReply("PASS", { code: 530, text: "Login incorrect." }, 2)).toThrow(
      "FTP PASS: 530 Login incorrect.",
    );
  });
});

describe("startSession", () => {
  it("a data timeout kills the session: later commands fail at once", async () => {
    const replies = "220 hi\r\n331 u\r\n230 p\r\n200 t\r\n227 Entering Passive Mode (1,2,3,4,0,21)\r\n150 go\r\n";
    const control = {
      readable: new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(enc.encode(replies)) }),
      writable: new WritableStream<Uint8Array>(),
    };
    const hung = { readable: new ReadableStream<Uint8Array>({ start() {} }) };
    const ftp = await startSession(control, () => hung, 50);
    await expect(ftp.retrieve("/a.png")).rejects.toThrow(/timeout/i);
    await expect(ftp.retrieve("/b.png")).rejects.toThrow(/unusable/);
  });
});
