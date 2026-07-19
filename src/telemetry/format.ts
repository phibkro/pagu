// pure: human-readable rendering of telemetry v0.
import type { TelemetryViewV0 } from "./projection.ts";

function subject(agent: string, label: string): string {
  return [agent, label].filter(Boolean).join(":") || "-";
}

function table(headers: readonly string[], rows: readonly string[][]): string {
  if (rows.length === 0) return "(none)";
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length))
  );
  const line = (cells: readonly string[]) =>
    cells.map((cell, index) => cell.padEnd(widths[index])).join("  ").trimEnd();
  return [
    line(headers),
    line(widths.map((width) => "-".repeat(width))),
    ...rows.map(line),
  ]
    .join("\n");
}

/** Render the same view returned by `--json`; presentation never re-folds or
 * reinterprets retained events. */
export function formatTelemetry(
  view: TelemetryViewV0,
  top = 10,
): string {
  const deniedRows = view.deniedPaths.slice(0, top).map((item) => [
    item.profile,
    subject(item.subjectAgent, item.subjectLabel),
    item.path,
    String(item.denied),
    String(item.refused),
  ]);
  const approvalRows = view.approvalRates.map((item) => [
    item.profile,
    subject(item.subjectAgent, item.subjectLabel),
    `${item.approved}/${item.decisions}`,
    `${(item.rate * 100).toFixed(1)}%`,
  ]);
  const pruneRows = view.pruneCandidates.map((item) => [
    item.profile,
    subject(item.subjectAgent, item.subjectLabel),
    item.path,
    `${item.ageDays}d`,
    item.grant,
  ]);
  return [
    `Telemetry v${view.version} · ${view.logs} log(s) · prune cutoff ${view.olderThanDays}d`,
    "",
    "Top denied/refused paths",
    table(["PROFILE", "SUBJECT", "PATH", "DENIED", "REFUSED"], deniedRows),
    "",
    "Approval rate per profile/subject",
    table(["PROFILE", "SUBJECT", "APPROVED", "RATE"], approvalRows),
    "",
    "Decision tiers",
    `auto ${view.decisionTiers.auto} · operator ${view.decisionTiers.operator} · refuse ${view.decisionTiers.refuse}`,
    "",
    "Prune candidates (approved grants without launch evidence)",
    table(["PROFILE", "SUBJECT", "PATH", "AGE", "GRANT"], pruneRows),
  ].join("\n");
}
