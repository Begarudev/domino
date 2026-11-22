# Video capture pipeline (work in progress)

Records the real DOMINO app with Playwright (CDP screencast, 1920x1080) and assembles a captioned mp4 with ffmpeg.
This ffmpeg build has no drawtext/libass, so caption bands and title cards are rendered as PNGs with Playwright.

- `lib.mjs`: Playwright from `$PW` (default /Users/garudev/dev/umbra/node_modules/playwright-core), screencast recorder
  with timestamped marks, a visible cursor, and an in-page CSS camera (`zoomTo`) so close-ups stay sharp.
- `capture.mjs main|replay --base URL --out DIR`: drives the app through the script, writes frames, marks.json, facts.json.
  Status: written against the pre-pivot theatre (`?view=theatre`). The landing → theatre → kill/resume path works;
  the classic-view section needs its selectors updated, and the whole flow must move to web2 after the pivot.
- `overlays.mjs`: caption band (step N/6, headline, subline, honesty pills such as 4x, Cached, Injected fault) and title cards.
- `assemble.mjs --script S --takes DIR --out FILE.mp4`: builds a master per take, cuts segments between marks
  (speed, hold), overlays bands, concatenates, and writes FILE.srt plus FILE.edit.json.
- `script-theatre.mjs`: pipeline-check edit for the theatre take. The submission storyboard is
  ~/Documents/domino-video/script.txt.

Run the app on its own port and DB: `DOMINO_PORT=4400 DOMINO_DB=data/video.db DOMINO_OUTBOX=data/video-outbox bun server/index.ts`.
