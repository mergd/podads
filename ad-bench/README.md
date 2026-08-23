# ad-bench

Transcript-only ad detection bench, plus a public site for the price / quality curve.

The task looks easy. Cheap models still leak a Bloomberg mid-roll or invent a sponsor on a clean Jane Street interview.

## Cases

| id | show | why it's here |
|---|---|---|
| `jasmine-sun` | Odd Lots | Multi-brand Bloomberg pods. Whisper glues the last interview clause to the IB open. |
| `lex-ffmpeg` | Lex Fridman | Long context. One long host-read stack after a couple minutes of intro. |
| `short-wave-avocados` | Short Wave | Short NPR. Mid-roll starts after a show sting, not the joke before it. |
| `signals-threads` | Signals and Threads | No paid ads. Website CTA at the end is not an ad. |
| `planet-money-big-box` | Planet Money | NPR mid-rolls. Saying "Capital One" in a news cite is not an ad. |

Pass: leftover ≤ 30s, overcut ≤ 45s, F1 ≥ 0.8. Empty gold fails if the model cuts more than 5s.

## Run the bench

Needs `OPENROUTER_API_KEY`. Transcripts cache under `ad-bench/.cache` after the first R2 pull.

```bash
# full bench, 5 runs, default models
ap run openrouter -- bun run --cwd ad-bench bench

# smoke
ap run openrouter -- bun run --cwd ad-bench bench -- --runs 1 --cases jasmine-sun --models qwen/qwen3.7-flash,openai/gpt-5.6-luna
```

`--models` and `--cases` are comma-separated. All jobs run in parallel. `--concurrency N` caps in-flight calls. `--output-file` writes extra JSON. Every complete run also writes `site/public/results.json` for the site.

## Site

```bash
bun run --cwd ad-bench dev
```

Opens on [http://localhost:4177](http://localhost:4177). `bun run --cwd ad-bench build` emits `site/dist`.
