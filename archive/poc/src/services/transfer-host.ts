/**
 * Transfer Host - builds this device's externally reachable base URL for
 * the data plane. TRANSFER_HOST overrides auto-detection (NAT/DDNS cases).
 */

import os from 'node:os';
import dgram from 'node:dgram';
import { config } from '../config.js';

function isRfc1918(ip: string): boolean {
  return (
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  );
}

function isLinkLocal(ip: string): boolean {
  return ip.startsWith('169.254.');
}

/**
 * The IP the OS would use for outbound traffic: a UDP "connect" performs a
 * route lookup without sending any packets, and the socket's local address
 * is the interface the kernel picked — i.e. the REAL LAN NIC, not some
 * virtual adapter (VMware/Hyper-V/WSL host interfaces love being .1 in
 * RFC1918 space and fool naive interface scans).
 */
function outboundAddress(): Promise<string | null> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    sock.once('error', () => {
      sock.close();
      resolve(null);
    });
    // TEST-NET-3 (RFC 5737): unroutable by design; UDP connect sends nothing.
    sock.connect(80, '203.0.113.1', () => {
      const addr = sock.address().address;
      sock.close();
      resolve(typeof addr === 'string' ? addr : null);
    });
  });
}

function scanFallback(): string {
  const candidates: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal && !isLinkLocal(addr.address)) {
        candidates.push(addr.address);
      }
    }
  }
  return candidates.find(isRfc1918) ?? candidates[0] ?? '127.0.0.1';
}

export async function primaryLanAddress(): Promise<string> {
  const outbound = await outboundAddress();
  return outbound ?? scanFallback();
}

export async function transferBaseUrl(): Promise<string> {
  const host = process.env.TRANSFER_HOST || (await primaryLanAddress());
  return `http://${host}:${config.port}`;
}
