/**
 * A/B subject test results: one card per arm with sent / open / click counts, and a note
 * naming the leader (by open rate). Renders nothing when the campaign had no test.
 *
 * @param {object} props
 * @param {{ arms: object[], leader: 'A'|'B'|null }|null} props.variants
 */
export const VariantPanel = ({ variants }) => {
  if (!variants) return null;

  return (
    <div className="flex flex-col gap-2.5" aria-label="A/B subject test results">
      <h3 className="text-sm font-semibold text-white">A/B Subject Test</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        {variants.arms.map((arm) => {
          const isLeader = variants.leader === arm.variant;
          return (
            <div
              key={arm.variant}
              className={`p-3.5 rounded-xl border bg-slate-950/60 ${
                isLeader ? 'border-emerald-500/60' : 'border-slate-800'
              }`}
            >
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="text-xs font-bold text-slate-200">Variant {arm.variant}</span>
                {isLeader && (
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-emerald-300">
                    Leading
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-400 break-words mb-2.5">{arm.subject}</p>
              <dl className="grid grid-cols-3 gap-2 text-center">
                {[
                  ['Sent', arm.sent],
                  ['Open rate', `${arm.openRate}%`],
                  ['Click rate', `${arm.clickRate}%`],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dd className="text-base font-bold text-white">{value}</dd>
                    <dt className="text-[11px] text-slate-400">{label}</dt>
                  </div>
                ))}
              </dl>
            </div>
          );
        })}
      </div>
      {!variants.leader && (
        <p className="text-[11px] text-slate-500">
          No clear leader yet: both subjects have the same open rate or one has not sent.
        </p>
      )}
    </div>
  );
};

export default VariantPanel;
