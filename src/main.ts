import { Editor, MarkdownFileInfo, MarkdownView, Menu, Plugin, TFile, Notice, WorkspaceLeaf } from 'obsidian';
import { TtsController } from './controller';
import { ReaderView, VIEW_TYPE } from './view';
import { DEFAULT_SETTINGS, TtsSettingTab, type PluginData } from './settings';
import { t } from './l10n';

export default class TtsPlugin extends Plugin {
  override settings: PluginData = DEFAULT_SETTINGS;
  controller!: TtsController;
  private statusItem: HTMLElement | null = null;

  override async onload(): Promise<void> {
    await this.loadSettings();
    this.controller = new TtsController(this);

    this.registerView(VIEW_TYPE, (leaf) => new ReaderView(leaf, this));

    this.addRibbonIcon('volume-2', t('Read Aloud'), () => {
      void this.readDocument();
    });

    this.addCommand({
      id: 'read-document',
      name: t('Read Aloud: Read Document'),
      callback: () => void this.readDocument(),
    });
    this.addCommand({
      id: 'read-from-cursor',
      name: t('Read from cursor'),
      editorCallback: (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
        if (ctx instanceof MarkdownView) void this.readFromCursor(editor, ctx);
      },
    });
    this.addCommand({
      id: 'read-selection',
      name: t('Read selection'),
      editorCallback: (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
        if (ctx instanceof MarkdownView) void this.readSelection(editor, ctx);
      },
    });
    this.addCommand({
      id: 'toggle-play-pause',
      name: t('Read Aloud — click to play/pause'),
      callback: () => {
        if (this.controller.player) this.controller.control('playpause');
        else new Notice(t('Read Aloud: no active player. Run "Read Aloud: Read Document" to start.'));
      },
    });
    this.addCommand({
      id: 'stop',
      name: t('Stop'),
      callback: () => this.controller.control('stop'),
    });
    this.addCommand({
      id: 'open-player',
      name: t('Read Aloud'),
      callback: () => void this.readDocument(),
    });

    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu: Menu, editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
        if (!(ctx instanceof MarkdownView)) return;
        const view = ctx;
        menu.addItem((item) =>
          item
            .setTitle(t('Read from cursor'))
            .setIcon('volume-2')
            .onClick(() => void this.readFromCursor(editor, view))
        );
        if (editor.getSelection()) {
          menu.addItem((item) =>
            item
              .setTitle(t('Read selection'))
              .setIcon('volume-2')
              .onClick(() => void this.readSelection(editor, view))
          );
        }
      })
    );

    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (file instanceof TFile) this.controller.onDocChanged(file);
      })
    );

    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (file instanceof TFile) this.controller.onDocRenamed(file, oldPath);
      })
    );

    this.statusItem = this.addStatusBarItem();
    this.statusItem.addClass('obtts-status', 'obtts-hidden');
    this.statusItem.addEventListener('click', () => this.controller.control('playpause'));

    this.addSettingTab(new TtsSettingTab(this.app, this));
  }

  override onunload(): void {
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => leaf.detach());
    this.controller.dispose();
  }

  async loadSettings(): Promise<void> {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  updateStatusItem(playing: boolean, title: string): void {
    if (!this.statusItem) return;
    this.statusItem.removeClass('obtts-hidden');
    const shortTitle = title.length > 24 ? title.slice(0, 23) + '…' : title;
    this.statusItem.setText(`${playing ? '⏸' : '▶'} ${shortTitle}`);
    this.statusItem.setAttribute('aria-label', t('Read Aloud — click to play/pause'));
  }

  // ---------------------------------------------------------------------
  // Commands: gather source text and open the reader
  // ---------------------------------------------------------------------

  private async openReader(preferredLeaf?: WorkspaceLeaf): Promise<ReaderView> {
    if (preferredLeaf) {
      // A caller-provided pane (e.g. K-Plex's sidecar companion) hosts the reader in
      // place: focus stays with the caller, exactly like an adjacent preview pane.
      if (!(preferredLeaf.view instanceof ReaderView)) {
        await preferredLeaf.setViewState({ type: VIEW_TYPE, active: false });
      }
      if (preferredLeaf.view instanceof ReaderView) return preferredLeaf.view;
      // A host that refuses the view falls through to the normal reader tab.
    }
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    const leaf: WorkspaceLeaf = existing ?? this.app.workspace.getLeaf(true);
    if (!existing) await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
    const view = leaf.view;
    if (!(view instanceof ReaderView)) throw new Error('Read Aloud: failed to open the reader view.');
    return view;
  }

  private getActiveMarkdown(): { file: TFile; editor: Editor } | undefined {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.file) return undefined;
    return { file: view.file, editor: view.editor };
  }

  private async readDocument(): Promise<void> {
    const active = this.getActiveMarkdown();
    if (!active) {
      new Notice(t('Read Aloud: open a Markdown file first.'));
      return;
    }
    const source = await this.app.vault.read(active.file);
    if (!source.trim()) {
      new Notice(t('Read Aloud: nothing readable found in this document.'));
      return;
    }
    const view = await this.openReader();
    view.player && this.controller.attachPlayer(view.player);
    this.controller.open(source, active.file.basename, { docUri: active.file });
  }

  /**
   * Read arbitrary Markdown text aloud (e.g. a highlight or a section panel).
   * Public interface — other plugins call this through
   * `app.plugins.plugins.obtts.readText(...)`.
   */
  async readText(text: string, title: string, opts: { docUri?: TFile; baseLine?: number; leaf?: WorkspaceLeaf } = {}): Promise<void> {
    if (!text.trim()) {
      new Notice(t('Read Aloud: nothing readable in the selection.'));
      return;
    }
    const view = await this.openReader(opts.leaf);
    view.player && this.controller.attachPlayer(view.player);
    this.controller.open(text, title, {
      docUri: opts.docUri,
      isSelection: true,
      baseLine: opts.baseLine,
    });
  }

  private async readFromCursor(editor: Editor, view: MarkdownView): Promise<void> {
    const file = view.file;
    if (!file) return;
    const source = await this.app.vault.read(file);
    if (!source.trim()) {
      new Notice(t('Read Aloud: nothing readable found in this document.'));
      return;
    }
    const readerView = await this.openReader();
    readerView.player && this.controller.attachPlayer(readerView.player);
    this.controller.open(source, file.basename, {
      docUri: file,
      startOffset: editor.posToOffset(editor.getCursor()),
    });
  }

  private async readSelection(editor: Editor, view: MarkdownView): Promise<void> {
    const selection = editor.getSelection();
    if (!selection) {
      await this.readFromCursor(editor, view);
      return;
    }
    const file = view.file;
    if (!file) return;
    if (!selection.trim()) {
      new Notice(t('Read Aloud: nothing readable in the selection.'));
      return;
    }
    const from = editor.getCursor('from');
    const readerView = await this.openReader();
    readerView.player && this.controller.attachPlayer(readerView.player);
    this.controller.open(selection, `${file.basename} (selection)`, {
      docUri: file,
      isSelection: true,
      baseLine: from.line + 1,
    });
  }
}
