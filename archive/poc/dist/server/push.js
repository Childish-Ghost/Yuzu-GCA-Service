/**
 * Push notifications via openclaw CLI — feishu + wechat dual-channel.
 */
import { execFile } from 'node:child_process';
import { serverConfig } from './config.js';
const TARGETS = [
    { channel: 'feishu', target: 'ou_9e2a60ba69101ee35caaccfcb9f14cd1' },
    { channel: 'openclaw-weixin', target: 'o9cq802h_JTovYHG16ua-yf-9TH4@im.wechat' },
];
function sendOne(channel, target, text) {
    return new Promise((resolve) => {
        execFile(serverConfig.openclawBin, ['message', 'send', '--channel', channel, '--target', target, '-m', text], { timeout: 90000 }, (err, _stdout, stderr) => {
            resolve({ channel, ok: !err, detail: err ? String(stderr || err.message).slice(0, 400) : 'sent' });
        });
    });
}
export async function push(text) {
    const channels = TARGETS.map(t => t.channel);
    Promise.all(TARGETS.map(t => sendOne(t.channel, t.target, text)))
        .then(r => console.log(new Date().toISOString(), 'push delivered', JSON.stringify(r)))
        .catch(() => { });
    return { accepted: true, channels };
}
//# sourceMappingURL=push.js.map