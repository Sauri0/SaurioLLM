import { describe, expect, it } from 'vitest';
import { CHAT_SCROLL_FOLLOW_THRESHOLD_PX, isNearChatScrollBottom } from './chatScroll.js';

describe('isNearChatScrollBottom', () => {
  it('sigue el chat al estar al final o dentro del margen visual', () => {
    expect(isNearChatScrollBottom(1_000, 600, 400)).toBe(true);
    expect(isNearChatScrollBottom(1_000, 600 - CHAT_SCROLL_FOLLOW_THRESHOLD_PX, 400)).toBe(true);
  });

  it('no fuerza el scroll cuando la persona está leyendo más arriba', () => {
    expect(isNearChatScrollBottom(1_000, 520, 400)).toBe(false);
  });
});
