import voicesData from './data/voices.json';
import type { Gender } from './types';
import { uiLocale } from './l10n';

export interface VoiceRec {
  shortName: string;
  locale: string;
  lang: string;
  gender: string; // "Female" | "Male"
  friendlyName: string;
  multilingual: boolean;
}

interface VoicesJson {
  voiceCount: number;
  localeCount: number;
  langCount: number;
  generatedAt: string;
  voices: VoiceRec[];
  curated: Record<string, { female?: string; male?: string }>;
  langDefaultLocale: Record<string, string>;
}

const data = voicesData as VoicesJson;
const voices: VoiceRec[] = data.voices;
const curated: Record<string, { female?: string; male?: string }> = data.curated;
const langDefaultLocale: Record<string, string> = data.langDefaultLocale;

const FALLBACK: Record<Gender, string> = {
  female: 'en-US-AvaMultilingualNeural',
  male: 'en-US-AndrewMultilingualNeural',
};

/** Map a base ISO-639-1 language code (e.g. "de") to its primary locale (e.g. "de-DE"). */
export function localeForLang(lang: string): string | undefined {
  return langDefaultLocale[lang.toLowerCase()];
}

/** The curated female/male pair for a locale (best voices we picked). */
export function curatedPair(locale: string): { female?: string; male?: string } {
  return curated[locale] || curated[localeForLang(locale.split('-')[0]) || ''] || {};
}

/** Pick the best voice for a locale + preferred gender, honoring user overrides. */
export function pickVoice(
  locale: string,
  gender: Gender,
  overrides: Record<string, string> = {}
): string {
  if (overrides[locale]) return overrides[locale];
  const base = locale.split('-')[0];
  if (overrides[base]) return overrides[base];

  const tryLocales = [locale, langDefaultLocale[base]].filter((v): v is string => !!v);
  for (const loc of tryLocales) {
    const c = curated[loc];
    if (c) return c[gender] || c[gender === 'female' ? 'male' : 'female'] || FALLBACK[gender];
  }
  return FALLBACK[gender];
}

/** All voices for a locale (for the advanced "all voices" picker). */
export function voicesForLocale(locale: string): VoiceRec[] {
  return voices.filter((v) => v.locale === locale);
}

export function getVoice(shortName: string): VoiceRec | undefined {
  return voices.find((v) => v.shortName === shortName);
}

/** Extract a short friendly name, e.g. "Microsoft Ava Online (Natural) - English…" -> "Ava". */
export function displayName(shortName: string): string {
  const v = getVoice(shortName);
  if (v) {
    const m = v.friendlyName.match(/Microsoft\s+([^\s]+?)(?:Multilingual)?\b/);
    if (m) return m[1];
  }
  // Fallback: parse from the shortName ("de-DE-SeraphinaMultilingualNeural" -> "Seraphina")
  const part = shortName.split('-').slice(2).join('-');
  return part.replace(/Multilingual/i, '').replace(/Neural$/i, '') || shortName;
}

// Render language/region names in the user's UI display language. Intl/ICU supplies
// the names for all locales, so no per-string translation is needed. Memoized.
let _displayNames: Intl.DisplayNames | null | undefined;
function displayNames(): Intl.DisplayNames | null {
  if (_displayNames !== undefined) return _displayNames;
  for (const loc of [uiLocale(), 'en']) {
    try {
      _displayNames = new Intl.DisplayNames([loc], { type: 'language' });
      return _displayNames;
    } catch {
      /* try the next locale */
    }
  }
  _displayNames = null;
  return _displayNames;
}

export function localeDisplay(locale: string): string {
  try {
    return displayNames()?.of(locale) || locale;
  } catch {
    return locale;
  }
}

/** All locales we have a curated voice for, with display names, sorted. */
export function allCuratedLocales(): { locale: string; name: string }[] {
  return Object.keys(curated)
    .map((locale) => ({ locale, name: localeDisplay(locale) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const catalogInfo = {
  voiceCount: data.voiceCount,
  localeCount: data.localeCount,
  langCount: data.langCount,
  generatedAt: data.generatedAt,
};
