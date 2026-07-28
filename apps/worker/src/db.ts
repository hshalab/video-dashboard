import postgres from 'postgres';
import {
  canTransition,
  type Asset,
  type AssetKind,
  type BrandAssetKind,
  type Job,
  type JobType,
  type ScriptVersion,
  type Video,
  type VideoStatus,
} from '@vd/shared';
import { requiredEnv } from './env';

/** brand_assets row (not part of shared types). */
export interface BrandAsset {
  id: string;
  kind: BrandAssetKind;
  name: string;
  r2_key: string;
  is_default: boolean;
  meta: Record<string, unknown>;
  created_at: string | Date;
}

/** posts row. */
export interface PostRow {
  id: string;
  video_id: string;
  ghl_post_id: string;
  ghl_account_id: string;
  caption: string;
  schedule_date: string | Date;
  status: 'scheduled' | 'published' | 'failed';
  last_checked_at: string | Date | null;
  created_at: string | Date;
}

let _sql: postgres.Sql | undefined;

export function db(): postgres.Sql {
  return (_sql ??= postgres(requiredEnv('DATABASE_URL'), {
    max: 10,
    onnotice: () => {},
  }));
}

export async function closeDb(): Promise<void> {
  if (_sql) await _sql.end({ timeout: 5 });
}

/**
 * Claim up to `limit` queued jobs. FOR UPDATE SKIP LOCKED inside a transaction
 * so multiple worker replicas (or concurrent ticks) never claim the same job.
 */
/**
 * jsonb payloads that were double-encoded (a JSON string, or an array of JSON
 * strings from `||` concat of two strings) are re-parsed into a plain object.
 */
export function normalizeJobPayload(job: Job): Job {
  let p: unknown = job.payload;
  try {
    if (typeof p === 'string') p = JSON.parse(p);
    if (Array.isArray(p)) {
      const merged: Record<string, unknown> = {};
      for (const part of p) {
        const obj = typeof part === 'string' ? JSON.parse(part) : part;
        if (obj && typeof obj === 'object') Object.assign(merged, obj);
      }
      p = merged;
    }
  } catch {
    p = {};
  }
  return { ...job, payload: (p ?? {}) as Record<string, unknown> };
}

export async function claimJobs(limit: number, types?: JobType[]): Promise<Job[]> {
  const s = db();
  const claimed = await s.begin(async (tx) => {
    const jobs = await tx<Job[]>`
      select * from jobs
      where status = 'queued' and run_after <= now()
        and (${types ?? null}::text[] is null or type = any(${types ?? null}::text[]))
      order by created_at
      limit ${limit}
      for update skip locked
    `;
    if (jobs.length === 0) return [] as Job[];
    await tx`
      update jobs
      set status = 'running', started_at = now(), error = null
      where id in ${tx(jobs.map((j) => j.id))}
    `;
    return jobs;
  });
  return (claimed as Job[]).map(normalizeJobPayload);
}

export async function completeJob(
  jobId: string,
  extra: { external_status?: string; external_output?: unknown } = {},
): Promise<void> {
  const s = db();
  await s`
    update jobs
    set status = 'succeeded',
        finished_at = now(),
        error = null,
        external_status = coalesce(${extra.external_status ?? null}, external_status),
        external_output = coalesce(${
          extra.external_output !== undefined ? s.json(extra.external_output as never) : null
        }, external_output)
    where id = ${jobId}
  `;
}

/**
 * attempts++ with exponential backoff (2^attempts * 30s). After max_attempts,
 * mark the job failed and push the video into 'failed' with status_error.
 */
