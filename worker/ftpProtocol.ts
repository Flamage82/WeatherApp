// Pure FTP logic (no cloudflare:sockets import) so it can be unit-tested in Node.
// worker/ftp.ts supplies the real sockets.

export interface FtpSource {
  list(pathOrGlob: string): Promise<string[]>;
  retrieve(path: string): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface FtpReply {
  code: number;
  text: string;
}

export const REPLY_TIMEOUT_MS = 15_000;

/** Read from a reader, rejecting if nothing arrives within `timeoutMs`. */
async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  what: string,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`FTP timeout waiting for ${what}`)), timeoutMs);
  });
  try {
    return await Promise.race([reader.read(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function parsePasv(line: string): { port: number } {
  const m = line.match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/);
  if (!m) throw new Error(`FTP PASV: cannot parse "${line}"`);
  return { port: Number(m[5]) * 256 + Number(m[6]) };
}

/** Reads control-connection replies, including multi-line `123-` ... `123 ` ones. */
export class ReplyReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private decoder = new TextDecoder();
  private buf = ""; // incomplete trailing line
  private lines: string[] = []; // complete lines not yet returned in a reply
  private scanned = 0; // lines[0..scanned) are known not to end a reply

  private timeoutMs: number;

  constructor(readable: ReadableStream<Uint8Array>, timeoutMs: number = REPLY_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
    this.reader = readable.getReader();
  }

  async next(): Promise<FtpReply> {
    for (;;) {
      // Each line is examined once; only newly arrived text is split.
      for (; this.scanned < this.lines.length; this.scanned++) {
        const line = this.lines[this.scanned]!;
        if (/^\d{3} /.test(line)) {
          const text = this.lines
            .slice(0, this.scanned + 1)
            .map((l) => l.replace(/^\d{3}[- ]/, ""))
            .join("\n");
          const code = Number(line.slice(0, 3));
          this.lines = this.lines.slice(this.scanned + 1);
          this.scanned = 0;
          return { code, text };
        }
      }
      const { value, done } = await readWithTimeout(this.reader, this.timeoutMs, "reply");
      if (done) throw new Error(`FTP control connection closed: ${this.buf}`);
      this.buf += this.decoder.decode(value, { stream: true });
      if (this.buf.includes("\r\n")) {
        const parts = this.buf.split("\r\n");
        this.buf = parts.pop()!;
        for (const p of parts) this.lines.push(p);
      }
    }
  }
}

/** Throw `FTP <cmd>: <code> <text>` unless the reply's first digit is `cls`. */
export function expectReply(cmd: string, reply: FtpReply, cls: number): FtpReply {
  if (Math.floor(reply.code / 100) !== cls) {
    throw new Error(`FTP ${cmd}: ${reply.code} ${reply.text}`);
  }
  return reply;
}

/** Drain a stream to EOF into one Uint8Array. */
export async function readAll(
  readable: ReadableStream<Uint8Array>,
  timeoutMs: number = REPLY_TIMEOUT_MS,
): Promise<Uint8Array> {
  const reader = readable.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { value, done } = await readWithTimeout(reader, timeoutMs, "data");
    if (done) break;
    chunks.push(value);
    n += value.length;
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export interface DataConn {
  readable: ReadableStream<Uint8Array>;
  close?(): unknown;
}

export interface ControlConn {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close?(): unknown;
}

/**
 * Drives an already-connected control socket: banner, login, TYPE I.
 * `openData(port)` must connect to the control HOSTNAME (not the PASV IP).
 */
export async function startSession(
  control: ControlConn,
  openData: (port: number) => DataConn,
  timeoutMs: number = REPLY_TIMEOUT_MS,
): Promise<FtpSource> {
  const replies = new ReplyReader(control.readable, timeoutMs);
  const writer = control.writable.getWriter();
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  // After a timeout or closed socket the control channel can be out of step (a reply still pending), so the
  // session is dead: every later command fails at once and the caller opens a new one.
  let broken: Error | null = null;
  const breakWith = (e: unknown) => {
    broken ??= new Error(`FTP session unusable after: ${e instanceof Error ? e.message : String(e)}`);
  };
  const reply = async () => {
    try {
      return await replies.next();
    } catch (e) {
      breakWith(e);
      throw e;
    }
  };

  const send = (cmd: string) => writer.write(enc.encode(cmd + "\r\n"));
  const cmd = async (c: string, cls: number, name = c.split(" ")[0] ?? c) => {
    if (broken) throw broken;
    await send(c);
    return expectReply(name, await reply(), cls);
  };

  expectReply("connect", await reply(), 2);
  await cmd("USER anonymous", 3);
  await cmd("PASS anonymous@", 2);
  await cmd("TYPE I", 2);

  // Fresh PASV per transfer; data socket opened and read before the command is sent.
  async function transfer(command: string): Promise<Uint8Array> {
    const name = command.split(" ")[0] ?? command;
    const { port } = parsePasv((await cmd("PASV", 2)).text);
    const data = openData(port);
    const dataP = readAll(data.readable, timeoutMs);
    dataP.catch(() => {}); // avoid unhandled rejection if the command fails first
    try {
      await cmd(command, 1, name);
      let bytes: Uint8Array;
      try {
        bytes = await dataP;
      } catch (e) {
        breakWith(e);
        throw e;
      }
      expectReply(name, await reply(), 2);
      return bytes;
    } catch (e) {
      try {
        await data.close?.();
      } catch {
        /* ignore */
      }
      throw e;
    }
  }

  return {
    async list(pathOrGlob) {
      const bytes = await transfer(`NLST ${pathOrGlob}`);
      return dec
        .decode(bytes)
        .split(/\r?\n/)
        .map((s) => s.trim().split("/").pop()!)
        .filter((s) => s.length > 0);
    },
    retrieve: (path) => transfer(`RETR ${path}`),
    async close() {
      // QUIT is fire-and-forget
      send("QUIT").catch(() => {});
    },
  };
}
