import type { Job, JobType } from '@vd/shared';
import { ghl, wavespeed } from './clients';
import {
  claimJobs,
  closeDb,
  db,
  failJobWithRetry,
  getScheduledPosts,
  getStaleExternalJobs,
  logEvent,
  setVideoStatus,
  touchJob,
  updatePostStatus,
} from './db';
import { workerConcurrency } from './env';
import { finalizeExternalJob, resultFromWebhookColumns } from './finalize';
import { handleAvatar } from './handlers/avatar';
import { generateMissingBrandPosters } from './handlers/brandPosters';
import { handleCaption } from './handlers/caption';
import { handleGenerateScript } from './handlers/generateScript';
import { handleGhlPost } from './handlers/ghlPost';
import { handleRender } from './handlers/render';
import { handleScene } from './handlers/scene';
import { handleTts } from './handlers/tts';

const TICK_MS = 3000;
const POSTS_CHECK_MS = 6 * 3600 * 1000; // "daily-ish": every 6 hours
const POSTERS_CHECK_MS = 5 * 60 * 1000;

const handlers: Record<JobType, (job: Job) => Promise<void>> = {
  generate_script: handleGenerateScript,
  tts: handleTts,
  avatar: handleAvatar,
  scene: handleScene,
  render: handleRender,
  generate_caption: handleCaption,
  ghl_post: handleGhlPost,
};

/** Everything except 'render' — claimed freely up to WORKER_CONCURRENCY. */
const LIGHT_JOB_TYPES = (Object.keys(handlers) as JobType[]).filter((t) => t !== 'render');

let stopping = false;
let renderInFlight = false;
const inFlight = new Set<Promise<void>>();
let lastPostsCheck = 0;
let lastPostersCheck = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runJob(job: Job): Promise<void> {
  console.log(`[job] start ${job.type} ${job.id} (video ${job.video_id}, attempt ${job.attempts + 1})`);
  try {
    await logEvent(job.video_id, 'job_started', { job_id: job.id, type: job.type });
    await handlers[job.type](job);
    console.log(`[job] finished ${job.type} ${job.id}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[job] error in ${job.type} ${job.id}:`, err);
    await failJobWithRetry(job, message).catch((e) =>
      console.error(`[job] failJobWithRetry itself failed for ${job.id}:`, e),
    );
  }
}

/**
 * Poll backstop for external predictions. The web app's webhook route only
 * writes external_status/external_output on the job row; the worker owns
 * finalization (download to R2, asset row, job status, video status).
 */
async function pollExternalJobs(): Promise<void> {
  const jobs = await getStaleExternalJobs();
  for (const job of jobs) {
    try {
      let result = resultFromWebhookColumns(job);
      if (!result) {
        if (!job.external_id) {
          await failJobWithRetry(job, 'awaiting_external job has no external_id');
          continue;
        }
        result = await wavespeed().getResult(job.external_id);
      }
      await finalizeExternalJob(job, result);
    } catch (err) {
      console.error(`[poll] error finalizing job ${job.id}:`, err);
      // Bump updated_at so we don't hot-loop on the same broken job.
      await touchJob(job.id).catch(() => {});
    }
  }
}

/** Check GHL for scheduled posts that should have gone out by now. */
async function checkScheduledPosts(): Promise<void> {
  const posts = await getScheduledPosts();
  if (posts.length > 0) console.log(`[posts] checking ${posts.length} scheduled post(s)`);
  for (const post of posts) {
    try {
      const remote = await ghl().getPost(post.ghl_post_id);
      const status = remote.status.toLowerCase();
      if (/publish|posted|success/.test(status)) {
        await updatePostStatus(post.id, 'published');
        await setVideoStatus(post.video_id, 'posted', { ghl_post_id: post.ghl_post_id });
        await logEvent(post.video_id, 'post_published', { ghl_post_id: post.ghl_post_id });
      } else if (/fail|error|deleted/.test(status)) {
        await updatePostStatus(post.id, 'failed');
        // Surface the failure on the pipeline board — the video would
        // otherwise sit in "Scheduled" forever.
        const flipped = await setVideoStatus(post.video_id, 'failed', {
          ghl_post_id: post.ghl_post_id,
          ghl_status: remote.status,
        });
        if (flipped) {
          await db()`
            update videos
            set status_error = ${`GHL post ${remote.status} — save a new schedule time to recreate the post`}
            where id = ${post.video_id}
          `;
        }
        await logEvent(post.video_id, 'post_failed', {
          ghl_post_id: post.ghl_post_id,
          ghl_status: remote.status,
        });
        console.warn(`[posts] post ${post.id} failed in GHL (status: ${remote.status})`);
      } else {
        await updatePostStatus(post.id, null); // still scheduled — just record the check
      }
    } catch (err) {
      console.error(`[posts] error checking post ${post.id}:`, err);
    }
  }
}

async function tick(): Promise<void> {
  const capacity = workerConcurrency() - inFlight.size;
  if (capacity > 0) {
    const jobs = await claimJobs(capacity, LIGHT_JOB_TYPES);
    // One render at a time. A render runs headless Chrome plus ffmpeg on a
    // 1080x1920 timeline; two in one container starve Chrome's video decoder,
    // which then ships layers that never decoded (black outro, no bubble).
    if (jobs.length < capacity && !renderInFlight) {
      jobs.push(...(await claimJobs(1, ['render'])));
    }
    for (const job of jobs) {
      if (job.type === 'render') renderInFlight = true;
      const p: Promise<void> = runJob(job).finally(() => {
        inFlight.delete(p);
        if (job.type === 'render') renderInFlight = false;
      });
      inFlight.add(p);
    }
  }

  await pollExternalJobs();

  if (Date.now() - lastPostsCheck >= POSTS_CHECK_MS) {
    lastPostsCheck = Date.now();
    await checkScheduledPosts();
  }

  if (Date.now() - lastPostersCheck >= POSTERS_CHECK_MS) {
    lastPostersCheck = Date.now();
    await generateMissingBrandPosters().catch((err) =>
      console.error('[posters] scan failed:', err),
    );
  }
}

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`[worker] ${signal} received — draining ${inFlight.size} in-flight job(s)...`);
  await Promise.allSettled([...inFlight]);
  await closeDb().catch(() => {});
  console.log('[worker] shutdown complete');
  process.exit(0);
}

async function main(): Promise<void> {
  console.log(`[worker] starting (concurrency ${workerConcurrency()}, tick ${TICK_MS}ms)`);
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
  while (!stopping) {
    try {
      await tick();
    } catch (err) {
      console.error('[worker] tick error:', err);
    }
    await sleep(TICK_MS);
  }
}

void main();