export async function failJobWithRetry(job: Job, message: string): Promise<void> {
  const s = db();
  const attempts = job.attempts + 1;
  const msg = message.slice(0, 4000);
  if (attempts >= job.max_attempts) {
    await s`
      update jobs
      set status = 'failed', attempts = ${attempts}, error = ${msg}, finished_at = now()
      where id = ${job.id}
    `;
    await s`
      update videos
      set status = 'failed',
          status_error = ${`${job.type} job failed after ${attempts} attempts: ${msg}`.slice(0, 4000)}
      where id = ${job.video_id}
    `;
    await logEvent(job.video_id, 'job_failed_permanently', {
      job_id: job.id,
      type: job.type,
      attempts,
      error: msg,
    });
    console.error(`[job] ${job.type} ${job.id} permanently failed after ${attempts} attempts`);
  } else {
    const delayS = 2 ** attempts * 30;
    await s`
      update jobs
      set status = 'queued',
          attempts = ${attempts},
          error = ${msg},
          external_id = null,
          external_status = null,
          run_after = now() + ${delayS} * interval '1 second'
      where id = ${job.id}
    `;
    await logEvent(job.video_id, 'job_retry_scheduled', {
      job_id: job.id,
      type: job.type,
      attempts,
      retry_in_s: delayS,
      error: msg,
    });
    console.warn(`[job] ${job.type} ${job.id} attempt ${attempts} failed; retry in ${delayS}s`);
  }
}

/**
 * Validated status transition (shared TRANSITIONS). Returns false and skips
 * (with a warning) when the transition is invalid or lost a concurrent race.
 */
export async function setVideoStatus(
  videoId: string,
  to: VideoStatus,
  detail: Record<string, unknown> = {},
): Promise<boolean> {
  const s = db();
  const [video] = await s<Pick<Video, 'id' | 'status'>[]>`
    select id, status from videos where id = ${videoId}
  `;
  if (!video) {
    console.warn(`[status] video ${videoId} not found`);
    return false;
  }
  if (!canTransition(video.status, to)) {
    console.warn(`[status] skip invalid transition ${video.status} -> ${to} (video ${videoId})`);
    return false;
  }
  // Optimistic guard: only win if status is still what we read.
  const res = await s`
    update videos set status = ${to}, status_error = null
    where id = ${videoId} and status = ${video.status}
  `;
  if (res.count === 0) return false;
  await logEvent(videoId, 'status_change', { from: video.status, to, ...detail });
  console.log(`[status] video ${videoId}: ${video.status} -> ${to}`);
  return true;
}

export async function logEvent(
  videoId: string,
  event: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  const s = db();
  await s`
    insert into pipeline_events (video_id, event, detail)
    values (${videoId}, ${event}, ${s.json(detail as never)})
  `;
}

export async function insertAsset(asset: {
  video_id: string;
  kind: AssetKind;
  r2_key: string;
  scene_index?: number | null;
  duration_s?: number | null;
  size_bytes?: number | null;
  meta?: Record<string, unknown>;
}): Promise<void> {
  const s = db();
  await s`
    insert into assets (video_id, kind, scene_index, r2_key, duration_s, size_bytes, meta)
    values (
      ${asset.video_id}, ${asset.kind}, ${asset.scene_index ?? null}, ${asset.r2_key},
      ${asset.duration_s ?? null}, ${asset.size_bytes ?? null},
      ${s.json((asset.meta ?? {}) as never)}
    )
  `;
}

export async function getAssets(videoId: string, kind?: AssetKind): Promise<Asset[]> {
  const s = db();
  const rows = kind
    ? await s<Asset[]>`
        select * from assets where video_id = ${videoId} and kind = ${kind}
        order by created_at desc`
    : await s<Asset[]>`
        select * from assets where video_id = ${videoId}
        order by created_at desc`;
  return rows as Asset[];
}

export async function getLatestAsset(
  videoId: string,
  kind: AssetKind,
  sceneIndex?: number,
): Promise<Asset | null> {
  const s = db();
  const rows =
    sceneIndex != null
      ? await s<Asset[]>`
          select * from assets
          where video_id = ${videoId} and kind = ${kind} and scene_index = ${sceneIndex}
          order by created_at desc limit 1`
      : await s<Asset[]>`
          select * from assets
          where video_id = ${videoId} and kind = ${kind}
          order by created_at desc limit 1`;
  return rows[0] ?? null;
}

export async function getVideo(videoId: string): Promise<Video> {
  const [video] = await db()<Video[]>`select * from videos where id = ${videoId}`;
  if (!video) throw new Error(`Video ${videoId} not found`);
  return video;
}

