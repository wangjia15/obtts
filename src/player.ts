import type { Gender } from './types';
import { detectLangCode } from './languageDetector';

/**
 * ReaderPlayer — a faithful TypeScript port of the reference `media/reader.js`.
 *
 * The ONLY structural change vs. the reference: the VS Code webview messaging
 * shim is replaced by direct in-process interfaces. The reader no longer
 * `postMessage`s to a host; it calls a `SynthProvider` (for synthesis requests)
 * and a `HostCallbacks` object (for everything else: persist prefs, reveal
 * source, transport state, voice/language changes). Audio arrives back through
 * the public `onAudio` / `onAudioError` / `onEngineFallback` methods.
 *
 * All playback logic — gapless prefetch, sentence highlight + auto-scroll,
 * seek, sleep timer, collapse, voice/language pickers, themes — is ported
 * verbatim from reader.js and operates on `this.root` (the reader pane), not
 * `document`/`document.body`.
 */

// ---------------------------------------------------------------------------
// Contracts (the host/webview boundary, collapsed into direct calls)
// ---------------------------------------------------------------------------

export interface SynthProvider {
  /** Request synthesis for sentence `id` (load generation `gen`). */
  synth(id: number, text: string, gen: number): void;
}

export interface ReaderPrefs {
  font: string;
  theme: string;
  comfort: string;
  ambient: boolean;
  badges: boolean;
}

export interface VoiceOption {
  shortName: string;
  name: string;
  gender: string;
  multilingual: boolean;
}

export interface VoicePairEntry {
  shortName: string;
  name: string;
}

export interface VoiceUiPayload {
  autoLang: boolean;
  locale: string;
  localeName: string;
  locales: { locale: string; name: string }[];
  voicePair: { female?: VoicePairEntry; male?: VoicePairEntry };
  allVoices: VoiceOption[];
  currentVoice: string;
  currentVoiceName: string;
  gender: Gender;
}

export interface ReaderSettings {
  codeBlocks: 'skip' | 'announce' | 'read';
  tables: 'skip' | 'read';
  announceHeadings: boolean;
  highlight: boolean;
}

export interface LoadPayload {
  html: string;
  title: string;
  docKey: string;
  baseHref: string;
  engine: 'edge' | 'browser';
  rate: number;
  volume: number;
  settings: Partial<ReaderSettings>;
  prefs: ReaderPrefs | null;
  resume: { idx: number; total: number; text: string } | null;
  anchorText: string | null;
  autoplay: boolean;
  voiceUi: VoiceUiPayload;
}

/** Everything the player pushes up to the controller (was `postMessage`). */
export interface HostCallbacks {
  persistPrefs(prefs: ReaderPrefs): void;
  persistSpeed(value: number): void;
  persistVolume(value: number): void;
  openSource(line: number): void;
  editSource(line: number): void;
  position(docKey: string, idx: number, total: number, text: string): void;
  playState(playing: boolean): void;
  setGender(gender: Gender): void;
  setAutoLang(value: boolean): void;
  setLocale(locale: string): void;
  setVoice(shortName: string): void;
}

export interface PlayerOptions {
  rate: number;
  volume: number;
  settings: ReaderSettings;
  prefs: ReaderPrefs | null;
  engine: 'edge' | 'browser';
}

// ---------------------------------------------------------------------------
// Static UI data (ported verbatim)
// ---------------------------------------------------------------------------

interface FontDef {
  key: string;
  name: string;
  sub: string;
}

const FONTS: FontDef[] = [
  { key: 'serif', name: 'Literata', sub: '' },
  { key: 'sans', name: 'Inter', sub: '' },
  { key: 'a11y', name: 'Atkinson Hyperlegible', sub: '' },
  { key: 'mono', name: 'IBM Plex Mono', sub: '' },
];
const THEMES = ['auto', 'study', 'daylight', 'paper'];
const COMFORTS = ['compact', 'cozy', 'wide'];
const SPEED_PRESETS = [0.75, 1, 1.25, 1.5, 2];

interface IconSet {
  [k: string]: string;
}

const I: IconSet = {
  prev: '<svg viewBox="0 0 24 24"><path d="M6 5v14h2V5H6zm3 7l9 7V5l-9 7z"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" rx="1.3"/><rect x="14" y="5" width="4" height="14" rx="1.3"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M16 5v14h2V5h-2zM15 12L6 5v14l9-7z"/></svg>',
  moon: '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 109 9c0-.46-.04-.92-.1-1.36A5.5 5.5 0 0112.36 3.1 9.05 9.05 0 0012 3z"/></svg>',
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6L19 19M19 5l-1.4 1.4M6.4 17.6L5 19"/></svg>',
  paper: '<svg viewBox="0 0 24 24"><path d="M6 3h9l5 5v13H6zM14 4v5h5"/></svg>',
  auto: '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 100 18V3z"/><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  ambient: '<svg viewBox="0 0 24 24"><path d="M12 7a5 5 0 100 10 5 5 0 000-10zm0 8a3 3 0 110-6 3 3 0 010 6z" opacity=".55"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke="currentColor" stroke-width="1.6"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><path d="M19.14 12.94a7.49 7.49 0 000-1.88l2.03-1.58a.5.5 0 00.12-.64l-1.92-3.32a.5.5 0 00-.6-.22l-2.39.96a7.3 7.3 0 00-1.62-.94l-.36-2.54a.5.5 0 00-.5-.42h-3.84a.5.5 0 00-.5.42l-.36 2.54c-.58.24-1.12.55-1.62.94l-2.39-.96a.5.5 0 00-.6.22L2.71 8.84a.5.5 0 00.12.64l2.03 1.58a7.49 7.49 0 000 1.88l-2.03 1.58a.5.5 0 00-.12.64l1.92 3.32c.13.22.39.31.6.22l2.39-.96c.5.39 1.04.7 1.62.94l.36 2.54c.04.24.25.42.5.42h3.84c.25 0 .46-.18.5-.42l.36-2.54c.58-.24 1.12-.55 1.62-.94l2.39.96c.21.09.47 0 .6-.22l1.92-3.32a.5.5 0 00-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1112 8.5a3.5 3.5 0 010 7z"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M12 16l-6-6h12z"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>',
  playSm: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
};
const SPK = '<svg viewBox="0 0 24 24"><path d="M4 9v6h3.6L13 20V4L7.6 9H4z"/><path d="M16 8.6a4 4 0 010 6.8M18.4 6a7 7 0 010 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
const SPK_MUTE = '<svg viewBox="0 0 24 24"><path d="M4 9v6h3.6L13 20V4L7.6 9H4z"/><path d="M16.5 9.5l5 5M21.5 9.5l-5 5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';

const STOP: Record<string, string[]> = {
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'mit', 'auch', 'sich', 'ein', 'eine', 'den', 'dem', 'für', 'von', 'zu', 'ich', 'wird', 'dann'],
  fr: ['le', 'la', 'les', 'et', 'est', 'pas', 'vous', 'une', 'des', 'du', 'je', 'que', 'qui', 'pour', 'par', 'ce'],
  es: ['el', 'la', 'los', 'las', 'y', 'es', 'no', 'una', 'por', 'para', 'con', 'que', 'de', 'está', 'este'],
  en: ['the', 'and', 'is', 'to', 'of', 'a', 'in', 'you', 'it', 'for', 'read', 'with', 'that', 'this', 'your'],
};
const LANG_LABEL: Record<string, string> = {
  de: 'DE', fr: 'FR', es: 'ES', en: 'EN', zh: 'ZH', ja: 'JA', ru: 'RU', it: 'IT', pt: 'PT',
};

const BLOCKISH = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, pre, ul, ol, table';
const PREFETCH = 2;

interface Segment {
  id: number;
  el: HTMLElement;
  text: string;
  lang: string;
}

interface Section {
  idx: number;
  title: string;
}

interface SleepState {
  mode: 'section' | 'timer';
  boundary?: number;
  id?: number;
}

// ---------------------------------------------------------------------------
// Helpers (module-level, pure)
// ---------------------------------------------------------------------------

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const fmt = (k: string, ...a: (string | number)[]): string =>
  a.reduce<string>((s, v, i) => s.replace('{' + i + '}', String(v)), k);

const fmtRate = (r: number): string =>
  (Math.round(r * 100) / 100).toFixed(2).replace(/(\.\d)0$/, '$1') + '×';

/** Fast stop-word/script heuristic — the fallback when `eld` can't commit. */
function heuristicLang(text: string): string {
  const t = text.toLowerCase();
  if (/[぀-ヿ]/.test(t)) return 'ja';
  if (/[一-鿿]/.test(t)) return 'zh';
  if (/[Ѐ-ӿ]/.test(t)) return 'ru';
  const words = t.match(/[\p{L}]+/gu) || [];
  const sc: Record<string, number> = { de: 0, fr: 0, es: 0, en: 0 };
  for (const w of words) for (const k in STOP) if (STOP[k].includes(w)) sc[k]++;
  if (/[äöüß]/.test(t)) sc.de += 2;
  if (/[ñ¿¡]/.test(t)) sc.es += 2;
  if (/[àâçéèêëîïôûœ]/.test(t)) sc.fr += 1.5;
  let best = 'en';
  let bv = 0;
  for (const k in sc) if (sc[k] > bv) { bv = sc[k]; best = k; }
  return bv === 0 ? 'en' : best;
}

