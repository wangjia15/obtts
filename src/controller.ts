import { App, MarkdownView, Notice, TFile } from 'obsidian';
import type { Gender } from './types';
import { EdgeTtsEngine, type TimerHandle } from './engine';
import { renderMarkdownHtml } from './markdown/render';
import { normalizeForSpeech, applyPronunciations } from './markdown/normalize';
import { detectLocale, detectReliableLocale } from './languageDetector';
import {
  allCuratedLocales,
  curatedPair,
  displayName,
  getVoice,
  localeDisplay,
  pickVoice,
  voicesForLocale,
} from './voices';
import {
  ReaderPlayer,
  type HostCallbacks,
  type LoadPayload,
  type ReaderPrefs,
  type ReaderSettings,
  type SynthProvider,
  type VoiceUiPayload,
} from './player';
import type TtsPlugin from './main';
import type { PluginData, StoredPosition } from './settings';
import { t } from './l10n';

const MAX_POSITIONS = 24;
const CACHE_CAP = 600;

export interface OpenOptions {
  docUri?: TFile;
  /** character offset in `source` to start reading from (read-from-cursor) */
  startOffset?: number;
  isSelection?: boolean;
  /** 1-based line in the original document where `source` starts (selection reads) */
  baseLine?: number;
}

/**
 * TtsController — the synthesis + state orchestrator (port of the reference's
 * `playerPanel.ts` host half). Owns the engine, the per-sentence audio cache,
 * the inflight-synthesis map, and the voice/language state. Implements
 * `SynthProvider` so the player's per-sentence requests route here.
 * In Obsidian the webview/host boundary collapses: instead of `postMessage`,
 * the controller calls `player.onAudio(...)` directly, and the player calls
 * back through `HostCallbacks`.
 */
export class TtsController implements SynthProvider {
  private app: App;
  private plugin: TtsPlugin;
  private engine = new EdgeTtsEngine();
  private engineId: 'edge' | 'browser' = 'edge';
  private supertonicWarned = false;

  private docLocale = 'en-US';
  private activeLocale = 'en-US';
  private currentVoice = '';
  private gender: Gender = 'female';
  private autoLang = true;

  private docUri: TFile | undefined;
  private docTitle = '';
  private baseLine = 1;
  private isSelection = false;
  private lastLoad: LoadPayload | null = null;

  private generation = 0;
  private hadSuccess = false;
  private cache = new Map<string, ArrayBuffer>();
  private inflight = new Map<string, Promise<void>>();

  player: ReaderPlayer | null = null;
  private updateTimer: TimerHandle | undefined;

  constructor(plugin: TtsPlugin) {
    this.plugin = plugin;
    this.app = plugin.app;
  }

  /** Wire the active reader view's player into the controller. */
  attachPlayer(player: ReaderPlayer): void {
    this.player = player;
  }

  detachPlayer(player: ReaderPlayer): void {
    if (this.player === player) this.player = null;
  }

  /** The engine the current/next document will use (for the reader's opts). */
  getEngineId(): 'edge' | 'browser' {
    return this.engineId;
  }

  // -------------------------------------------------------------------------
  // Settings accessors
  // -------------------------------------------------------------------------

  private get settings(): PluginData {
    return this.plugin.settings;
  }

  private overrides(): Record<string, string> {
    return this.settings.voiceOverrides;
  }

  // -------------------------------------------------------------------------
  // Open a document into the reader and start it (port of playerPanel.open)
  // -------------------------------------------------------------------------

