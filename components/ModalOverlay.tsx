import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

type ModalOverlayProps = {
  children: React.ReactNode;
  onClose: () => void;
  labelledBy: string;
  className?: string;
  initialFocus?: React.RefObject<HTMLElement | null>;
};

/** Escape ancestor filters/stacking contexts so every modal covers the whole viewport. */
export const ModalOverlay: React.FC<ModalOverlayProps> = ({ children, onClose, labelledBy, className = '', initialFocus }) => {
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useLayoutEffect(() => { close.current = onClose; }, [onClose]);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const bodyOverflow = document.body.style.overflow;
    const htmlOverflow = document.documentElement.style.overflow;
    const background = Array.from(document.body.children).filter((element): element is HTMLElement => element instanceof HTMLElement && !element.contains(dialog.current));
    const previousInert = background.map(element => element.inert);
    background.forEach(element => { element.inert = true; });
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    const focusable = () => Array.from<HTMLElement>(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled):not([hidden]), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]') || [])
      .filter(element => element.getClientRects().length > 0);
    (initialFocus?.current || focusable()[0] || dialog.current)?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close.current(); }
      if (event.key !== 'Tab') return;
      const elements = focusable(), first = elements[0], last = elements[elements.length - 1];
      if (!first) { event.preventDefault(); dialog.current?.focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = bodyOverflow;
      document.documentElement.style.overflow = htmlOverflow;
      background.forEach((element, index) => { element.inert = previousInert[index]; });
      previousFocus?.focus();
    };
  }, [initialFocus]);

  return createPortal(
    <div data-modal-overlay className="fixed inset-0 z-[2147483000] flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-md no-print" onClick={event => { if (event.target === event.currentTarget) close.current(); }}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={labelledBy} tabIndex={-1} className={`w-full max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain outline-none ${className}`}>
        {children}
      </div>
    </div>,
    document.body,
  );
};
