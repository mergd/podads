import { barX, defineChart, dot, lineY, text } from "@tanstack/charts";
import { Chart } from "@tanstack/charts/react";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { tooltip } from "@tanstack/charts/tooltip";
import { useMemo } from "react";

import { formatF1, formatSeconds, formatUsd, modelLabel } from "./format";
import type { ModelSummary } from "./results";

const INK = "#161616";
const MUTE = "#6a6a6a";
const GRID = "#ddd9d0";
const FAIL = "#c43c3c";

const theme = {
  foreground: INK,
  muted: MUTE,
  grid: GRID,
  background: "transparent",
  palette: [INK, FAIL]
};

interface CurveRow {
  model: string;
  label: string;
  costUsd: number;
  f1: number;
  passed: boolean;
}

interface LeftoverRow {
  label: string;
  leftoverSec: number;
  fail: boolean;
}


export function CurveChart({ rows }: { rows: ModelSummary[] }) {
  const data: CurveRow[] = useMemo(
    () =>
      [...rows]
        .sort((left, right) => left.costUsd - right.costUsd)
        .map((row) => ({
          model: row.model,
          label: modelLabel(row.model),
          costUsd: row.costUsd,
          f1: row.f1,
          passed: row.passedCases === row.caseCount
        })),
    [rows]
  );

  const definition = useMemo(
    () =>
      defineChart({
        marks: [
          lineY(data, {
            x: "costUsd",
            y: "f1",
            stroke: INK,
            strokeWidth: 1.25
          }),
          dot(data, {
            x: "costUsd",
            y: "f1",
            r: 5,
            fill: INK,
            key: "model"
          }),
          text(data, {
            x: "costUsd",
            y: "f1",
            text: (row) => row.label,
            fill: MUTE,
            dx: 8,
            dy: -6,
            fontSize: 11,
            fontFamily: "ui-sans-serif, system-ui, sans-serif"
          })
        ],
        x: {
          scale: scaleLinear,
          nice: true,
          grid: true,
          axis: {
            label: "Dollars per episode",
            ticks: { format: (value) => formatUsd(Number(value)) }
          }
        },
        y: {
          scale: () => scaleLinear().domain([0.7, 1]),
          nice: false,
          grid: true,
          axis: {
            label: "F1",
            ticks: { format: (value) => formatF1(Number(value)) }
          }
        },
        theme,
        tooltip
      }),
    [data]
  );

  return (
    <div className="chart-host">
      <Chart definition={definition} height={420} ariaLabel="F1 versus dollars per episode" />
    </div>
  );
}

export function LeftoverChart({ rows }: { rows: ModelSummary[] }) {
  const data: LeftoverRow[] = useMemo(
    () =>
      rows.map((row) => ({
        label: modelLabel(row.model),
        leftoverSec: row.leftoverMs / 1000,
        fail: row.leftoverMs > 30_000
      })),
    [rows]
  );
  const labels = data.map((row) => row.label);

  const definition = useMemo(
    () =>
      defineChart({
        marks: [
          barX(data, {
            y: "label",
            x: "leftoverSec",
            fill: (row) => (row.fail ? FAIL : INK),
            key: "label"
          }),
          text(data, {
            y: "label",
            x: "leftoverSec",
            text: (row) => formatSeconds(row.leftoverSec * 1000),
            fill: MUTE,
            dx: 8,
            fontSize: 11,
            fontFamily: "ui-sans-serif, system-ui, sans-serif"
          })
        ],
        x: {
          scale: scaleLinear,
          nice: true,
          grid: true,
          axis: {
            label: "Leftover seconds",
            ticks: { format: (value) => `${Number(value).toFixed(0)}s` }
          }
        },
        y: {
          scale: () => scaleBand<string>().domain(labels).padding(0.28)
        },
        theme,
        tooltip
      }),
    [data, labels]
  );

  return (
    <div className="chart-host">
      <Chart definition={definition} height={280} ariaLabel="Mean leftover ad seconds" />
    </div>
  );
}

