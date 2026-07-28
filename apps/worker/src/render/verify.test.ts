/**
 * Tests for the HyperFrames output check (pure parts — no ffmpeg).
 * Run with: pnpm --filter @vd/worker test
 */
import assert from 'node:assert/strict';
import { resolveRenderTemplate } from '@vd/shared';
import { bubbleCenterPx, bubbleProbePx, meanAbsDiff, meanLevel } from './verify';

// --- meanLevel ---
assert.equal(meanLevel(Buffer.from([0, 0, 0, 0])), 0, 'black frame');
assert.equal(meanLevel(Buffer.from([10, 20, 30, 40])), 25);
assert.equal(meanLevel(Buffer.alloc(0)), 0, 'empty buffer never divides by zero');

// --- meanAbsDiff ---
assert.equal(meanAbsDiff(Buffer.from([5, 5]), Buffer.from([5, 5])), 0, 'identical crops');
assert.equal(meanAbsDiff(Buffer.from([0, 0]), Buffer.from([100, 200])), 150, 'bubble replaced by B-roll');
assert.equal(meanAbsDiff(Buffer.alloc(0), Buffer.from([1])), 255, 'a missing sample is a failure');

// --- bubbleCenterPx (default: 460px circle, 24px margin) ---
{
  const b = resolveRenderTemplate({}).avatarBubble;
  assert.deepEqual(bubbleCenterPx(b), { cx: 24 + 230, cy: 1920 - 24 - 230 }, 'bottom-left centre');
  const right = resolveRenderTemplate({ avatarBubble: { position: 'bottom_right' } }).avatarBubble;
  assert.deepEqual(bubbleCenterPx(right), { cx: 1080 - 24 - 230, cy: 1920 - 24 - 230 }, 'bottom-right centre');
}

// --- bubbleProbePx: even, inside the circle, never wider than the bubble ---
assert.equal(bubbleProbePx(460), 240, 'capped at the probe size');
assert.equal(bubbleProbePx(200), 184, 'shrinks to stay inside a small bubble');
assert.equal(bubbleProbePx(120), 104);
assert.ok(bubbleProbePx(200) % 2 === 0, 'even so the crop stays on a pixel grid');

console.log('verify.test.ts: all assertions passed');
