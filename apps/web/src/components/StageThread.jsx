import { STAGES } from '@vs/shared/stages.js';
import { shortDate } from './DateLabel.jsx';

const COLORS = {
  done: 'var(--vs-indigo)',
  rule: 'var(--vs-rule)',
  late: 'var(--vs-kumkum)',
  tight: 'var(--vs-haldi)',
};
const LAST = STAGES.length - 1;
const position = (key) => STAGES.findIndex((s) => s.key === key);

/**
 * Where a garment stands on its thread. Order taken is complete once the order exists, so a new
 * garment is working towards Materials ready. Finished garments are complete; cancelled or
 * rejected ones show no progress.
 */
function threadState(currentStage, status) {
  if (status === 'picked_up') return { current: LAST + 1, label: 'Picked up' };
  if (status === 'cancelled') return { current: -1, label: 'Cancelled' };
  if (status === 'rejected') return { current: -1, label: 'Rejected' };
  const current = currentStage === 'order_taken' ? 1 : position(currentStage);
  return { current, label: `Stage ${current + 1} of ${STAGES.length}: ${STAGES[current].label}` };
}

function knotState(i, current, skipped) {
  if (skipped) return 'skipped';
  if (i < current) return 'done';
  if (i === current) return 'current';
  return 'upcoming';
}

const knotLabel = (stage, state, late) =>
  `${stage.label}: ${state}${state === 'current' && late ? ', late' : ''}`;

function Knot({ cx, cy, state, late, tight, label }) {
  const common = { cx, cy, role: 'img', 'aria-label': label };
  if (state === 'done') return <circle {...common} r={3.5} fill={COLORS.done} />;
  if (state === 'current') {
    const stroke = late ? COLORS.late : tight ? COLORS.tight : COLORS.done;
    return <circle {...common} r={5} fill={late ? COLORS.late : '#fff'} stroke={stroke} strokeWidth={2} />;
  }
  if (state === 'skipped') return <circle {...common} r={2} fill={COLORS.rule} />;
  return <circle {...common} r={3} fill="#fff" stroke={COLORS.rule} strokeWidth={1.5} />;
}

const STEP = 15;
const PAD = 6;

function CompactThread({ stagePlan, current, label, late, tight }) {
  const width = PAD * 2 + STEP * LAST;
  const y = 8;
  const split = PAD + STEP * Math.max(0, Math.min(current, LAST));
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${width} 16`}
      width={width}
      height={16}
      style={{ maxWidth: '100%', display: 'block', overflow: 'visible' }}
    >
      <line x1={PAD} y1={y} x2={split} y2={y} stroke={COLORS.done} strokeWidth={1.5} strokeDasharray="3 2" />
      <line x1={split} y1={y} x2={width - PAD} y2={y} stroke={COLORS.rule} strokeWidth={1.5} strokeDasharray="3 2" />
      {STAGES.map((stage, i) => {
        const state = knotState(i, current, stagePlan?.[i]?.skipped);
        return (
          <Knot
            key={stage.key}
            cx={PAD + STEP * i}
            cy={y}
            state={state}
            late={late}
            tight={tight}
            label={knotLabel(stage, state, late)}
          />
        );
      })}
    </svg>
  );
}

function FullThread({ stagePlan, current, label, late, tight }) {
  return (
    <div role="group" aria-label={label} className="vs-thread-draw" style={{ position: 'relative' }}>
      <svg className="vs-thread-line" aria-hidden="true" preserveAspectRatio="none" viewBox="0 0 2 100" height="100%">
        <line x1={1} y1={0} x2={1} y2={100} stroke={COLORS.rule} strokeWidth={2} strokeDasharray="3 2" vectorEffect="non-scaling-stroke" />
      </svg>
      <ol className="vs-thread-full">
        {STAGES.map((stage, i) => {
          const entry = stagePlan?.[i];
          const state = knotState(i, current, entry?.skipped);
          const isLate = state === 'current' && late;
          return (
            <li key={stage.key}>
              <svg width={20} height={20} viewBox="0 0 20 20" style={{ position: 'relative' }}>
                <circle cx={10} cy={10} r={7} fill="#fff" />
                <Knot cx={10} cy={10} state={state} late={late} tight={tight} label={knotLabel(stage, state, late)} />
              </svg>
              <span
                aria-hidden="true"
                style={{
                  fontWeight: state === 'current' ? 600 : 400,
                  color: state === 'upcoming' || state === 'skipped' ? 'var(--vs-muted)' : 'var(--vs-ink)',
                  textDecoration: state === 'skipped' ? 'line-through' : undefined,
                }}
              >
                {stage.label}
              </span>
              <span
                className="vs-figures"
                style={{ fontSize: 13, color: isLate ? COLORS.late : 'var(--vs-muted)', fontWeight: isLate ? 600 : 400 }}
              >
                {entry?.skipped ? 'Skipped' : entry?.plannedDate ? shortDate(entry.plannedDate) : ''}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * A garment's 14 stages as a running stitch: filled knots for stages done, a ring for the stage
 * being worked (kumkum when late, haldi when the plan is tight), empty knots for what is ahead.
 * `compact` is one line for lists; `full` adds names and planned dates and draws in once.
 */
export function StageThread({ stagePlan, currentStage, status, tight = false, late = false, variant = 'compact' }) {
  const { current, label } = threadState(currentStage, status);
  const Thread = variant === 'full' ? FullThread : CompactThread;
  return <Thread stagePlan={stagePlan} current={current} label={label} late={late} tight={tight} />;
}
