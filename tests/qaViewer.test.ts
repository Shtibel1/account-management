import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { uprightRotationOfBox, pageRotationsFromWords, readPageRotations, normalizeQuarterTurn } from '@/shared/orientation';
import { clampZoom, zoomScrollFor, rotatedPoint, MAX_ZOOM, MIN_ZOOM } from '@/shared/viewerZoom';

// A word box as Vision returns it: vertices in reading order (TL, TR, BR, BL of the upright text)
const upright = [{ x: 10, y: 10 }, { x: 50, y: 10 }, { x: 50, y: 20 }, { x: 10, y: 20 }];
const upsideDown = [{ x: 50, y: 20 }, { x: 10, y: 20 }, { x: 10, y: 10 }, { x: 50, y: 10 }];
// Page turned clockwise: the text runs top -> bottom, its "down" points left
const turnedCw = [{ x: 20, y: 10 }, { x: 20, y: 50 }, { x: 10, y: 50 }, { x: 10, y: 10 }];
// Page turned counter-clockwise: the text runs bottom -> top, its "down" points right
const turnedCcw = [{ x: 10, y: 50 }, { x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 50 }];

describe('orientation from OCR word boxes', () => {
  test('box vertex order gives the turn that makes the word upright', () => {
    assert.equal(uprightRotationOfBox(upright), 0);
    assert.equal(uprightRotationOfBox(upsideDown), 180);
    assert.equal(uprightRotationOfBox(turnedCw), 270);
    assert.equal(uprightRotationOfBox(turnedCcw), 90);
    assert.equal(uprightRotationOfBox([]), 0);
    assert.equal(uprightRotationOfBox(undefined), 0);
    // Vision omits x / y when they are 0
    assert.equal(uprightRotationOfBox([{ x: 40, y: 10 }, { y: 10 }, {}, { x: 40 }]), 180);
  });

  test('normalized vertices use the page proportions', () => {
    // On a wide page a box 0.02 high x 0.01 wide (normalized) is really 20 wide x 10 high
    const box = [{ x: 0.1, y: 0.1 }, { x: 0.12, y: 0.1 }, { x: 0.12, y: 0.11 }, { x: 0.1, y: 0.11 }];
    assert.equal(uprightRotationOfBox(box, 1000, 1000), 0);
  });

  const words = (n: number, rot: 0 | 90 | 180 | 270, page = 1) =>
    Array.from({ length: n }, (_, i) => ({ text: `word${i}`, page, ...(rot ? { rot } : {}) }));

  test('page rotation: majority of the page text, only pages that need a turn', () => {
    assert.equal(pageRotationsFromWords(words(20, 0)), null);
    assert.deepEqual(pageRotationsFromWords(words(20, 180)), { '1': 180 });
    assert.deepEqual(
      pageRotationsFromWords([...words(20, 0, 1), ...words(20, 180, 2), ...words(12, 90, 3)]),
      { '2': 180, '3': 90 }
    );
    // a few odd words (a stamp, a sideways margin note) don't turn the page
    assert.equal(pageRotationsFromWords([...words(20, 0), ...words(5, 180)]), null);
    // too few words to trust
    assert.equal(pageRotationsFromWords(words(3, 180)), null);
    // mixed without a clear winner: leave it
    assert.equal(pageRotationsFromWords([...words(10, 0), ...words(10, 180)]), null);
    assert.equal(pageRotationsFromWords([]), null);
    assert.equal(pageRotationsFromWords(undefined), null);
  });

  test('stored value is sanitized for the viewer', () => {
    assert.deepEqual(readPageRotations({ '1': 180, '2': 0, '3': 450, x: 90, '4': 'abc' }), { '1': 180, '3': 90 });
    assert.deepEqual(readPageRotations(null), {});
    assert.deepEqual(readPageRotations([180]), {});
    assert.equal(normalizeQuarterTurn(-90), 270);
    assert.equal(normalizeQuarterTurn(45), 0);
  });
});

describe('preprocessor marks rotated words (same Vision response, no extra call)', () => {
  test('ocrImage: upside-down words get rot 180, upright ones none', async () => {
    process.env.GOOGLE_CLOUD_API_KEY = 'test-key';
    const word = (text: string, vertices: { x: number; y: number }[]) => ({
      boundingBox: { vertices },
      symbols: text.split('').map((c) => ({ text: c })),
    });
    const visionResponse = {
      responses: [{
        fullTextAnnotation: {
          text: 'EMV Contactless',
          pages: [{
            width: 100, height: 100, confidence: 0.9,
            blocks: [{ paragraphs: [{ words: [word('EMV', upsideDown), word('Contactless', upright)] }] }],
          }],
        },
      }],
    };
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify(visionResponse), { status: 200 });
    }) as typeof fetch;
    try {
      const { ocrImage } = await import('@/agents/preprocessor');
      const res = await ocrImage(Buffer.from('img'));
      assert.equal(calls.length, 1);
      assert.equal(res.ocrWords[0].rot, 180);
      assert.equal('rot' in res.ocrWords[1], false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('viewer zoom math', () => {
  test('clamps and snaps to fit', () => {
    assert.equal(clampZoom(10), MAX_ZOOM);
    assert.equal(clampZoom(0.1), MIN_ZOOM);
    assert.equal(clampZoom(1.01), 1);
    assert.equal(clampZoom(Number.NaN), 1);
    assert.equal(clampZoom(1.5625), 1.563);
  });

  test('zooming keeps the point under the pointer in place', () => {
    // content point 116 (scroll 100 + pointer 32 - pad 16) doubles to 232 -> scroll 232 + 16 - 32
    assert.deepEqual(zoomScrollFor({ left: 100, top: 0 }, { x: 32, y: 48 }, 2, { x: 16, y: 48 }), { left: 216, top: 0 });
    assert.deepEqual(zoomScrollFor({ left: 0, top: 0 }, { x: 10, y: 10 }, 0.5), { left: 0, top: 0 });
  });

  test('rotated box centers', () => {
    assert.deepEqual(rotatedPoint({ x: 10, y: 20 }, 180), { x: -10, y: -20 });
    assert.deepEqual(rotatedPoint({ x: 10, y: 0 }, 90), { x: -0, y: 10 });
    assert.deepEqual(rotatedPoint({ x: 0, y: 10 }, 270), { x: 10, y: -0 });
  });
});

describe('routes and marketing layout', () => {
  test('/dashboard redirects to /clients', async () => {
    const spec = '../next.config.ts'; // not a literal: tsc would want allowImportingTsExtensions
    const { default: config } = (await import(spec)) as { default: import('next').NextConfig };
    const rules = await config.redirects!();
    assert.deepEqual(rules.find((r) => r.source === '/dashboard'), { source: '/dashboard', destination: '/clients', permanent: false });
  });

  test('404 page: signed-in users go home to /clients', () => {
    const src = readFileSync(new URL('../src/app/not-found.tsx', import.meta.url), 'utf8');
    assert.match(src, /signedIn \?/);
    assert.match(src, /href=\{DEFAULT_AFTER_LOGIN\}/);
  });

  test('no off-screen (negative offset) hiding that widens RTL pages', () => {
    const src = readFileSync(new URL('../src/app/(marketing)/order/page.tsx', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /-10000px/);
    assert.match(src, /clipPath: 'inset\(50%\)'/);
    assert.match(src, /name="website" tabIndex=\{-1\}/);
  });
});