/**
 * Block-level language for badges + the browser-engine voice pick. Prefers the
 * `eld` detector (the same one that drives per-paragraph synthesis) so labels
 * agree with what is actually spoken, and falls back to the cheap heuristic for
 * short or ambiguous runs where `eld` won't commit.
 */
function detectLang(text: string): string {
  return detectLangCode(text) || heuristicLang(text);
}

function sentencesOf(text: string, base: string): { segment: string; index: number }[] {
  try {
    return [...new Intl.Segmenter(base, { granularity: 'sentence' }).segment(text)];
  } catch {
    return [{ segment: text, index: 0 }];
  }
}

const isBlockish = (n: Node): boolean =>
  n.nodeType === 1 && ((n as Element).matches?.(BLOCKISH) || !!(n as Element).querySelector?.(BLOCKISH));

// ---------------------------------------------------------------------------
// The player
// ---------------------------------------------------------------------------

export class ReaderPlayer {
  private root: HTMLElement;
  private provider: SynthProvider;
  private host: HostCallbacks;
  private L: Record<string, string>;
  private audio: HTMLAudioElement;
  private RM: MediaQueryList;

  private state = {
    idx: 0,
    playing: false,
    rate: 1,
    volume: 1,
    lastVol: 1,
    muted: false,
    engine: 'edge' as 'edge' | 'browser',
    autoLang: true,
    following: true,
    font: 'serif',
    theme: 'auto',
    comfort: 'cozy',
    ambient: false,
    badges: false,
    settings: {
      codeBlocks: 'announce' as ReaderSettings['codeBlocks'],
      tables: 'skip' as ReaderSettings['tables'],
      announceHeadings: false,
      highlight: true,
    },
    sleep: null as SleepState | null,
    ended: false,
    docKey: '',
  };

  private vu: VoiceUiPayload | null = null;
  private SEG_SEQ = 0;
  private SEGMENTS: Segment[] = [];
  private SECTIONS: Section[] = [];
  private wordsPrefix: number[] = [];
  private synthVoice: SpeechSynthesisVoice | null = null;
  private urlCache = new Map<number, string>();
  private localeById = new Map<number, string>();
  private requested = new Set<number>();
  private waitingFor = -1;
  private rovingEl: HTMLElement | null = null;
  private loadGen = 0;
  private fadeMul = 1;
  private openPopInfo: { pop: HTMLElement; btn: HTMLElement } | null = null;
  private scrollRaf = 0;
  private resumeTimer = 0;
  private posTimer = 0;
  private lastSentIdx = -1;
  private speedPersist = 0;
  private destroyed = false;

  constructor(
    root: HTMLElement,
    provider: SynthProvider,
    host: HostCallbacks,
    strings: Record<string, string>,
    opts: PlayerOptions
  ) {
    this.root = root;
    this.provider = provider;
    this.host = host;
    this.L = strings;
    this.audio = new Audio();
    this.audio.preservesPitch = true;
    this.RM = root.ownerDocument.defaultView!.matchMedia('(prefers-reduced-motion: reduce)');

    // seed font subtitles from localized strings
    FONTS[0].sub = strings.fontSerifSub;
    FONTS[1].sub = strings.fontSansSub;
    FONTS[2].sub = strings.fontA11ySub;
    FONTS[3].sub = strings.fontMonoSub;

    this.state.rate = opts.rate;
    this.state.volume = opts.volume;
    this.state.engine = opts.engine;
    this.state.settings = { ...opts.settings };
    this.applyPrefs(opts.prefs);

    this.buildChrome();
    this.applyTheme();
    this.applyFont();
    this.applyComfort();
    this.applyAmbient();
    this.applyBadgesPref();
    this.applyRate();
    this.applyVolume();

    // sentence click → read from there; Alt+Click → open the source line.
    this.root.addEventListener('click', (e) => this.onRootClick(e));

    this.audio.addEventListener('ended', () => {
      if (this.state.playing) this.advance();
    });
    this.audio.addEventListener('error', () => {
      if (this.state.playing && this.audio.src) this.advance();
    });
  }

  private $(id: string): HTMLElement | null {
    return this.root.querySelector('#' + id) as HTMLElement | null;
  }

  private applyPrefs(p: ReaderPrefs | null): void {
    if (!p) return;
    if (FONTS.some((f) => f.key === p.font)) this.state.font = p.font;
    if (THEMES.includes(p.theme)) this.state.theme = p.theme;
    if (COMFORTS.includes(p.comfort)) this.state.comfort = p.comfort;
    if (typeof p.ambient === 'boolean') this.state.ambient = p.ambient;
    if (typeof p.badges === 'boolean') this.state.badges = p.badges;
  }

  private persistPrefs(): void {
    const p: ReaderPrefs = {
      font: this.state.font,
      theme: this.state.theme,
      comfort: this.state.comfort,
      ambient: this.state.ambient,
      badges: this.state.badges,
    };
    this.host.persistPrefs(p);
  }

  // -------------------------------------------------------------------------
  // Chrome (the toolbar + reader shell) — ported from buildChrome/bindChrome
  // -------------------------------------------------------------------------

  private buildChrome(): void {
    const app = this.$('app') ?? (() => {
      const el = document.createElement('div');
      el.id = 'app';
      this.root.appendChild(el);
      return el;
    })();
    const L = this.L;
    app.innerHTML = `
      <header id="bar"><div class="bar-row">
        <div class="controls">
          <button class="btn" data-act="prev" title="${esc(L.prev)} (←)" aria-label="${esc(L.prev)}">${I.prev}</button>
          <button class="btn play" data-act="toggle" aria-pressed="false" aria-label="${esc(L.play)}" title="${esc(L.play)} (Space)">${I.play}</button>
          <button class="btn" data-act="next" title="${esc(L.next)} (→)" aria-label="${esc(L.next)}">${I.next}</button>
        </div>
        <div class="title-block">
          <div class="doc-title" id="doctitle">${esc(L.title)}</div>
          <div class="meta"><span id="pos"></span><span class="dot"></span><span id="eta"></span><span class="dot"></span><span class="chip" id="curlang">EN</span></div>
        </div>
        <button id="speed-btn" aria-haspopup="true" aria-expanded="false" title="${esc(L.speed)}" aria-label="${esc(L.speed)}">1.0×</button>
        <div class="vol"><button class="ico-btn" id="mute" title="${esc(L.mute)}" aria-label="${esc(L.mute)}">${SPK}</button><input type="range" id="volume" min="0" max="1" step="0.05" value="1" aria-label="${esc(L.volume)}"></div>
        <button class="btn" data-act="edit" title="${esc(L.edit)}" aria-label="${esc(L.edit)}">${I.edit}</button>
        <button class="btn" data-act="gear" title="${esc(L.settings)}" aria-haspopup="true" aria-label="${esc(L.settings)}" aria-expanded="false">${I.gear}</button>
        <div class="progress" id="progress" role="slider" tabindex="0" aria-label="${esc(L.progress)}" aria-valuemin="1" aria-valuemax="1" aria-valuenow="1"><i id="prog"></i></div>
      </div></header>
      <div id="reader-wrap">
        <article id="reader" data-font="serif" data-comfort="cozy">
          <div id="empty-note">${esc(L.nothingToRead)}</div>
          <div id="doc"></div>
        </article>
      </div>
      <div id="vignette" aria-hidden="true"></div>

      <div class="pop" id="pop" role="dialog" aria-label="${esc(L.settings)}">
        <div class="grp"><span class="lbl">${esc(L.voice)}</span>
          <div class="seg-ctl" id="gender" style="width:max-content">
            <button data-g="female" aria-pressed="true">${esc(L.female)}</button><button data-g="male" aria-pressed="false">${esc(L.male)}</button></div>
          <label class="toggle"><input type="checkbox" id="autolang" checked> ${esc(L.autoLangLabel)}</label>
          <select id="lang" aria-label="${esc(L.language)}"></select>
          <select id="voice" aria-label="${esc(L.voice)}"></select>
        </div>
        <div class="grp"><span class="lbl">${esc(L.playback)}</span>
          <span class="lbl" style="text-transform:none;letter-spacing:0">${esc(L.sleepTimer)}</span>
          <div class="seg-row" id="sleep">
            <button data-sleep="off" class="sel-on">${esc(L.off)}</button><button data-sleep="section" title="${esc(L.untilSectionEnd)}">§</button><button data-sleep="15">15m</button><button data-sleep="30">30m</button><button data-sleep="60">60m</button></div>
        </div>
        <div class="grp"><span class="lbl">${esc(L.readingFont)}</span><div class="font-list" id="font-list"></div></div>
        <div class="grp"><span class="lbl">${esc(L.theme)}</span><div class="seg-ctl pop-theme" id="theme-pop" role="group" aria-label="${esc(L.theme)}">
          <button data-theme-set="auto" title="${esc(L.themeAuto)}" aria-label="${esc(L.themeAuto)}">${I.auto}</button><button data-theme-set="study" title="${esc(L.themeStudy)}" aria-label="${esc(L.themeStudy)}">${I.moon}</button><button data-theme-set="daylight" title="${esc(L.themeDaylight)}" aria-label="${esc(L.themeDaylight)}">${I.sun}</button><button data-theme-set="paper" title="${esc(L.themePaper)}" aria-label="${esc(L.themePaper)}">${I.paper}</button></div></div>
        <div class="grp"><span class="lbl">${esc(L.comfort)}</span><div class="seg-row" id="comfort">
          <button data-comfort="compact">${esc(L.compact)}</button><button data-comfort="cozy">${esc(L.cozy)}</button><button data-comfort="wide">${esc(L.wide)}</button></div></div>
        <div class="grp"><span class="lbl">${esc(L.reading)}</span>
          <label class="toggle"><input type="checkbox" id="ambient-t"> ${esc(L.ambient)}</label>
          <label class="toggle"><input type="checkbox" id="badges"> ${esc(L.badges)}</label>
          <div class="mini-row"><button class="btn" id="collapse-all" title="${esc(L.collapseAll)}" aria-label="${esc(L.collapseAll)}">−</button><button class="btn" id="expand-all" title="${esc(L.expandAll)}" aria-label="${esc(L.expandAll)}">+</button></div>
          <span class="hint">${esc(L.openInEditor)}</span>
        </div>
      </div>

      <div class="pop mini" id="spop" role="dialog" aria-label="${esc(L.speed)}">
        <div class="slider-row"><input type="range" id="rate" min="0.5" max="2.5" step="0.05" value="1" aria-label="${esc(L.speed)}"><span class="val" id="ratev">1.0×</span></div>
        <div class="preset-row" id="speed-presets">${SPEED_PRESETS.map((p) => `<button data-rate="${p}">${fmtRate(p)}</button>`).join('')}</div>
      </div>

      <div class="pill-float" id="follow-pill"><button class="primary" id="follow-btn">${I.down} ${esc(L.backToReading)}</button></div>
      <div class="pill-float" id="resume-pill"><span class="pill-label">${esc(L.resumed)}</span><span class="pill-sep"></span><button class="primary" id="startover-btn">${esc(L.startOver)}</button></div>
      <div id="ptip" aria-hidden="true"></div>`;
    this.bindChrome();
  }

