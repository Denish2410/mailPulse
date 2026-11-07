import { useMemo } from 'react';
import { formatInTimeZone, getBrowserTimeZone, getTimeZoneOptions, zonedInputToFutureIso } from '../../utils/timezone.js';

/**
 * Timezone picker for the schedule inputs, plus a one-line hint converting the chosen time to
 * the viewer's own timezone when the two differ.
 *
 * @param {object} props
 * @param {string} props.value - Selected IANA timezone
 * @param {(zone: string) => void} props.onChange
 * @param {string} props.inputValue - Current datetime-local value (for the hint)
 * @param {string} [props.idPrefix]
 */
export const ScheduleTimeZone = ({ value, onChange, inputValue, idPrefix = 'schedule' }) => {
  const browserZone = useMemo(() => getBrowserTimeZone(), []);
  const options = useMemo(() => {
    const list = getTimeZoneOptions(browserZone);
    return list.includes(value) ? list : [value, ...list];
  }, [browserZone, value]);

  const iso = value !== browserZone && inputValue ? zonedInputToFutureIso(inputValue, value) : null;

  return (
    <div className="flex flex-col gap-1 text-xs text-slate-300">
      <label htmlFor={`${idPrefix}-timezone`} className="flex flex-col gap-1">
        Timezone
        <select
          id={`${idPrefix}-timezone`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-slate-100 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
        >
          {options.map((zone) => (
            <option key={zone} value={zone}>
              {zone === browserZone ? `${zone} (your timezone)` : zone}
            </option>
          ))}
        </select>
      </label>
      {iso && (
        <span className="text-[11px] text-slate-500">
          That is {formatInTimeZone(iso, browserZone)} for you.
        </span>
      )}
    </div>
  );
};

export default ScheduleTimeZone;
