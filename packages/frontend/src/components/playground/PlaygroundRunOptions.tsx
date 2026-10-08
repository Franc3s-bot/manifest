import { createSignal, For, Show, type Component } from 'solid-js';
import type { PlaygroundOutputKind } from 'manifest-shared';
import type { PlaygroundContentPart } from '../../services/api.js';
import type { PlaygroundMediaOptions } from '../../services/playground-store.js';

export type PlaygroundAttachmentKind = 'image' | 'audio' | 'video' | 'file';

/** One attachment on a multimodal chat prompt: a URL or an inlined local file. */
export interface PlaygroundAttachment {
  id: string;
  kind: PlaygroundAttachmentKind;
  name: string;
  /** Public URL or `data:` URI. */
  url: string;
}

export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

interface Props {
  attachments: PlaygroundAttachment[];
  onAttachmentsChange: (attachments: PlaygroundAttachment[]) => void;
  /** Media output kinds present in the current column set. */
  mediaKinds: PlaygroundOutputKind[];
  media: PlaygroundMediaOptions;
  onMediaChange: (media: PlaygroundMediaOptions) => void;
  disabled?: boolean;
  /** Surfaced when a file/URL is rejected (too large / too many / unsupported). */
  onError?: (message: string) => void;
}

let attachmentCounter = 0;
const nextAttachmentId = (): string => `att-${++attachmentCounter}-${Date.now().toString(36)}`;

/** Map a MIME type to the attachment kind the provider adapters understand. */
export function attachmentKindFor(mime: string, name = ''): PlaygroundAttachmentKind {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) return 'image';
  if (['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'].includes(ext)) return 'audio';
  if (['mp4', 'webm', 'mov', 'mkv'].includes(ext)) return 'video';
  return 'file';
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

/**
 * Validate + inline files as attachments. Accepts any file type (image, audio,
 * video, PDF, …); the kind drives how it is forwarded to the provider.
 * Exported so the prompt's paste handler reuses the exact same rules.
 */
export async function addAttachmentFiles(
  existing: PlaygroundAttachment[],
  files: FileList | File[],
  onError?: (message: string) => void,
): Promise<PlaygroundAttachment[]> {
  const next = [...existing];
  for (const file of Array.from(files)) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      onError?.(`${file.name} is larger than 8 MB`);
      continue;
    }
    if (next.length >= MAX_ATTACHMENTS) {
      onError?.(`At most ${MAX_ATTACHMENTS} attachments per prompt`);
      break;
    }
    try {
      const url = await readFileAsDataUrl(file);
      next.push({
        id: nextAttachmentId(),
        kind: attachmentKindFor(file.type, file.name),
        name: file.name,
        url,
      });
    } catch {
      onError?.(`Could not read ${file.name}`);
    }
  }
  return next;
}

/**
 * Turn an attachment into the OpenAI-style content part the backend forwards.
 * Images ride as `image_url`; inline audio as `input_audio`; everything else as
 * a generic `file` part (data URI or URL) that the provider adapters translate
 * to their native block.
 */
export function attachmentToContentPart(attachment: PlaygroundAttachment): PlaygroundContentPart {
  if (attachment.kind === 'image') {
    return { type: 'image_url', image_url: { url: attachment.url } };
  }
  if (attachment.kind === 'audio') {
    const match = /^data:audio\/([^;,]+)(?:;[^,]*)?;base64,(.*)$/is.exec(attachment.url);
    if (match) {
      return { type: 'input_audio', input_audio: { data: match[2]!, format: match[1]! } };
    }
  }
  return {
    type: 'file',
    file: {
      ...(attachment.url.startsWith('data:')
        ? { file_data: attachment.url }
        : { url: attachment.url }),
      filename: attachment.name,
    },
  };
}

/** Best-effort name for a pasted URL. */
function nameFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname;
    const last = path.split('/').filter(Boolean).pop();
    return last || 'attachment';
  } catch {
    return 'attachment';
  }
}

const KIND_LABEL: Record<PlaygroundAttachmentKind, string> = {
  image: 'IMG',
  audio: 'AUD',
  video: 'VID',
  file: 'FILE',
};