  open(source: string, title: string, opts: OpenOptions = {}): void {
    const fallback = this.settings.fallbackLanguage;
    const autoDetect = this.settings.autoDetectLanguage;
    this.gender = this.settings.preferredGender;
    this.autoLang = this.settings.perParagraphLanguage;
    this.engineId = this.resolveEngine();
    this.docLocale = autoDetect ? detectLocale(source, fallback).locale : fallback;
    this.activeLocale = this.docLocale;
    this.currentVoice = pickVoice(this.docLocale, this.gender, this.overrides());
    this.generation++;
    this.hadSuccess = false;
    this.inflight.clear();

    this.docUri = opts.docUri;
    this.docTitle = title;
    this.baseLine = opts.baseLine ?? 1;
    this.isSelection = !!opts.isSelection;

    const docKey = opts.docUri && !opts.isSelection ? opts.docUri.path : '';
    const anchorText = typeof opts.startOffset === 'number' ? anchorFrom(source, opts.startOffset) : undefined;
    const resume = docKey && !anchorText ? this.positions()[docKey] : undefined;

    const html = renderMarkdownHtml(source);
    const payload: LoadPayload = {
      html,
      title,
      docKey,
      baseHref: '',
      engine: this.engineId,
      rate: this.settings.speed,
      volume: this.settings.volume,
      settings: {
        codeBlocks: this.settings.codeBlocks,
        tables: this.settings.tables,
        announceHeadings: this.settings.announceHeadings,
        highlight: this.settings.highlightWhileReading,
      },
      prefs: this.settings.readerPrefs,
      resume: resume ? { idx: resume.idx, total: resume.total, text: resume.text } : null,
      anchorText: anchorText ?? null,
      autoplay: true,
      voiceUi: this.voiceUiPayload(),
    };
    this.lastLoad = payload;
    this.player?.load(payload);
    this.updateStatus(false);
  }

  /** Push a live re-render of the edited source into the open reader (keeps place). */
  updateSource(html: string): void {
    if (!this.lastLoad || !this.player) return;
    this.lastLoad.html = html;
    this.player.update(html);
  }

  control(action: 'playpause' | 'stop'): void {
    this.player?.control(action);
  }

  // -------------------------------------------------------------------------
  // Synthesis (port of playerPanel.provideSynth) — implements SynthProvider
  // -------------------------------------------------------------------------

  synth(id: number, text: string, loadGen: number): void {
    void this.provideSynth(id, text, loadGen);
  }

