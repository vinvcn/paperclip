import type { UsageSummarySeriesPoint } from "@paperclipai/shared";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime, formatTokens } from "@/lib/utils";

/**
 * The Usage page's Tokens bar chart (docs/specs/usage-request-logs.md, UI):
 * hand-rolled SVG, no charting library. One column per series bucket — the
 * server zero-fills empty buckets, so the axis is continuous and zero buckets
 * render as empty stubs rather than missing positions. The y axis scales to
 * the window maximum, rounded up to a nice 1/2/2.5/5 × 10^n value, with
 * gridlines at the maximum, its half and the baseline. Hovering a column
 * shows the bucket's local time, tokens and request count through a native
 * SVG title.
 */

// Fixed viewBox geometry (SVG units); the svg scales to the card width.
const WIDTH = 720;
const HEIGHT = 220;
const GUTTER = 48; // left gutter for y-axis labels
const TOP = 12;
const BOTTOM = 28; // x-axis label band
const RIGHT = 8;
const MAX_X_LABELS = 9;

/** Round a window maximum up to the nearest 1/2/2.5/5 × 10^n value. */
export function niceCeiling(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const base = 10 ** Math.floor(Math.log10(value));
  const fraction = value / base;
  const step = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return step * base;
}

/** Midnight buckets read as dates; the rest as local hours. */
function bucketAxisLabel(bucketStart: string): string {
  const date = new Date(bucketStart);
  if (date.getHours() === 0 && date.getMinutes() === 0) {
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  return date.toLocaleTimeString("en-US", { hour: "numeric" });
}

function bucketTitle(point: UsageSummarySeriesPoint): string {
  return `${formatDateTime(point.bucketStart)} · ${formatTokens(point.tokens)} tokens · ${point.requests} requests`;
}

/**
 * Renders the whole chart card. `undefined` series means the summary has not
 * arrived yet; an empty series means the window held no requests at all.
 */
export function UsageTokensChart({ series }: { series: UsageSummarySeriesPoint[] | undefined }) {
  const plotWidth = WIDTH - GUTTER - RIGHT;
  const plotHeight = HEIGHT - TOP - BOTTOM;
  const baseline = TOP + plotHeight;
  const maxTokens = Math.max(0, ...(series?.map((point) => point.tokens) ?? [0]));
  const yMax = niceCeiling(maxTokens);
  // The all-zero window still needs a scale; 1 keeps the empty stubs on a
  // visible baseline without implying a meaningful magnitude.
  const gridlineValues = maxTokens === 0 ? [1, 0] : [yMax, yMax / 2, 0];
  const xLabelStep = series && series.length > 0 ? Math.ceil(series.length / MAX_X_LABELS) : 1;

  return (
    <Card className="gap-3 py-4">
      <CardHeader className="gap-0 px-5">
        <CardTitle className="text-base">Tokens</CardTitle>
        <CardDescription>Tokens processed per bucket, bucketed in your local timezone.</CardDescription>
      </CardHeader>
      <CardContent className="px-5">
        {series === undefined ? (
          <p className="text-sm text-muted-foreground">Loading&hellip;</p>
        ) : series.length === 0 ? (
          <p className="text-sm text-muted-foreground">No requests observed in this window.</p>
        ) : (
          <div>
            <svg
              role="img"
              aria-label="Tokens processed per bucket"
              viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
              className="block w-full"
            >
              {gridlineValues.map((value) => {
                const y = baseline - (value / yMax) * plotHeight;
                return (
                  <g key={`gridline-${value}`}>
                    <line x1={GUTTER} y1={y} x2={WIDTH - RIGHT} y2={y} stroke="var(--color-border)" strokeWidth={1} />
                    <text x={GUTTER - 6} y={y + 3.5} textAnchor="end" fontSize={10} fill="var(--color-muted-foreground)">
                      {formatTokens(value)}
                    </text>
                  </g>
                );
              })}
              <line x1={GUTTER} y1={baseline} x2={WIDTH - RIGHT} y2={baseline} stroke="var(--color-border)" strokeWidth={1.5} />
              {series.map((point, index) => {
                const band = plotWidth / series.length;
                const barWidth = Math.max(1, Math.min(36, band * 0.7));
                const centerX = GUTTER + band * index + band / 2;
                const zero = point.tokens === 0;
                const barHeight = zero ? 2 : Math.max(1, (point.tokens / yMax) * plotHeight);
                return (
                  <g
                    key={point.bucketStart}
                    data-testid="usage-chart-bar"
                    data-zero={zero ? "" : undefined}
                  >
                    <title>{bucketTitle(point)}</title>
                    {/* full-band hit area so gaps between bars stay hoverable */}
                    <rect x={GUTTER + band * index} y={TOP} width={band} height={plotHeight} fill="transparent" />
                    <rect
                      x={centerX - barWidth / 2}
                      y={baseline - barHeight}
                      width={barWidth}
                      height={barHeight}
                      rx={1}
                      fill={zero ? "var(--color-muted-foreground)" : "var(--color-primary)"}
                      opacity={zero ? 0.35 : 0.9}
                    />
                    {index % xLabelStep === 0 && (
                      <text x={centerX} y={HEIGHT - 8} textAnchor="middle" fontSize={10} fill="var(--color-muted-foreground)">
                        {bucketAxisLabel(point.bucketStart)}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
            {maxTokens === 0 && (
              <p className="mt-1 text-sm text-muted-foreground">No token activity in this window.</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
