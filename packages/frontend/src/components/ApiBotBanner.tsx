import { Show, createSignal, type Component } from 'solid-js';
import DitherGround from './DitherGround.jsx';

export const API_BOT_URL = 'https://manifest.build/api-bot/';
const API_BOT_BANNER_DISMISSED_KEY = 'api-bot-banner-dismissed';

/**
 * Top-of-page banner announcing API Bot, on API Bot's dithered ground. Shows
 * for everyone with a per-session dismiss.
 */
const ApiBotBanner: Component = () => {
  const [dismissed, setDismissed] = createSignal(
    sessionStorage.getItem(API_BOT_BANNER_DISMISSED_KEY) === '1',
  );

  const dismiss = () => {
    sessionStorage.setItem(API_BOT_BANNER_DISMISSED_KEY, '1');
    setDismissed(true);
  };

  return (
    <Show when={!dismissed()}>
      <div class="api-bot-banner">
        <DitherGround />
        <span class="api-bot-banner__text">
          <strong>Introducing API Bot:</strong> keep your app running through upstream API breaking
          changes.
        </span>
        <a href={API_BOT_URL} target="_blank" rel="noopener noreferrer" class="api-bot-btn">
          Get started
        </a>
        <button
          type="button"
          class="api-bot-close"
          title="Hide for this session"
          aria-label="Hide this banner for this session"
          onClick={dismiss}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            fill="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path d="m16.192 6.344-4.243 4.242-4.242-4.242-1.414 1.414L10.535 12l-4.242 4.242 1.414 1.414 4.242-4.242 4.243 4.242 1.414-1.414L13.364 12l4.242-4.242z" />
          </svg>
        </button>
      </div>
    </Show>
  );
};

export default ApiBotBanner;
