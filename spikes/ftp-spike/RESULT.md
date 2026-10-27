# FTP-from-Worker spike result

Verdict: FTP over `cloudflare:sockets` WORKS, CPU is under the free 10 ms limit only with the NLST glob mitigation. R2 half NOT tested because R2 is not enabled on the account (`wrangler r2 bucket create` -> code 10042 "Please enable R2 through the Cloudflare Dashboard"). Gate is therefore not fully closed; see bottom.

## Command sequence that worked (control + 2 data sockets, 1 session)
```
connect(ftp.bom.gov.au:21)
< 220-Welcome ... (about 25 lines of "220-" disclaimer, final line "220 ")   multi-line banner
> USER anonymous      < 331 Please specify the password.
> PASS anonymous@     < 230 Login successful.
> TYPE I              < 200 Switching to Binary mode.
> PASV                < 227 Entering Passive Mode (134,178,253,145,123,84).
  data = connect(ftp.bom.gov.au, port = 123*256+84)   (hostname, ignore reply IP)
> NLST /anon/gen/radar/IDR503.T.*.png    < 150 Here comes the directory listing.  (read data socket to EOF)  < 226 Directory send OK.
> PASV                < 227 ... (new port each time)
  data = connect(host, port)
> RETR /anon/gen/radar/IDR503.T.202610270649.png
                      < 150 Opening BINARY mode data connection for ... (7741 bytes).   (read data to EOF)  < 226 Transfer complete.
> QUIT
```

## Quirks for Task 2
- Server is vsftpd-style. PASV worked every time; EPSV fallback never needed (kept in code, untested).
- 220 banner is MULTI-LINE (`220-` ... final `220 `). The reply reader must wait for a line matching `^\d{3} ` (space, not dash). Same rule for every reply.
- Control replies can arrive split across chunks; buffer and split on `\r\n`.
- PASV reply IP (134.178.253.145) is ignored; connecting the data socket to the control hostname at the PASV port works.
- Open the data socket and start reading it BEFORE sending NLST/RETR, then await the 150 reply, drain data to EOF, then read the 226.
- Each transfer needs a fresh PASV (new port).
- **NLST of the whole `/anon/gen/radar/` returns about 417 KB (all products, hundreds of files).** Decoding and filtering that costs about 12 ms CPU alone. Use a server-side glob: `NLST /anon/gen/radar/IDR503.T.*.png` (vsftpd globs work). Returns about 25 names. Do one glob per product (or one session, several globs).
- Listing returns names (NLST with a path argument returned bare names here; code strips any leading path anyway).
- Frame cadence is about 5 min; about 23-26 IDR503 frames listed. PNGs ~7.7-8 KB, 512x512 (verified from IHDR).
- Do not await QUIT (fire and forget).

## Bytes and timing
- 1 file (7.7-8.0 KB) per session.
- Warm HTTP-triggered session wall time: 280-380 ms (glob listing about 230 ms, RETR about 55 ms). First call after deploy: 3.5 s.
- Cron-triggered runs wall time: 3.3 s and 5.7 s (cold and slower; seen in 2 samples). Still fine for a cron.
- Login only: 80-100 ms wall. TCP connect to port 21: about 30-45 ms.

## CPU time (from `wrangler tail --format json` `cpuTime`)
| variant | CPU ms |
|---|---|
| trivial request | 0 |
| connect + read banner | 1 |
| login only (USER/PASS/TYPE/QUIT) | 1-2 |
| login + full-directory NLST (417 KB) | 13-19 |
| full run, full NLST + RETR 1 file | 17-34 (first measure with big debug log: 21/39/49) |
| **full run, glob NLST + RETR 1 file** | **4-6** |
| cron run, glob (2 samples) | 5 and 9 |

Free plan limit is 10 ms. With the glob: 4-9 ms for ONE file. Cron sample of 9 ms is close to the line. Per extra file expect roughly 1-2 ms more (not measured per file; each adds a PASV, a data socket and RETR). Eight products x about 1 new frame per run is NOT measured and could exceed 10 ms; budget accordingly (see below). R2 `put` cost not measured.

Observation: runs above 10 ms (up to 49 ms) still returned `outcome: ok` on the free plan; enforcement did not kill them in this test. Do not rely on that.

## Cron
`*/5 * * * *` scheduled handler ran twice during tail observation (07:00 and 07:05 UTC), both `outcome: ok`, logs show listed 25-26 and bytes 7824 / 7995. R2 write skipped (no bucket). Cron has been removed again from the config and redeployed.

## Recommendations for Task 2
1. Glob NLST per product, never list the whole directory.
2. Fetch only frames not already in R2; first-fill (about 18 frames x 8 products) must be spread over several runs (a few files per run).
3. One session per run; split products across runs/crons if CPU nears 10 ms (e.g. 2-3 products per cron invocation, staggered).
4. Keep per-run logging minimal (building/serializing the command log costs CPU).
5. Re-measure with the R2 put included.

## Gate verdict
FTP: PASS. CPU: PASS with mitigation (4-9 ms for one file). R2 write + object download check: NOT DONE, blocked on the user enabling R2 in the Cloudflare dashboard (Storage & databases -> R2; may ask for a payment method even for the free tier). The `ftp-spike` Worker is still deployed (cron removed) at https://ftp-spike.bytecreep.workers.dev so the R2 check can be finished by adding the binding. No cleanup was done; bucket `rain-radar` does not exist yet.
