import { Show, createSignal, type Component } from 'solid-js';
import DitherGround from './DitherGround.jsx';
import { API_BOT_URL } from './ApiBotBanner.jsx';

const API_BOT_CARD_DISMISSED_KEY = 'api-bot-card-dismissed';

/**
 * Sidebar card announcing API Bot, on API Bot's dithered ground. Shows for
 * everyone in every deployment mode with a per-session dismiss.
 */
const ApiBotAnnouncement: Component = () => {
  const [dismissed, setDismissed] = createSignal(
    sessionStorage.getItem(API_BOT_CARD_DISMISSED_KEY) === '1',
  );

  const dismiss = () => {
    sessionStorage.setItem(API_BOT_CARD_DISMISSED_KEY, '1');
    setDismissed(true);
  };

  return (
    <Show when={!dismissed()}>
      <div class="sidebar-api-bot">
        <DitherGround />
        <button
          type="button"
          class="api-bot-close sidebar-api-bot__close"
          title="Hide for this session"
          aria-label="Hide the announcement for this session"
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
        <img
          class="sidebar-api-bot__image"
          src="/api-bot-works-with-any-api.svg"
          alt="API Bot works with any API"
          width="1600"
          height="720"
        />
        <span class="sidebar-api-bot__title">Meet API Bot</span>
        <p class="sidebar-api-bot__text">API changes won't take your app down anymore.</p>
        <a href={API_BOT_URL} target="_blank" rel="noopener noreferrer" class="api-bot-btn">
          Get started
        </a>
      </div>
    </Show>
  );
};

export default ApiBotAnnouncement;
