import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@solidjs/testing-library';
import PlaygroundRunOptions, {
  addAttachmentFiles,
  attachmentKindFor,
  attachmentToContentPart,
  MAX_ATTACHMENT_BYTES,
} from '../../src/components/playground/PlaygroundRunOptions';

const baseProps = {
  attachments: [],
  onAttachmentsChange: vi.fn(),
  mediaKinds: ['text'] as const,
  media: {},
  onMediaChange: vi.fn(),
};

describe('attachmentKindFor', () => {
  it('classifies by MIME type then by extension', () => {
    expect(attachmentKindFor('image/png')).toBe('image');
    expect(attachmentKindFor('audio/mpeg')).toBe('audio');
    expect(attachmentKindFor('video/mp4')).toBe('video');
    expect(attachmentKindFor('application/pdf')).toBe('file');
    expect(attachmentKindFor('', 'shot.JPG')).toBe('image');
    expect(attachmentKindFor('', 'clip.webm')).toBe('video');
    expect(attachmentKindFor('', 'song.mp3')).toBe('audio');
    expect(attachmentKindFor('', 'doc.pdf')).toBe('file');
  });
});

describe('attachmentToContentPart', () => {
  it('sends images as image_url parts', () => {
    expect(
      attachmentToContentPart({
        id: '1',
        kind: 'image',
        name: 'a.png',
        url: 'data:image/png;base64,AA',
      }),
    ).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } });
  });

  it('sends inline audio as input_audio with the format and raw base64', () => {
    expect(
      attachmentToContentPart({
        id: '1',
        kind: 'audio',
        name: 'a.wav',
        url: 'data:audio/wav;base64,QUJD',
      }),
    ).toEqual({ type: 'input_audio', input_audio: { data: 'QUJD', format: 'wav' } });
  });

  it('sends a remote audio URL as a file part', () => {
    expect(
      attachmentToContentPart({ id: '1', kind: 'audio', name: 'a.mp3', url: 'https://cdn/a.mp3' }),
    ).toEqual({ type: 'file', file: { url: 'https://cdn/a.mp3', filename: 'a.mp3' } });
  });

  it('sends a data-URI document as a file part with file_data', () => {
    expect(
      attachmentToContentPart({
        id: '1',
        kind: 'file',
        name: 'doc.pdf',
        url: 'data:application/pdf;base64,QUJD',
      }),
    ).toEqual({
      type: 'file',
      file: { file_data: 'data:application/pdf;base64,QUJD', filename: 'doc.pdf' },
    });
  });
});

describe('PlaygroundRunOptions', () => {
  it('shows the attachment controls only when a text column exists', () => {
    const { container, unmount } = render(() => (
      <PlaygroundRunOptions {...baseProps} mediaKinds={['image']} />
    ));
    expect(container.querySelector('.playground-options__url')).toBeNull();
    unmount();

    const second = render(() => <PlaygroundRunOptions {...baseProps} mediaKinds={['text']} />);
    expect(second.container.querySelector('.playground-options__url')).not.toBeNull();
  });

  it('adds an attachment from a pasted URL', () => {
    const onAttachmentsChange = vi.fn();
    const { container } = render(() => (
      <PlaygroundRunOptions {...baseProps} onAttachmentsChange={onAttachmentsChange} />
    ));
    const input = container.querySelector<HTMLInputElement>('.playground-options__url')!;
    fireEvent.input(input, { target: { value: 'https://cdn.example/pic.png' } });
    fireEvent.click(
      Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Add URL')!,
    );

    expect(onAttachmentsChange).toHaveBeenCalledTimes(1);
    const added = onAttachmentsChange.mock.calls[0][0];
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      kind: 'image',
      name: 'pic.png',
      url: 'https://cdn.example/pic.png',
    });
  });

  it('rejects a non-http URL', () => {
    const onError = vi.fn();
    const { container } = render(() => <PlaygroundRunOptions {...baseProps} onError={onError} />);
    const input = container.querySelector<HTMLInputElement>('.playground-options__url')!;
    fireEvent.input(input, { target: { value: 'ftp://nope' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onError).toHaveBeenCalledWith('Enter an http(s) URL');
  });

  it('uploads a local file of any type', async () => {
    const onAttachmentsChange = vi.fn();
    const { container } = render(() => (
      <PlaygroundRunOptions {...baseProps} onAttachmentsChange={onAttachmentsChange} />
    ));
    const input = container.querySelector<HTMLInputElement>('.playground-options__file-input')!;
    const file = new File(['hello'], 'clip.mp4', { type: 'video/mp4' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    fireEvent.change(input);

    await waitFor(() => expect(onAttachmentsChange).toHaveBeenCalledTimes(1));
    expect(onAttachmentsChange.mock.calls[0][0][0]).toMatchObject({
      kind: 'video',
      name: 'clip.mp4',
    });
  });

  it('removes an existing attachment', () => {
    const onAttachmentsChange = vi.fn();
    const { container } = render(() => (
      <PlaygroundRunOptions
        {...baseProps}
        attachments={[{ id: 'a1', kind: 'image', name: 'a.png', url: 'data:image/png;base64,AA' }]}
        onAttachmentsChange={onAttachmentsChange}
      />
    ));
    fireEvent.click(container.querySelector('.playground-options__remove')!);
    expect(onAttachmentsChange).toHaveBeenCalledWith([]);
  });

  it('shows a thumbnail for an image and a kind chip otherwise', () => {
    const { container } = render(() => (
      <PlaygroundRunOptions
        {...baseProps}
        attachments={[
          { id: 'a1', kind: 'image', name: 'a.png', url: 'data:image/png;base64,AA' },
          { id: 'a2', kind: 'file', name: 'doc.pdf', url: 'https://cdn/doc.pdf' },
        ]}
      />
    ));
    expect(container.querySelector('img.playground-options__thumb')).not.toBeNull();
    expect(container.querySelector('.playground-options__kind')?.textContent).toBe('FILE');
  });

  it('reveals media options and reports edits', () => {
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
    )!;
    fireEvent.input(sizeInput, { target: { value: '2K' } });
    expect(onMediaChange).toHaveBeenCalledWith(expect.objectContaining({ size: '2K' }));
  });

  it('reveals video-only fields for a video column', () => {
    const { container } = render(() => (
      <PlaygroundRunOptions {...baseProps} mediaKinds={['video']} />
    ));
    fireEvent.click(container.querySelector('.playground-options__toggle')!);
    expect(container.textContent).toContain('Seconds');
    expect(container.textContent).toContain('First frame URL');
    expect(container.textContent).not.toContain('Format');
  });
});

describe('addAttachmentFiles', () => {
  it('inlines a file as a data URL and classifies its kind', async () => {
    const file = new File(['hello'], 'pasted.png', { type: 'image/png' });
    const next = await addAttachmentFiles([], [file]);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ kind: 'image', name: 'pasted.png' });
    expect(next[0]!.url.startsWith('data:image/png')).toBe(true);
  });

  it('rejects oversized files', async () => {
    const onError = vi.fn();
    const big = new File([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], 'big.bin');
    const next = await addAttachmentFiles([], [big], onError);
    expect(next).toHaveLength(0);
    expect(onError).toHaveBeenCalledWith('big.bin is larger than 8 MB');
  });
});
