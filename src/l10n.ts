import de from './l10n/de.json';
import es from './l10n/es.json';
import fr from './l10n/fr.json';
import it from './l10n/it.json';
import ja from './l10n/ja.json';
import ptBr from './l10n/pt-br.json';
import zhCn from './l10n/zh-cn.json';

/** The UI's display language (BCP-47), from Obsidian's moment locale. */
export function uiLocale(): string {
  const g = globalThis as { moment?: unknown };
  const m = g.moment;
  if (m && typeof m === 'object' && 'locale' in m && typeof m.locale === 'function') {
    return m.locale();
  }
  return 'en';
}

type Bundle = Record<string, string>;

const BUNDLES: Record<string, Bundle> = {
  de, es, fr, it, ja, 'pt-br': ptBr, 'zh-cn': zhCn,
};

/**
 * Resolve one localized string. Falls back to the English key when the bundle or
 * the key is missing — the keys are already English, so a missing translation is
 * a cosmetic degradation, never a crash.
 */
export function t(key: string): string {
  const loc = uiLocale();
  const bundle = BUNDLES[loc] || BUNDLES[loc.split('-')[0]];
  return (bundle && bundle[key]) || key;
}

/** The reader player's short-key → localized-phrase map (was window.__l10n). */
export function uiStrings(): Record<string, string> {
  return {
    title: t('Read Aloud'),
    play: t('Play'),
    pause: t('Pause'),
    stop: t('Stop'),
    prev: t('Previous sentence'),
    next: t('Next sentence'),
    speed: t('Speed'),
    volume: t('Volume'),
    mute: t('Mute'),
    unmute: t('Unmute'),
    female: t('Female'),
    male: t('Male'),
    voice: t('Voice'),
    language: t('Language'),
    autoLangLabel: t('Auto language (per paragraph)'),
    multilingual: t('multilingual'),
    readingFont: t('Reading font'),
    comfort: t('Comfort'),
    compact: t('Compact'),
    cozy: t('Cozy'),
    wide: t('Wide'),
    theme: t('Theme'),
    themeAuto: t('Follow VS Code'),
    themeStudy: t('Study'),
    themeDaylight: t('Daylight'),
    themePaper: t('Paper'),
    ambient: t('Ambient focus'),
    badges: t('Show language badges'),
    readSection: t('Read section'),
    settings: t('More settings'),
    reading: t('Reading'),
    playback: t('Playback'),
    minShort: t('~{0} min'),
    edit: t('Edit source'),
    collapseAll: t('Collapse all sections'),
    expandAll: t('Expand all sections'),
    toggleSection: t('Toggle section'),
    backToReading: t('Back to reading'),
    startOver: t('Start over'),
    resumed: t('Resumed where you left off'),
    sleepTimer: t('Sleep timer'),
    off: t('Off'),
    untilSectionEnd: t('Until end of section'),
    codeBlock: t('Code block'),
    heading: t('Heading'),
    sentenceOf: t('Sentence {0} of {1}'),
    progress: t('Progress'),
    nothingToRead: t('Nothing readable in this document.'),
    openInEditor: t('Alt+Click a sentence to open it in the editor'),
    fontSerifSub: t('warm serif'),
    fontSansSub: t('clean sans'),
    fontA11ySub: t('max legibility'),
    fontMonoSub: t('calm, technical'),
  };
}
