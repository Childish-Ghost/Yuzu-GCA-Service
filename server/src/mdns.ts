/**
 * mdns.ts — 局域网服务发现发布端（INT-004）：DNS-SD 服务 _gca-server._tcp.local.
 *
 * 让 desktop / agent 通过 mDNS 自动发现 gca-server（替代手填地址 / 全网段端口扫描）。
 * 零依赖：node:dgram + 手写 DNS 包编解码（组播 224.0.0.251:5353）。
 *
 * 行为：
 *   1. 启动即发一次 announce（PTR + SRV + TXT + A，多播，TTL 120s）
 *   2. 应答 `_gca-server._tcp.local.` 的 PTR 查询（多播应答，同包带附加节）
 *   3. 每 60s 重新 announce（防缓存过期）
 *
 * 客户端解析约定（desktop mdns.rs / 本模块自测）：
 *   服务器地址 = 应答包源 IP + SRV rdata 端口（A 记录供标准 mDNS 工具使用）。
 * 绑定失败（端口被占等）→ 静默降级，不影响服务本身。
 */

import dgram from 'node:dgram';
import os from 'node:os';

/** DNS-SD 服务类型（标准后缀 .local.） */
export const SERVICE_TYPE = '_gca-server._tcp.local.';
/** 服务实例名（PTR 指向它） */
export const INSTANCE = 'GCA Server.' + SERVICE_TYPE;
/** SRV 目标主机名（A 记录挂它；客户端实际用源 IP） */
export const TARGET = 'gca-server.local.';
const MDNS_GROUP = '224.0.0.251';
const MDNS_PORT = 5353;
const TTL = 120; // 秒
/** 重 announce 间隔 */
const REANNOUNCE_MS = 60_000;

export interface MdnsOptions {
  /** gca-server 端口（SRV rdata 用） */
  port: number;
  /** TXT 附加信息（如 version） */
  info?: Record<string, string>;
  /** 日志（默认静默） */
  log?: (...args: unknown[]) => void;
}

export interface MdnsAnnouncer {
  close(): void;
}

/** 本机所有 IPv4（跳回环/APIPA/组播），用于 A 记录 */
function localIpv4s(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) {
        const ip = ni.address;
        if (!ip.startsWith('169.254.')) out.push(ip);
      }
    }
  }
  return out;
}

// --- DNS 名称编解码（手写，零依赖） ---

function encodeName(name: string): Buffer {
  const out: number[] = [];
  for (const label of name.replace(/\.$/, '').split('.')) {
    out.push(label.length);
    for (const b of Buffer.from(label, 'utf8')) out.push(b);
  }
  out.push(0);
  return Buffer.from(out);
}

/** 压缩指针链最大跳数（防指针循环，RFC 1035 名称最长 255 字节 + 合理余量） */
const MAX_POINTER_JUMPS = 32;
const MAX_NAME_BYTES = 255;

/**
 * 解析名称（支持压缩指针），返回名称与下一个字段偏移。
 *
 * S4 修复（2026-08-12 审查）：此前无任何边界/循环防护——畸形包可死循环卡死
 * 事件循环（整个 HTTP 服务 DoS）：
 *   1. 压缩指针必须**严格指向前方**（ptr < pos，RFC 1035 指针引用先前出现处）——
 *      自引用（ptr==pos）或前向指针立即拒绝
 *   2. 跳转次数上限（MAX_POINTER_JUMPS）
 *   3. 每次访问前检查越界（截断包：buf[pos] 为 undefined 曾导致 pos+=NaN 死循环）
 *   4. 名称累计字节上限（MAX_NAME_BYTES）
 * 解析失败抛异常——调用方（shouldRespond）已 try/catch 转为不应答。
 */
function decodeName(buf: Buffer, off: number): { name: string; next: number } {
  const labels: string[] = [];
  let pos = off;
  let end = off;
  let jumped = false;
  let jumps = 0;
  let total = 0;
  for (;;) {
    if (pos >= buf.length) throw new Error('name: offset past end');
    const len = buf[pos];
    if (len === 0) {
      pos += 1;
      if (!jumped) end = pos;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) throw new Error('name: truncated pointer');
      const ptr = ((len & 0x3f) << 8) | buf[pos + 1];
      if (ptr >= pos) throw new Error('name: pointer not backward');
      if (++jumps > MAX_POINTER_JUMPS) throw new Error('name: too many pointer jumps');
      if (!jumped) end = pos + 2;
      jumped = true;
      pos = ptr;
      continue;
    }
    if (pos + 1 + len > buf.length) throw new Error('name: label past end');
    total += len + 1;
    if (total > MAX_NAME_BYTES) throw new Error('name: name too long');
    labels.push(buf.subarray(pos + 1, pos + 1 + len).toString('utf8'));
    pos += 1 + len;
  }
  return { name: labels.join('.') + '.', next: jumped ? end : pos };
}

/** RR 编码：名称 + 类型/类/TTL + rdata 长度/rdata */
function encodeRr(name: Buffer, type: number, ttl: number, rdata: Buffer): Buffer {
  const head = Buffer.alloc(10);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(1, 2); // class IN
  head.writeUInt32BE(ttl, 4);
  head.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([name, head, rdata]);
}

