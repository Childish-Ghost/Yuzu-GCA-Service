//! mdns.rs — 局域网 gca-server 自动发现（INT-004）：
//! mDNS PTR 查询 `_gca-server._tcp.local.`（QU 位 → 服务端单播应答，
//! 临时端口即可收包，无需绑定 5353/加入组播组）。零依赖 std UdpSocket + 手写 DNS 包。
//!
//! 解析约定（与 server/src/mdns.ts 对应）：server 地址 = 应答包源 IP + SRV rdata 端口。
//! 无结果（无 mDNS 发布者/被防火墙拦）→ 调用方回退全网段端口扫描（scan.rs）。

use std::net::{Ipv4Addr, SocketAddr, UdpSocket};
use std::time::{Duration, Instant};

const MDNS_GROUP: Ipv4Addr = Ipv4Addr::new(224, 0, 0, 251);
const MDNS_PORT: u16 = 5353;
const SERVICE_TYPE: &str = "_gca-server._tcp.local.";
const QTYPE_PTR: u16 = 12;
const QTYPE_SRV: u16 = 33;
/// 查询 ID（mDNS 无事务要求，固定值即可）
const QUERY_ID: u16 = 0x61ca;

/// mDNS 发现 gca-server：返回 URL 列表（如 `http://<网关IP>:18790`）。
/// 发现首个即返回；超时返回已收集结果（可能为空——调用方回退端口扫描）。
/// 注意：组播出口必须钉在物理网卡上（Windows 默认路由选接口可能落在
/// WSL/Hyper-V 虚拟网卡，组播不出物理网——本机实测 172.29 虚拟网卡不出包），
/// 所以对本机每个 IPv4 逐个发查询（QU 位 → 应答单播回临时端口，无需加组）。
pub fn discover(timeout_ms: u64) -> Vec<String> {
    let query = build_query();
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let mut urls: Vec<String> = Vec::new();
    let mut buf = [0u8; 4096];

    // 每个本地 IPv4 单独建 socket（绑到具体源地址 → 组播出口跟随该接口）。
    // 不绑 0.0.0.0：Windows 默认组播接口可能落在 WSL/Hyper-V 虚拟网卡上
    // （本机实测 172.29 虚拟网卡组播不出物理网）。QU 位 → 应答单播回本 socket。
    for ip in crate::scan::local_ipv4s() {
        if !urls.is_empty() || Instant::now() >= deadline {
            break;
        }
        let Ok(iface) = ip.parse::<std::net::Ipv4Addr>() else { continue };
        let Ok(sock) = UdpSocket::bind((iface, 0)) else { continue };
        let _ = sock.set_multicast_loop_v4(false);
        // 本接口接收窗口 ≤ 400ms（读超时受总 deadline 约束）
        let window = deadline.saturating_duration_since(Instant::now()).min(Duration::from_millis(400));
        if sock.set_read_timeout(Some(window)).is_err() {
            continue;
        }
        if sock
            .send_to(&query, SocketAddr::new(MDNS_GROUP.into(), MDNS_PORT))
            .is_err()
        {
            continue;
        }
        let slot_end = Instant::now() + window;
        while Instant::now() < slot_end && Instant::now() < deadline {
            match sock.recv_from(&mut buf) {
                Ok((n, src)) => {
                    for url in parse_response(&buf[..n], src.ip()) {
                        if !urls.contains(&url) {
                            urls.push(url);
                        }
                    }
                    if !urls.is_empty() {
                        break; // 发现即返回（首个 server 优先，端口扫描回退兜底）
                    }
                }
                Err(_) => break, // 本接口窗口无应答
            }
        }
    }
    urls
}

// --- DNS 包编解码（手写，零依赖） ---

