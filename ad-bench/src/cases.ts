export interface BenchCase {
  id: string;
  episodeId: number;
  feed: string;
  title: string;
  transcriptKey: string;
  notes: string;
  tags: string[];
}

export const AD_BENCH_CASES: BenchCase[] = [
  {
    id: "jasmine-sun",
    episodeId: 30147244,
    feed: "Odd Lots",
    title: "Jasmine Sun on What the AI Industry Got Wrong About the Public Backlash",
    transcriptKey: "transcripts/3/30147244/v1.json",
    notes: "Bloomberg national pods. Mid-rolls are 3-brand blocks; Whisper glues the last interview clause to the IB open.",
    tags: ["multi-pod", "bloomberg"]
  },
  {
    id: "lex-ffmpeg",
    episodeId: 1134450,
    feed: "Lex Fridman Podcast",
    title: "#496 – FFmpeg: The Incredible Technology Behind Video on the Internet",
    transcriptKey: "transcripts/4/1134450/v1.json",
    notes: "Long-context host-read stack (~7 min) after a long editorial intro. 2h analyzed window.",
    tags: ["long-context", "host-read"]
  },
  {
    id: "short-wave-avocados",
    episodeId: 21275050,
    feed: "Short Wave",
    title: "The problem with modern avocados and the ancient solution",
    transcriptKey: "transcripts/2/21275050/v1.json",
    notes: "Short NPR show. Mid-roll starts after a show sting, not at the joke that precedes it.",
    tags: ["short", "npr"]
  },
  {
    id: "signals-threads",
    episodeId: 12117999,
    feed: "Signals and Threads",
    title: "Building a data warehouse from scratch with Jacob Baskin",
    transcriptKey: "transcripts/15/12117999/v1.json",
    notes: "Jane Street interview. No paid ads. A website CTA at the end is not an ad.",
    tags: ["no-ads"]
  },
  {
    id: "planet-money-big-box",
    episodeId: 30333704,
    feed: "Planet Money",
    title: "Who decides what big box sells? Our GAME got us answers",
    transcriptKey: "transcripts/16/30333704/v1.json",
    notes: "NPR mid-rolls. Editorial that cites a Capital One report is not an ad.",
    tags: ["npr", "false-friend"]
  }
];