export async function getScriptVersion(id: string): Promise<ScriptVersion> {
  const [sv] = await db()<ScriptVersion[]>`select * from script_versions where id = ${id}`;
  if (!sv) throw new Error(`Script version ${id} not found`);
  return sv;
}

/** jsonb value from app_settings, or null when the key is unset. */
export async function getAppSetting(key: string): Promise<unknown> {
  const rows = await db()<{ value: unknown }[]>`
    select value from app_settings where key = ${key} limit 1`;
  return rows[0]?.value ?? null;
}

/** By id when given, otherwise the default (or newest) brand asset of a kind. */
export async function getBrandAsset(
  kind: BrandAssetKind,
  id?: string,
): Promise<BrandAsset | null> {
  const s = db();
  const rows = id
    ? await s<BrandAsset[]>`select * from brand_assets where id = ${id} limit 1`
    : await s<BrandAsset[]>`
        select * from brand_assets where kind = ${kind}
        order by is_default desc, created_at desc limit 1`;
  return rows[0] ?? null;
}

export async function enqueueJob(
  videoId: string,
  type: JobType,
  payload: Record<string, unknown> = {},
): Promise<string> {
  const s = db();
  const [row] = await s<{ id: string }[]>`
    insert into jobs (video_id, type, payload)
    values (${videoId}, ${type}, ${s.json(payload as never)})
    returning id
  `;
  console.log(`[queue] enqueued ${type} ${row.id} for video ${videoId}`);
  return row.id;
}

export async function setJobAwaitingExternal(
  jobId: string,
  externalId: string,
  payloadPatch: Record<string, unknown> = {},
): Promise<void> {
  const s = db();
  await s`
    update jobs
    set status = 'awaiting_external',
        external_id = ${externalId},
        payload = payload || ${s.json(payloadPatch as never)}
    where id = ${jobId}
  `;
}

/**
 * Jobs the poll backstop should look at: webhook already delivered a terminal
 * status, or nothing has touched the row for >60s (webhook missed/lost).
 */
export async function getStaleExternalJobs(limit = 10): Promise<Job[]> {
  const rows = await db()<Job[]>`
    select * from jobs
    where status = 'awaiting_external'
      and (external_status in ('completed', 'failed')
           or updated_at < now() - interval '60 seconds')
    order by updated_at asc
    limit ${limit}
  `;
  return (rows as Job[]).map(normalizeJobPayload);
}

/** Bump updated_at (via trigger) so the backstop waits another 60s. */
export async function touchJob(jobId: string): Promise<void> {
  await db()`update jobs set external_status = external_status where id = ${jobId}`;
}

/** True when the video has a queued/running/awaiting job of this type. */
export async function hasPendingJob(videoId: string, type: JobType): Promise<boolean> {
  const [row] = await db()<{ n: number }[]>`
    select count(*)::int as n from jobs
    where video_id = ${videoId} and type = ${type}
      and status in ('queued', 'running', 'awaiting_external')
  `;
  return (row?.n ?? 0) > 0;
}

export async function getScheduledPosts(): Promise<PostRow[]> {
  const rows = await db()<PostRow[]>`
    select * from posts where status = 'scheduled' order by schedule_date asc
  `;
  return rows as PostRow[];
}

export async function updatePostStatus(
  postId: string,
  status: PostRow['status'] | null,
): Promise<void> {
  const s = db();
  if (status) {
    await s`update posts set status = ${status}, last_checked_at = now() where id = ${postId}`;
  } else {
    await s`update posts set last_checked_at = now() where id = ${postId}`;
  }
}

export async function insertPost(post: {
  video_id: string;
  ghl_post_id: string;
  ghl_account_id: string;
  caption: string;
  schedule_date: string;
}): Promise<void> {
  await db()`
    insert into posts (video_id, ghl_post_id, ghl_account_id, caption, schedule_date)
    values (${post.video_id}, ${post.ghl_post_id}, ${post.ghl_account_id},
            ${post.caption}, ${post.schedule_date})
  `;
}