/** PTR rdata（目标实例名） */
function rrPtr(targetName: string): Buffer {
  return encodeName(targetName);
}
/** SRV rdata：priority/weight 0 + port + target */
function rrSrv(port: number): Buffer {
  return Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from([(port >> 8) & 0xff, port & 0xff]), encodeName(TARGET)]);
}
/** TXT rdata：key=value 序列（单长度前缀） */
function rrTxt(info: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(info)) {
    const kv = Buffer.from(`${k}=${v}`, 'utf8');
    parts.push(Buffer.concat([Buffer.from([kv.length]), kv]));
  }
  return Buffer.concat(parts);
}
/** A rdata：IPv4 四字节 */
function rrA(ip: string): Buffer | null {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return Buffer.from(parts);
}

/** 组装多播应答包（复制请求 ID；QD=0，AN=PTR/SRV/TXT，AR=A×N） */
export function buildResponse(id: number, port: number, info: Record<string, string>, ips: string[]): Buffer {
  const ptr = encodeRr(encodeName(SERVICE_TYPE), 12, TTL, rrPtr(INSTANCE));
  const srv = encodeRr(encodeName(INSTANCE), 33, TTL, rrSrv(port));
  const txt = encodeRr(encodeName(INSTANCE), 16, TTL, rrTxt(info));
  const aRrs = ips
    .map((ip) => rrA(ip))
    .filter((b): b is Buffer => b !== null)
    .map((a) => encodeRr(encodeName(TARGET), 1, TTL, a));

  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x8400, 2); // response, authoritative
  header.writeUInt16BE(0, 4); // QDCOUNT
  header.writeUInt16BE(3, 6); // ANCOUNT
  header.writeUInt16BE(0, 8); // NSCOUNT
  header.writeUInt16BE(aRrs.length, 10); // ARCOUNT
  return Buffer.concat([header, ptr, srv, txt, ...aRrs]);
}

/** 仅应答 _gca-server._tcp.local. 的 PTR/ANY 查询（标准查询，非响应）。
 *  `unicast`：QU 位（QCLASS 高比特）——客户端用临时端口收不到组播应答，按规范改单播回包。 */
export function shouldRespond(pkt: Buffer): { id: number; ok: boolean; unicast: boolean } {
  if (pkt.length < 12) return { id: 0, ok: false, unicast: false };
  const qd = pkt.readUInt16BE(4);
  const flags = pkt.readUInt16BE(2);
  if (qd === 0 || (flags & 0x8000) !== 0) return { id: 0, ok: false, unicast: false }; // 非查询/重复响应
  const id = pkt.readUInt16BE(0);
  let off = 12;
  for (let i = 0; i < qd; i++) {
    let qname: string;
    try {
      ({ name: qname, next: off } = decodeName(pkt, off));
    } catch {
      return { id: 0, ok: false, unicast: false };
    }
    if (pkt.length < off + 4) return { id: 0, ok: false, unicast: false };
    const qtype = pkt.readUInt16BE(off);
    const qclass = pkt.readUInt16BE(off + 2);
    if (qname.toLowerCase() === SERVICE_TYPE && (qtype === 12 || qtype === 255) && (qclass & 0x7fff) === 1) {
      return { id, ok: true, unicast: (qclass & 0x8000) !== 0 };
    }
  }
  return { id: 0, ok: false, unicast: false };
}

/**
 * 启动 mDNS 发布。绑定失败（5353 被占）→ log 后返回可 close 的空对象（优雅降级）。
 */
export function startMdnsAnnouncer(opts: MdnsOptions): MdnsAnnouncer {
  const log = opts.log ?? (() => {});
  const info = { version: 'gca-server', ...(opts.info ?? {}) };

  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let closed = false;
  let timer: NodeJS.Timeout | null = null;

  const announce = () => {
    if (closed) return;
    const ips = localIpv4s();
    if (ips.length === 0) return;
    const pkt = buildResponse(0, opts.port, info, ips);
    socket.send(pkt, MDNS_PORT, MDNS_GROUP, (err) => {
      if (err && !closed) log('[mdns] announce failed:', err.message);
    });
  };

  socket.on('message', (msg, rinfo) => {
    const { id, ok, unicast } = shouldRespond(msg);
    if (!ok) return;
    const ips = localIpv4s();
    const pkt = buildResponse(id, opts.port, info, ips);
    // QU 位 → 单播回包（客户端临时端口场景）；否则组播（标准 mDNS 客户端）
    const destPort = unicast ? rinfo.port : MDNS_PORT;
    const destAddr = unicast ? rinfo.address : MDNS_GROUP;
    socket.send(pkt, destPort, destAddr, (err) => {
      if (err && !closed) log('[mdns] respond failed:', err.message);
    });
    log('[mdns] answered query from', rinfo.address, unicast ? '(unicast)' : '(multicast)');
  });

  socket.on('error', (err) => {
    log('[mdns] error:', err.message);
  });

  socket.bind(MDNS_PORT, () => {
    try {
      socket.addMembership(MDNS_GROUP);
    } catch (err) {
      log('[mdns] join group failed:', err instanceof Error ? err.message : err);
    }
    socket.setMulticastTTL(255);
    announce();
    log(`[mdns] publishing ${SERVICE_TYPE} port ${opts.port} on ${MDNS_GROUP}:${MDNS_PORT}`);
    timer = setInterval(announce, REANNOUNCE_MS);
    timer.unref();
  });

  return {
    close() {
      closed = true;
      if (timer) clearInterval(timer);
      try {
        socket.close();
      } catch {
        /* 已关闭 */
      }
    },
  };
}
