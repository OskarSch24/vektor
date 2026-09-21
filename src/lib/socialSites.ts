/**
 * Sites whose page count makes mapping meaningless.
 *
 * A social platform has no bounded set of pages: the sitemap covers millions of
 * profiles, the feed is generated per visitor, and most of it sits behind a
 * login. "Map the whole site" there is not a large job — it is one with no end,
 * and it would spend the user's API budget on navigation chrome.
 *
 * Single posts from these platforms are still perfectly good input. It is only
 * the whole-site mode that is switched off.
 *
 * The extension carries the same list so the toggle can be disabled before the
 * user clicks it. This copy is the one that decides: a request that reaches the
 * app is refused here regardless of what the popup allowed.
 */

const SOCIAL_HOSTS: Record<string, string> = {
  'facebook.com': 'Facebook',
  'instagram.com': 'Instagram',
  'threads.net': 'Threads',
  'threads.com': 'Threads',
  'tiktok.com': 'TikTok',
  'x.com': 'X',
  'twitter.com': 'X',
  'linkedin.com': 'LinkedIn',
  'reddit.com': 'Reddit',
  'youtube.com': 'YouTube',
  'youtu.be': 'YouTube',
  'pinterest.com': 'Pinterest',
  'pinterest.de': 'Pinterest',
  'snapchat.com': 'Snapchat',
  'tumblr.com': 'Tumblr',
  'bsky.app': 'Bluesky',
  'mastodon.social': 'Mastodon',
  'twitch.tv': 'Twitch',
  'vk.com': 'VK',
  'weibo.com': 'Weibo',
  'telegram.org': 'Telegram',
  't.me': 'Telegram',
  'discord.com': 'Discord',
  'quora.com': 'Quora',
  'medium.com': 'Medium',
};

/** The platform's name when whole-site mode is off for it, otherwise null. */
export function socialPlatform(url: string): string | null {
  let host: string;
  try {
    host = new URL(url.startsWith('http') ? url : `https://${url}`).hostname.toLowerCase();
  } catch {
    return null;
  }

  host = host.replace(/^www\./, '');

  for (const [candidate, label] of Object.entries(SOCIAL_HOSTS)) {
    if (host === candidate || host.endsWith(`.${candidate}`)) return label;
  }
  return null;
}
