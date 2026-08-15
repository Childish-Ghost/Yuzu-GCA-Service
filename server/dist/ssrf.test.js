/**
 * ssrf.test.ts — safeUrl SSRF 防护回归（2026-08-12 审查 S3 重写）。
 * 绕过矩阵：IPv4-mapped（点分/十六进制）、回环、私网、链路本地、组播、
 * CGNAT、benchmark 段全部拒绝；公网字面 IP 放行。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { safeUrl } from './gca-server.js';
const REJECTED = [
    // 经典绕过（此前实测可通）
    'http://[::ffff:7f00:1]:3001/mcp', // IPv4-mapped 十六进制 → 127.0.0.1
    'http://[::ffff:0a00:0001]:3001/mcp', // → 10.0.0.1
    'http://[::ffff:127.0.0.1]:3001/mcp', // IPv4-mapped 点分
    'http://[::1]:3001/mcp', // 裸 IPv6 回环（此前连这都放行）
    // 字面 IPv4 各保留段
    'http://127.0.0.1:3001/mcp',
    'http://localhost:3001/mcp',
    'http://<网关IP>:3001/mcp',
    'http://172.16.0.1:3001/mcp',
    'http://172.31.255.1:3001/mcp',
    'http://192.168.1.1:3001/mcp',
    'http://169.254.169.254/latest/meta-data/', // 云元数据端点
    'http://0.0.0.0:3001/mcp',
    'http://100.64.0.1:3001/mcp', // CGNAT
    'http://198.18.0.1:3001/mcp', // benchmark
    'http://224.0.0.251:5353/', // 组播
    'http://240.0.0.1:3001/mcp', // 保留
    // 非 http(s) 协议
    'file:///etc/passwd',
    'ftp://<网关IP>/x',
    'garbage',
];
const ALLOWED = [
    'http://8.8.8.8:3001/mcp', // 公网字面 IP
    'http://1.1.1.1:53/',
    'http://example.com:8080/path', // 公网 DNS 名（解析任一公网地址即放行）
];
test('SSRF 拒绝矩阵全部拦截', async () => {
    for (const url of REJECTED) {
        const r = await safeUrl(url);
        assert.equal(r, null, `应拒绝: ${url}`);
    }
});
test('公网地址放行', async () => {
    for (const url of ALLOWED) {
        const r = await safeUrl(url);
        assert.ok(r !== null, `应放行: ${url}`);
    }
});
//# sourceMappingURL=ssrf.test.js.map