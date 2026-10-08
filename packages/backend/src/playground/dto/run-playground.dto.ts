import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  Validate,
  ValidateNested,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AUTH_TYPES, PLAYGROUND_OUTPUT_KINDS } from 'manifest-shared';

/**
 * A single OpenAI-style content part. Multimodal chat sends the prompt as a
 * `[{ type: 'text' }, { type: 'image_url' }]` array; the proxy's provider
 * adapters translate that into native Anthropic / Google blocks. Text-only
 * clients keep sending a plain string.
 */
/** Per-message cap on the visible prompt text (image data URIs are exempt). */
const MAX_MESSAGE_TEXT_LENGTH = 50_000;

@ValidatorConstraint({ name: 'PlaygroundMessageContent', async: false })
export class PlaygroundMessageContentConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value === 'string') {
      return value.length > 0 && value.length <= MAX_MESSAGE_TEXT_LENGTH;
    }
    if (!Array.isArray(value) || value.length === 0) return false;
    let textLength = 0;
    for (const part of value) {
      if (part === null || typeof part !== 'object' || Array.isArray(part)) return false;
      const record = part as Record<string, unknown>;
      const type = record['type'];
      if (typeof type !== 'string') return false;
      // `text` parts carry their own text; image parts carry an `image_url`
      // (string or `{ url }`) that the provider adapters understand.
      if (type === 'text') {
        if (typeof record['text'] !== 'string') return false;
        textLength += record['text'].length;
        if (textLength > MAX_MESSAGE_TEXT_LENGTH) return false;
        continue;
      }
      if (type === 'image_url' || type === 'input_image') {
        const image = record['image_url'] ?? record['image'];
        if (typeof image === 'string') {
          if (image.length === 0) return false;
          continue;
        }
        if (
          image === null ||
          typeof image !== 'object' ||
          typeof (image as Record<string, unknown>)['url'] !== 'string'
        ) {
          return false;
        }
        continue;
      }
      // OpenAI-style inline audio: `{ input_audio: { data, format } }`.
      if (type === 'input_audio') {
        const audio = record['input_audio'];
        if (audio === null || typeof audio !== 'object') return false;
        const a = audio as Record<string, unknown>;
        if (typeof a['data'] !== 'string' || a['data'].length === 0) return false;
        if (typeof a['format'] !== 'string' || a['format'].length === 0) return false;
        continue;
      }
      // Generic attachment (PDF, video, other): a URL or a data URI plus an
      // optional filename. Providers translate it to their native block.
      if (type === 'file') {
        const file = record['file'];
        if (file === null || typeof file !== 'object') return false;
        const f = file as Record<string, unknown>;
        const hasData = typeof f['file_data'] === 'string' && f['file_data'].length > 0;
        const hasUrl = typeof f['url'] === 'string' && f['url'].length > 0;
        if (!hasData && !hasUrl) return false;
        if (f['filename'] !== undefined && typeof f['filename'] !== 'string') return false;
        continue;
      }
      return false;
    }
    return true;
  }

  defaultMessage(): string {
    return 'content must be a non-empty string or an array of text/image/audio/file parts';
  }
}

export class PlaygroundMessageDto {
  @IsString()
  @IsIn(['system', 'user', 'assistant'])
  role!: string;

  @Validate(PlaygroundMessageContentConstraint)
  content!: string | Record<string, unknown>[];
}

/**
 * Constraint asserting exactly one payload shape is set.
 *
 * `messages` is the chat-completions shape Manifest builds itself; `prompt`
 * is the media-generation shape (image / video); `rawRequestBody` (replay,
 * future) ships the verbatim recorded payload. Allowing more than one is
 * ambiguous (which wins?); allowing none is a silent no-op upstream.
 * Exactly-one is the only safe contract.
 */
@ValidatorConstraint({ name: 'PlaygroundPayloadShape', async: false })
export class PlaygroundPayloadShapeConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const obj = args.object as { messages?: unknown; rawRequestBody?: unknown; prompt?: unknown };
    const hasMessages = Array.isArray(obj.messages) && obj.messages.length > 0;
    const hasRaw =
      obj.rawRequestBody != null &&
      typeof obj.rawRequestBody === 'object' &&
      !Array.isArray(obj.rawRequestBody);
    const hasPrompt = typeof obj.prompt === 'string' && obj.prompt.trim().length > 0;
    const shapes = [hasMessages, hasRaw, hasPrompt].filter(Boolean).length;
    return shapes === 1;
  }

  defaultMessage(): string {
    return 'exactly one of `messages`, `prompt`, or `rawRequestBody` must be provided';
  }
}

