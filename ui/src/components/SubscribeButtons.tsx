import { useState } from "react";
import { Dialog } from "@base-ui/react/dialog";

import applePodcastsIcon from "../assets/players/apple-podcasts.svg";
import castroIcon from "../assets/players/castro.svg";
import overcastIcon from "../assets/players/overcast.svg";
import pocketCastsIcon from "../assets/players/pocket-casts.svg";
import spotifyIcon from "../assets/players/spotify.svg";
import youtubeMusicIcon from "../assets/players/youtube-music.svg";
import styles from "./SubscribeButtons.module.css";

interface Player {
  name: string;
  icon: string;
  buildUrl: (feedUrl: string) => string;
}

const players: Player[] = [
  {
    name: "Apple Podcasts",
    icon: applePodcastsIcon,
    buildUrl: (url) => url.replace(/^https?:\/\//, "podcast://"),
  },
  {
    name: "Overcast",
    icon: overcastIcon,
    buildUrl: (url) => `overcast://x-callback-url/add?url=${encodeURIComponent(url)}`,
  },
  {
    name: "Pocket Casts",
    icon: pocketCastsIcon,
    buildUrl: (url) => `pktc://subscribe/${url}`,
  },
  {
    name: "Castro",
    icon: castroIcon,
    buildUrl: (url) => `castro://subscribe/${url}`,
  },
  {
    name: "Spotify",
    icon: spotifyIcon,
    buildUrl: (url) => `spotify:subscribe:${encodeURIComponent(url)}`,
  },
  {
    name: "YouTube Music",
    icon: youtubeMusicIcon,
    buildUrl: (url) => `https://music.youtube.com/podcasts?url=${encodeURIComponent(url)}`,
  },
];

interface SubscribeButtonsProps {
  feedUrl: string;
}

export function SubscribeButtons({ feedUrl }: SubscribeButtonsProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopyRss() {
    await navigator.clipboard.writeText(feedUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Dialog.Root>
      <Dialog.Trigger className={styles.trigger}>
        Add to podcast player
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className={styles.backdrop} />
        <Dialog.Viewport>
          <Dialog.Popup className={styles.popup}>
            <Dialog.Title className={styles.title}>Add to podcast player</Dialog.Title>
            <Dialog.Description className={styles.subtitle}>
              Choose your preferred app to subscribe to this feed.
            </Dialog.Description>

            <div className={styles.grid}>
              {players.map((player) => (
                <a
                  className={styles.playerCard}
                  href={player.buildUrl(feedUrl)}
                  key={player.name}
                >
                  <img alt="" className={styles.playerIcon} src={player.icon} />
                  <span className={styles.playerName}>{player.name}</span>
                </a>
              ))}
            </div>

            <div className={styles.rssRow}>
              <code className={styles.rssUrl}>{feedUrl}</code>
              <button className={styles.copyButton} onClick={handleCopyRss} type="button">
                {copied ? "Copied!" : "Copy RSS"}
              </button>
            </div>

            <Dialog.Close className={styles.closeButton} aria-label="Close">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M12 4L4 12M4 4l8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </Dialog.Close>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
