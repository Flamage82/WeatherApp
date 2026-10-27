import { connect } from "cloudflare:sockets";

const HOST = "ftp.bom.gov.au";
const dec = new TextDecoder();
const enc = new TextEncoder();

class Ctl {
  r: ReadableStreamDefaultReader<Uint8Array>; w: WritableStreamDefaultWriter<Uint8Array>; buf = ""; log: string[] = [];
  constructor(public s: any) { this.r = s.readable.getReader(); this.w = s.writable.getWriter(); }
  async reply(): Promise<string> {
    for (;;) {
      const lines = this.buf.split("\r\n");
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3} /.test(lines[i])) {
          const out = lines.slice(0, i + 1).join("\r\n");
          this.buf = lines.slice(i + 1).join("\r\n");
          this.log.push("< " + out.replace(/\r\n/g, " | "));
          return out;
        }
      }
      const { value, done } = await this.r.read();
      if (done) throw new Error("ctl closed: " + this.buf);
      this.buf += dec.decode(value);
    }
  }
  async cmd(c: string): Promise<string> { this.log.push("> " + c); await this.w.write(enc.encode(c + "\r\n")); return this.reply(); }
}

async function pasv(c: Ctl): Promise<{ port: number; mode: string }> {
  const r = await c.cmd("PASV");
  const m = r.match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/);
  if (m) return { port: +m[5] * 256 + +m[6], mode: "PASV" };
  const r2 = await c.cmd("EPSV");
  const m2 = r2.match(/\(\|\|\|(\d+)\|\)/);
  if (m2) return { port: +m2[1], mode: "EPSV" };
  throw new Error("no pasv/epsv: " + r + " / " + r2);
}

async function readAll(s: any): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []; let n = 0;
  const r = s.readable.getReader();
  for (;;) { const { value, done } = await r.read(); if (done) break; chunks.push(value); n += value.length; }
  const out = new Uint8Array(n); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

async function run(env: any, lean = false, glob = false) {
  const t0 = Date.now();
  const c = new Ctl(connect({ hostname: HOST, port: 21 }));
  await c.reply();
  await c.cmd("USER anonymous");
  await c.cmd("PASS anonymous@");
  await c.cmd("TYPE I");
  let p = await pasv(c);
  const d1 = connect({ hostname: HOST, port: p.port });
  const listP = readAll(d1);
  await c.cmd(glob ? "NLST /anon/gen/radar/IDR503.T.*.png" : "NLST /anon/gen/radar/");
  const listing = dec.decode(await listP);
  await c.reply(); // 226
  const names = listing.split(/\r?\n/).map(s => s.trim().split("/").pop()!).filter(n => /^IDR503\.T\.\d{12}\.png$/.test(n)).sort();
  const name = names[names.length - 1];
  const tList = Date.now() - t0;
  p = await pasv(c);
  const d2 = connect({ hostname: HOST, port: p.port });
  const dataP = readAll(d2);
  await c.cmd("RETR /anon/gen/radar/" + name);
  const data = await dataP;
  await c.reply(); // 226
  let r2 = "skipped";
  if (env.BUCKET) { await env.BUCKET.put("spike/" + name, data, { httpMetadata: { contentType: "image/png" } }); r2 = "ok"; }
  c.cmd("QUIT").catch(() => {});
  const dv = new DataView(data.buffer, data.byteOffset);
  const png = data.length > 24 ? { sig: String.fromCharCode(...data.slice(1, 4)), w: dv.getUint32(16), h: dv.getUint32(20) } : null;
  return { listed: names.length, fetched: name, bytes: data.length, ms: Date.now() - t0, msList: tList, mode: p.mode, r2, png, log: lean ? undefined : c.log };
}

export default {
  async fetch(req: Request, env: any) {
    const path = new URL(req.url).pathname;
    if (path === "/ping") return new Response("ok");
    if (path === "/connect") { const t = Date.now(); const so = connect({ hostname: HOST, port: 21 }); const r = so.readable.getReader(); await r.read(); await so.close().catch(() => {}); return Response.json({ ms: Date.now() - t }); }
    if (path === "/login") { const c = new Ctl(connect({ hostname: HOST, port: 21 })); await c.reply(); await c.cmd("USER anonymous"); await c.cmd("PASS anonymous@"); await c.cmd("TYPE I"); c.cmd("QUIT").catch(() => {}); return Response.json({ ok: 1 }); }
    if (path === "/pasv") { const c = new Ctl(connect({ hostname: HOST, port: 21 })); await c.reply(); await c.cmd("USER anonymous"); await c.cmd("PASS anonymous@"); await c.cmd("TYPE I"); const p = await pasv(c); const d = connect({ hostname: HOST, port: p.port }); const lp = readAll(d); await c.cmd("NLST /anon/gen/radar/"); const l = await lp; await c.reply(); c.cmd("QUIT").catch(() => {}); return Response.json({ n: l.length }); }
    if (path === "/glob") { try { return Response.json(await run(env, true, true)); } catch (e: any) { return Response.json({ error: String(e?.stack ?? e) }, { status: 500 }); } }
    if (path === "/lean") { try { return Response.json(await run(env, true)); } catch (e: any) { return Response.json({ error: String(e?.stack ?? e) }, { status: 500 }); } }
    if (path !== "/run") return new Response("ok");
    try { return Response.json(await run(env)); } catch (e: any) { return Response.json({ error: String(e?.stack ?? e) }, { status: 500 }); }
  },
  async scheduled(_e: any, env: any) { const r = await run(env, true, true); console.log("cron", JSON.stringify({ ...r, log: undefined })); },
};
