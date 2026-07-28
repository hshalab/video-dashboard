import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { RenderTemplate } from '@vd/shared';
import { runFfmpeg } from './exec';
import { bubbleCropPx } from './render';

/**
 * Post-render pixel check for the HyperFrames engine.
 *
 * Headless Chrome decodes every <video> layer itself. Under load it
 * intermittently ships a layer that never decoded — the outro renders as black
 * frames, or the presenter bubble is simply absent — and still exits 0 with a
 * correct duration and stream list, so no probe of the container catches it.
 * Compare pixels instead: a returned reason means the render is broken and the
 * caller must retry / fall back to ffmpeg.
 */

const FRAME_W = 1080;
const FRAME_H = 1920;

/** Mean gray level below which a frame counts as "never decoded" (black). */
const BLACK_LEVEL = 4;
/** Mean abs difference above which the bubble is not showing the avatar head. */
const BUBBLE_DIFF = 30;
/** Side of the square sampled at the centre of the bubble circle. */
const BUBBLE_PROBE_PX = 240;

/** One frame at `atS` as raw 8-bit gray pixels (accurate seek, `vf` applied). */
async function grayFrame(src: string, atS: number, vf: string, out: string): Promise<Buffer> {
  await runFfmpeg([
    '-y', '-i', src,
    '-ss', atS.toFixed(3),
    '-frames:v', '1',
    '-vf', `${vf},format=gray`,
    '-f', 'rawvideo',
    out,
  ]);
  return readFile(out);
}

export function meanLevel(px: Buffer): number {
  if (px.length === 0) return 0;
  let sum = 0;
  for (const v of px) sum += v;
  return sum / px.length;
}

/** Mean absolute difference of two equal-length gray buffers (255 = opposite). */
export function meanAbsDiff(a: Buffer, b: Buffer): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 255;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(a[i] - b[i]);
  return sum / n;
}

/** Centre of the bubble circle on the output canvas (mirrors bubbleCss). */
export function bubbleCenterPx(bubble: RenderTemplate['avatarBubble']): { cx: number; cy: number } {
  const d = bubble.diameterPx;
  return {
    cx: bubble.position === 'bottom_left' ? bubble.marginPx + d / 2 : FRAME_W - bubble.marginPx - d / 2,
    cy: FRAME_H - bubble.marginPx - d / 2,
  };
}

/** Even-sized probe square that fits inside both the circle and the frame. */
export function bubbleProbePx(diameterPx: number): number {
  const fit = Math.min(BUBBLE_PROBE_PX, Math.max(32, diameterPx - 16));
  return 2 * Math.floor(fit / 2);
}

export interface HfVerifyInput {
  /** Rendered video to check. */
  outPath: string;
  /** Scratch dir for the sampled frames. */
  tmpDir: string;
  mainDurationS: number;
  outroDurationS: number;
  outroPath?: string | null;
  avatarPath: string;
  template: RenderTemplate;
}

/** Reason the render is broken, or null when it looks right. */
export async function verifyHfRender(input: HfVerifyInput): Promise<string | null> {
  const scratch = (name: string): string => path.join(input.tmpDir, name);

  if (input.outroPath && input.outroDurationS > 0) {
    const at = input.mainDurationS + input.outroDurationS / 2;
    const rendered = meanLevel(
      await grayFrame(input.outPath, at, 'scale=192:-2', scratch('vf_outro_out.gray')),
    );
    if (rendered < BLACK_LEVEL) {
      // Only a bug if the outro itself is not a black frame.
      const source = meanLevel(
        await grayFrame(
          input.outroPath,
          input.outroDurationS / 2,
          'scale=192:-2',
          scratch('vf_outro_src.gray'),
        ),
      );
      if (source >= BLACK_LEVEL) {
        return `outro is black at ${at.toFixed(2)}s (level ${rendered.toFixed(1)}, source ${source.toFixed(1)})`;
      }
    }
  }

  const bubble = input.template.avatarBubble;
  if (bubble.enabled && input.mainDurationS > 0.5) {
    const at = input.mainDurationS / 2;
    const probe = bubbleProbePx(bubble.diameterPx);
    const { cx, cy } = bubbleCenterPx(bubble);
    const x = Math.min(FRAME_W - probe, Math.max(0, Math.round(cx - probe / 2)));
    const y = Math.min(FRAME_H - probe, Math.max(0, Math.round(cy - probe / 2)));
    const rendered = await grayFrame(
      input.outPath,
      at,
      `crop=${probe}:${probe}:${x}:${y}`,
      scratch('vf_bubble_out.gray'),
    );
    // Same head crop the bubble shows, scaled the same way. The avatar source
    // is not 1080x1920 (HeyGen returns a square), so cover-fit it first —
    // bubbleCropPx works on the fitted frame, like the composition does.
    const c = bubbleCropPx(bubble.crop);
    const d = bubble.diameterPx;
    const off = Math.round((d - probe) / 2);
    const expected = await grayFrame(
      input.avatarPath,
      at,
      `scale=${FRAME_W}:${FRAME_H}:force_original_aspect_ratio=increase,crop=${FRAME_W}:${FRAME_H},` +
        `crop=${c.size}:${c.size}:${c.x}:${c.y},scale=${d}:${d},crop=${probe}:${probe}:${off}:${off}`,
      scratch('vf_bubble_src.gray'),
    );
    const diff = meanAbsDiff(rendered, expected);
    if (diff > BUBBLE_DIFF) {
      return `presenter bubble missing at ${at.toFixed(2)}s (head diff ${diff.toFixed(1)})`;
    }
  }

  return null;
}
