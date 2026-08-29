import { useEffect, useState } from "react";

import { CurveChart, LeftoverChart } from "./charts";
import { caseLabel, formatF1, formatSeconds, formatUsd, modelLabel } from "./format";
import type { BenchOutput } from "./results";

const FALLBACK: BenchOutput = {
  status: "running",
  runs: 5,
  models: [
    "qwen/qwen3.7-flash",
    "deepseek/deepseek-v4-flash-0731",
    "google/gemini-3.1-flash-lite",
    "openai/gpt-5.6-luna"
  ],
  cases: [
    {
      id: "jasmine-sun",
      episodeId: 30147244,
      feed: "Odd Lots",
      title: "Jasmine Sun on What the AI Industry Got Wrong About the Public Backlash",
      notes: "Bloomberg pods. Three brands in one mid-roll. Whisper glues the last interview clause to the IB open.",
      tags: ["multi-pod", "bloomberg"]
    },
    {
      id: "lex-ffmpeg",
      episodeId: 1134450,
      feed: "Lex Fridman Podcast",
      title: "#496 FFmpeg: The Incredible Technology Behind Video on the Internet",
      notes: "Long host-read stack after a couple minutes of intro. Two-hour window.",
      tags: ["long-context", "host-read"]
    },
    {
      id: "short-wave-avocados",
      episodeId: 21275050,
      feed: "Short Wave",
      title: "The problem with modern avocados and the ancient solution",
      notes: "Short NPR. Mid-roll starts after the sting, not the joke before it.",
      tags: ["short", "npr"]
    },
    {
      id: "signals-threads",
      episodeId: 12117999,
      feed: "Signals and Threads",
      title: "Building a data warehouse from scratch with Jacob Baskin",
      notes: "No paid ads. The website CTA at the end is not an ad.",
      tags: ["no-ads"]
    },
    {
      id: "planet-money-big-box",
      episodeId: 30333704,
      feed: "Planet Money",
      title: "Who decides what big box sells? Our GAME got us answers",
      notes: "NPR mid-rolls. A Capital One news cite is not an ad.",
      tags: ["npr", "false-friend"]
    }
  ],
  summary: [],
  results: []
};

async function loadResults(): Promise<BenchOutput> {
  const response = await fetch("/results.json", { cache: "no-store" });
  if (!response.ok) {
    return FALLBACK;
  }
  return (await response.json()) as BenchOutput;
}

export function App() {
  const [data, setData] = useState<BenchOutput>(FALLBACK);

  useEffect(() => {
    void loadResults().then(setData);
  }, []);

  const rows = data.summary;
  const ready = data.status === "complete" && rows.length > 0;
  const caseIds = data.cases.map((entry) => entry.id);

  return (
    <div className="page">
      <header>
        <img
          className="mark"
          src="/ad-bench-mark.png?v=5"
          width={148}
          height={148}
          alt="Pencil drawing of scissors cutting an indigo mid-roll from a waveform"
        />
        <div>
          <h1>Ad bench</h1>
          <p>
            Five podcast transcripts, five runs each. Mark the ads. Cheap models still miss a mid-roll or cut a show that
            has none.
          </p>
          <p className="rule">
            Pass if leftover is at most 30s, overcut at most 45s, and F1 is at least 0.8. A no-ad episode fails if the
            model cuts more than 5s.
          </p>
        </div>
      </header>

      {!ready ? (
        <p className="status">
          Run in progress. {data.runs} runs, {data.models.length} models, {data.cases.length} cases.
        </p>
      ) : (
        <>
          <section>
            <h2>F1 vs cost</h2>
            <CurveChart rows={rows} />
          </section>

          <section>
            <h2>Leftover</h2>
            <LeftoverChart rows={rows} />
          </section>

          <section>
            <h2>By case</h2>
            <div className="grid-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Model</th>
                    {caseIds.map((caseId) => (
                      <th key={caseId}>{caseLabel(caseId)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.model}>
                      <th>{modelLabel(row.model)}</th>
                      {caseIds.map((caseId) => {
                        const cell = row.cases.find((entry) => entry.caseId === caseId);
                        return <td key={caseId}>{cell ? formatF1(cell.f1) : "-"}</td>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <h2>Results</h2>
            <div className="grid-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Pass</th>
                    <th>F1</th>
                    <th>σ</th>
                    <th>Left</th>
                    <th>Over</th>
                    <th>$/ep</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.model}>
                      <th>{modelLabel(row.model)}</th>
                      <td>
                        {row.passedCases}/{row.caseCount}
                      </td>
                      <td>{formatF1(row.f1)}</td>
                      <td>{formatF1(row.f1Std)}</td>
                      <td>{formatSeconds(row.leftoverMs)}</td>
                      <td>{formatSeconds(row.overcutMs)}</td>
                      <td>{formatUsd(row.costUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      <section>
        <h2>Cases</h2>
        <ul className="cases">
          {data.cases.map((entry) => (
            <li key={entry.id}>
              <strong>{entry.feed}</strong>
              <span>{entry.notes}</span>
            </li>
          ))}
        </ul>
      </section>

      {data.generatedAt ? <p className="meta">{new Date(data.generatedAt).toUTCString()}</p> : null}
    </div>
  );
}
