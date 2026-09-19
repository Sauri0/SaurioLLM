import { describe, expect, it } from 'vitest';
import { formatAttachmentSize } from './attachments.js';

describe('formatAttachmentSize', () => {
  it('bytes chicos', () => {
    expect(formatAttachmentSize(500)).toBe('500 B');
  });
  it('kilobytes', () => {
    expect(formatAttachmentSize(2048)).toBe('2 KB');
  });
  it('megabytes con un decimal', () => {
    expect(formatAttachmentSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });
  it('undefined -> string vacío', () => {
    expect(formatAttachmentSize(undefined)).toBe('');
  });
});
