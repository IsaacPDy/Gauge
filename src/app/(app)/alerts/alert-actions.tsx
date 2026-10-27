import { SubmitButton } from "@/components/form-controls";
import { inputClass } from "@/components/ui";
import { acknowledgeAlert, muteAlert, unmuteAlert } from "./actions";

/** Acknowledge / mute / unmute controls for one alert. */
export function AlertActions({ alert, back }: { alert: { id: string; status: string; cycle_reset_at: string | null }; back: string }) {
  if (alert.status === "resolved" || alert.status === "superseded") return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {alert.status === "open" ? (
        <form action={acknowledgeAlert}>
          <input type="hidden" name="alertId" value={alert.id} />
          <input type="hidden" name="back" value={back} />
          <SubmitButton size="sm" variant="secondary" pendingText="…">
            Acknowledge
          </SubmitButton>
        </form>
      ) : null}
      {alert.status === "muted" ? (
        <form action={unmuteAlert}>
          <input type="hidden" name="alertId" value={alert.id} />
          <input type="hidden" name="back" value={back} />
          <SubmitButton size="sm" variant="secondary" pendingText="…">
            Unmute
          </SubmitButton>
        </form>
      ) : (
        <form action={muteAlert} className="flex items-center gap-1">
          <input type="hidden" name="alertId" value={alert.id} />
          <input type="hidden" name="back" value={back} />
          <label htmlFor={`mute-${alert.id}`} className="sr-only">
            Mute duration
          </label>
          <select id={`mute-${alert.id}`} name="duration" className={`${inputClass} h-7 w-auto py-0 text-xs`} defaultValue="1d">
            <option value="1d">1 day</option>
            <option value="7d">7 days</option>
            {alert.cycle_reset_at ? <option value="cycle">Until cycle resets</option> : null}
          </select>
          <SubmitButton size="sm" variant="ghost" pendingText="…">
            Mute
          </SubmitButton>
        </form>
      )}
    </div>
  );
}
