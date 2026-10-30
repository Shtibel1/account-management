'use client';

import { useEffect, useRef } from 'react';

// Open layers (dialogs, the mobile drawer) that close on Esc, in opening order. Only the topmost one
// handles a press, so Esc in a dialog opened over another dialog closes just the top one.
const stack: { current: () => void }[] = [];
let listening = false;

function onKeyDown(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  const top = stack[stack.length - 1];
  if (!top) return;
  e.preventDefault();
  top.current();
}

/** Calls onEscape when Esc is pressed while `active` and this is the most recently opened layer. */
export function useEscapeKey(onEscape: () => void, active = true): void {
  const handler = useRef(onEscape);
  useEffect(() => {
    handler.current = onEscape;
  }, [onEscape]);

  useEffect(() => {
    if (!active) return;
    const entry = handler;
    stack.push(entry);
    if (!listening) {
      document.addEventListener('keydown', onKeyDown);
      listening = true;
    }
    return () => {
      const i = stack.lastIndexOf(entry);
      if (i !== -1) stack.splice(i, 1);
      if (stack.length === 0 && listening) {
        document.removeEventListener('keydown', onKeyDown);
        listening = false;
      }
    };
  }, [active]);
}
