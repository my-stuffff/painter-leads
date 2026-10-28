import { useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router';

/** True when the browser history has an earlier entry inside this app (react-router stores its index in state). */
export function hasInAppHistory(): boolean {
  const idx = (window.history.state as { idx?: number } | null)?.idx;
  return typeof idx === 'number' && idx > 0;
}

/** Back = exactly one step: the previous in-app screen, or the parent screen when the page was opened directly. */
export function useBack(fallback: string) {
  const navigate = useNavigate();
  return useCallback(() => {
    if (hasInAppHistory()) navigate(-1);
    else navigate(fallback, { replace: true });
  }, [navigate, fallback]);
}

/** Calls `fn` when `key` is pressed outside text fields (e.g. "/" to focus a search box). */
export function useHotkey(key: string, fn: (e: KeyboardEvent) => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== key || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (document.querySelector('dialog[open]')) return;
      fn(e);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [key, fn, enabled]);
}
