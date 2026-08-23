# ad-bench

Transcript-only ad detection bench. Five real Podads episodes, gold spans reviewed from the transcript, each model run 5 times so variance shows up.

The interesting bit is that the task looks easy and a lot of cheap models still leak a Bloomberg mid-roll or invent an ad on a clean Jane Street interview.

## Cases

| id | show | why it's here |
|---|---|---|
| `jasmine-sun` | Odd Lots | Multi-brand Bloomberg pods. Whisper glues the last interview clause to the IB open. |
| `lex-ffmpeg` | Lex Fridman | Long context. One long host-read stack after a couple minutes of intro. |
| `short-wave-avocados` | Short Wave | Short NPR. Mid-roll starts after a show sting, not the joke before it. |
| `signals-threads` | Signals and Threads | No paid ads. Website CTA at the end is not an ad. |
| `planet-money-big-box` | Planet Money | NPR mid-rolls. Saying "Capital One" in a news cite is not an ad. |

Pass: leftover ≤ 30s, overcut ≤ 45s, F1 ≥ 0.8. Empty gold (no ads) fails if the model cuts more than 5s.

## Run

Needs `OPENROUTER_API_KEY`. Transcripts cache under `src/ad-bench/.cache` after the first R2 pull.

```bash
# full bench, 5 runs, default OSS + Gemini Flash Lite + Luna
ap run openrouter -- bun run ad-bench

# smoke
ap run openrouter -- bun run ad-bench -- --runs 1 --cases jasmine-sun --models qwen/qwen3.7-flash,openai/gpt-5.6-luna
```

`--models` and `--cases` are comma-separated. `--output-file` writes the raw JSON.
