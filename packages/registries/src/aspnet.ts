import * as cheerio from 'cheerio';
import type { FetchOptions, FetchResult, FetchSession } from '@pp/core';

/** Every `<input type="hidden">` of the page, by name (ViewState, EventValidation, antiforgery tokens, ...). */
export function hiddenFields(html: string): Record<string, string> {
  const $ = cheerio.load(html);
  const out: Record<string, string> = {};
  $('input[type="hidden"]').each((_, el) => {
    const name = $(el).attr('name');
    if (name) out[name] = $(el).attr('value') ?? '';
  });
  return out;
}

/** ASP.NET answers some failures with HTTP 200 and an error page, so read the content, not just the status. */
export function isAspNetError(html: string): boolean {
  return /<title>\s*Runtime Error|Server Error in '[^']*' Application|<h1>\s*Server Error|Unhandled Exception/i.test(html);
}

export class AspNetFlowError extends Error {
  constructor(
    message: string,
    readonly step: string,
  ) {
    super(`${step}: ${message}`);
    this.name = 'AspNetFlowError';
  }
}

export type PostBackSubmit =
  /** A link/select postback: `__EVENTTARGET` is set to the control's name. */
  | { eventTarget: string; eventArgument?: string }
  /** A real submit button: its `name=value` is part of the form, like a browser click. */
  | { button: { name: string; value: string } };

/**
 * One ASP.NET postback in a cookie session (Pitfall 9): re-sends ALL hidden inputs of the latest
 * response, then the controls the caller sets (`fields` win over the hidden values), then the
 * clicked control. Never builds a form from an older page.
 */
export function buildPostBackForm(
  html: string,
  fields: Record<string, string>,
  submit?: PostBackSubmit,
): Record<string, string> {
  const form: Record<string, string> = { ...hiddenFields(html), ...fields };
  if (submit && 'eventTarget' in submit) {
    form.__EVENTTARGET = submit.eventTarget;
    form.__EVENTARGUMENT = submit.eventArgument ?? '';
  } else if (submit) {
    form[submit.button.name] = submit.button.value;
  }
  return form;
}

export async function postBack(
  session: FetchSession,
  url: string,
  html: string,
  fields: Record<string, string>,
  submit?: PostBackSubmit,
  opts?: Partial<FetchOptions>,
): Promise<FetchResult> {
  return session.post(url, buildPostBackForm(html, fields, submit), opts);
}

/** `javascript:__doPostBack('ctl00$Main$lb','')` href -> the event target, or null. */
export function eventTargetOf(href: string | undefined): string | null {
  if (!href) return null;
  const m = /__doPostBack\(\s*['"]([^'"]+)['"]/.exec(href);
  return m ? (m[1] as string) : null;
}

/** The absolute URL a page's form posts to (its `action` resolved against the page URL); the page URL when it has none. */
export function formAction(html: string, pageUrl: string): string {
  const action = cheerio.load(html)('form').first().attr('action');
  if (!action) return pageUrl;
  return new URL(action, pageUrl).toString();
}

/** Visible text of a page, whitespace collapsed (scripts and styles dropped). */
export function pageText(html: string): string {
  const $ = cheerio.load(html);
  $('script, style').remove();
  return $('body').text().replace(/\s+/g, ' ').trim();
}