/**
 * Run-level input controls shared by every column: multimodal attachments for
 * chat columns (by URL or local file) and generation options for image / video
 * columns.
 */
const PlaygroundRunOptions: Component<Props> = (props) => {
  const [mediaOpen, setMediaOpen] = createSignal(false);
  const [urlDraft, setUrlDraft] = createSignal('');
  let fileInput: HTMLInputElement | undefined;

  const hasMedia = () => props.mediaKinds.includes('image') || props.mediaKinds.includes('video');
  const hasText = () => props.mediaKinds.includes('text');

  const handleFiles = async (files: FileList | File[]) => {
    const next = await addAttachmentFiles(props.attachments, files, props.onError);
    props.onAttachmentsChange(next);
  };

  const addUrl = () => {
    const url = urlDraft().trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) {
      props.onError?.('Enter an http(s) URL');
      return;
    }
    if (props.attachments.length >= MAX_ATTACHMENTS) {
      props.onError?.(`At most ${MAX_ATTACHMENTS} attachments per prompt`);
      return;
    }
    const name = nameFromUrl(url);
    props.onAttachmentsChange([
      ...props.attachments,
      { id: nextAttachmentId(), kind: attachmentKindFor('', name), name, url },
    ]);
    setUrlDraft('');
  };

  const update = <K extends keyof PlaygroundMediaOptions>(
    key: K,
    value: PlaygroundMediaOptions[K],
  ) => {
    props.onMediaChange({ ...props.media, [key]: value });
  };

  const numberOrUndefined = (value: string): number | undefined => {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };

  return (
    <div class="playground-options">
      <Show when={hasText()}>
        <div class="playground-options__row">
          <input
            type="url"
            class="playground-options__url"
            placeholder="Paste an image / audio / video / PDF URL…"
            value={urlDraft()}
            disabled={props.disabled}
            onInput={(e) => setUrlDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addUrl();
              }
            }}
            aria-label="Attachment URL"
          />
          <button
            type="button"
            class="playground-options__attach"
            disabled={props.disabled || urlDraft().trim().length === 0}
            onClick={addUrl}
          >
            Add URL
          </button>
          <button
            type="button"
            class="playground-options__attach"
            disabled={props.disabled}
            onClick={() => fileInput?.click()}
            title="Upload a file from disk"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 3l4 4h-3v6h-2V7H8zm-7 14h14v2H5z" />
            </svg>
            <span>Upload</span>
          </button>
          <input
            ref={(el) => {
              fileInput = el;
            }}
            type="file"
            multiple
            class="playground-options__file-input"
            onChange={(event) => {
              const files = event.currentTarget.files;
              if (files) void handleFiles(files);
              event.currentTarget.value = '';
            }}
          />
        </div>
        <Show when={props.attachments.length > 0}>
          <ul class="playground-options__list">
            <For each={props.attachments}>
              {(attachment) => (
                <li class="playground-options__item">
                  <Show
                    when={attachment.kind === 'image'}
                    fallback={
                      <span class="playground-options__kind" title={attachment.kind}>
                        {KIND_LABEL[attachment.kind]}
                      </span>
                    }
                  >
                    <img
                      class="playground-options__thumb"
                      src={attachment.url}
                      alt={attachment.name}
                    />
                  </Show>
                  <span class="playground-options__name" title={attachment.url}>
                    {attachment.name}
                  </span>
                  <button
                    type="button"
                    class="playground-options__remove"
                    aria-label={`Remove ${attachment.name}`}
                    disabled={props.disabled}
                    onClick={() =>
                      props.onAttachmentsChange(
                        props.attachments.filter((a) => a.id !== attachment.id),
                      )
                    }
                  >
                    ×
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>

      <Show when={hasMedia()}>
        <div class="playground-options__row playground-options__row--media">
          <button
            type="button"
            class="playground-options__toggle"
            aria-expanded={mediaOpen()}
            disabled={props.disabled}
            onClick={() => setMediaOpen((v) => !v)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M3 5h18v14H3zm2 2v10h14V7zm2 8 3-4 2.5 3 2-2.5L17 15z" />
            </svg>
            <span>Media options</span>
            <svg
              class="playground-options__caret"
              classList={{ 'playground-options__caret--open': mediaOpen() }}
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <path d="M17.35 8H6.65c-.64 0-.99.76-.56 1.24l5.35 6.11c.3.34.83.34 1.13 0l5.35-6.11C18.34 8.76 18 8 17.36 8Z" />
            </svg>
          </button>
        </div>
        <Show when={mediaOpen()}>
          <div class="playground-options__panel">
            <label class="playground-options__field">
              <span>Size</span>
              <input
                type="text"
                placeholder="1K / 1024x1024"
                value={props.media.size ?? ''}
                disabled={props.disabled}
                onInput={(e) => update('size', e.currentTarget.value || undefined)}
              />
            </label>
            <label class="playground-options__field">
              <span>Ratio</span>
              <input
                type="text"
                placeholder="16:9"
                value={props.media.ratio ?? ''}
                disabled={props.disabled}
                onInput={(e) => update('ratio', e.currentTarget.value || undefined)}
              />
            </label>
            <Show when={props.mediaKinds.includes('image')}>
              <label class="playground-options__field">
                <span>Count</span>
                <input
                  type="number"
                  min="1"
                  max="10"
                  value={props.media.n ?? ''}
                  disabled={props.disabled}
                  onInput={(e) => update('n', numberOrUndefined(e.currentTarget.value))}
                />
              </label>
              <label class="playground-options__field">
                <span>Format</span>
                <select
                  value={props.media.responseFormat ?? 'url'}
                  disabled={props.disabled}
                  onChange={(e) =>
                    update(
                      'responseFormat',
                      e.currentTarget.value === 'b64_json' ? 'b64_json' : 'url',
                    )
                  }
                >
                  <option value="url">url</option>
                  <option value="b64_json">b64_json</option>
                </select>
              </label>
            </Show>
            <Show when={props.mediaKinds.includes('video')}>
              <label class="playground-options__field">
                <span>Seconds</span>
                <input
                  type="number"
                  min="1"
                  max="120"
                  value={props.media.seconds ?? ''}
                  disabled={props.disabled}
                  onInput={(e) => update('seconds', numberOrUndefined(e.currentTarget.value))}
                />
              </label>
              <label class="playground-options__field">
                <span>Mode</span>
                <select
                  value={props.media.mode ?? 'text'}
                  disabled={props.disabled}
                  onChange={(e) =>
                    update('mode', e.currentTarget.value as PlaygroundMediaOptions['mode'])
                  }
                >
                  <option value="text">text</option>
                  <option value="keyframe">keyframe</option>
                  <option value="reference">reference</option>
                </select>
              </label>
              <label class="playground-options__field playground-options__field--wide">
                <span>First frame URL</span>
                <input
                  type="text"
                  placeholder="https://…"
                  value={props.media.firstFrame ?? ''}
                  disabled={props.disabled}
                  onInput={(e) => update('firstFrame', e.currentTarget.value || undefined)}
                />
              </label>
              <label class="playground-options__field playground-options__field--wide">
                <span>Last frame URL</span>
                <input
                  type="text"
                  placeholder="https://…"
                  value={props.media.lastFrame ?? ''}
                  disabled={props.disabled}
                  onInput={(e) => update('lastFrame', e.currentTarget.value || undefined)}
                />
              </label>
            </Show>
            <label class="playground-options__field playground-options__field--wide">
              <span>Reference image URLs (comma separated)</span>
              <input
                type="text"
                placeholder="https://…, https://…"
                value={(props.media.referenceImages ?? []).join(', ')}
                disabled={props.disabled}
                onInput={(e) => {
                  const urls = e.currentTarget.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean);
                  update('referenceImages', urls.length > 0 ? urls : undefined);
                }}
              />
            </label>
          </div>
        </Show>
      </Show>
    </div>
  );
};

export default PlaygroundRunOptions;
