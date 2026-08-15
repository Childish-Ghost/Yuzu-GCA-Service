//! 零依赖 base64 编解码（从 term.rs 抽出公共化——Android 截图 P2 也要用，
//! term 是 Windows-only 模块）。

/// base64 编码（标准字母表 + 填充）
pub fn encode(data: &[u8]) -> String {
    const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], chunk.get(1).copied().unwrap_or(0), chunk.get(2).copied().unwrap_or(0)];
        out.push(B64[(b[0] >> 2) as usize] as char);
        out.push(B64[(((b[0] & 0x03) << 4) | (b[1] >> 4)) as usize] as char);
        out.push(if chunk.len() > 1 {
            B64[(((b[1] & 0x0F) << 2) | (b[2] >> 6)) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 { B64[(b[2] & 0x3F) as usize] as char } else { '=' });
    }
    out
}

/// base64 解码（忽略空白/填充错误宽容处理）
pub fn decode(s: &str) -> Vec<u8> {
    const TABLE: [i16; 256] = {
        let mut t = [-1i16; 256];
        let mut i = 0;
        while i < 26 {
            t[b'A' as usize + i] = i as i16;
            t[b'a' as usize + i] = (i + 26) as i16;
            i += 1;
        }
        i = 0;
        while i < 10 {
            t[b'0' as usize + i] = (i + 52) as i16;
            i += 1;
        }
        t[b'+' as usize] = 62;
        t[b'/' as usize] = 63;
        t
    };
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for c in s.bytes() {
        let v = TABLE[c as usize];
        if v < 0 {
            continue; // 空白/填充
        }
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    out
}
