import en from './en.json';
import ru from './ru.json';
import de from './de.json';
import uk from './uk.json';
import es from './es.json';
import it from './it.json';
import fr from './fr.json';

const translations: Record<string, typeof en> = { en, ru, de, uk, es, it, fr };

export const locales = ['en', 'de', 'ru', 'uk', 'es', 'it', 'fr'] as const;
export const defaultLocale = 'en';
export const localeNames: Record<string, string> = {
  en: 'English',
  de: 'Deutsch',
  ru: '\u0420\u0443\u0441\u0441\u043a\u0438\u0439',
  uk: '\u0423\u043a\u0440\u0430\u0457\u043d\u0441\u044c\u043a\u0430',
  es: 'Espa\u00f1ol',
  it: 'Italiano',
  fr: 'Fran\u00e7ais',
};

export function getLangFromUrl(url: URL): string {
  const [, lang] = url.pathname.split('/');
  if (lang && (locales as readonly string[]).includes(lang)) return lang;
  return defaultLocale;
}

export function t(lang: string): typeof en {
  return translations[lang] || translations[defaultLocale];
}

export function localePath(lang: string, path: string): string {
  const clean = path.startsWith('/') ? path : `/${path}`;
  if (lang === defaultLocale) return clean;
  return `/${lang}${clean}`;
}
