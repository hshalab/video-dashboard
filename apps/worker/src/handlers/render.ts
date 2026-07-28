import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeSceneCoverageWindows,
  resolveBgmVolume,
  resolveRenderTemplate,
  stripMarkerWords,
  type Asset,
  type Job,
  type Script,
  type Video,
  type WordTimestamp,
} from '@vd/shared';
import { r2 } from '../clients';
import {
  completeJob,
  getAppSetting,
  getAssets,
  getBrandAsset,
  getLatestAsset,
  getScriptVersion,
  getVideo,
  insertAsset,
  logEvent,
  setVideoStatus,
} from '../db';
import { probeDimensions, probeDurationS, run, runFfmpeg } from '../render/exec';
import {
  buildRenderPlan,
  buildThumbnailArgs,
  fitClipToWindow,
  type RenderSceneInput,
} from '../render/render';
import { buildHfComposition, hfProjectFiles } from '../render/hyperframes';
import { verifyHfRender } from '../render/verify';

/** Bundled fonts (apps/worker/fonts) — see README; DejaVu Sans is the fallback. */
function bundledFontsDir(): string | null {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fonts');
  return existsSync(dir) ? dir : null;
}

/** Absolute path to the hyperframes CLI entry (dist/cli.js of the pinned dep). */
function hyperframesCliPath(): string {
  const req = createRequire(import.meta.url);
  const pkgPath = req.resolve('hyperframes/package.json');
  return path.join(path.dirname(pkgPath), 'dist', 'cli.js');
}

async function download(tmpDir: string, r2Key: string, filename: string): Promise<string> {
  const bytes = await r2().getBytes(r2Key);
  const p = path.join(tmpDir, filename);
  await writeFile(p, bytes);
  return p;
}

interface RenderResult {
  engine: 'ffmpeg' | 'hyperframes';
  mainDurationS: number;
  outroDurationS: number;
  totalDurationS: number;
  /** Engine-specific layout artifact uploaded next to the video for debugging. */
  artifact: {
    key: string;
    content: string;
    contentType: string;
    assetKind?: 'subtitle_ass' | 'composition_html';
    meta?: Record<string, unknown>;
  };
}

/**
 * A keyframe every 30 frames (1s). HyperFrames seeks each media element once
 * per output frame in headless Chrome; with the 10s GOP HeyGen and WaveSpeed
 * ship, a seek lands far from a keyframe, the decode does not finish in time
 * and that layer renders blank — hyperframes' own compiler warns about it.
 */
const DENSE_KEYFRAMES = ['-g', '30', '-keyint_min', '30'];

const HF_ASSET_CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
};

/**
 * Render the stored (possibly operator-edited) composition verbatim — no
 * regeneration, no ffmpeg fallback (ffmpeg cannot honor edited HTML).
 */