/// PTR 查询包：ID + flags=0 + QD=1 + 名称 + type=PTR + class=IN|QU
fn build_query() -> Vec<u8> {
    let mut pkt = Vec::with_capacity(64);
    pkt.extend_from_slice(&QUERY_ID.to_be_bytes());
    pkt.extend_from_slice(&[0, 0]); // flags: 标准查询
    pkt.extend_from_slice(&[0, 1]); // QDCOUNT
    pkt.extend_from_slice(&[0, 0, 0, 0, 0, 0]); // AN/NS/AR
    encode_name(&mut pkt, SERVICE_TYPE);
    pkt.extend_from_slice(&QTYPE_PTR.to_be_bytes());
    pkt.extend_from_slice(&0x8001u16.to_be_bytes()); // class IN + QU 位
    pkt
}

/// 名称编码（点分，无压缩）——仅用于构造查询
fn encode_name(out: &mut Vec<u8>, name: &str) {
    for label in name.trim_end_matches('.').split('.') {
        out.push(label.len() as u8);
        out.extend_from_slice(label.as_bytes());
    }
    out.push(0);
}

/// 解析名称（支持压缩指针），返回名称与下一个字段偏移；畸形输入 Err。
/// S4b 修复（2026-08-12 审查，与 server mdns.ts 同修）：
///   1. 压缩指针必须**严格指向前方**（ptr < off）——自引用指针此前死循环
///   2. 跳转次数上限（MAX_POINTER_JUMPS）兜底
/// 其余越界检查原有已具备。
fn decode_name(pkt: &[u8], mut off: usize) -> Result<(String, usize), ()> {
    const MAX_POINTER_JUMPS: usize = 32;
    let mut labels = Vec::new();
    let mut end = off;
    let mut jumped = false;
    let mut jumps = 0;
    loop {
        if off >= pkt.len() {
            return Err(());
        }
        let len = pkt[off];
        if len == 0 {
            off += 1;
            if !jumped {
                end = off;
            }
            break;
        }
        if len & 0xc0 == 0xc0 {
            if off + 1 >= pkt.len() {
                return Err(());
            }
            let ptr = ((len & 0x3f) as usize) << 8 | pkt[off + 1] as usize;
            if ptr >= off {
                return Err(()); // 自引用/前向指针：畸形包，拒绝
            }
            jumps += 1;
            if jumps > MAX_POINTER_JUMPS {
                return Err(());
            }
            if !jumped {
                end = off + 2;
            }
            jumped = true;
            off = ptr;
            continue;
        }
        if off + 1 + len as usize > pkt.len() {
            return Err(());
        }
        labels.push(std::str::from_utf8(&pkt[off + 1..off + 1 + len as usize]).unwrap_or(""));
        off += 1 + len as usize;
    }
    Ok((labels.join(".") + ".", end))
}

