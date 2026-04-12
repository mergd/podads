import { useCallback, useEffect, useRef, useState } from "react";
import { Pause, Play, Spinner } from "@phosphor-icons/react";

import styles from "./InlineAudioPlayer.module.css";

type PlaybackState = "idle" | "loading" | "playing" | "paused";

interface InlineAudioPlayerProps {
  buttonText?: string;
  className?: string;
  label: string;
  src: string;
  type?: string | null;
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export function InlineAudioPlayer({ buttonText, className, label, src, type }: InlineAudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [state, setState] = useState<PlaybackState>("idle");
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const handleToggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;

    switch (state) {
      case "idle":
        setState("loading");
        audio.load();
        void audio.play();
        break;
      case "paused":
        void audio.play();
        break;
      case "playing":
        audio.pause();
        break;
      case "loading":
        break;
    }
  }, [state]);

  const handleSeek = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    audio.currentTime = Number(e.target.value);
  }, [duration]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    function onPlay() {
      setState("playing");
    }
    function onPause() {
      setState("paused");
    }
    function onWaiting() {
      setState("loading");
    }
    function onPlaying() {
      setState("playing");
    }
    function onTimeUpdate() {
      setCurrentTime(audio!.currentTime);
    }
    function onLoadedMetadata() {
      setDuration(audio!.duration);
    }
    function onEnded() {
      setState("paused");
    }

    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("waiting", onWaiting);
    audio.addEventListener("playing", onPlaying);
    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("loadedmetadata", onLoadedMetadata);
    audio.addEventListener("ended", onEnded);

    return () => {
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("waiting", onWaiting);
      audio.removeEventListener("playing", onPlaying);
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("ended", onEnded);
    };
  }, []);

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;
  const isActive = state !== "idle";
  const rootClassName = className ? `${styles.root} ${className}` : styles.root;

  if (!isActive) {
    return (
      <div className={rootClassName}>
        <button aria-label={label} className={styles.trigger} onClick={handleToggle} type="button">
          <Play weight="fill" size={16} />
          {buttonText ? <span>{buttonText}</span> : null}
        </button>
        <audio ref={audioRef} preload="none">
          <source src={src} type={type ?? undefined} />
        </audio>
      </div>
    );
  }

  return (
    <div className={rootClassName}>
      <div className={styles.player}>
        <button
          aria-label={state === "playing" ? "Pause" : "Play"}
          className={styles.playPause}
          onClick={handleToggle}
          type="button"
        >
          {state === "loading" ? (
            <Spinner className={styles.spinner} size={16} />
          ) : state === "playing" ? (
            <Pause weight="fill" size={16} />
          ) : (
            <Play weight="fill" size={16} />
          )}
        </button>

        <div className={styles.track}>
          <div className={styles.trackFill} style={{ width: `${progress}%` }} />
          <input
            aria-label="Seek"
            className={styles.seekInput}
            max={duration || 0}
            min={0}
            onChange={handleSeek}
            step={0.1}
            type="range"
            value={currentTime}
          />
        </div>

        <span className={styles.time}>
          {formatTime(currentTime)}
          {duration > 0 ? ` / ${formatTime(duration)}` : ""}
        </span>
      </div>

      <audio ref={audioRef} preload="none">
        <source src={src} type={type ?? undefined} />
      </audio>
    </div>
  );
}
