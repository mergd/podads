import { useCallback, useEffect, useRef, useState } from "react";
import { Pause, Play, Spinner } from "@phosphor-icons/react";

import styles from "./InlineAudioPlayer.module.css";

type PlaybackState = "idle" | "loading" | "playing" | "paused";

const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4] as const;

interface InlineAudioPlayerProps {
  buttonText?: string;
  className?: string;
  label: string;
  src: string;
  type?: string | null;
}

function formatTime(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function formatRate(rate: number): string {
  return rate === 1 ? "1x" : `${rate}x`;
}

export function InlineAudioPlayer({ buttonText, className, label, src, type }: InlineAudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [state, setState] = useState<PlaybackState>("idle");
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(1);
  const [isSeeking, setIsSeeking] = useState(false);

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

  const handleSeekStart = useCallback(() => {
    setIsSeeking(true);
  }, []);

  const handleSeekInput = useCallback((e: React.FormEvent<HTMLInputElement>) => {
    setCurrentTime(Number(e.currentTarget.value));
  }, []);

  const handleSeekEnd = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const audio = audioRef.current;
    if (audio) {
      audio.currentTime = Number(e.target.value);
    }
    setIsSeeking(false);
  }, []);

  const handleRateChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const audio = audioRef.current;
    if (!audio) return;
    const next = Number(e.target.value);
    if (!Number.isFinite(next)) return;
    audio.playbackRate = next;
    setRate(next);
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    function onPlay() { setState("playing"); }
    function onPause() { setState("paused"); }
    function onWaiting() { setState("loading"); }
    function onPlaying() { setState("playing"); }
    function onTimeUpdate() {
      if (!isSeeking) setCurrentTime(audio!.currentTime);
    }
    function onLoadedMetadata() { setDuration(audio!.duration); }
    function onEnded() { setState("paused"); }

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
  }, [isSeeking]);

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
            onChange={handleSeekEnd}
            onInput={handleSeekInput}
            onMouseDown={handleSeekStart}
            onTouchStart={handleSeekStart}
            step={0.1}
            type="range"
            value={currentTime}
          />
        </div>

        <span className={styles.time}>
          {formatTime(currentTime)}
          {duration > 0 ? ` / ${formatTime(duration)}` : ""}
        </span>

        <label className={styles.rateField}>
          <span className={styles.rateLabel}>Speed</span>
          <select
            aria-label="Playback speed"
            className={styles.rateSelect}
            onChange={handleRateChange}
            value={String(rate)}
          >
            {PLAYBACK_RATES.map((playbackRate) => (
              <option key={playbackRate} value={playbackRate}>
                {formatRate(playbackRate)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <audio ref={audioRef} preload="none">
        <source src={src} type={type ?? undefined} />
      </audio>
    </div>
  );
}
