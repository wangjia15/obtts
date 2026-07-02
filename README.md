# Markdown Read Aloud

Read your Markdown notes aloud in Obsidian with free, high‑quality neural voices —
sentence highlighting, automatic language detection, and a distraction‑free reader.

No API key, no account, no cost: speech is synthesized through Microsoft Edge's
free read‑aloud neural voices, with the system's built‑in voices as an offline
fallback.

> Desktop only. Requires Obsidian 1.5.0+.

---

## Features

- **Free neural voices** — Microsoft Edge TTS (hundreds of voices across ~90
  languages), streamed per sentence with gapless prefetch so playback stays smooth.
- **Sentence highlighting + auto‑scroll** — a teleprompter‑style reader follows
  along; scroll away and a "back to reading" pill brings you back.
- **Automatic language detection** — the document language is detected on open,
  and with *per‑paragraph* mode each paragraph switches voice to its own language
  (great for mixed‑language notes). Detection uses [`eld`](https://github.com/nitotm/efficient-language-detector).
- **Obsidian‑aware** — wikilinks, embeds, `%%comments%%`, `==highlights==`,
  callouts, `#tags`, and block references are handled so they aren't read as
  literal punctuation.
- **Reader controls** — speed (0.5–2.5×), volume/mute, seek bar with section
  markers, sleep timer (end of section / 15 / 30 / 60 min), collapsible headings,
  per‑section reading‑time estimates, and resume‑where‑you‑left‑off per note.
- **Reading comfort** — four fonts (Literata, Inter, Atkinson Hyperlegible,
  IBM Plex Mono), themes (auto / study / daylight / paper), width presets, and an
  ambient focus mode.
- **Reads from anywhere** — the whole note, from the cursor, or just the selection.
- **Click to navigate** — click a sentence to read from there; `Alt`+click to jump
  to that line in the source editor.
- **Localized UI** — English, German, Spanish, French, Italian, Japanese,
  Brazilian Portuguese, and Simplified Chinese.

---

## Install

### From this repo (manual)

1. Build the plugin (see [Development](#development)) or grab a release.
2. Copy `main.js`, `manifest.json`, `styles.css`, and the `media/` folder into
   your vault at:

   ```
   <vault>/.obsidian/plugins/obtts/
   ```

3. In Obsidian: **Settings → Community plugins → Reload**, then enable
   **Markdown Read Aloud**.

---

## Usage

Open a Markdown note and start reading via any of:

- The **ribbon icon** (speaker).
- The **command palette** (`Ctrl/Cmd‑P`):
  - **Read Aloud: Read Document** — read the whole note.
  - **Read from cursor** — start at the cursor position.
  - **Read selection** — read only the selected text.
  - **Read Aloud — click to play/pause** — toggle transport.
  - **Stop**.
- The **editor right‑click menu**: *Read from cursor* / *Read selection*.

A reader pane opens with the note laid out for listening. A compact play/pause
control also appears in the status bar while a note is loaded.

### Keyboard (in the reader pane)

| Key | Action |
| --- | --- |
| `Space` | Play / pause |
| `←` / `↑` | Previous sentence |
| `→` / `↓` | Next sentence |
| `+` / `-` | Speed up / down |
| `m` | Mute / unmute |
| `f` | Cycle reading font |
| `Esc` | Stop |
| Click a sentence | Read from there |
| `Alt`+click | Open that line in the source editor |

---

## Settings

- **Voice** — preferred gender (female / male) for the auto‑selected voice.
- **Auto language (per paragraph)** — detect each paragraph's language and switch
  voices automatically.
- **Speed** / **Volume** — defaults for new reads (also adjustable live).
- **Language** — fallback reading language when auto‑detection is off or unsure.
- **Auto‑detect document language** — pick the document language on open.
- **Announce headings** — prefix headings with a spoken "Heading." marker.
- **Code blocks** — *Off* (skip) / *Code block* (announce) / *Read* (read the code).
- **Tables** — *Off* (skip) / *Read* (read cells).
- **Highlight while reading** — toggle the sentence highlight.
- **Pronunciations** — per‑word spoken replacements, one per line as
  `word=replacement` (e.g. `nginx=engine x`).

---

## How it works

Markdown is preprocessed for Obsidian‑specific syntax, then rendered to sanitized
HTML for the reader DOM. The reader segments each block into sentences
(`Intl.Segmenter`) and requests audio one sentence at a time, prefetching ahead
for gapless playback.

Speech is produced by `EdgeTtsEngine`, which talks to Microsoft Edge's free
read‑aloud WebSocket endpoint. A single connection serves the whole document —
including mixed languages — because the voice travels in each request, so there's
no reconnect when the language changes. If Edge is unreachable, the plugin falls
back to the browser's built‑in `speechSynthesis` voices (offline).

Synthesized audio is cached (LRU) per `voice · locale · text`, so repeated
sentences and re‑reads are instant.

---

## Development

```bash
npm install
npm run dev     # watch build (esbuild)
npm run build   # production build → main.js
```

The build bundles the Node `ws` client (via an esbuild alias) so the Edge
endpoint's required `Origin` / `User‑Agent` headers can be set — the renderer's
native `WebSocket` cannot set those.

### Source layout

| File | Responsibility |
| --- | --- |
| `src/main.ts` | Plugin entry: commands, ribbon, menus, status bar |
| `src/controller.ts` | Synthesis + state orchestrator, audio cache, voice/language state |
| `src/engine.ts` | Edge neural TTS over a bundled `ws` WebSocket |
| `src/player.ts` | The reader: segmentation, playback, highlight, transport UI |
| `src/view.ts` | Obsidian `ItemView` hosting the reader; font injection |
| `src/settings.ts` | Settings tab + persisted plugin data |
| `src/markdown/render.ts` | Markdown → sanitized reader HTML |
| `src/markdown/obsidian.ts` | Obsidian‑syntax preprocessing (wikilinks, callouts, …) |
| `src/markdown/normalize.ts` | Speech text cleanup + pronunciation overrides |
| `src/languageDetector.ts` | Document / per‑paragraph language detection (`eld`) |
| `src/voices.ts` | Voice catalog, curated per‑locale voice pairs |

---

## Privacy

Text you read aloud is sent to Microsoft's public read‑aloud service for
synthesis (the same one Edge's built‑in Read Aloud uses). If that service is
unreachable, the plugin automatically falls back to your system's built‑in
voices, which run fully offline.

## License

MIT