export class RunPlaygroundDto {
  /**
   * @deprecated Ignored by the backend — the Playground always runs under
   * the reserved per-tenant Playground agent. Kept optional so existing
   * clients that still send it don't fail whitelist validation.
   */
  @IsOptional()
  @IsString()
  agentName?: string;

  @IsString()
  @IsNotEmpty()
  // The XOR shape check is attached here (a non-optional field) rather than
  // to `messages` / `prompt` / `rawRequestBody`, because @IsOptional() on
  // those fields short-circuits @Validate when the field is undefined —
  // letting a payload with none (or several) set slip past the DTO. Model is
  // always present, so the validator always runs.
  @Validate(PlaygroundPayloadShapeConstraint)
  model!: string;

  @IsString()
  @IsNotEmpty()
  provider!: string;

  @IsOptional()
  @IsIn(AUTH_TYPES)
  authType?: 'api_key' | 'subscription' | 'local';

  /**
   * Optional provider key label to target a specific connection when multiple
   * keys exist for this provider.
   */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  providerKeyLabel?: string;

  /**
   * Harness (agent) whose header tier a synthetic `auto-*` model should
   * resolve against. The Playground runs under the reserved Playground agent,
   * which owns no tiers, so a synthetic run names the harness that defines the
   * tier. Ignored for a non-synthetic model.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  harness?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => PlaygroundMessageDto)
  messages?: PlaygroundMessageDto[];

  /**
   * Plain-text prompt for an image / video generation run. Mutually exclusive
   * with `messages` and `rawRequestBody`.
   */
  @IsOptional()
  @IsString()
  @MaxLength(50_000)
  prompt?: string;

  /**
   * Output modality to run. Optional: when omitted the backend infers it from
   * the selected model's advertised output modalities. Sending it explicitly
   * lets the client pin a modality (and force the media surface) for a model
   * whose modality discovery is ambiguous.
   */
  @IsOptional()
  @IsIn(PLAYGROUND_OUTPUT_KINDS)
  outputKind?: 'text' | 'image' | 'video';

  /* ── Image generation options ─────────────────────────────────── */

  /** Number of images to generate. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  n?: number;

  /** Output size: a provider tier (`1K`, `2K`, …) or exact `WIDTHxHEIGHT`. */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  size?: string;

  /** Aspect ratio, e.g. `16:9`. */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  ratio?: string;

  /** `url` (default) or `b64_json`. */
  @IsOptional()
  @IsIn(['url', 'b64_json'])
  responseFormat?: 'url' | 'b64_json';

  /** Reference images for image-to-image / composition (URL or data URI). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  referenceImages?: string[];

  /* ── Video generation options ─────────────────────────────────── */

  /** Output duration in seconds. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(120)
  seconds?: number;

  /** Generation mode: text-to-video, keyframe control, or reference inputs. */
  @IsOptional()
  @IsIn(['text', 'keyframe', 'reference'])
  mode?: 'text' | 'keyframe' | 'reference';

  /** First-frame image URL for keyframe mode. */
  @IsOptional()
  @IsString()
  @MaxLength(500_000)
  firstFrame?: string;

  /** Last-frame image URL for keyframe mode. */
  @IsOptional()
  @IsString()
  @MaxLength(500_000)
  lastFrame?: string;

  /**
   * Verbatim recorded request body, replayed as-is. Optional today —
   * the future "replay a recorded query" flow will set this and leave
   * `messages` empty. Validated only for size and basic shape; the
   * provider client treats it as an opaque JSON object.
   */
  @IsOptional()
  @IsObject()
  rawRequestBody?: Record<string, unknown>;

  /**
   * Client-generated identifier linking every column of the same UI submit
   * into one playground_runs row. Optional — when omitted a standalone run
   * record is created. When provided, reused if the run already exists.
   */
  @IsOptional()
  @IsUUID()
  runId?: string;

  /**
   * 0-indexed position of this column within its run, used to preserve
   * column order when rendering history.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(20)
  position?: number;

  /**
   * Extra HTTP headers to attach to the outgoing provider request.
   * Sanitized server-side — Manifest-managed and transport-layer headers
   * are silently dropped.
   */
  @IsOptional()
  @IsObject()
  requestHeaders?: Record<string, string>;
}
