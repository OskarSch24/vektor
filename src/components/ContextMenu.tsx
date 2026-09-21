import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface ContextMenuItem {
  label: string;
  icon?: React.ReactNode;
  shortcut?: string;
  disabled?: boolean;
  onSelect: () => void;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
  anchor?: HTMLElement | null;
  ariaLabel?: string;
}

const VIEWPORT_MARGIN = 6;

/**
 * Small workbench menu shared by Explorer-like lists. It is portalled so the
 * surrounding panels can keep their overflow clipping without cutting off the
 * menu.
 */
export const ContextMenu: React.FC<ContextMenuProps> = ({
  x,
  y,
  items,
  onClose,
  anchor = null,
  ariaLabel = 'Kontextmenü',
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  const close = (restoreFocus: boolean) => {
    onClose();
    if (restoreFocus && anchor?.isConnected) {
      window.requestAnimationFrame(() => anchor.focus());
    }
  };

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;

    const { width, height } = menu.getBoundingClientRect();
    const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN);
    const maxTop = Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN);
    const left = Math.min(Math.max(VIEWPORT_MARGIN, x), maxLeft);
    const top = Math.min(Math.max(VIEWPORT_MARGIN, y), maxTop);
    setPosition((current) => current.left === left && current.top === top ? current : { left, top });

    const firstItem = menu.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)');
    firstItem?.focus();
  }, [items.length, x, y]);

  useEffect(() => {
    const closeForPointer = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) close(false);
    };
    const closeForScroll = () => close(false);
    const closeForWindowChange = () => close(false);

    document.addEventListener('pointerdown', closeForPointer, true);
    document.addEventListener('scroll', closeForScroll, true);
    window.addEventListener('resize', closeForWindowChange);
    window.addEventListener('blur', closeForWindowChange);
    return () => {
      document.removeEventListener('pointerdown', closeForPointer, true);
      document.removeEventListener('scroll', closeForScroll, true);
      window.removeEventListener('resize', closeForWindowChange);
      window.removeEventListener('blur', closeForWindowChange);
    };
  });

  const moveFocus = (direction: 1 | -1) => {
    const enabledItems = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []
    );
    if (enabledItems.length === 0) return;
    const currentIndex = enabledItems.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex = currentIndex < 0
      ? direction === 1 ? 0 : enabledItems.length - 1
      : (currentIndex + direction + enabledItems.length) % enabledItems.length;
    enabledItems[nextIndex]?.focus();
  };

  const focusBoundary = (edge: 'first' | 'last') => {
    const enabledItems = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []
    );
    (edge === 'first' ? enabledItems[0] : enabledItems[enabledItems.length - 1])?.focus();
  };

  const menu = (
    <div
      ref={menuRef}
      role="menu"
      aria-label={ariaLabel}
      className="cursor-context-menu"
      style={{ left: position.left, top: position.top }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        switch (event.key) {
          case 'ArrowDown':
            event.preventDefault();
            moveFocus(1);
            break;
          case 'ArrowUp':
            event.preventDefault();
            moveFocus(-1);
            break;
          case 'Home':
            event.preventDefault();
            focusBoundary('first');
            break;
          case 'End':
            event.preventDefault();
            focusBoundary('last');
            break;
          case 'Escape':
            event.preventDefault();
            close(true);
            break;
          case 'Tab':
            close(false);
            break;
        }
      }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          tabIndex={-1}
          disabled={item.disabled}
          className="cursor-context-menu-item"
          onClick={() => {
            close(false);
            item.onSelect();
          }}
        >
          <span className="cursor-context-menu-icon" aria-hidden="true">{item.icon}</span>
          <span className="cursor-context-menu-label">{item.label}</span>
          {item.shortcut && <span className="cursor-context-menu-shortcut">{item.shortcut}</span>}
        </button>
      ))}
    </div>
  );

  return createPortal(menu, document.body);
};
