/**
 * Clipboard (R-003) - read/write the system clipboard (text + images).
 *
 * Windows: PowerShell + System.Windows.Forms.Clipboard (STA thread)
 * Linux: xclip -selection clipboard (apt install xclip)
 * Headless Linux: file-based virtual clipboard
 *
 * Images: JPEG base64, up to 5MB. The sync watcher pushes/pulls both
 * types; the relay stores type + content so receivers know how to set it.
 */

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { logger } from '../utils/logger.js';

const isWindows = os.platform() === 'win32';
const hasDisplay = !!process.env.DISPLAY;
const FILE_CLIPBOARD = path.join(os.homedir(), '.gca', 'clipboard');
const FILE_CLIPBOARD_PNG = FILE_CLIPBOARD + '.png';
const MAX_TEXT_CHARS = 10240;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB JPEG

export type ClipboardType = 'text' | 'image';
export interface ClipboardData {
  type: ClipboardType;
  content: string; // text or base64 JPEG
}

// --- PowerShell helpers ---

function runPowerShell(script: string, env: Record<string, string> = {}, timeoutMs = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-Command', script],
      { env: { ...process.env, ...env, PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    const chunks: Buffer[] = [];
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('clipboard operation timed out')); }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => { chunks.push(d); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(chunks).toString('utf8');
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim().substring(0, 300) || `PowerShell exited ${code}`));
    });
  });
}

function runShell(cmd: string, input?: string, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', cmd], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('clipboard operation timed out')); }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim().substring(0, 300) || `shell exited ${code}`));
    });
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

// --- Read clipboard (detects text vs image) ---

const PS_CHECK_IMAGE = `
Add-Type -AssemblyName System.Windows.Forms;
[Console]::Out.Write([System.Windows.Forms.Clipboard]::ContainsImage());
`;

const PS_GET_TEXT = `
$OutputEncoding = [System.Text.Encoding]::UTF8;
Add-Type -AssemblyName System.Windows.Forms;
$text = [System.Windows.Forms.Clipboard]::GetText();
$bytes = [System.Text.Encoding]::UTF8.GetBytes($text);
[Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length);
`;

const PS_GET_IMAGE = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing;
$img = [System.Windows.Forms.Clipboard]::GetImage();
if ($null -eq $img) { [Console]::Out.Write(''); exit }
$ms = New-Object System.IO.MemoryStream;
$img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Jpeg);
[Console]::Out.Write([Convert]::ToBase64String($ms.ToArray()));
$ms.Dispose(); $img.Dispose();
`;

export async function getClipboard(): Promise<string> {
  const data = await getClipboardData();
  return data.content;
}

export async function getClipboardData(): Promise<ClipboardData> {
  if (isWindows) {
    // Check if clipboard has an image
    const hasImage = (await runPowerShell(PS_CHECK_IMAGE, {}, 5000)).trim() === 'True';
    if (hasImage) {
      const b64 = (await runPowerShell(PS_GET_IMAGE, {}, 15000)).trim();
      if (b64 && b64.length > 0) {
        const bytes = Math.round(b64.length * 3 / 4);
        if (bytes <= MAX_IMAGE_BYTES) {
          logger.info('Clipboard image read', { bytes, kb: Math.round(bytes / 1024) });
          return { type: 'image', content: b64 };
        }
        logger.warn('Clipboard image too large, skipping', { bytes, cap: MAX_IMAGE_BYTES });
      }
    }
    // Fall back to text
    const text = await runPowerShell(PS_GET_TEXT, {}, 10000);
    const trimmed = text.length > MAX_TEXT_CHARS ? text.substring(0, MAX_TEXT_CHARS) : text;
    logger.info('Clipboard text read', { chars: trimmed.length, source: 'win32' });
    return { type: 'text', content: trimmed };
  }

  if (hasDisplay) {
    // Try image first (xclip with image target)
    try {
      const imgData = await runShell('xclip -selection clipboard -t image/png -o 2>/dev/null | base64 -w0', undefined, 5000);
      if (imgData && imgData.length > 100) {
        return { type: 'image', content: imgData };
      }
    } catch {}
    // Fall back to text
    const text = await runShell('xclip -selection clipboard -o 2>/dev/null || xsel --clipboard --output 2>/dev/null', undefined, 5000);
    const trimmed = text.length > MAX_TEXT_CHARS ? text.substring(0, MAX_TEXT_CHARS) : text;
    logger.info('Clipboard text read', { chars: trimmed.length, source: 'xclip' });
    return { type: 'text', content: trimmed };
  }

  // Headless Linux: file-based — check .png first, then .txt
  try {
    const pngData = await readFile(FILE_CLIPBOARD_PNG);
    const b64 = pngData.toString('base64');
    logger.info('Clipboard image read', { bytes: pngData.length, source: 'file' });
    return { type: 'image', content: b64 };
  } catch {
    // No .png file, read text
  }
  try {
    const text = await readFile(FILE_CLIPBOARD, 'utf8');
    logger.info('Clipboard text read', { chars: text.length, source: 'file' });
    return { type: 'text', content: text };
  } catch {
    return { type: 'text', content: '' };
  }
}

// --- Write clipboard (text or image) ---

export async function setClipboard(text: string): Promise<void> {
  await setClipboardData({ type: 'text', content: text });
}

const PS_SET_TEXT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;
Add-Type -AssemblyName System.Windows.Forms;
[System.Windows.Forms.Clipboard]::SetText($env:GCA_CLIP_TEXT);
`;

