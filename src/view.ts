import { ItemView, WorkspaceLeaf } from 'obsidian';
import { ReaderPlayer, type HostCallbacks, type PlayerOptions, type ReaderPrefs } from './player';
import type { TtsController } from './controller';
import type TtsPlugin from './main';
import { uiStrings } from './l10n';

export const VIEW_TYPE = 'obtts-reader';

/** The font files bundled in media/fonts (family, weight, style) — sourced from playerPanel.FONT_FILES. */
const FONT_FILES: Record<string, [string, number, 'normal' | 'italic']> = {
  'inter-latin-400-normal.woff2': ['Inter', 400, 'normal'],
  'inter-latin-500-normal.woff2': ['Inter', 500, 'normal'],
  'inter-latin-600-normal.woff2': ['Inter', 600, 'normal'],
  'inter-latin-700-normal.woff2': ['Inter', 700, 'normal'],
  'literata-latin-400-normal.woff2': ['Literata', 400, 'normal'],
  'literata-latin-400-italic.woff2': ['Literata', 400, 'italic'],
  'literata-latin-600-normal.woff2': ['Literata', 600, 'normal'],
  'literata-latin-700-normal.woff2': ['Literata', 700, 'normal'],
  'atkinson-hyperlegible-latin-400-normal.woff2': ['Atkinson Hyperlegible', 400, 'normal'],
  'atkinson-hyperlegible-latin-400-italic.woff2': ['Atkinson Hyperlegible', 400, 'italic'],
  'atkinson-hyperlegible-latin-700-normal.woff2': ['Atkinson Hyperlegible', 700, 'normal'],
  'ibm-plex-mono-latin-400-normal.woff2': ['IBM Plex Mono', 400, 'normal'],
  'ibm-plex-mono-latin-500-normal.woff2': ['IBM Plex Mono', 500, 'normal'],
};

/**
 * ReaderView — an Obsidian `ItemView` leaf that hosts the `ReaderPlayer` on a
 * root `<div class="obtts-reader">`. This is the one place the Obsidian API
 * (`ItemView`, `WorkspaceLeaf`, `getResourcePath`) meets the ported player.
 *
 * The reader HTML, CSS (`styles.css`, app-global), and bundled fonts load here.
 * `styles.css` is auto-loaded by Obsidian; the `@font-face` rules MUST be injected
 * at runtime because Obsidian does not resolve relative `url()` in the CSS to the
 * plugin directory — they need resource paths.
 */
export class ReaderView extends ItemView {
  player: ReaderPlayer | null = null;
  private plugin: TtsPlugin;

  constructor(leaf: WorkspaceLeaf, plugin: TtsPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  override getViewType(): string {
    return VIEW_TYPE;
  }

  override getDisplayText(): string {
    return uiStrings().title;
  }

  override getIcon(): string {
    return 'volume-2';
  }

  override async onOpen(): Promise<void> {
    const controller: TtsController = this.plugin.controller;

    // Clear any prior chrome in this leaf and mount the reader root.
    this.contentEl.empty();
    const root = this.contentEl.createDiv({ cls: 'obtts-reader' });
    root.id = 'obtts-root';
    root.tabIndex = -1; // make it focusable so reader keyboard shortcuts work

    this.injectFonts();

    // The <div id="app"> chrome + <div id="sr"> live-region node are created by the player.
    const sr = root.createDiv({ cls: 'sr-only' });
    sr.id = 'sr';
    sr.setAttribute('role', 'status');
    sr.setAttribute('aria-live', 'polite');
    const appDiv = root.createDiv();
    appDiv.id = 'app';

    const opts: PlayerOptions = {
      rate: this.plugin.settings.speed,
      volume: this.plugin.settings.volume,
      settings: controller.readerSettings(),
      prefs: (this.plugin.settings.readerPrefs as ReaderPrefs | null) ?? null,
      engine: controller.getEngineId(),
    };
    const host: HostCallbacks = controller.buildHostCallbacks();
    const strings = uiStrings();
    const player = new ReaderPlayer(root, controller, host, strings, opts);
    this.player = player;
    controller.attachPlayer(player);
  }

  override async onClose(): Promise<void> {
    if (this.player) {
      this.plugin.controller.detachPlayer(this.player);
      this.player.destroy();
      this.player = null;
    }
  }

  /** Inject `@font-face` for the 13 bundled woff2 via resource paths. */
  private injectFonts(): void {
    const id = 'obtts-fonts';
    if (document.getElementById(id)) return;
    const css = Object.entries(FONT_FILES)
      .map(([file, [family, weight, style]]) => {
        const url = this.resourceUrl(`media/fonts/${file}`);
        return `@font-face{font-family:'${family}';font-style:${style};font-weight:${weight};font-display:swap;src:url(${url}) format('woff2');}`;
      })
      .join('\n');
    const style = document.createElement('style');
    style.id = id;
    style.textContent = css;
    document.head.appendChild(style);
  }

  /** Resolve a plugin-relative path to a loadable resource URL. */
  private resourceUrl(relPath: string): string {
    const pluginDir = this.plugin.manifest.dir;
    const full = pluginDir ? `${pluginDir}/${relPath}` : relPath;
    try {
      return this.app.vault.adapter.getResourcePath(full);
    } catch {
      // Fallback: the app://local URL for the plugin folder.
      return `app://local/${full}`;
    }
  }
}
