# 🎙️ Narrate — watch videos, record narrations

Crowd-narration tool: a worker signs in with email OTP, watches a short video, and
records a voice narration of what's happening. Narrations land in Supabase Storage
+ Postgres for review/export.

**Live:** https://fiddeesss.github.io/video-narrator/

## Stack

- Frontend: static HTML/CSS/JS (no framework), hosted on GitHub Pages
- Auth: Supabase email OTP (6-digit code, no password)
- Recording: browser MediaRecorder (mic) → WebM upload to Supabase Storage
- Data: `vn_narrations` table (one row per submission) + `vn_videos` catalog
- Backend: Supabase project `lbzcvnvucdqfyubipjxj` (shared with GIG support bot,
  everything namespaced `vn_` / `vn-`)

## How it works (flow)

1. User enters email → gets 6-digit code → verifies (account auto-created)
2. App loads active videos from `vn_videos` (ordered by `sort_order`)
3. User watches, presses record, narrates, stops → WebM uploaded to
   `vn-narrations/{user_id}/{video_id}-{timestamp}.webm`
4. Row inserted into `vn_narrations` with `audio_url` (public URL), duration, status
5. Progress bar shows X / Y done; finished users see "All done"

## Adding videos

Insert rows into `vn_videos` (public table — readable by anyone, writable only via
service role / dashboard):

```sql
insert into public.vn_videos (id, title, url, sort_order) values
('vid-1', 'My first video', 'https://host.example/video.mp4', 1);
```

`active = true` to show, `false` to hide. Currently seeded with 2 sample videos.

## Reviewing narrations

All narrations are in `vn_narrations`; audio is publicly fetchable via `audio_url`.
Best views: Supabase dashboard Table Editor, or:

```sql
select u.email, n.video_id, n.duration_sec, n.created_at, n.audio_url
from vn_narrations n join auth.users u on u.id = n.user_id
order by n.created_at desc;
```

## Security model (verified)

- `vn_videos`: RLS on, SELECT for everyone (public catalog). No write policy —
  service role only.
- `vn_narrations`: RLS on, SELECT own + INSERT own (`auth.uid() = user_id`).
- Storage `vn-narrations`: INSERT only when path starts with the caller's uid
  (`(storage.foldername(name))[1] = auth.uid()`), public read.
- Verified: anon insert/update/delete → blocked; own-folder upload → 200;
  wrong-folder upload → 403.

## Local dev / deploy

- `site/` = the whole frontend. Edit, commit, push → GitHub Pages auto-deploys.
- `~/video-narrator/setup_backend.py` — provisioned tables/bucket/RLS (idempotent
  script, management-API DDL).
- `~/video-narrator/deploy.py` — uploaded site to Supabase Storage (unused now;
  Storage force-serves HTML as text/plain, so Pages is the host).
- `.env.local` holds the project keys (anon is public; service role is server-only).

## Known limits / next steps

- Default Supabase SMTP for OTP emails (rate-limited) — switch to Resend before
  heavy traffic.
- No QC/flagging, no payouts, no text-narration option (voice-only by design).
- Runs on the GIG support bot's Supabase project — move to a dedicated project
  before a real launch (free tier is at its 2-project limit).
- MediaRecorder needs Chrome/Safari on desktop or iOS 14.3+/Android Chrome.

## Data integrity (added after QA)

`vn_narrations` has two constraints beyond the primary key:
- `unique (user_id, video_id)` — a user can't submit the same video twice
  (client shows it as "already done" via a 23505-handled insert, no error toast).
- `foreign key (video_id) references vn_videos(id)` — rejects narrations for
  videos that don't exist in the catalog (23503 on violation).

The "Discard & retry" button previously called the same stop handler as
"Stop & submit", silently uploading and persisting an empty 0-second
narration. Fixed: `stopRecording(discard)` now takes an explicit flag, and
the discard path returns before building the audio blob or touching the
network. Recording MIME type also now falls through webm → mp4 → ogg
candidates (previously webm-only, which doesn't exist on some browsers) and
the upload's content-type/extension match what `MediaRecorder` actually
produced instead of being hardcoded to `.webm`.