async function renderFromComposition(job: Job, video: Video): Promise<void> {
  const comp = await getLatestAsset(video.id, 'composition_html');
  if (!comp) {
    throw new Error('No editable composition found — run a normal render first');
  }
  const manifest = (comp.meta.assets ?? {}) as Record<string, string>;

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'vd-render-'));
  try {
    const hfDir = path.join(tmpDir, 'hf');
    const hfAssets = path.join(hfDir, 'assets');
    await mkdir(hfAssets, { recursive: true });

    await writeFile(path.join(hfDir, 'index.html'), await r2().getBytes(comp.r2_key));
    for (const [name, key] of Object.entries(manifest)) {
      await writeFile(path.join(hfAssets, path.basename(name)), await r2().getBytes(key));
    }
    for (const f of hfProjectFiles(`vd-${video.id}`)) {
      await writeFile(path.join(hfDir, f.path), f.content, 'utf8');
    }

    const outPath = path.join(tmpDir, 'final.mp4');
    const thumbPath = path.join(tmpDir, 'thumb.jpg');
    const cli = hyperframesCliPath();
    console.log(`[render] video ${video.id}: hyperframes render from stored composition (${cli})`);
    await run(process.execPath, [cli, 'render', '--workers', '1', '--output', outPath], {
      cwd: hfDir,
    });
    await runFfmpeg(buildThumbnailArgs(outPath, thumbPath));

    const finalKey = `videos/${video.id}/final.mp4`;
    const thumbKey = `videos/${video.id}/thumb.jpg`;
    const [finalBytes, thumbBytes] = await Promise.all([readFile(outPath), readFile(thumbPath)]);
    await r2().put(finalKey, finalBytes, 'video/mp4');
    await r2().put(thumbKey, thumbBytes, 'image/jpeg');

    const durationS = await probeDurationS(outPath);
    await insertAsset({
      video_id: video.id,
      kind: 'final_video',
      r2_key: finalKey,
      duration_s: Number(durationS.toFixed(3)),
      size_bytes: finalBytes.length,
      meta: {
        main_duration_s: comp.meta.main_duration_s,
        outro_duration_s: comp.meta.outro_duration_s,
        render_engine: 'hyperframes',
        from_composition: true,
      },
    });
    await insertAsset({
      video_id: video.id,
      kind: 'thumbnail',
      r2_key: thumbKey,
      size_bytes: thumbBytes.length,
    });

    await logEvent(video.id, 'render_completed', {
      job_id: job.id,
      duration_s: durationS,
      size_bytes: finalBytes.length,
      render_engine: 'hyperframes',
      from_composition: true,
    });
    await setVideoStatus(video.id, 'video_review', { job_id: job.id });
    await completeJob(job.id);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

export async function handleRender(job: Job): Promise<void> {
  const video = await getVideo(job.video_id);
  // Re-render can arrive from video_changes_requested; move into rendering so
  // the final rendering -> video_review transition is valid. No-op if already there.
  await setVideoStatus(video.id, 'rendering', { job_id: job.id });
  if (job.payload.use_composition) {
    return renderFromComposition(job, video);
  }
  if (!video.current_script_version_id) {
    throw new Error(`Video ${video.id} has no current script version`);
  }
  const sv = await getScriptVersion(video.current_script_version_id);
  const script: Script = { hook: sv.hook, scenes: sv.scenes, cta: sv.cta };

  const voiceover = await getLatestAsset(video.id, 'voiceover');
  if (!voiceover) throw new Error('No voiceover asset');
  const rawWords = (voiceover.meta.word_timestamps ?? []) as WordTimestamp[];
  if (!Array.isArray(rawWords) || rawWords.length === 0) {
    throw new Error('Voiceover asset has no word_timestamps in meta');
  }
  // Assets stored before marker stripping still carry "<start>"/"<end>" tokens.
  const words = stripMarkerWords(rawWords);

  const avatarAsset = await getLatestAsset(video.id, 'avatar_video');
  if (!avatarAsset) throw new Error('No avatar_video asset');
  const sceneAssets: Asset[] = [];
  for (const scene of sv.scenes) {
    const a = await getLatestAsset(video.id, 'scene_clip', scene.index);
    if (!a) throw new Error(`Missing scene_clip asset for scene ${scene.index}`);
    sceneAssets.push(a);
  }

  const [logo, outro, bgm, rawTemplate, rawEngine, rawBgmVolume] = await Promise.all([
    getBrandAsset('logo'),
    getBrandAsset('outro'),
    getBrandAsset('bgm'),
    getAppSetting('render_template'),
    getAppSetting('render_engine'),
    getAppSetting('bgm_volume'),
  ]);
  const template = resolveRenderTemplate(rawTemplate);
  const engine: 'ffmpeg' | 'hyperframes' = rawEngine === 'ffmpeg' ? 'ffmpeg' : 'hyperframes';
  const bgmVolume = resolveBgmVolume(rawBgmVolume);

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'vd-render-'));
  try {
    const avatarPath = await download(tmpDir, avatarAsset.r2_key, 'avatar.mp4');
    const scenePaths: string[] = [];
    for (let i = 0; i < sceneAssets.length; i++) {
      scenePaths.push(await download(tmpDir, sceneAssets[i].r2_key, `scene_${i + 1}.mp4`));
    }
    let logoPath = logo
      ? await download(tmpDir, logo.r2_key, `logo${path.extname(logo.r2_key) || '.png'}`)
      : null;
    let outroPath = outro
      ? await download(tmpDir, outro.r2_key, `outro${path.extname(outro.r2_key) || '.png'}`)
      : null;

    // Pre-scale still images ONCE. A looped image input re-decodes the file
    // for every output frame — a print-resolution logo (e.g. 7500x10300 PNG)
    // is ~300MB of raw pixels per frame and OOM-kills the main render pass.
    // (Also keeps Chrome from decoding a giant PNG in the hyperframes path.)
    if (logoPath) {
      const small = path.join(tmpDir, 'logo_small.png');
      await runFfmpeg([
        '-y', '-i', logoPath,
        '-vf', `scale=w=${template.logo.widthPx}:h=-2`,
        '-frames:v', '1', small,
      ]);
      logoPath = small;
    }
    if (outroPath && !/\.(mp4|mov|webm)$/i.test(outroPath)) {
      const fitted = path.join(tmpDir, 'outro_fit.png');
      await runFfmpeg([
        '-y', '-i', outroPath,
        '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920',
        '-frames:v', '1', fitted,
      ]);
      outroPath = fitted;
    }
    // Normalize uploaded outro videos to H.264-in-mp4 with dense keyframes.
    // The hyperframes engine plays media in headless Chrome, which can't decode
    // HEVC (the default for iPhone/Mac exports) or QuickTime containers — the
    // outro silently renders as black frames while ffprobe still reports the
    // right duration. Chrome also re-seeks the clip for every output frame, so
    // a long GOP leaves it decoding from the same distant keyframe each time
    // and the layer comes out blank; always re-encode rather than probe.
    if (outroPath && /\.(mp4|mov|webm)$/i.test(outroPath)) {
      const normalized = path.join(tmpDir, 'outro_h264.mp4');
      await runFfmpeg([
        '-y', '-i', outroPath,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '18',
        ...DENSE_KEYFRAMES,
        '-c:a', 'aac',
        '-movflags', '+faststart',
        normalized,
      ]);
      outroPath = normalized;
    }
    const bgmPath = bgm
      ? await download(tmpDir, bgm.r2_key, `bgm${path.extname(bgm.r2_key) || '.mp3'}`)
      : null;

    const avatarDurationS = await probeDurationS(avatarPath);
    const outroIsVideo = outroPath != null && /\.(mp4|mov|webm)$/i.test(outroPath);
    const outroDurationS = outroIsVideo && outroPath ? await probeDurationS(outroPath) : 3;

    // Contiguous coverage windows: B-roll tiles the entire main video (scene 1
    // covers the hook, scene 3 the CTA) so the full-screen avatar never shows.
    const windows = computeSceneCoverageWindows(script, words, avatarDurationS);
    const scenes: RenderSceneInput[] = [];
    for (let i = 0; i < sv.scenes.length; i++) {
      const scene = sv.scenes[i];
      const win = windows.find((w) => w.section === `scene_${scene.index}`);
      if (!win) throw new Error(`No coverage window computed for scene ${scene.index}`);
      scenes.push({
        path: scenePaths[i],
        durationS: await probeDurationS(scenePaths[i]),
        windowStart: win.start,
        windowEnd: win.end,
      });
    }

    const outPath = path.join(tmpDir, 'final.mp4');
    const thumbPath = path.join(tmpDir, 'thumb.jpg');

    const renderWithFfmpeg = async (): Promise<RenderResult> => {
      // One-frame circular mask for the avatar head bubble (alphamerge input).
      let bubbleMaskPath: string | null = null;
      if (template.avatarBubble.enabled) {
        const d = template.avatarBubble.diameterPx;
        bubbleMaskPath = path.join(tmpDir, 'bubble_mask.png');
        await runFfmpeg([
          '-y', '-f', 'lavfi', '-i', `color=c=black:s=${d}x${d}`,
          '-vf', `format=gray,geq=lum='if(lte(hypot(X-W/2+0.5,Y-H/2+0.5),W/2-1),255,0)'`,
          '-frames:v', '1', bubbleMaskPath,
        ]);
      }

      const subsPath = path.join(tmpDir, 'subs.ass');
      const plan = buildRenderPlan({
        avatarPath,
        avatarDurationS,
        scenes,
        words,
        subsPath,
        outPath,
        logoPath,
        outroPath,
        outroIsVideo,
        outroDurationS,
        bgmPath,
        bgmVolume,
        fontsDir: bundledFontsDir(),
        template,
        bubbleMaskPath,
      });
      await writeFile(subsPath, plan.subs, 'utf8');
      console.log(`[render] video ${video.id}: ffmpeg ${plan.args.join(' ')}`);
      await runFfmpeg(plan.args); // throws with command + stderr tail on failure
      return {
        engine: 'ffmpeg',
        mainDurationS: plan.mainDurationS,
        outroDurationS: plan.outroDurationS,
        totalDurationS: plan.totalDurationS,
        artifact: {
          key: `videos/${video.id}/subs.ass`,
          content: plan.subs,
          contentType: 'text/plain; charset=utf-8',
          assetKind: 'subtitle_ass',
        },
      };
    };

    const renderWithHyperframes = async (): Promise<RenderResult> => {
      const hfDir = path.join(tmpDir, 'hf');
      const hfAssets = path.join(hfDir, 'assets');
      await mkdir(hfAssets, { recursive: true });

      const stage = async (src: string): Promise<string> => {
        const rel = `assets/${path.basename(src)}`;
        await copyFile(src, path.join(hfDir, rel));
        return rel;
      };

      const logoAspect = logoPath
        ? await probeDimensions(logoPath).then((d) => d.width / d.height)
        : undefined;

      // HyperFrames does NOT hold the last frame when a clip's source runs out
      // before its window ends — the element goes blank and the avatar base
      // shows through. Pre-fit short clips the same way the ffmpeg engine
      // does: slow down up to 1.25x, then clone the last frame to the window.
      // Clips that already fit still get re-encoded, for the keyframes.
      const fitSceneClip = async (s: RenderSceneInput, i: number): Promise<string> => {
        const windowDur = s.windowEnd - s.windowStart;
        const { setptsFactor, tpadSeconds } = fitClipToWindow(s.durationS, windowDur);
        const vf: string[] = [];
        if (setptsFactor !== 1) vf.push(`setpts=${setptsFactor.toFixed(4)}*PTS`);
        if (tpadSeconds > 0.01) {
          vf.push(`tpad=stop_mode=clone:stop_duration=${tpadSeconds.toFixed(3)}`);
        }
        const fitted = path.join(tmpDir, `scene_fit_${i + 1}.mp4`);
        await runFfmpeg([
          '-y', '-i', s.path,
          ...(vf.length > 0 ? ['-vf', vf.join(',')] : []),
          '-an',
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '20',
          ...DENSE_KEYFRAMES,
          fitted,
        ]);
        return fitted;
      };

      // Same treatment for the avatar — it backs two layers (the full-screen
      // base and the presenter bubble), and HeyGen ships it with a 10s GOP.
      const denseAvatarPath = path.join(tmpDir, 'avatar_kf.mp4');
      await runFfmpeg([
        '-y', '-i', avatarPath,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '20',
        ...DENSE_KEYFRAMES,
        '-c:a', 'copy',
        '-movflags', '+faststart',
        denseAvatarPath,
      ]);

      const comp = buildHfComposition({
        avatarFile: await stage(denseAvatarPath),
        avatarDurationS,
        scenes: await Promise.all(
          scenes.map(async (s, i) => ({
            file: await stage(await fitSceneClip(s, i)),
            windowStart: s.windowStart,
            windowEnd: s.windowEnd,
          })),
        ),
        words,
        logoFile: logoPath ? await stage(logoPath) : null,
        logoAspect,
        outroFile: outroPath ? await stage(outroPath) : null,
        outroIsVideo,
        outroDurationS,
        bgmFile: bgmPath ? await stage(bgmPath) : null,
        bgmVolume,
        template,
      });

      await writeFile(path.join(hfDir, 'index.html'), comp.html, 'utf8');
      for (const f of hfProjectFiles(`vd-${video.id}`)) {
        await writeFile(path.join(hfDir, f.path), f.content, 'utf8');
      }

      // --workers 1 keeps a single Chrome process (~256MB) — sized for the
      // Railway container; bump workers only alongside instance memory.
      const cli = hyperframesCliPath();
      console.log(`[render] video ${video.id}: hyperframes render (${cli})`);
      await run(
        process.execPath,
        [cli, 'render', '--workers', '1', '--output', outPath],
        { cwd: hfDir },
      );

      // Chrome silently drops a video layer it failed to decode (black outro,
      // missing bubble) and still exits 0 — check the pixels before publishing.
      const broken = await verifyHfRender({
        outPath,
        tmpDir,
        mainDurationS: comp.mainDurationS,
        outroDurationS: comp.outroDurationS,
        outroPath,
        avatarPath: denseAvatarPath,
        template,
      });
      if (broken) throw new Error(`hyperframes output failed verification: ${broken}`);

      // Publish the staged media so the composition stays editable and
      // re-renderable (see renderFromComposition). Only after a successful
      // render — an ffmpeg fallback must not leave a half-published project.
      const manifest: Record<string, string> = {};
      for (const name of await readdir(hfAssets)) {
        const key = `videos/${video.id}/composition/assets/${name}`;
        const contentType =
          HF_ASSET_CONTENT_TYPES[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
        await r2().put(key, await readFile(path.join(hfAssets, name)), contentType);
        manifest[name] = key;
      }

      return {
        engine: 'hyperframes',
        mainDurationS: comp.mainDurationS,
        outroDurationS: comp.outroDurationS,
        totalDurationS: comp.totalDurationS,
        artifact: {
          key: `videos/${video.id}/composition.html`,
          content: comp.html,
          contentType: 'text/html; charset=utf-8',
          assetKind: 'composition_html',
          meta: {
            assets: manifest,
            width: 1080,
            height: 1920,
            main_duration_s: comp.mainDurationS,
            outro_duration_s: comp.outroDurationS,
            total_duration_s: comp.totalDurationS,
          },
        },
      };
    };

    let result: RenderResult;
    if (engine === 'hyperframes') {
      try {
        result = await renderWithHyperframes();
      } catch (e) {
        // Chrome-side failures (crash, dropped video layer) are transient, so
        // retry once before giving up the editable composition for ffmpeg.
        console.error(`[render] video ${video.id}: hyperframes failed, retrying once:`, e);
        await logEvent(video.id, 'render_engine_retry', {
          job_id: job.id,
          error: String(e).slice(0, 2000),
        });
        try {
          result = await renderWithHyperframes();
        } catch (e2) {
          // Never block the pipeline on the new engine — fall back to ffmpeg.
          console.error(`[render] video ${video.id}: hyperframes failed twice, using ffmpeg:`, e2);
          await logEvent(video.id, 'render_engine_fallback', {
            job_id: job.id,
            error: String(e2).slice(0, 2000),
          });
          result = await renderWithFfmpeg();
        }
      }
    } else {
      result = await renderWithFfmpeg();
    }

    await runFfmpeg(buildThumbnailArgs(outPath, thumbPath));

    const finalKey = `videos/${video.id}/final.mp4`;
    const thumbKey = `videos/${video.id}/thumb.jpg`;
    const [finalBytes, thumbBytes] = await Promise.all([readFile(outPath), readFile(thumbPath)]);
    await r2().put(finalKey, finalBytes, 'video/mp4');
    await r2().put(thumbKey, thumbBytes, 'image/jpeg');
    await r2().put(result.artifact.key, result.artifact.content, result.artifact.contentType);

    await insertAsset({
      video_id: video.id,
      kind: 'final_video',
      r2_key: finalKey,
      duration_s: Number(result.totalDurationS.toFixed(3)),
      size_bytes: finalBytes.length,
      meta: {
        main_duration_s: result.mainDurationS,
        outro_duration_s: result.outroDurationS,
        render_engine: result.engine,
      },
    });
    await insertAsset({
      video_id: video.id,
      kind: 'thumbnail',
      r2_key: thumbKey,
      size_bytes: thumbBytes.length,
    });
    if (result.artifact.assetKind) {
      await insertAsset({
        video_id: video.id,
        kind: result.artifact.assetKind,
        r2_key: result.artifact.key,
        size_bytes: Buffer.byteLength(result.artifact.content),
        meta: result.artifact.meta,
      });
    }

    await logEvent(video.id, 'render_completed', {
      job_id: job.id,
      duration_s: result.totalDurationS,
      size_bytes: finalBytes.length,
      render_engine: result.engine,
    });
    await setVideoStatus(video.id, 'video_review', { job_id: job.id });
    await completeJob(job.id);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
