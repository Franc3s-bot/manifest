import { createSignal, For, Show, type Component } from 'solid-js';
import type { PlaygroundOutputKind } from 'manifest-shared';
import type { PlaygroundMediaOptions } from '../../services/playground-store.js';

/** One image attached to a multimodal chat prompt. */
export interface PlaygroundAttachment {
  id: string;
  name: string;
  /** `data:` URI sent to the model as an `image_url` part. */
  dataUrl: string;
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
  /** Surfaced when a file is rejected (too large / too many / not an image). */
  onError?: (message: string) => void;
}

let attachmentCounter = 0;
const nextAttachmentId = (): string => `att-${++attachmentCounter}-${Date.now().toString(36)}`;

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

/**
 * Validate + inline image files as attachments. Exported so the prompt's paste
 * handler can reuse the exact same rules (type, size, count).
 */
export async function addAttachmentFiles(
  existing: PlaygroundAttachment[],
  files: FileList | File[],
  onError?: (message: string) => void,
): Promise<PlaygroundAttachment[]> {
  const next = [...existing];
  for (const file of Array.from(files)) {
    if (!file.type.startsWith('image/')) {
      onError?.(`${file.name}: only image files are supported`);
      continue;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      onError?.(`${file.name} is larger than 8 MB`);
      continue;
    }
    if (next.length >= MAX_ATTACHMENTS) {
      onError?.(`At most ${MAX_ATTACHMENTS} attachments per prompt`);
      break;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      next.push({ id: nextAttachmentId(), name: file.name, dataUrl });
    } catch {
      onError?.(`Could not read ${file.name}`);
    }
  }
  return next;
}

/**
 * Run-level input controls shared by every column: multimodal image
 * attachments for chat columns and generation options for image / video
 * columns. Attachments are inlined as `data:` URIs so the backend can forward
 * them to any provider without an upload round-trip.
 */
const PlaygroundRunOptions: Component<Props> = (props) => {
  const [mediaOpen, setMediaOpen] = createSignal(false);
  let fileInput: HTMLInputElement | undefined;

  const hasMedia = () => props.mediaKinds.includes('image') || props.mediaKinds.includes('video');
  const hasText = () => props.mediaKinds.includes('text');

  const handleFiles = async (files: FileList | File[]) => {
    const next = await addAttachmentFiles(props.attachments, files, props.onError);
    props.onAttachmentsChange(next);
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
          <button
            type="button"
            class="playground-options__attach"
            disabled={props.disabled}
            onClick={() => fileInput?.click()}
            title="Attach images (vision)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M16.5 6v11.5a4.5 4.5 0 0 1-9 0V6a3 3 0 0 1 6 0v11a1.5 1.5 0 0 1-3 0V7H9v10a3 3 0 0 0 6 0V6a4.5 4.5 0 0 0-9 0v11.5a6 6 0 0 0 12 0V6z" />
            </svg>
            <span>Images</span>
          </button>
          <input
            ref={(el) => {
              fileInput = el;
            }}
            type="file"
            accept="image/*"
            multiple
            class="playground-options__file-input"
            onChange={(event) => {
              const files = event.currentTarget.files;
              if (files) void handleFiles(files);
              event.currentTarget.value = '';
            }}
          />
          <For each={props.attachments}>
            {(attachment) => (
              <span class="playground-options__thumb">
                <img src={attachment.dataUrl} alt={attachment.name} title={attachment.name} />
                <button
                  type="button"
                  class="playground-options__thumb-remove"
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
              </span>
            )}
          </For>
        </div>
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
