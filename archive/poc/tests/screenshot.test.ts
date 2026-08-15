/**
 * Tests for screenshot (R-001) and the screen_consent window.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';

const testRoot = join(tmpdir(), `gca-screen-test-${process.pid}`);
process.env.GCA_SETTINGS_PATH = join(testRoot, 'settings.json');
process.env.GCA_SECRETS_DIR = join(testRoot, 'secrets');

const capture = await import('../src/services/screen-capture.js');
const consent = await import('../src/services/screen-consent.js');
const pending = await import('../src/services/pending-approvals.js');
const { screenshotHandler } = await import('../src/tools/screenshot/handler.js');
const { screenConsentHandler } = await import('../src/tools/screen-consent/handler.js');
const { confirmHandler } = await import('../src/tools/confirm/handler.js');

const isWindows = process.platform === 'win32';

function parseResult(handlerReturn: { content: { text: string }[] }) {
  return JSON.parse(handlerReturn.content[0].text);
}

before(async () => {
  await mkdir(testRoot, { recursive: true });
  await consent.revokeConsent();
  pending.clearPending();
});

after(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

describe('screen-consent window', () => {
  it('grant → hasConsent true; revoke → false', async () => {
    await consent.grantConsent(30);
    assert.equal(await consent.hasConsent(), true);
    const status = await consent.consentStatus();
    assert.equal(status.active, true);
    assert.ok(status.until);
    await consent.revokeConsent();
    assert.equal(await consent.hasConsent(), false);
  });

  it('expired window → hasConsent false', async () => {
    const { setSetting } = await import('../src/services/settings-store.js');
    await setSetting('screen.consentUntil', Date.now() - 1000);
    assert.equal(await consent.hasConsent(), false);
    await consent.revokeConsent();
  });

  it('screen_consent tool: grant flow requires confirmation, then activates', async () => {
    const r = parseResult(await screenConsentHandler({ minutes: 30 }));
    assert.equal(r.status, 'confirmation_required');
    assert.equal(await consent.hasConsent(), false); // not yet

    const granted = parseResult(await confirmHandler({}));
    assert.equal(granted.status, 'granted');
    assert.equal(granted.confirmedByUser, true);
    assert.equal(await consent.hasConsent(), true);

    // already_active on re-grant
    const again = parseResult(await screenConsentHandler({ minutes: 30 }));
    assert.equal(again.status, 'already_active');

    // revoke is free and instant
    const revoked = parseResult(await screenConsentHandler({ minutes: 0 }));
    assert.equal(revoked.status, 'revoked');
    assert.equal(await consent.hasConsent(), false);
  });
});

describe('screenshot', () => {
  it('without consent → confirmation_required, nothing captured', async () => {
    await consent.revokeConsent();
    pending.clearPending();
    const r = parseResult(await screenshotHandler({}));
    assert.equal(r.status, 'confirmation_required');
    assert.equal(r.operation, 'screenshot');
  });

  it('with consent → captures immediately (Windows only)', async () => {
    if (!isWindows) {
      console.log('skipped: screen capture is Windows-only');
      return;
    }
    await consent.grantConsent(30);
    const result = await screenshotHandler({ quality: 50, ocr: false });
    const imagePart = result.content.find((c: { type: string }) => c.type === 'image');
    assert.ok(imagePart, 'should return an image block');
    assert.equal(imagePart.mimeType, 'image/jpeg');
    const jpeg = Buffer.from(imagePart.data, 'base64');
    assert.equal(jpeg[0], 0xff, 'JPEG SOI byte 1');
    assert.equal(jpeg[1], 0xd8, 'JPEG SOI byte 2');
    assert.ok(jpeg.length > 10000, 'screenshot should be a real image');

    const meta = parseResult(result);
    assert.equal(meta.status, 'captured');
    assert.ok(meta.width > 0 && meta.height > 0);
    await consent.revokeConsent();
  });

  it('confirm path: pending screenshot executes on bare confirm', async () => {
    if (!isWindows) {
      console.log('skipped: screen capture is Windows-only');
      return;
    }
    await consent.revokeConsent();
    pending.clearPending();
    await screenshotHandler({ quality: 50, ocr: false });
    const result = await confirmHandler({});
    const imagePart = result.content.find((c: { type: string }) => c.type === 'image');
    assert.ok(imagePart, 'confirmed screenshot should return an image block');
  });
});