const PS_SET_IMAGE = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing;
$bytes = [Convert]::FromBase64String($env:GCA_CLIP_IMG);
$ms = New-Object System.IO.MemoryStream(,$bytes);
$img = [System.Drawing.Image]::FromStream($ms);
[System.Windows.Forms.Clipboard]::SetImage($img);
$ms.Dispose(); $img.Dispose();
`;

export async function setClipboardData(data: ClipboardData): Promise<void> {
  if (data.type === 'image') {
    const bytes = Math.round(data.content.length * 3 / 4);
    if (bytes > MAX_IMAGE_BYTES) throw new Error(`Image too large (${bytes} bytes, cap is ${MAX_IMAGE_BYTES})`);

    if (isWindows) {
      await runPowerShell(PS_SET_IMAGE, { GCA_CLIP_IMG: data.content }, 15000);
      logger.info('Clipboard image written', { bytes, kb: Math.round(bytes / 1024), source: 'win32' });
    } else if (hasDisplay) {
      // Decode base64 and pipe to xclip as image/png
      const tmpFile = path.join(os.tmpdir(), `gca-clip-${process.pid}.png`);
      await writeFile(tmpFile, Buffer.from(data.content, 'base64'));
      await runShell(`xclip -selection clipboard -t image/png < ${tmpFile} 2>/dev/null`, undefined, 5000);
      const { unlink } = await import('node:fs/promises');
      await unlink(tmpFile).catch(() => {});
      logger.info('Clipboard image written', { bytes, source: 'xclip' });
    } else {
      // Headless: save as .png, clear .txt
      const { unlink } = await import('node:fs/promises');
      await mkdir(path.dirname(FILE_CLIPBOARD), { recursive: true });
      await writeFile(FILE_CLIPBOARD_PNG, Buffer.from(data.content, 'base64'));
      await unlink(FILE_CLIPBOARD).catch(() => {});
      logger.info('Clipboard image written', { bytes, source: 'file' });
    }
    return;
  }

  // Text
  if (data.content.length > MAX_TEXT_CHARS) {
    throw new Error(`Text too long (${data.content.length} chars, cap is ${MAX_TEXT_CHARS})`);
  }
  if (isWindows) {
    await runPowerShell(PS_SET_TEXT, { GCA_CLIP_TEXT: data.content }, 10000);
  } else if (hasDisplay) {
    await runShell('xclip -selection clipboard 2>/dev/null || xsel --clipboard --input 2>/dev/null', data.content, 5000);
  } else {
    await mkdir(path.dirname(FILE_CLIPBOARD), { recursive: true });
    await writeFile(FILE_CLIPBOARD, data.content, 'utf8');
    // Clear .png when setting text (one type at a time)
    const { unlink } = await import('node:fs/promises');
    await unlink(FILE_CLIPBOARD_PNG).catch(() => {});
  }
  logger.info('Clipboard text written', { chars: data.content.length, source: isWindows ? 'win32' : hasDisplay ? 'xclip' : 'file' });
}