/// 解析应答包：扫描 AN+AR 节找 SRV 记录（type 33），
/// server URL = 源 IP + SRV 端口（与 server mdns.ts 约定一致）。畸形包返回空。
fn parse_response(pkt: &[u8], src: std::net::IpAddr) -> Vec<String> {
    if pkt.len() < 12 {
        return Vec::new();
    }
    let flags = u16::from_be_bytes([pkt[2], pkt[3]]);
    if flags & 0x8000 == 0 {
        return Vec::new(); // 非响应
    }
    let an = u16::from_be_bytes([pkt[6], pkt[7]]) as usize;
    let ar = u16::from_be_bytes([pkt[10], pkt[11]]) as usize;
    let mut urls = Vec::new();
    let mut off = 12usize;
    for _ in 0..an + ar {
        let (_, next) = match decode_name(pkt, off) {
            Ok(v) => v,
            Err(_) => return urls, // 畸形包：放弃剩余部分
        };
        if next + 10 > pkt.len() {
            return urls;
        }
        let rtype = u16::from_be_bytes([pkt[next], pkt[next + 1]]);
        let rdlen = u16::from_be_bytes([pkt[next + 8], pkt[next + 9]]) as usize;
        let rdata = next + 10;
        if rdata + rdlen > pkt.len() {
            return urls;
        }
        if rtype == QTYPE_SRV && rdlen >= 6 {
            let port = u16::from_be_bytes([pkt[rdata + 4], pkt[rdata + 5]]);
            urls.push(format!("http://{src}:{port}"));
        }
        off = rdata + rdlen;
    }
    urls
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 手写应答包（无压缩）：PTR 回答 + SRV 回答 + A 附加，模拟 server mdns.ts 结构
    fn fake_response(port: u16, src_ip: &str) -> Vec<u8> {
        let mut pkt = Vec::new();
        pkt.extend_from_slice(&QUERY_ID.to_be_bytes());
        pkt.extend_from_slice(&0x8400u16.to_be_bytes()); // QR=1 authoritative
        pkt.extend_from_slice(&[0, 0]); // QD
        pkt.extend_from_slice(&[0, 2]); // AN: PTR + SRV
        pkt.extend_from_slice(&[0, 0]); // NS
        pkt.extend_from_slice(&[0, 1]); // AR: A
        // PTR: name=_gca-server._tcp.local., rdata=实例名
        encode_name(&mut pkt, SERVICE_TYPE);
        pkt.extend_from_slice(&QTYPE_PTR.to_be_bytes());
        pkt.extend_from_slice(&[0, 1]); // class IN
        pkt.extend_from_slice(&[0, 0, 0, 120]); // TTL
        let mut rdata_ptr = Vec::new();
        encode_name(&mut rdata_ptr, "GCA Server._gca-server._tcp.local.");
        pkt.extend_from_slice(&(rdata_ptr.len() as u16).to_be_bytes());
        pkt.extend_from_slice(&rdata_ptr);
        // SRV: name=实例名, priority/weight 0, port, target
        encode_name(&mut pkt, "GCA Server._gca-server._tcp.local.");
        pkt.extend_from_slice(&QTYPE_SRV.to_be_bytes());
        pkt.extend_from_slice(&[0, 1]);
        pkt.extend_from_slice(&[0, 0, 0, 120]);
        let mut rdata_srv = vec![0u8, 0, 0, 0];
        rdata_srv.extend_from_slice(&port.to_be_bytes());
        encode_name(&mut rdata_srv, "gca-server.local.");
        pkt.extend_from_slice(&(rdata_srv.len() as u16).to_be_bytes());
        pkt.extend_from_slice(&rdata_srv);
        // A: name=target, 4 字节 IP
        encode_name(&mut pkt, "gca-server.local.");
        pkt.extend_from_slice(&[0, 1]);
        pkt.extend_from_slice(&[0, 1]);
        pkt.extend_from_slice(&[0, 0, 0, 120]);
        pkt.extend_from_slice(&[0, 4]);
        pkt.extend_from_slice(&[10, 1, 0, 50]);
        pkt
    }

    #[test]
    fn parse_srv_from_response() {
        let pkt = fake_response(18790, "<网关IP>");
        let ip: std::net::IpAddr = "<网关IP>".parse().unwrap();
        let urls = parse_response(&pkt, ip);
        assert_eq!(urls, vec!["http://<网关IP>:18790"]);
    }

    #[test]
    fn non_response_ignored() {
        let pkt = build_query(); // 查询包（QR=0）
        let ip: std::net::IpAddr = "<网关IP>".parse().unwrap();
        assert!(parse_response(&pkt, ip).is_empty());
    }

    #[test]
    fn truncated_packet_no_panic() {
        let ip: std::net::IpAddr = "<网关IP>".parse().unwrap();
        assert!(parse_response(&[0u8; 6], ip).is_empty());
        assert!(parse_response(&[0u8; 40], ip).is_empty());
    }

    #[test]
    fn query_roundtrip_shape() {
        let q = build_query();
        assert_eq!(u16::from_be_bytes([q[4], q[5]]), 1, "QDCOUNT=1");
        // 名称后应为 type + class
        assert_eq!(q.len() > 12, true);
    }

    /// 实网验证（需局域网内有 gca-server 在发布 mDNS；CI 不跑）
    #[test]
    #[ignore]
    fn live_discover() {
        let urls = discover(3000);
        assert!(!urls.is_empty(), "局域网内应有 gca-server mDNS 应答");
        eprintln!("discovered: {urls:?}");
    }
}