  private readableSelector(): string {
    let s = 'p, li, h1, h2, h3, h4, h5, h6, blockquote';
    if (this.state.settings.tables === 'read') s += ', td, th';
    return s;
  }

  private buildSegments(docRoot: HTMLElement): void {
    this.SEG_SEQ = 0;
    this.SEGMENTS = [];
    const sel = this.readableSelector() + ', pre';
    docRoot.querySelectorAll(sel).forEach((block) => {
      if (block.tagName === 'PRE') { this.handlePre(block as HTMLPreElement); return; }
      if (block.closest('pre')) return;
      this.wrapBlock(block as HTMLElement);
    });
    this.root.classList.toggle('no-segments', this.SEGMENTS.length === 0);
    this.wordsPrefix = new Array(this.SEGMENTS.length + 1).fill(0);
    for (let i = 0; i < this.SEGMENTS.length; i++) {
      this.wordsPrefix[i + 1] = this.wordsPrefix[i] + (this.SEGMENTS[i].text.match(/\S+/g) || []).length;
    }
    this.applyBadges();
  }

  private wrapBlock(block: HTMLElement): void {
    if (!block.textContent?.trim()) return;
    const isHeading = /^H[1-6]$/.test(block.tagName);
    const prefix = isHeading && this.state.settings.announceHeadings ? this.L.heading + '. ' : '';
    const runs: Node[][] = [];
    let run: Node[] = [];
    block.childNodes.forEach((n) => {
      if (isBlockish(n)) { if (run.length) runs.push(run); run = []; }
      else run.push(n);
    });
    if (run.length) runs.push(run);
    let first = true;
    for (const r of runs) {
      const did = this.segmentRun(block, r, first ? prefix : '');
      if (did) first = false;
    }
  }

  private segmentRun(block: HTMLElement, nodes: Node[], ttsPrefix: string): boolean {
    const text = nodes.map((n) => (n.textContent || '')).join('');
    if (!text.trim()) return false;
    const tnodes: { node: Text; start: number; end: number }[] = [];
    let off = 0;
    for (const n of nodes) {
      if (n.nodeType === 3) {
        const t = n as Text;
        tnodes.push({ node: t, start: off, end: off + (t.nodeValue?.length || 0) });
        off += t.nodeValue?.length || 0;
      } else if (n.nodeType === 1) {
        const w = document.createTreeWalker(n, NodeFilter.SHOW_TEXT);
        let tnode: Node | null;
        while ((tnode = w.nextNode())) {
          const t = tnode as Text;
          tnodes.push({ node: t, start: off, end: off + (t.nodeValue?.length || 0) });
          off += t.nodeValue?.length || 0;
        }
      }
    }
    if (!tnodes.length) return false;
    const last = tnodes[tnodes.length - 1];
    const locateStart = (i: number): [Text, number] => {
      for (const t of tnodes) if (i < t.end) return [t.node, Math.max(0, i - t.start)];
      return [last.node, last.node.nodeValue?.length || 0];
    };
    const locateEnd = (i: number): [Text, number] => {
      for (const t of tnodes) if (i <= t.end) return [t.node, Math.max(0, i - t.start)];
      return [last.node, last.node.nodeValue?.length || 0];
    };
    const base = detectLang(text);
    const segs = sentencesOf(text, base);
    const spans: HTMLElement[] = [];
    let pushed = false;
    for (const s of segs) {
      const range = document.createRange();
      const [sn, so] = locateStart(s.index);
      const [en, eo] = locateEnd(s.index + s.segment.length);
      range.setStart(sn, so);
      range.setEnd(en, eo);
      const span = document.createElement('span');
      span.className = 'seg';
      span.dataset.seg = String(this.SEG_SEQ);
      span.appendChild(range.cloneContents());
      const tts = s.segment.replace(/\s+/g, ' ').trim();
      // Reliable per-sentence detection, else inherit the block's language
      // (short fragments are ambiguous and would otherwise flip to English).
      const lang = detectLangCode(s.segment) || base;
      span.dataset.lang = lang;
      if (tts) {
        span.tabIndex = -1;
        this.SEGMENTS.push({
          id: this.SEG_SEQ,
          el: span,
          text: (!pushed && ttsPrefix ? ttsPrefix : '') + tts,
          lang,
        });
        pushed = true;
      }
      this.SEG_SEQ++;
      spans.push(span);
    }
    const parent = nodes[0].parentNode as HTMLElement;
    const anchor = nodes[0];
    for (const sp of spans) parent.insertBefore(sp, anchor);
    for (const n of nodes) n.parentNode?.removeChild(n);
    return pushed;
  }

  private handlePre(pre: HTMLPreElement): void {
    const mode = this.state.settings.codeBlocks;
    if (mode === 'skip') return;
    if (mode === 'announce') {
      const prev = this.SEGMENTS.length ? this.SEGMENTS[this.SEGMENTS.length - 1].lang : 'en';
      this.SEGMENTS.push({ id: this.SEG_SEQ++, el: pre, text: this.L.codeBlock, lang: prev });
      return;
    }
    // 'read': chunk the code into line groups so synthesis stays manageable
    const lines = (pre.textContent || '').split('\n');
    let buf = '';
    const flush = () => {
      const t = buf.replace(/\s+/g, ' ').trim();
      if (t) this.SEGMENTS.push({ id: this.SEG_SEQ++, el: pre, text: t, lang: 'en' });
      buf = '';
    };
    for (const ln of lines) {
      buf += ln + '\n';
      if (buf.length > 240) flush();
    }
    flush();
  }

