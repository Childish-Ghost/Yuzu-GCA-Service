/**
 * mdns.test.ts — 手写 DNS 包编解码自测（INT-004）：
 * 构造查询 → shouldRespond 判定 → 应答包结构/内容校验。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldRespond, buildResponse, SERVICE_TYPE, INSTANCE, TARGET } from './mdns.js';
/** 构造一个标准 PTR 查询包（无压缩，含名称/类型/类） */
function buildQuery(id, name, qtype = 12, qclass = 1) {
    const nameBuf = encodeNameForTest(name);
    const header = Buffer.alloc(12);
    header.writeUInt16BE(id, 0);
    header.writeUInt16BE(0, 2); // standard query
    header.writeUInt16BE(1, 4); // QDCOUNT
    header.writeUInt16BE(0, 6);
    header.writeUInt16BE(0, 8);
    header.writeUInt16BE(0, 10);
    const tail = Buffer.alloc(4);
    tail.writeUInt16BE(qtype, 0);
    tail.writeUInt16BE(qclass, 2);
    return Buffer.concat([header, nameBuf, tail]);
}
function encodeNameForTest(name) {
    const out = [];
    for (const label of name.replace(/\.$/, '').split('.')) {
        out.push(label.length);
        for (const b of Buffer.from(label))
            out.push(b);
    }
    out.push(0);
    return Buffer.from(out);
}
/** 解析应答包：返回 { an: [{type, name, ttl}], ar: [...] , port? } */
function parseResponse(pkt) {
    assert.ok(pkt.length >= 12, 'header present');
    const an = pkt.readUInt16BE(6);
    const ar = pkt.readUInt16BE(10);
    const types = [];
    const names = [];
    let ttl = 0;
    let off = 12;
    const readName = (pos) => {
        // 测试包内名称均无压缩指针，直接解析
        const labels = [];
        while (pos < pkt.length) {
            const len = pkt[pos];
            if (len === 0) {
                pos += 1;
                break;
            }
            labels.push(pkt.subarray(pos + 1, pos + 1 + len).toString());
            pos += 1 + len;
        }
        return { name: labels.join('.') + '.', next: pos };
    };
    for (let i = 0; i < an + ar; i++) {
        const { name, next } = readName(off);
        names.push(name);
        const type = pkt.readUInt16BE(next);
        types.push(type);
        ttl = pkt.readUInt32BE(next + 4);
        const rdlen = pkt.readUInt16BE(next + 8);
        off = next + 10;
        if (type === 33) {
            const port = pkt.readUInt16BE(off + 4); // priority/weight(4) 后是端口
            assert.strictEqual(port, 18790, 'SRV port');
        }
        off += rdlen;
    }
    return { types, names, ttl };
}
test('PTR 查询被识别为应应答', () => {
    const q = buildQuery(0x1234, SERVICE_TYPE);
    assert.deepEqual(shouldRespond(q), { id: 0x1234, ok: true, unicast: false });
});
test('QU 位（QCLASS 高比特）→ 单播应答', () => {
    const q = buildQuery(0x1235, SERVICE_TYPE, 12, 0x8001);
    assert.deepEqual(shouldRespond(q), { id: 0x1235, ok: true, unicast: true });
});
test('ANY 查询（type=255）也应答', () => {
    const q = buildQuery(2, SERVICE_TYPE, 255);
    assert.equal(shouldRespond(q).ok, true);
});
test('无关服务查询不应答', () => {
    const q = buildQuery(1, '_other._tcp.local.');
    assert.equal(shouldRespond(q).ok, false);
});
test('响应包（QR=1）不应答', () => {
    const q = buildQuery(1, SERVICE_TYPE);
    q.writeUInt16BE(0x8400, 2);
    assert.equal(shouldRespond(q).ok, false);
});
test('应答包结构：PTR+SRV+TXT 回答 + A 附加', () => {
    const pkt = buildResponse(0xbeef, 18790, { version: 'gca-server' }, ['<网关IP>']);
    const { types, names, ttl } = parseResponse(pkt);
    assert.deepEqual(types, [12, 33, 16, 1], 'PTR/SRV/TXT/A');
    assert.equal(names[0].toLowerCase(), SERVICE_TYPE);
    assert.equal(names[1].toLowerCase(), INSTANCE.toLowerCase());
    assert.equal(names[2].toLowerCase(), INSTANCE.toLowerCase());
    assert.equal(names[3].toLowerCase(), TARGET);
    assert.equal(ttl, 120);
});
test('应答包可被本模块自己的名称解析器解读（round trip）', () => {
    const pkt = buildResponse(0x1, 18790, { version: 'gca-server' }, ['<网关IP>']);
    // 应答包头部之后第一个 RR 名称应等于 SERVICE_TYPE
    const { name } = decodeNameForTest(pkt, 12);
    assert.equal(name.toLowerCase(), SERVICE_TYPE);
});
function decodeNameForTest(buf, off) {
    const labels = [];
    let pos = off;
    for (;;) {
        const len = buf[pos];
        if (len === 0) {
            pos += 1;
            break;
        }
        if ((len & 0xc0) === 0xc0) {
            const ptr = ((len & 0x3f) << 8) | buf[pos + 1];
            pos = ptr;
            continue;
        }
        labels.push(buf.subarray(pos + 1, pos + 1 + len).toString());
        pos += 1 + len;
    }
    return { name: labels.join('.') + '.', next: pos };
}
// --- S4 畸形包回归（2026-08-12 审查）：此前 decodeName 无边界/循环防护，
// 畸形压缩指针或截断包可死循环卡死事件循环（HTTP 全停）。
// 以下用例必须**有限时间内**返回 ok:false——node:test 超时会挂。 ---
/** 构造一个名称区为原始字节的查询包（QDCOUNT=1） */
function queryWithNameBytes(nameBytes, qtype = 12, qclass = 1) {
    const header = Buffer.alloc(12);
    header.writeUInt16BE(1, 0);
    header.writeUInt16BE(0, 2); // standard query
    header.writeUInt16BE(1, 4); // QDCOUNT
    header.writeUInt16BE(0, 6);
    header.writeUInt16BE(0, 8);
    header.writeUInt16BE(0, 10);
    const tail = Buffer.alloc(4);
    tail.writeUInt16BE(qtype, 0);
    tail.writeUInt16BE(qclass, 2);
    return Buffer.concat([header, Buffer.from(nameBytes), tail]);
}
test('畸形：自引用压缩指针（ptr==pos）→ 不应答且有限时间返回', () => {
    const q = queryWithNameBytes([0xc0, 0x0c]); // 偏移 12 的指针指向 12 自身
    const start = Date.now();
    assert.equal(shouldRespond(q).ok, false);
    assert.ok(Date.now() - start < 1000, 'no infinite loop');
});
test('畸形：截断 label（长度字节超出包尾）→ 不应答', () => {
    const q = queryWithNameBytes([5, 0x61]); // label 声明 5 字节但只有 1 字节
    assert.equal(shouldRespond(q).ok, false);
});
test('畸形：截断指针（只余 1 字节）→ 不应答', () => {
    const header = Buffer.alloc(12);
    header.writeUInt16BE(1, 0);
    header.writeUInt16BE(0, 2);
    header.writeUInt16BE(1, 4);
    const q = Buffer.concat([header, Buffer.from([0xc0])]); // 指针缺第二个字节
    assert.equal(shouldRespond(q).ok, false);
});
test('畸形：指针越界（ptr > 包长）→ 不应答', () => {
    const q = queryWithNameBytes([0xc0, 0xff]); // ptr=255 远超包长
    assert.equal(shouldRespond(q).ok, false);
});
test('畸形：前向压缩指针（ptr > pos）→ 不应答', () => {
    const q = queryWithNameBytes([0xc0, 0x14]); // 偏移 12 的指针指向 20（前向）
    assert.equal(shouldRespond(q).ok, false);
});
test('畸形：指针环（12→16→12→16...）→ 不应答且有限时间返回', () => {
    const q = queryWithNameBytes([0xc0, 0x10, 0xc0, 0x0c]); // 12→16，16→12（后向），12→16（前向拒绝）
    const start = Date.now();
    assert.equal(shouldRespond(q).ok, false);
    assert.ok(Date.now() - start < 1000, 'no infinite loop');
});
test('畸形：超长名称（累计 >255 字节）→ 不应答', () => {
    const bytes = [];
    for (let i = 0; i < 200; i++)
        bytes.push(2, 0x61, 0x62); // 200×3=600 字节标签流
    const q = queryWithNameBytes(bytes);
    assert.equal(shouldRespond(q).ok, false);
});
//# sourceMappingURL=mdns.test.js.map