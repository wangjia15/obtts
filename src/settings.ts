import { App, PluginSettingTab, Setting } from 'obsidian';
import type TtsPlugin from './main';
import type { ReaderPrefs } from './player';
import { t } from './l10n';

export type EngineChoice = 'edge' | 'supertonic' | 'browser';
export type CodeBlockMode = 'skip' | 'announce' | 'read';
export type TableMode = 'skip' | 'read';

export interface TtsSettings {
  engine: EngineChoice;
  preferredGender: 'female' | 'male';
  speed: number;
  volume: number;
  autoDetectLanguage: boolean;
  perParagraphLanguage: boolean;
  fallbackLanguage: string;
  voiceOverrides: Record<string, string>;
  announceHeadings: boolean;
  codeBlocks: CodeBlockMode;
  tables: TableMode;
  highlightWhileReading: boolean;
  pronunciations: Record<string, string>;
}

/** A saved resume position for one document (persisted in the plugin data file). */
export interface StoredPosition {
  idx: number;
  total: number;
  text: string;
  ts: number;
}

/** The full on-disk plugin data: settings + per-doc positions + reader prefs. */
export interface PluginData extends TtsSettings {
  positions: Record<string, StoredPosition>;
  readerPrefs: ReaderPrefs | null;
}

export const DEFAULT_SETTINGS: PluginData = {
  engine: 'edge',
  preferredGender: 'female',
  speed: 1,
  volume: 1,
  autoDetectLanguage: true,
  perParagraphLanguage: false,
  fallbackLanguage: 'en-US',
  voiceOverrides: {},
  announceHeadings: false,
  codeBlocks: 'announce',
  tables: 'skip',
  highlightWhileReading: true,
  pronunciations: {},
  positions: {},
  readerPrefs: null,
};

export class TtsSettingTab extends PluginSettingTab {
  private plugin: TtsPlugin;

  constructor(app: App, plugin: TtsPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const s = this.plugin.settings;

    new Setting(containerEl)
      .setName(t('Voice'))
      .addDropdown((dd) => {
        dd.addOption('female', t('Female'))
          .addOption('male', t('Male'))
          .setValue(s.preferredGender)
          .onChange(async (v) => {
            s.preferredGender = v as 'female' | 'male';
            await this.plugin.saveSettings();
            this.plugin.controller.changeGender(s.preferredGender);
          });
      });

    new Setting(containerEl)
      .setName(t('Auto language (per paragraph)'))
      .setDesc(t('Detect the language of each paragraph and switch voices automatically.'))
      .addToggle((tg) => {
        tg.setValue(s.perParagraphLanguage).onChange(async (v) => {
          s.perParagraphLanguage = v;
          await this.plugin.saveSettings();
          this.plugin.controller.setAutoLang(v);
        });
      });

    new Setting(containerEl)
      .setName(t('Speed'))
      .addSlider((sl) => {
        sl.setLimits(0.5, 2.5, 0.05)
          .setValue(s.speed)
          .setDynamicTooltip()
          .onChange(async (v) => {
            s.speed = v;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(t('Volume'))
      .addSlider((sl) => {
        sl.setLimits(0, 1, 0.05)
          .setValue(s.volume)
          .setDynamicTooltip()
          .onChange(async (v) => {
            s.volume = v;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(t('Language'))
      .setDesc(t('Fallback reading language when auto-detection is off or unreliable.'))
      .addText((txt) => {
        txt.setValue(s.fallbackLanguage).onChange(async (v) => {
          s.fallbackLanguage = v.trim() || 'en-US';
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName(t('Auto-detect document language'))
      .addToggle((tg) => {
        tg.setValue(s.autoDetectLanguage).onChange(async (v) => {
          s.autoDetectLanguage = v;
          await this.plugin.saveSettings();
          this.plugin.controller.invalidateAndRefresh();
        });
      });

    new Setting(containerEl)
      .setName(t('Announce headings'))
      .addToggle((tg) => {
        tg.setValue(s.announceHeadings).onChange(async (v) => {
          s.announceHeadings = v;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName(t('Code blocks'))
      .addDropdown((dd) => {
        dd.addOption('skip', t('Off'))
          .addOption('announce', t('Code block'))
          .addOption('read', t('Read'))
          .setValue(s.codeBlocks)
          .onChange(async (v) => {
            s.codeBlocks = v as CodeBlockMode;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(t('Tables'))
      .addDropdown((dd) => {
        dd.addOption('skip', t('Off'))
          .addOption('read', t('Read'))
          .setValue(s.tables)
          .onChange(async (v) => {
            s.tables = v as TableMode;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(t('Highlight while reading'))
      .addToggle((tg) => {
        tg.setValue(s.highlightWhileReading).onChange(async (v) => {
          s.highlightWhileReading = v;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName(t('Pronunciations'))
      .setDesc(t('Word → spoken replacement, one per line as: word=replacement'))
      .addTextArea((ta) => {
        const text = Object.entries(s.pronunciations).map(([k, v]) => `${k}=${v}`).join('\n');
        ta.setValue(text).onChange(async (v) => {
          const map: Record<string, string> = {};
          for (const line of v.split('\n')) {
            const i = line.indexOf('=');
            if (i > 0) {
              const key = line.slice(0, i).trim();
              const val = line.slice(i + 1).trim();
              if (key) map[key] = val;
            }
          }
          s.pronunciations = map;
          await this.plugin.saveSettings();
        });
        ta.inputEl.rows = 4;
        ta.inputEl.cols = 30;
      });
  }
}