  private applyBadges(): void {
    let prev: string | null = null;
    for (const s of this.SEGMENTS) {
      if (s.el.classList.contains('seg') && s.lang !== prev) {
        const b = document.createElement('span');
        b.className = 'langbadge';
        b.textContent = LANG_LABEL[s.lang] || s.lang;
        b.setAttribute('aria-hidden', 'true');
        s.el.insertBefore(b, s.el.firstChild);
        prev = s.lang;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Headings: collapse + read-section + reading time
  // -------------------------------------------------------------------------

  private decorateHeadings(): void {
    this.root.querySelectorAll('#doc h1, #doc h2, #doc h3').forEach((h) => {
      const hh = h as HTMLHeadingElement;
      const chev = document.createElement('button');
      chev.className = 'chev';
      chev.type = 'button';
      chev.title = this.L.toggleSection;
      chev.setAttribute('aria-label', this.L.toggleSection);
      chev.setAttribute('aria-expanded', 'true');
      chev.innerHTML = '<svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5z"/></svg>';
      chev.onclick = (e) => { e.stopPropagation(); this.toggleCollapse(hh); };
      hh.insertBefore(chev, hh.firstChild);
      const mins = this.sectionMinutes(hh);
      if (mins) {
        const m = document.createElement('span');
        m.className = 'sec-meta';
        m.textContent = fmt(this.L.minShort, mins);
        hh.appendChild(m);
      }
      const rh = document.createElement('button');
      rh.className = 'read-here';
      rh.type = 'button';
      rh.innerHTML = I.playSm + '<span class="rh-txt">' + esc(this.L.readSection) + '</span>';
      rh.setAttribute('aria-label', this.L.readSection);
      rh.onclick = (e) => { e.stopPropagation(); const i = this.firstSegIndexIn(hh); if (i >= 0) this.playAt(i); };
      hh.appendChild(rh);
    });
    this.SECTIONS = [];
    let hs = [...this.root.querySelectorAll('#doc h1, #doc h2')] as HTMLHeadingElement[];
    if (hs.length < 3) hs = [...this.root.querySelectorAll('#doc h1, #doc h2, #doc h3')] as HTMLHeadingElement[];
    if (hs.length > 40) hs = hs.filter((h) => h.tagName !== 'H3');
    for (const h of hs) {
      const i = this.firstSegIndexIn(h);
      if (i > 0) this.SECTIONS.push({ idx: i, title: this.headingText(h) });
    }
    this.buildTicks();
  }

  private headingText(h: HTMLHeadingElement): string {
    const c = h.cloneNode(true) as HTMLElement;
    c.querySelectorAll('.chev, .read-here, .sec-meta, .langbadge').forEach((n) => n.remove());
    return (c.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  }

  private sectionEls(h: HTMLElement): Element[] {
    const d = +h.tagName[1];
    const els: Element[] = [];
    let n: Element | null = h.nextElementSibling;
    while (n && !(/^H[1-6]$/.test(n.tagName) && +n.tagName[1] <= d)) { els.push(n); n = n.nextElementSibling; }
    return els;
  }

  private toggleCollapse(h: HTMLElement, force?: boolean): void {
    const c = force != null ? force : !(h.dataset.collapsed === '1');
    h.dataset.collapsed = c ? '1' : '0';
    this.sectionEls(h).forEach((e) => ((e as HTMLElement).style.display = c ? 'none' : ''));
    const ch = h.querySelector('.chev');
    if (ch) { ch.classList.toggle('rot', c); ch.setAttribute('aria-expanded', String(!c)); }
  }

  private ensureVisible(el: HTMLElement): void {
    if (el.offsetParent !== null) return;
    this.root.querySelectorAll<HTMLElement>('#doc h1,#doc h2,#doc h3').forEach((h) => {
      if (h.dataset.collapsed === '1' && this.sectionEls(h).some((s) => s.contains(el))) this.toggleCollapse(h, false);
    });
  }

  private firstSegIndexIn(h: HTMLElement): number {
    const els = this.sectionEls(h);
    els.unshift(h);
    for (let i = 0; i < this.SEGMENTS.length; i++) { if (els.some((e) => e.contains(this.SEGMENTS[i].el))) return i; }
    return -1;
  }

  private lastSegIndexIn(h: HTMLElement): number {
    const els = this.sectionEls(h);
    els.unshift(h);
    let last = -1;
    for (let i = 0; i < this.SEGMENTS.length; i++) { if (els.some((e) => e.contains(this.SEGMENTS[i].el))) last = i; }
    return last;
  }

  private sectionMinutes(h: HTMLElement): number {
    let w = 0;
    this.sectionEls(h).forEach((e) => { if (e.tagName !== 'PRE') w += ((e.textContent || '').match(/\S+/g) || []).length; });
    return w ? Math.max(1, Math.round(w / 200)) : 0;
  }

  // -------------------------------------------------------------------------
  // Playback (host-synthesized audio, with browser fallback)
  // -------------------------------------------------------------------------

  private setPlaying(p: boolean): void {
    if (this.state.playing === p) { this.setPlayIcon(); return; }
    this.state.playing = p;
    this.setPlayIcon();
    this.updateFollowPill();
    this.host.playState(p);
    if (!p) this.sendPosition(true);
  }

  private activate(i: number): void {
    this.SEGMENTS.forEach((s) => s.el.classList.remove('speaking'));
    const seg = this.SEGMENTS[i];
    if (!seg) return;
    this.ensureVisible(seg.el);
    if (this.state.settings.highlight) {
      seg.el.classList.add('speaking');
      if (this.state.following) this.scrollToSeg(seg);
    }
    if (this.rovingEl) this.rovingEl.tabIndex = -1;
    if (seg.el.classList.contains('seg')) { seg.el.tabIndex = 0; this.rovingEl = seg.el; }
    this.updateLangChip(i);
    this.updateProgress();
    const sr = this.$('sr');
    if (sr) { sr.lang = this.localeById.get(i) || seg.lang; sr.textContent = seg.text; }
    this.sendPosition(false);
  }

  private updateLangChip(i: number): void {
    const cl = this.$('curlang');
    if (!cl) return;
    const loc = this.localeById.get(i);
    const lang = loc ? loc.split('-')[0] : (this.state.engine === 'browser' && this.SEGMENTS[i] ? this.SEGMENTS[i].lang : null);
    if (lang) cl.textContent = LANG_LABEL[lang] || lang.toUpperCase();
  }

  private scrollToSeg(seg: Segment): void {
    seg.el.scrollIntoView({ behavior: this.RM.matches ? 'auto' : 'smooth', block: 'center' });
  }

  private stopAudioEl(): void {
    this.audio.pause();
    this.audio.removeAttribute('src');
  }

  private playAt(i: number): void {
    if (!this.SEGMENTS.length) return;
    if (i < 0) i = 0;
    if (i >= this.SEGMENTS.length) { this.finishAll(); return; }
    this.state.idx = i;
    this.state.ended = false;
    this.state.following = true;
    this.setPlaying(true);
    this.activate(i);
    this.updateFollowPill();
    if (this.state.engine === 'browser') { this.speak(i); return; }
    const url = this.urlCache.get(i);
    if (url) { this.waitingFor = -1; this.startAudio(url); }
    else { this.stopAudioEl(); this.waitingFor = i; this.requestSynth(i); }
    for (let k = 1; k <= PREFETCH; k++) this.requestSynth(i + k);
  }

  private startAudio(url: string): void {
    this.audio.src = url;
    this.audio.playbackRate = this.state.rate;
    this.audio.volume = (this.state.muted ? 0 : this.state.volume) * this.fadeMul;
    try { this.audio.currentTime = 0; } catch { /* ignore */ }
    const p = this.audio.play();
    if (p && p.catch) p.catch(() => this.setPlaying(false));
  }

  private requestSynth(i: number): void {
    if (i < 0 || i >= this.SEGMENTS.length) return;
    if (this.urlCache.has(i) || this.requested.has(i)) return;
    this.requested.add(i);
    this.provider.synth(i, this.SEGMENTS[i].text, this.loadGen);
  }

  /** Controller → player: audio for sentence `id` arrived (generation `gen`). */
  onAudio(id: number, gen: number, locale: string, mime: string, bytes: ArrayBuffer): void {
    if (gen !== this.loadGen) return;
    this.requested.delete(id);
    if (locale) this.localeById.set(id, locale);
    const blob = new Blob([bytes], { type: mime || 'audio/mpeg' });
    const url = URL.createObjectURL(blob);
    const old = this.urlCache.get(id);
    if (old) URL.revokeObjectURL(old);
    this.urlCache.set(id, url);
    if (this.state.idx === id) this.updateLangChip(id);
    if (this.state.playing && this.state.idx === id && this.waitingFor === id) {
      this.waitingFor = -1;
      this.startAudio(url);
    }
  }

  onAudioError(id: number, gen: number): void {
    if (gen !== this.loadGen) return;
    this.requested.delete(id);
    if (this.state.playing && this.state.idx === id) this.advance();
  }

  /** Controller → player: Edge unreachable; switch to the system engine. */
  onEngineFallback(): void {
    this.switchToBrowser();
  }

  private doPlay(): void {
    if (!this.SEGMENTS.length) return;
    if (this.state.ended) { this.state.ended = false; this.playAt(0); return; }
    this.setPlaying(true);
    if (this.state.engine === 'edge') {
      if (this.audio.src && !this.audio.ended && this.audio.currentTime > 0) this.audio.play().catch(() => this.setPlaying(false));
      else this.playAt(this.state.idx);
    } else {
      if (speechSynthesis.paused && speechSynthesis.speaking) speechSynthesis.resume();
      else this.speak(this.state.idx);
    }
  }

  private doPause(): void {
    this.setPlaying(false);
    if (this.state.engine === 'edge') this.audio.pause();
    else speechSynthesis.pause();
  }

  private togglePlay(): void {
    this.state.playing ? this.doPause() : this.doPlay();
  }

  private doStop(): void {
    this.setPlaying(false);
    if (this.state.engine === 'edge') this.stopAudioEl();
    else speechSynthesis.cancel();
    this.state.idx = 0;
    this.state.ended = false;
    this.waitingFor = -1;
    this.SEGMENTS.forEach((s) => s.el.classList.remove('speaking'));
    this.disarmSleep();
    this.updateProgress();
  }

  private finishAll(): void {
    this.setPlaying(false);
    this.state.idx = 0;
    this.state.ended = true;
    this.SEGMENTS.forEach((s) => s.el.classList.remove('speaking'));
    this.disarmSleep();
    const pr = this.$('prog');
    if (pr) pr.style.width = '100%';
  }

  private advance(): void {
    const n = this.state.idx + 1;
    if (this.state.sleep && this.state.sleep.mode === 'section' && this.state.sleep.boundary != null && n > this.state.sleep.boundary) {
      this.disarmSleep();
      this.doPause();
      this.stopAudioEl();
      this.state.idx = Math.min(n, this.SEGMENTS.length - 1);
      this.updateProgress();
      return;
    }
    this.playAt(n);
  }

  // browser engine fallback
  private initSynthVoices(): void {
    const load = () => {
      const vs = speechSynthesis.getVoices();
      const base = this.SEGMENTS[this.state.idx] ? this.SEGMENTS[this.state.idx].lang : 'en';
      this.synthVoice = vs.find((v) => v.lang.toLowerCase().startsWith(base)) || vs.find((v) => v.default) || vs[0] || null;
    };
    speechSynthesis.onvoiceschanged = load;
    load();
  }

  private speak(i: number): void {
    if (i >= this.SEGMENTS.length) { this.finishAll(); return; }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(this.SEGMENTS[i].text);
    u.rate = Math.min(2.5, Math.max(0.5, this.state.rate));
    u.volume = this.state.muted ? 0 : this.state.volume;
    const vs = speechSynthesis.getVoices();
    const base = this.SEGMENTS[i].lang;
    const v = vs.find((x) => x.lang.toLowerCase().startsWith(base)) || this.synthVoice;
    if (v) { u.voice = v; u.lang = v.lang; }
    u.onend = () => { if (this.state.playing && this.state.idx === i) this.advance(); };
    this.activate(i);
    speechSynthesis.speak(u);
  }

  private restartUtterance(): void {
    if (this.state.engine === 'browser' && this.state.playing && speechSynthesis.speaking) {
      speechSynthesis.cancel();
      this.speak(this.state.idx);
    }
  }

  private clearAudioCache(): void {
    for (const u of this.urlCache.values()) URL.revokeObjectURL(u);
    this.urlCache.clear();
    this.localeById.clear();
    this.requested.clear();
    this.waitingFor = -1;
  }

  private switchToBrowser(): void {
    this.state.engine = 'browser';
    this.audio.pause();
    this.initSynthVoices();
    if (this.state.playing) this.speak(this.state.idx);
  }

  // -------------------------------------------------------------------------
  // follow / detach (teleprompter)
  // -------------------------------------------------------------------------

  private detachFollow(): void {
    if (!this.state.following) return;
    this.state.following = false;
    this.updateFollowPill();
  }

  private attachFollow(): void {
    this.state.following = true;
    this.updateFollowPill();
    const seg = this.SEGMENTS[this.state.idx];
    if (seg && this.state.playing) this.scrollToSeg(seg);
  }

  private updateFollowPill(): void {
    const p = this.$('follow-pill');
    if (!p) return;
    const show = !this.state.following && this.state.playing && this.state.settings.highlight;
    p.classList.toggle('show', show);
    if (show) this.hideResumePill();
  }

  private onScroll = (): void => {
    const wrap = this.$('reader-wrap') as HTMLElement | null;
    const bar = this.$('bar');
    if (wrap && bar) bar.classList.toggle('scrolled', wrap.scrollTop > 4);
    if (this.state.following || !this.state.playing) return;
    if (this.scrollRaf) return;
    this.scrollRaf = requestAnimationFrame(() => {
      this.scrollRaf = 0;
      const seg = this.SEGMENTS[this.state.idx];
      if (!seg) return;
      const wrap2 = this.$('reader-wrap') as HTMLElement | null;
      if (!wrap2) return;
      const r = seg.el.getBoundingClientRect();
      const w = wrap2.getBoundingClientRect();
      const cy = (r.top + r.bottom) / 2;
      if (cy > w.top + w.height * 0.32 && cy < w.top + w.height * 0.68) this.attachFollow();
    });
  };

  // -------------------------------------------------------------------------
  // resume pill
  // -------------------------------------------------------------------------

  private showResumePill(): void {
    const p = this.$('resume-pill');
    if (!p) return;
    p.classList.add('show');
    clearTimeout(this.resumeTimer);
    this.resumeTimer = setTimeout(() => this.hideResumePill(), 12000) as unknown as number;
  }

  private hideResumePill(): void {
    const p = this.$('resume-pill');
    if (p && p.classList.contains('show')) p.classList.remove('show');
    clearTimeout(this.resumeTimer);
  }

  // -------------------------------------------------------------------------
  // sleep timer
  // -------------------------------------------------------------------------

  private disarmSleep(): void {
    if (this.state.sleep?.id) clearTimeout(this.state.sleep.id);
    this.state.sleep = null;
    this.updateSleepUI('off');
  }

  private armSleep(key: string): void {
    this.disarmSleep();
    if (key === 'off') return;
    if (key === 'section') {
      const seg = this.SEGMENTS[this.state.idx];
      let boundary = this.SEGMENTS.length - 1;
      if (seg) {
        const hs = [...this.root.querySelectorAll('#doc h1, #doc h2, #doc h3')] as HTMLElement[];
        for (const h of hs) {
          const els = this.sectionEls(h);
          els.unshift(h);
          if (els.some((e) => e.contains(seg.el))) boundary = this.lastSegIndexIn(h);
        }
      }
      this.state.sleep = { mode: 'section', boundary };
    } else {
      const mins = parseInt(key, 10);
      const id = setTimeout(() => this.fadeOutAndPause(), mins * 60000) as unknown as number;
      this.state.sleep = { mode: 'timer', id };
    }
    this.updateSleepUI(key);
  }

  private fadeOutAndPause(): void {
    const steps = 16;
    let n = 0;
    const iv = setInterval(() => {
      n++;
      this.fadeMul = Math.max(0, 1 - n / steps);
      this.audio.volume = (this.state.muted ? 0 : this.state.volume) * this.fadeMul;
      if (n >= steps) {
        clearInterval(iv);
        this.doPause();
        this.fadeMul = 1;
        this.audio.volume = this.state.muted ? 0 : this.state.volume;
        this.disarmSleep();
      }
    }, 250) as unknown as number;
  }

  private updateSleepUI(key: string): void {
    this.root.querySelectorAll('#sleep button').forEach((b) => b.classList.toggle('sel-on', (b as HTMLElement).dataset.sleep === key));
  }

  // -------------------------------------------------------------------------
  // progress / position / icons
  // -------------------------------------------------------------------------

  private buildTicks(): void {
    const bar = this.$('progress');
    if (!bar) return;
    bar.querySelectorAll('.tick').forEach((t) => t.remove());
    if (this.SEGMENTS.length < 2) return;
    for (const s of this.SECTIONS) {
      const t = document.createElement('span');
      t.className = 'tick';
      t.style.left = (s.idx / (this.SEGMENTS.length - 1)) * 100 + '%';
      bar.appendChild(t);
    }
  }

  private updateProgress(): void {
    const n = this.SEGMENTS.length;
    const pct = n > 1 ? (this.state.idx / (n - 1)) * 100 : 0;
    const pr = this.$('prog');
    if (pr) pr.style.width = (n ? pct : 0) + '%';
    const ps = this.$('pos');
    if (ps) ps.textContent = n ? this.state.idx + 1 + ' / ' + n : '';
    const bar = this.$('progress');
    if (bar) {
      bar.setAttribute('aria-valuemax', String(Math.max(1, n)));
      bar.setAttribute('aria-valuenow', String(Math.min(n, this.state.idx + 1)));
      bar.setAttribute('aria-valuetext', fmt(this.L.sentenceOf, this.state.idx + 1, n));
    }
    this.updateEta();
  }

  private updateEta(): void {
    const e = this.$('eta');
    if (!e) return;
    if (!this.SEGMENTS.length) { e.textContent = ''; return; }
    const remaining = this.wordsPrefix[this.SEGMENTS.length] - this.wordsPrefix[this.state.idx];
    const mins = Math.max(1, Math.round(remaining / (200 * this.state.rate)));
    e.textContent = fmt(this.L.minShort, mins);
  }

  private sendPosition(immediate: boolean): void {
    if (!this.SEGMENTS.length) return;
    const fire = () => {
      this.posTimer = 0;
      if (this.state.idx === this.lastSentIdx) return;
      this.lastSentIdx = this.state.idx;
      const seg = this.SEGMENTS[this.state.idx];
      this.host.position(this.state.docKey, this.state.idx, this.SEGMENTS.length, seg ? seg.text.slice(0, 80) : '');
    };
    if (immediate) { clearTimeout(this.posTimer); fire(); }
    else if (!this.posTimer) this.posTimer = setTimeout(fire, 1500) as unknown as number;
  }

  private setPlayIcon(): void {
    const b = this.root.querySelector('.btn.play');
    if (!b) return;
    b.innerHTML = this.state.playing ? I.pause : I.play;
    b.setAttribute('aria-pressed', String(this.state.playing));
    b.setAttribute('aria-label', this.state.playing ? this.L.pause : this.L.play);
    b.setAttribute('title', (this.state.playing ? this.L.pause : this.L.play) + ' (Space)');
  }

  // -------------------------------------------------------------------------
  // theme / font / comfort / ambient
  // -------------------------------------------------------------------------

  private applyTheme(): void {
    if (this.state.theme === 'auto') this.root.removeAttribute('data-theme');
    else this.root.dataset.theme = this.state.theme;
    this.root.querySelectorAll('[data-theme-set]').forEach((b) => b.setAttribute('aria-pressed', String((b as HTMLElement).dataset.themeSet === this.state.theme)));
  }

  private setTheme(t: string): void {
    this.state.theme = t;
    this.applyTheme();
    this.persistPrefs();
  }

  private applyFont(): void {
    const reader = this.$('reader');
    if (reader) reader.dataset.font = this.state.font;
    this.root.querySelectorAll('.font-opt').forEach((o) => o.classList.toggle('sel', (o as HTMLElement).dataset.font === this.state.font));
  }

  private setFont(key: string): void {
    this.state.font = key;
    this.applyFont();
    this.persistPrefs();
  }

  private cycleFont(): void {
    const i = FONTS.findIndex((f) => f.key === this.state.font);
    this.setFont(FONTS[(i + 1) % FONTS.length].key);
  }

  private applyComfort(): void {
    const reader = this.$('reader');
    if (reader) reader.dataset.comfort = this.state.comfort;
    this.root.querySelectorAll('#comfort button').forEach((b) => b.classList.toggle('sel-on', (b as HTMLElement).dataset.comfort === this.state.comfort));
  }

  private setComfort(c: string): void {
    this.state.comfort = c;
    this.applyComfort();
    this.persistPrefs();
  }

  private applyAmbient(): void {
    this.root.classList.toggle('ambient', this.state.ambient);
    this.root.classList.toggle('focusing', this.state.ambient);
    const t = this.$('ambient-t') as HTMLInputElement | null;
    if (t) t.checked = this.state.ambient;
  }

  private applyBadgesPref(): void {
    this.root.classList.toggle('hide-badges', !this.state.badges);
    const t = this.$('badges') as HTMLInputElement | null;
    if (t) t.checked = this.state.badges;
  }

  // -------------------------------------------------------------------------
  // voice / language pickers
  // -------------------------------------------------------------------------

  private buildFontList(): void {
    const wrap = this.$('font-list');
    if (!wrap) return;
    wrap.innerHTML = FONTS.map((f) => `<button type="button" class="font-opt" data-font="${f.key}"><span class="pv" style="font-family:var(--f-${f.key})">Ag</span><span><span class="nm">${esc(f.name)}</span><br><span class="sub">${esc(f.sub)}</span></span></button>`).join('');
    wrap.querySelectorAll('.font-opt').forEach((o) => (o as HTMLElement).onclick = () => this.setFont((o as HTMLElement).dataset.font || ''));
  }

  private renderPickers(): void {
    if (!this.vu) return;
    this.root.querySelectorAll('#gender button').forEach((b) => {
      const g = (b as HTMLElement).dataset.g || '';
      const on = g === this.vu!.gender;
      b.classList.toggle('sel-on', on);
      b.setAttribute('aria-pressed', String(on));
      const has = this.vu!.voicePair && this.vu!.voicePair[g as 'female' | 'male'];
      (b as HTMLButtonElement).disabled = !has;
    });
    const al = this.$('autolang') as HTMLInputElement | null;
    if (al) al.checked = !!this.vu.autoLang;
    const lang = this.$('lang') as HTMLSelectElement | null;
    if (lang) {
      lang.innerHTML = (this.vu.locales || []).map((l) => `<option value="${esc(l.locale)}" ${l.locale === this.vu!.locale ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
      lang.disabled = !!this.vu.autoLang;
    }
    const voice = this.$('voice') as HTMLSelectElement | null;
    if (voice) {
      const groups: Record<'female' | 'male', VoiceOption[]> = { female: [], male: [] };
      for (const v of this.vu.allVoices || []) {
        const key = (v.gender === 'male' ? 'male' : 'female') as 'female' | 'male';
        groups[key].push(v);
      }
      let html = '';
      for (const g of ['female', 'male'] as const) {
        if (!groups[g].length) continue;
        html += `<optgroup label="${g === 'female' ? esc(this.L.female) : esc(this.L.male)}">`;
        for (const v of groups[g]) html += `<option value="${esc(v.shortName)}">${esc(v.name)}${v.multilingual ? ' · ' + esc(this.L.multilingual) : ''}</option>`;
        html += '</optgroup>';
      }
      voice.innerHTML = html;
      voice.value = this.vu.currentVoice || '';
      voice.disabled = !!this.vu.autoLang;
    }
  }

  // -------------------------------------------------------------------------
  // volume / speed
  // -------------------------------------------------------------------------

  private updateMuteUI(): void {
    const b = this.$('mute');
    const m = this.state.muted || this.state.volume === 0;
    if (b) {
      b.classList.toggle('muted', m);
      b.innerHTML = m ? SPK_MUTE : SPK;
      b.setAttribute('aria-label', m ? this.L.unmute : this.L.mute);
      b.setAttribute('title', m ? this.L.unmute : this.L.mute);
    }
    const v = this.$('volume');
    if (v) {
      const pct = Math.round((m ? 0 : this.state.volume) * 100) + '%';
      v.setAttribute('aria-valuetext', pct);
      v.setAttribute('title', this.L.volume + ' ' + pct);
    }
  }

  private applyVolume(): void {
    this.audio.volume = this.state.muted ? 0 : this.state.volume;
    const v = this.$('volume') as HTMLInputElement | null;
    if (v) v.value = String(this.state.volume);
    this.updateMuteUI();
  }

  private applyRate(): void {
    this.audio.playbackRate = this.state.rate;
    const r = this.$('rate') as HTMLInputElement | null;
    if (r) { r.value = String(this.state.rate); r.setAttribute('aria-valuetext', fmtRate(this.state.rate)); }
    const rv = this.$('ratev');
    if (rv) rv.textContent = fmtRate(this.state.rate);
    const sb = this.$('speed-btn');
    if (sb) { sb.textContent = fmtRate(this.state.rate); sb.classList.toggle('on', Math.abs(this.state.rate - 1) > 0.001); }
    this.root.querySelectorAll('#speed-presets button').forEach((b) => b.classList.toggle('sel-on', Math.abs(parseFloat((b as HTMLElement).dataset.rate || '0') - this.state.rate) < 0.001));
    this.updateEta();
  }

  private setRate(r: number, persist: boolean): void {
    this.state.rate = Math.min(2.5, Math.max(0.5, Math.round(r * 100) / 100));
    this.applyRate();
    if (persist) {
      clearTimeout(this.speedPersist);
      this.speedPersist = setTimeout(() => { this.restartUtterance(); this.host.persistSpeed(this.state.rate); }, 400) as unknown as number;
    } else this.restartUtterance();
  }

  // -------------------------------------------------------------------------
  // popovers (anchored)
  // -------------------------------------------------------------------------

  private positionPop(pop: HTMLElement, btn: HTMLElement): void {
    const r = btn.getBoundingClientRect();
    const win = this.root.ownerDocument.defaultView!;
    pop.style.top = Math.round(r.bottom + 8) + 'px';
    pop.style.right = Math.max(8, Math.round(win.innerWidth - r.right)) + 'px';
    pop.style.maxHeight = Math.max(120, win.innerHeight - r.bottom - 20) + 'px';
  }

  private openPop(pop: HTMLElement, btn: HTMLElement): void {
    this.closePops();
    pop.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
    this.positionPop(pop, btn);
    this.openPopInfo = { pop, btn };
    const f = pop.querySelector<HTMLElement>('button:not([disabled]), input, select');
    if (f) f.focus({ preventScroll: true });
  }

  private closePops(refocus?: boolean): void {
    if (!this.openPopInfo) return;
    this.openPopInfo.pop.classList.remove('open');
    this.openPopInfo.btn.setAttribute('aria-expanded', 'false');
    if (refocus) this.openPopInfo.btn.focus({ preventScroll: true });
    this.openPopInfo = null;
  }

  private togglePop(pop: HTMLElement, btn: HTMLElement): void {
    if (this.openPopInfo && this.openPopInfo.pop === pop) this.closePops();
    else this.openPop(pop, btn);
  }

  // -------------------------------------------------------------------------
  // seek (progress strip)
  // -------------------------------------------------------------------------

  private segAtX(clientX: number): number {
    const bar = this.$('progress') as HTMLElement | null;
    if (!bar) return 0;
    const r = bar.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return Math.round(ratio * (this.SEGMENTS.length - 1));
  }

  private seekTo(i: number): void {
    if (!this.SEGMENTS.length) return;
    i = Math.min(this.SEGMENTS.length - 1, Math.max(0, i));
    this.state.following = true;
    this.hideResumePill();
    if (this.state.playing) this.playAt(i);
    else { this.stopAudioEl(); this.waitingFor = -1; this.state.idx = i; this.state.ended = false; this.activate(i); }
  }

  private sectionTitleFor(i: number): string {
    let t = '';
    for (const s of this.SECTIONS) { if (s.idx <= i) t = s.title; else break; }
    return t;
  }

  private bindProgress(): void {
    const bar = this.$('progress') as HTMLElement | null;
    const tip = this.$('ptip');
    if (!bar || !tip) return;
    let scrubbing = false;
    const showTip = (x: number) => {
      if (!this.SEGMENTS.length) return;
      const i = this.segAtX(x);
      const sec = this.sectionTitleFor(i);
      tip.textContent = (sec ? sec + ' · ' : '') + fmt(this.L.sentenceOf, i + 1, this.SEGMENTS.length);
      const r = bar.getBoundingClientRect();
      const win = this.root.ownerDocument.defaultView!;
      tip.style.left = Math.min(win.innerWidth - 20, Math.max(20, x)) + 'px';
      tip.style.top = r.top + 'px';
      tip.classList.add('show');
    };
    bar.addEventListener('pointermove', (e) => { if (!scrubbing) showTip(e.clientX); });
    bar.addEventListener('pointerleave', () => { if (!scrubbing) tip.classList.remove('show'); });
    bar.addEventListener('pointerdown', (e) => {
      if (!this.SEGMENTS.length) return;
      scrubbing = true;
      bar.classList.add('scrubbing');
      bar.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        const i = this.segAtX(ev.clientX);
        const pr = this.$('prog');
        if (pr) pr.style.width = (this.SEGMENTS.length > 1 ? (i / (this.SEGMENTS.length - 1)) * 100 : 0) + '%';
        showTip(ev.clientX);
      };
      move(e as unknown as PointerEvent);
      const finish = () => {
        bar.removeEventListener('pointermove', move);
        bar.removeEventListener('pointerup', up);
        bar.removeEventListener('pointercancel', cancel);
        scrubbing = false;
        bar.classList.remove('scrubbing');
        tip.classList.remove('show');
      };
      const up = (ev: PointerEvent) => { finish(); this.seekTo(this.segAtX(ev.clientX)); };
      const cancel = () => { finish(); this.updateProgress(); };
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', up);
      bar.addEventListener('pointercancel', cancel);
    });
    bar.addEventListener('keydown', (e) => {
      if (!this.SEGMENTS.length) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); this.seekTo(this.state.idx - 1); }
      else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); this.seekTo(this.state.idx + 1); }
      else if (e.key === 'Home') { e.preventDefault(); this.seekTo(0); }
      else if (e.key === 'End') { e.preventDefault(); this.seekTo(this.SEGMENTS.length - 1); }
    });
  }

  // -------------------------------------------------------------------------
  // bindings (ported from bindChrome)
  // -------------------------------------------------------------------------

  private bindChrome(): void {
    this.root.querySelectorAll<HTMLElement>('[data-act]').forEach((el) => {
      el.onclick = () => {
        const a = el.dataset.act;
        if (a === 'toggle') this.togglePlay();
        else if (a === 'prev') this.playAt(this.state.idx - 1);
        else if (a === 'next') this.playAt(this.state.idx + 1);
        else if (a === 'gear') this.togglePop(this.$('pop')!, el);
        else if (a === 'edit') {
          const seg = this.SEGMENTS[this.state.idx];
          const lineEl = seg && seg.el.closest ? seg.el.closest('[data-line]') : null;
          this.host.editSource(lineEl ? parseInt((lineEl as HTMLElement).dataset.line || '1', 10) : 1);
        }
      };
    });
    const speedBtn = this.$('speed-btn')!;
    speedBtn.onclick = () => this.togglePop(this.$('spop')!, speedBtn);
    speedBtn.addEventListener('wheel', (e: WheelEvent) => { e.preventDefault(); this.setRate(this.state.rate + (e.deltaY < 0 ? 0.05 : -0.05), true); }, { passive: false });
    this.root.querySelectorAll<HTMLElement>('[data-theme-set]').forEach((b) => b.onclick = () => this.setTheme(b.dataset.themeSet || 'auto'));
    this.root.querySelectorAll<HTMLElement>('#comfort button').forEach((b) => b.onclick = () => this.setComfort(b.dataset.comfort || 'cozy'));
    this.root.querySelectorAll<HTMLElement>('#sleep button').forEach((b) => b.onclick = () => this.armSleep(b.dataset.sleep || 'off'));
    const gender = this.$('gender')!;
    gender.addEventListener('click', (e: MouseEvent) => {
      const b = (e.target as HTMLElement).closest('button');
      if (b && !(b as HTMLButtonElement).disabled) this.host.setGender((b.dataset.g === 'male' ? 'male' : 'female') as Gender);
    });
    (this.$('autolang') as HTMLInputElement).onchange = (e) => this.host.setAutoLang((e.target as HTMLInputElement).checked);
    (this.$('lang') as HTMLSelectElement).onchange = (e) => this.host.setLocale((e.target as HTMLSelectElement).value);
    (this.$('voice') as HTMLSelectElement).onchange = (e) => this.host.setVoice((e.target as HTMLSelectElement).value);
    (this.$('badges') as HTMLInputElement).onchange = (e) => { this.state.badges = (e.target as HTMLInputElement).checked; this.applyBadgesPref(); this.persistPrefs(); };
    (this.$('ambient-t') as HTMLInputElement).onchange = (e) => { this.state.ambient = (e.target as HTMLInputElement).checked; this.applyAmbient(); this.persistPrefs(); };
    (this.$('collapse-all')!).onclick = () => this.root.querySelectorAll<HTMLElement>('#doc h2, #doc h3').forEach((h) => this.toggleCollapse(h, true));
    (this.$('expand-all')!).onclick = () => this.root.querySelectorAll<HTMLElement>('#doc h1,#doc h2,#doc h3').forEach((h) => this.toggleCollapse(h, false));
    (this.$('follow-btn')!).onclick = () => this.attachFollow();
    (this.$('startover-btn')!).onclick = () => { this.hideResumePill(); this.playAt(0); };

    const rate = this.$('rate') as HTMLInputElement;
    rate.oninput = (e) => this.setRate(parseFloat((e.target as HTMLInputElement).value), true);
    this.root.querySelectorAll<HTMLElement>('#speed-presets button').forEach((b) => b.onclick = () => this.setRate(parseFloat(b.dataset.rate || '1'), true));

    const vol = this.$('volume') as HTMLInputElement;
    vol.oninput = (e) => {
      const v = parseFloat((e.target as HTMLInputElement).value);
      this.state.volume = v;
      if (v > 0) { this.state.lastVol = v; this.state.muted = false; }
      this.audio.volume = this.state.muted ? 0 : this.state.volume;
      this.updateMuteUI();
    };
    vol.onchange = () => { this.restartUtterance(); this.host.persistVolume(this.state.volume); };
    (this.$('mute')!).onclick = () => {
      if (this.state.muted || this.state.volume === 0) {
        this.state.muted = false;
        if (this.state.volume === 0) this.state.volume = this.state.lastVol > 0 ? this.state.lastVol : 1;
        this.host.persistVolume(this.state.volume);
      } else {
        this.state.lastVol = this.state.volume;
        this.state.muted = true;
      }
      this.applyVolume();
      this.restartUtterance();
    };

    const wrap = this.$('reader-wrap') as HTMLElement | null;
    if (wrap) {
      wrap.addEventListener('scroll', this.onScroll, { passive: true });
      wrap.addEventListener('wheel', (e: WheelEvent) => {
        if (!this.state.playing) return;
        const canScroll = (e.deltaY < 0 && wrap.scrollTop > 0) || (e.deltaY > 0 && wrap.scrollTop < wrap.scrollHeight - wrap.clientHeight - 1);
        if (canScroll) this.detachFollow();
      }, { passive: true });
      wrap.addEventListener('touchmove', () => { if (this.state.playing) this.detachFollow(); }, { passive: true });
      wrap.addEventListener('pointerdown', (e: PointerEvent) => {
        if (this.state.playing && e.target === wrap && e.offsetX >= wrap.clientWidth) this.detachFollow();
      });
    }
    this.bindProgress();

    this.root.addEventListener('keydown', (e) => this.onKeydown(e));
    this.root.addEventListener('click', (e) => {
      if (!this.openPopInfo) return;
      const target = e.target as HTMLElement;
      if (!target.isConnected) return;
      if (!target.closest('.pop') && target !== this.openPopInfo.btn && !this.openPopInfo.btn.contains(target)) this.closePops();
    });
    this.root.ownerDocument.defaultView!.addEventListener('resize', () => {
      if (this.openPopInfo) this.positionPop(this.openPopInfo.pop, this.openPopInfo.btn);
    });
  }

  private onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      if (this.openPopInfo) { e.preventDefault(); this.closePops(true); }
      else if (this.state.playing || this.audio.src) { e.preventDefault(); this.doStop(); }
      return;
    }
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (t && t.classList.contains('seg') && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      const id = this.SEGMENTS.findIndex((s) => s.el === t);
      if (id >= 0) this.playAt(id);
      return;
    }
    if (t && t.closest && t.closest('button, a, [role="button"], [role="slider"]')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === ' ') { e.preventDefault(); this.togglePlay(); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); this.playAt(this.state.idx - 1); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); this.playAt(this.state.idx + 1); }
    else if (e.key === '+' || e.key === '=') this.setRate(this.state.rate + 0.1, true);
    else if (e.key === '-') this.setRate(this.state.rate - 0.1, true);
    else if (e.key.toLowerCase() === 'm') (this.$('mute') as HTMLElement).click();
    else if (e.key.toLowerCase() === 'f') this.cycleFont();
    else if (e.key === 'PageUp' || e.key === 'PageDown' || e.key === 'Home' || e.key === 'End') { if (this.state.playing) this.detachFollow(); }
  }

  private onRootClick(e: MouseEvent): void {
    const seg = (e.target as HTMLElement).closest?.('.seg') as HTMLElement | null;
    if (!seg) return;
    if (e.altKey) {
      const lineEl = seg.closest('[data-line]') || (e.target as HTMLElement).closest?.('[data-line]');
      if (lineEl) { this.host.openSource(parseInt((lineEl as HTMLElement).dataset.line || '1', 10)); return; }
    }
    const id = this.SEGMENTS.findIndex((s) => s.el === seg);
    if (id >= 0) this.playAt(id);
  }

  // -------------------------------------------------------------------------
  // Public API (controller → player), ported from onLoad/onUpdate/onVoiceUi
  // -------------------------------------------------------------------------

  load(m: LoadPayload): void {
    this.stopAudioEl();
    try { speechSynthesis.cancel(); } catch { /* ignore */ }
    this.setPlaying(false);
    this.disarmSleep();
    this.hideResumePill();
    this.clearAudioCache();
    this.lastSentIdx = -1;
    this.loadGen++;

    this.state.engine = m.engine || 'edge';
    this.state.rate = typeof m.rate === 'number' ? m.rate : 1;
    this.state.volume = typeof m.volume === 'number' ? m.volume : 1;
    this.state.lastVol = this.state.volume || 1;
    this.state.muted = false;
    this.state.settings = {
      codeBlocks: 'announce',
      tables: 'skip',
      announceHeadings: false,
      highlight: true,
      ...m.settings,
    };
    this.root.classList.toggle('no-highlight', !this.state.settings.highlight);
    this.applyPrefs(m.prefs);
    this.vu = m.voiceUi;
    this.state.autoLang = !!m.voiceUi.autoLang;
    this.state.idx = 0;
    this.state.ended = false;
    this.state.following = true;

    const doctitle = this.$('doctitle');
    if (doctitle) {
      doctitle.textContent = m.title || this.L.title;
      doctitle.title = m.title || '';
    }
    this.state.docKey = m.docKey || '';
    const doc = this.$('doc');
    if (doc) doc.innerHTML = m.html || '';
    this.buildSegments(doc as HTMLElement);
    this.decorateHeadings();
    this.root.querySelectorAll<HTMLButtonElement>('[data-act="prev"], [data-act="toggle"], [data-act="next"]').forEach((b) => (b.disabled = !this.SEGMENTS.length));
    const speedBtn = this.$('speed-btn') as HTMLButtonElement | null;
    if (speedBtn) speedBtn.disabled = !this.SEGMENTS.length;

    this.buildFontList();
    this.applyFont();
    this.applyComfort();
    this.applyTheme();
    this.applyAmbient();
    this.applyBadgesPref();
    this.renderPickers();
    const cl = this.$('curlang');
    if (cl && m.voiceUi.locale) {
      const b = String(m.voiceUi.locale).split('-')[0];
      cl.textContent = LANG_LABEL[b] || b.toUpperCase();
    }
    this.applyRate();
    this.applyVolume();
    this.updateProgress();
    this.setPlayIcon();
    this.updateFollowPill();

    if (this.state.engine === 'browser') this.initSynthVoices();
    if (!this.SEGMENTS.length) return;

    let start = 0;
    let resumed = false;
    if (m.anchorText) {
      const a = this.anchorIndex(m.anchorText);
      if (a > 0) start = a;
    } else if (m.resume && typeof m.resume.idx === 'number' && m.resume.idx >= 3) {
      const r = this.resumeIndex(m.resume);
      if (r > 0) { start = r; resumed = true; }
    }
    if (m.autoplay === false) {
      this.state.idx = start;
      this.activate(start);
      if (resumed) this.showResumePill();
      this.requestSynth(start);
      for (let k = 1; k <= PREFETCH; k++) this.requestSynth(start + k);
    } else {
      this.playAt(start);
      if (resumed) this.showResumePill();
    }
  }

  /** Live re-render while the source is edited: swap the prose, keep the place. */
  update(html: string): void {
    const curText = this.SEGMENTS[this.state.idx] ? this.SEGMENTS[this.state.idx].text : '';
    const oldIdx = this.state.idx;
    const wrap = this.$('reader-wrap') as HTMLElement | null;
    const scrollTop = wrap ? wrap.scrollTop : 0;

    this.loadGen++;
    this.clearAudioCache();
    this.lastSentIdx = -1;
    const doc = this.$('doc');
    if (doc) doc.innerHTML = html;
    this.buildSegments(doc as HTMLElement);
    this.decorateHeadings();
    this.root.querySelectorAll<HTMLButtonElement>('[data-act="prev"], [data-act="toggle"], [data-act="next"]').forEach((b) => (b.disabled = !this.SEGMENTS.length));
    const speedBtn = this.$('speed-btn') as HTMLButtonElement | null;
    if (speedBtn) speedBtn.disabled = !this.SEGMENTS.length;

    if (!this.SEGMENTS.length) { this.doStop(); return; }
    let idx = Math.max(0, Math.min(oldIdx, this.SEGMENTS.length - 1));
    if (curText) {
      const probe = (i: number) => this.SEGMENTS[i] && this.SEGMENTS[i].text === curText;
      if (!probe(idx)) {
        for (let d = 1; d <= 60; d++) {
          if (probe(oldIdx - d)) { idx = oldIdx - d; break; }
          if (probe(oldIdx + d)) { idx = oldIdx + d; break; }
        }
      }
    }
    this.state.idx = idx;
    this.state.ended = false;
    if (this.state.sleep && this.state.sleep.mode === 'section') this.armSleep('section');
    if (this.state.playing) {
      this.activate(idx);
      if (this.state.engine === 'browser') {
        if (idx !== oldIdx) this.speak(idx);
      } else {
        if (!this.audio.src || this.audio.paused || this.audio.ended) this.waitingFor = idx;
        this.requestSynth(idx);
        for (let k = 1; k <= PREFETCH; k++) this.requestSynth(idx + k);
      }
    } else {
      const f = this.state.following;
      this.state.following = false;
      this.activate(idx);
      this.state.following = f;
      if (wrap) wrap.scrollTop = scrollTop;
    }
    this.updateProgress();
  }

  applyVoiceUi(vu: VoiceUiPayload): void {
    this.clearAudioCache();
    this.vu = vu;
    this.state.autoLang = !!vu.autoLang;
    this.renderPickers();
    if (this.state.engine === 'browser') this.initSynthVoices();
    if (this.state.playing) this.playAt(this.state.idx);
    else if (this.state.engine === 'edge') this.stopAudioEl();
    else speechSynthesis.cancel();
  }

  /** External transport control from Obsidian commands. */
  control(action: 'playpause' | 'stop'): void {
    if (action === 'playpause') this.togglePlay();
    else if (action === 'stop') this.doStop();
  }

  /** Apply a speed change from an external control (the settings tab). */
  setExternalRate(value: number): void {
    if (!Number.isFinite(value)) return;
    this.setRate(value, false);
  }

  /** Apply a volume change from an external control (the settings tab). */
  setExternalVolume(value: number): void {
    if (!Number.isFinite(value)) return;
    this.state.volume = Math.min(1, Math.max(0, value));
    if (this.state.volume > 0) { this.state.lastVol = this.state.volume; this.state.muted = false; }
    this.applyVolume();
    this.restartUtterance();
  }

  private anchorIndex(anchorText: string): number {
    const words = (anchorText.toLowerCase().match(/[\p{L}\p{N}']+/gu) || []).slice(0, 6);
    for (let take = words.length; take >= 3; take--) {
      const needle = words.slice(0, take).join(' ');
      for (let i = 0; i < this.SEGMENTS.length; i++) {
        const hay = (this.SEGMENTS[i].text.toLowerCase().match(/[\p{L}\p{N}']+/gu) || []).join(' ');
        if (hay.includes(needle)) return i;
      }
    }
    return -1;
  }

  private resumeIndex(r: { idx: number; total: number; text: string }): number {
    const probe = (i: number) => this.SEGMENTS[i] && this.SEGMENTS[i].text.slice(0, 80) === r.text;
    if (probe(r.idx)) return r.idx;
    for (let d = 1; d <= 30; d++) {
      if (probe(r.idx - d)) return r.idx - d;
      if (probe(r.idx + d)) return r.idx + d;
    }
    if (r.total && Math.abs(r.total - this.SEGMENTS.length) <= Math.max(4, r.total * 0.05) && r.idx < this.SEGMENTS.length) return r.idx;
    return -1;
  }

  /** Re-apply a status/transport update (e.g. from the status-bar mini-player). */
  setStatus(playing: boolean): void {
    this.setPlaying(playing);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopAudioEl();
    try { speechSynthesis.cancel(); } catch { /* ignore */ }
    this.clearAudioCache();
    clearTimeout(this.posTimer);
    clearTimeout(this.resumeTimer);
    clearTimeout(this.speedPersist);
    if (this.state.sleep?.id) clearTimeout(this.state.sleep.id);
    this.audio.src = '';
  }
}