  private async provideSynth(id: number, text: string, loadGen: number): Promise<void> {
    if (this.engineId === 'browser') return; // the player synthesizes locally
    const clean = applyPronunciations(normalizeForSpeech(text), this.settings.pronunciations);
    if (!clean) {
      this.player?.onAudioError(id, loadGen);
      return;
    }
    let locale: string;
    let voice: string;
    if (this.autoLang) {
      locale = detectReliableLocale(text) || this.docLocale;
      voice = pickVoice(locale, this.gender, this.overrides());
    } else {
      locale = this.activeLocale;
      voice = this.currentVoice;
    }
    const key = `${voice}|${locale}|${clean}`;

    const cached = this.cache.get(key);
    if (cached) {
      this.sendAudio(id, cached, loadGen, locale);
      return;
    }
    const gen = this.generation;
    const existing = this.inflight.get(key);
    if (existing) {
      existing.then(() => {
        if (gen !== this.generation) return;
        const ab = this.cache.get(key);
        if (ab) this.sendAudio(id, ab, loadGen, locale);
        else this.player?.onAudioError(id, loadGen);
      });
      return;
    }
    const task = (async () => {
      try {
        const ab = await this.engine.synth(clean, voice, locale);
        this.hadSuccess = true;
        this.cache.set(key, ab);
        if (this.cache.size > CACHE_CAP) {
          const oldest = this.cache.keys().next().value;
          if (oldest) this.cache.delete(oldest);
        }
        if (gen === this.generation) this.sendAudio(id, ab, loadGen, locale);
      } catch (err) {
        if (gen !== this.generation) return;
        if (this.engineId === 'edge' && !this.hadSuccess) {
          this.engineId = 'browser';
          new Notice(t('Read Aloud: Edge voices unreachable ({0}). Falling back to system voices (offline).').replace('{0}', errMsg(err)));
          this.player?.onEngineFallback();
        } else {
          this.player?.onAudioError(id, loadGen);
        }
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, task);
    await task;
  }

  private sendAudio(id: number, ab: ArrayBuffer, gen: number, locale: string): void {
    this.player?.onAudio(id, gen, locale, this.engine.mime, ab);
  }

  private resolveEngine(): 'edge' | 'browser' {
    const eng = this.settings.engine;
    if (eng === 'browser') return 'browser';
    if (eng === 'supertonic' && !this.supertonicWarned) {
      this.supertonicWarned = true;
      new Notice(t('Read Aloud: the offline Supertonic engine is coming in a later update — using Edge neural voices for now.'));
    }
    return 'edge';
  }

  // -------------------------------------------------------------------------
  // Voice / language state (ports playerPanel change*/set*/invalidateAndRefresh)
  // -------------------------------------------------------------------------

  invalidateAndRefresh(): void {
    this.generation++;
    if (this.player && this.lastLoad) this.player.applyVoiceUi(this.voiceUiPayload());
  }

  setAutoLang(on: boolean): void {
    this.autoLang = on;
    if (on) {
      this.activeLocale = this.docLocale;
      this.currentVoice = pickVoice(this.activeLocale, this.gender, this.overrides());
    }
    this.settings.perParagraphLanguage = on;
    void this.plugin.saveSettings();
    this.invalidateAndRefresh();
  }

  changeGender(gender: Gender): void {
    this.gender = gender;
    if (!this.autoLang) this.currentVoice = pickVoice(this.activeLocale, gender, this.overrides());
    this.settings.preferredGender = gender;
    void this.plugin.saveSettings();
    this.invalidateAndRefresh();
  }

  changeLocale(locale: string): void {
    this.autoLang = false;
    this.activeLocale = locale;
    this.currentVoice = pickVoice(locale, this.gender, this.overrides());
    this.invalidateAndRefresh();
  }

  changeVoice(shortName: string): void {
    const v = getVoice(shortName);
    this.autoLang = false;
    if (v) {
      this.gender = v.gender.toLowerCase() === 'male' ? 'male' : 'female';
      this.activeLocale = v.locale;
    }
    this.currentVoice = shortName;
    this.invalidateAndRefresh();
  }

  /** Everything the reader needs to render the voice/language controls. */
  private voiceUiPayload(): VoiceUiPayload {
    const pair = curatedPair(this.activeLocale);
    return {
      autoLang: this.autoLang,
      locale: this.activeLocale,
      localeName: localeDisplay(this.activeLocale),
      locales: allCuratedLocales(),
      voicePair: {
        female: pair.female ? { shortName: pair.female, name: displayName(pair.female) } : undefined,
        male: pair.male ? { shortName: pair.male, name: displayName(pair.male) } : undefined,
      },
      allVoices: voicesForLocale(this.activeLocale).map((v) => ({
        shortName: v.shortName,
        name: displayName(v.shortName),
        gender: v.gender.toLowerCase(),
        multilingual: v.multilingual,
      })),
      currentVoice: this.currentVoice,
      currentVoiceName: displayName(this.currentVoice),
      gender: this.gender,
    };
  }

  // -------------------------------------------------------------------------
  // Per-document resume positions (persisted via plugin data)
  // -------------------------------------------------------------------------

  private positions(): Record<string, StoredPosition> {
    return this.settings.positions || {};
  }

  private savePosition(docKey: string, idx: number, total: number, text: string): void {
    if (!docKey) return;
    const all = { ...this.positions() };
    all[docKey] = { idx, total, text: text.slice(0, 80), ts: Date.now() };
    const keys = Object.keys(all);
    if (keys.length > MAX_POSITIONS) {
      keys.sort((a, b) => all[a].ts - all[b].ts);
      for (const k of keys.slice(0, keys.length - MAX_POSITIONS)) delete all[k];
    }
    this.settings.positions = all;
    void this.plugin.saveSettings();
  }

  // -------------------------------------------------------------------------
  // Status-bar mini-player + reveal-source (port of playerPanel.updateStatus/revealSource)
  // -------------------------------------------------------------------------

  private playing = false;

  updateStatus(playing: boolean): void {
    this.playing = playing;
    this.plugin.updateStatusItem(playing, this.docTitle);
  }

  isPlaying(): boolean {
    return this.playing;
  }

  getDocUri(): TFile | undefined {
    return this.docUri;
  }

  /** Open the source note with the cursor on the block's `data-line` (port of revealSource). */
  async revealSource(line: number): Promise<void> {
    if (!this.docUri) return;
    try {
      const leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(this.docUri);
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) return;
      const editor = view.editor;
      const lastLine = editor.lastLine();
      const targetLine = Math.max(0, Math.min(lastLine, this.baseLine + line - 2));
      const pos = { line: targetLine, ch: 0 };
      editor.setCursor(pos);
      editor.scrollIntoView({ from: pos, to: pos }, true);
      this.app.workspace.setActiveLeaf(leaf, { focus: true });
    } catch {
      /* document may be gone */
    }
  }

  /** The HostCallbacks object wired into the player (the player→controller surface). */
  buildHostCallbacks(): HostCallbacks {
    return {
      persistPrefs: (prefs: ReaderPrefs) => {
        this.settings.readerPrefs = prefs;
        void this.plugin.saveSettings();
      },
      persistSpeed: (value: number) => {
        if (!Number.isFinite(value)) return;
        this.settings.speed = Math.min(2.5, Math.max(0.5, value));
        void this.plugin.saveSettings();
      },
      persistVolume: (value: number) => {
        if (!Number.isFinite(value)) return;
        this.settings.volume = Math.min(1, Math.max(0, value));
        void this.plugin.saveSettings();
      },
      openSource: (line: number) => { void this.revealSource(line); },
      editSource: (line: number) => { void this.revealSource(line); },
      position: (docKey: string, idx: number, total: number, text: string) => {
        this.savePosition(docKey, idx, total, text);
      },
      playState: (playing: boolean) => this.updateStatus(playing),
      setGender: (gender: Gender) => this.changeGender(gender),
      setAutoLang: (value: boolean) => this.setAutoLang(value),
      setLocale: (locale: string) => this.changeLocale(locale),
      setVoice: (shortName: string) => this.changeVoice(shortName),
    };
  }

  /** Settings that affect the reader's segmentation pass (used by the player opts). */
  readerSettings(): ReaderSettings {
    return {
      codeBlocks: this.settings.codeBlocks,
      tables: this.settings.tables,
      announceHeadings: this.settings.announceHeadings,
      highlight: this.settings.highlightWhileReading,
    };
  }

  /** Debounced live re-render of the source note while the reader is open. */
  onDocChanged(file: TFile): void {
    if (!this.docUri || this.isSelection || !this.lastLoad || !this.player) return;
    if (file.path !== this.docUri.path) return;
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = setTimeout(async () => {
      this.updateTimer = undefined;
      if (!this.docUri) return;
      const text = await this.app.vault.read(this.docUri);
      this.updateSource(renderMarkdownHtml(text));
    }, 400);
  }

  dispose(): void {
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.engine.dispose();
    this.player = null;
  }
}

function errMsg(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const m = err.message; // narrowed to unknown by `in`
    return typeof m === 'string' ? m : String(m);
  }
  return String(err);
}

/** Plain-text anchor for "read from cursor": the first prose-looking line at/after the offset. */
function anchorFrom(source: string, offset: number): string | undefined {
  const rest = source.slice(Math.max(0, Math.min(source.length, offset)));
  for (const raw of rest.split('\n').slice(0, 40)) {
    const plain = raw
      .replace(/`{3,}.*/g, ' ')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[#>*_`~|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const words = plain.match(/[\p{L}\p{N}']+/gu) || [];
    if (words.length >= 3) return plain.slice(0, 80);
  }
  return undefined;
}
