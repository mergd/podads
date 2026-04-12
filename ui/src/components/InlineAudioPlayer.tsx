import styles from "./InlineAudioPlayer.module.css";

interface InlineAudioPlayerProps {
  className?: string;
  label: string;
  src: string;
  type?: string | null;
}

export function InlineAudioPlayer({ className, label, src, type }: InlineAudioPlayerProps) {
  const rootClassName = className ? `${styles.wrap} ${className}` : styles.wrap;

  return (
    <div className={rootClassName}>
      <audio aria-label={label} className={styles.player} controls preload="none">
        <source src={src} type={type ?? undefined} />
        Your browser does not support inline audio playback. <a href={src}>Open the audio file.</a>
      </audio>
    </div>
  );
}
