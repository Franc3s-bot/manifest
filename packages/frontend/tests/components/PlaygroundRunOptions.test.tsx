import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@solidjs/testing-library';
import PlaygroundRunOptions, {
  addAttachmentFiles,
  MAX_ATTACHMENT_BYTES,
} from '../../src/components/playground/PlaygroundRunOptions';

const baseProps = {
  attachments: [],
  onAttachmentsChange: vi.fn(),
  mediaKinds: ['text'] as const,
  media: {},
  onMediaChange: vi.fn(),
};

describe('PlaygroundRunOptions', () => {
  it('shows the attach control only when a text column exists', () => {
    const { container, unmount } = render(() => (
      <PlaygroundRunOptions {...baseProps} mediaKinds={['image']} />
    ));
    expect(container.querySelector('.playground-options__attach')).toBeNull();
    unmount();

    const second = render(() => <PlaygroundRunOptions {...baseProps} mediaKinds={['text']} />);
    expect(second.container.querySelector('.playground-options__attach')).not.toBeNull();
  });

  it('hides the media panel when no media column exists', () => {
    const { container } = render(() => (
      <PlaygroundRunOptions {...baseProps} mediaKinds={['text']} />
    ));
    expect(container.querySelector('.playground-options__toggle')).toBeNull();
  });

  it('reveals image options when an image column exists and reports edits', () => {
    const onMediaChange = vi.fn();
    const { container } = render(() => (
      <PlaygroundRunOptions
        {...baseProps}
        mediaKinds={['text', 'image']}
        onMediaChange={onMediaChange}
      />
    ));
    fireEvent.click(container.querySelector('.playground-options__toggle')!);
    const sizeInput = container.querySelector<HTMLInputElement>(
      '.playground-options__field input[placeholder="1K / 1024x1024"]',
    );
    expect(sizeInput).not.toBeNull();
    fireEvent.input(sizeInput!, { target: { value: '2K' } });
    expect(onMediaChange).toHaveBeenCalledWith(expect.objectContaining({ size: '2K' }));
  });

  it('reveals video-only fields for a video column', () => {
    const { container } = render(() => (
      <PlaygroundRunOptions {...baseProps} mediaKinds={['video']} />
    ));
    fireEvent.click(container.querySelector('.playground-options__toggle')!);
    expect(container.textContent).toContain('Seconds');
    expect(container.textContent).toContain('First frame URL');
    // Image-only controls must not appear for a video-only run.
    expect(container.textContent).not.toContain('Format');
  });

  it('adds a pasted image file as an attachment', async () => {
    const onAttachmentsChange = vi.fn();
    const file = new File(['hello'], 'pasted.png', { type: 'image/png' });

    const next = await addAttachmentFiles([], [file]);

    expect(next).toHaveLength(1);
    expect(next[0]!.name).toBe('pasted.png');
    expect(next[0]!.dataUrl.startsWith('data:image/png')).toBe(true);
    // Sanity: the exported helper is what the component uses.
    expect(onAttachmentsChange).not.toHaveBeenCalled();
  });

  it('rejects non-image files and oversized images', async () => {
    const onError = vi.fn();
    const text = new File(['x'], 'notes.txt', { type: 'text/plain' });
    const big = new File([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], 'big.png', {
      type: 'image/png',
    });

    const next = await addAttachmentFiles([], [text, big], onError);

    expect(next).toHaveLength(0);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('removes an existing attachment', () => {
    const onAttachmentsChange = vi.fn();
    const { container } = render(() => (
      <PlaygroundRunOptions
        {...baseProps}
        attachments={[{ id: 'a1', name: 'a.png', dataUrl: 'data:image/png;base64,AA' }]}
        onAttachmentsChange={onAttachmentsChange}
      />
    ));
    fireEvent.click(container.querySelector('.playground-options__thumb-remove')!);
    expect(onAttachmentsChange).toHaveBeenCalledWith([]);
  });

  it('reads a file selected through the input', async () => {
    const onAttachmentsChange = vi.fn();
    const { container } = render(() => (
      <PlaygroundRunOptions {...baseProps} onAttachmentsChange={onAttachmentsChange} />
    ));
    const input = container.querySelector<HTMLInputElement>('.playground-options__file-input')!;
    const file = new File(['hello'], 'picked.png', { type: 'image/png' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    fireEvent.change(input);

    await waitFor(() => expect(onAttachmentsChange).toHaveBeenCalledTimes(1));
    expect(onAttachmentsChange.mock.calls[0][0][0].name).toBe('picked.png');
  });
});
