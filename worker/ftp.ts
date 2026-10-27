import { connect } from "cloudflare:sockets";
import { startSession, type FtpSource } from "./ftpProtocol";

export type { FtpSource } from "./ftpProtocol";

const HOST = "ftp.bom.gov.au";

/** Opens an anonymous passive-mode FTP session to the BoM server. */
export async function openBomFtp(): Promise<FtpSource> {
  const control = connect({ hostname: HOST, port: 21 });
  return startSession(control, (port) => connect({ hostname: HOST, port }));
}
