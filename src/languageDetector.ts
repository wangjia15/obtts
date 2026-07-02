import { eld } from 'eld/small';
import { localeForLang } from './voices';
import { stripForDetection } from './markdown/normalize';
import { preprocessObsidian } from './markdown/obsidian';

interface DetectResult {
  language?: string;
  isReliable(): boolean;
}

interface EldApi {
  detect(text: string): DetectResult;
}

// `eld/small` ships a factory; verify its shape once at import via a real guard.
const eldApi: EldApi | undefined = isEldApi(eld) ? eld : undefined;

function isEldApi(v: unknown): v is EldApi {
  return !!v && typeof v === 'object' && 'detect' in v && typeof v.detect === 'function';
}

/**
 * Detect the document language from its markdown source and map it to a BCP-47
 * locale we have a voice for. Returns the fallback locale when detection is
 * unreliable or the language isn't supported.
 */
export function detectLocale(source: string, fallbackLocale: string): { locale: string; lang?: string; reliable: boolean } {
  const sample = stripForDetection(preprocessObsidian(source)).slice(0, 2000);
  if (sample.length < 12) return { locale: fallbackLocale, reliable: false };
  if (!eldApi) return { locale: fallbackLocale, reliable: false };
  try {
    const r = eldApi.detect(sample);
    const reliable = r.isReliable();
    if (r.language) {
      const loc = localeForLang(r.language);
      if (loc) return { locale: loc, lang: r.language, reliable };
    }
  } catch {
    /* ignore */
  }
  return { locale: fallbackLocale, reliable: false };
}

/**
 * Detect the locale of a single block of clean prose, but only return one when
 * the detection is reliable and maps to a supported voice. Short/ambiguous
 * blocks return undefined so the caller can keep the surrounding language.
 */
/**
 * Reliable ISO 639-1 language code for a run of text (e.g. "de", "zh"), or
 * undefined when the text is too short/ambiguous to be sure. Used by the reader
 * for language badges and the browser-engine voice pick so they agree with the
 * `eld`-driven synthesis language instead of a separate stop-word heuristic.
 */
export function detectLangCode(text: string): string | undefined {
  const sample = text.trim();
  if (sample.length < 12 || !eldApi) return undefined;
  try {
    const r = eldApi.detect(sample);
    if (r.language && r.isReliable()) return r.language;
  } catch {
    /* ignore */
  }
  return undefined;
}

export function detectReliableLocale(text: string): string | undefined {
  const sample = text.trim();
  if (sample.length < 18) return undefined;
  if (!eldApi) return undefined;
  try {
    const r = eldApi.detect(sample);
    if (r.language && r.isReliable()) {
      return localeForLang(r.language);
    }
  } catch {
    /* ignore */
  }
  return undefined;
}
