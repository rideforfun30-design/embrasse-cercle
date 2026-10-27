export const MEMBERSHIP_POLICY_VERSION = "bureau-monthly-notice-v1";

const PARIS = "Europe/Paris";
const localParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: PARIS, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
function parts(date: Date) {
  const values = Object.fromEntries(localParts.formatToParts(date).filter(p => p.type !== "literal").map(p => [p.type, Number(p.value)]));
  return { year: values.year, month: values.month, day: values.day, hour: values.hour, minute: values.minute, second: values.second };
}
/** A calendar boundary in Paris, converted without assuming CET or CEST. */
function parisMonthStart(year: number, monthIndex: number) {
  const normalized = new Date(Date.UTC(year, monthIndex, 1));
  const target = Date.UTC(normalized.getUTCFullYear(), normalized.getUTCMonth(), 1);
  let instant = target;
  for (let i = 0; i < 3; i++) {
    const p = parts(new Date(instant));
    const represented = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    instant += target - represented;
  }
  return new Date(instant).toISOString();
}
/** At least one calendar month of notice, ending on a monthly Paris boundary. */
export function cancellationEffectiveAt(requestedAt: string | Date): string {
  const date = new Date(requestedAt);
  if (!Number.isFinite(date.getTime())) throw new Error("Date de préavis invalide");
  const p = parts(date);
  const exactlyMonthStart = p.day === 1 && p.hour === 0 && p.minute === 0 && p.second === 0 && date.getUTCMilliseconds() === 0;
  return parisMonthStart(p.year, p.month - 1 + (exactlyMonthStart ? 1 : 2));
}
/** A scheduled cancellation never changes allocation before its effective instant. */
export function membershipIsActive(status: string, effectiveAt: string | null | undefined, at: string | Date): boolean {
  return status === "active" && (!effectiveAt || effectiveAt > new Date(at).toISOString());
}

/** UTC instant of the first day of a YYYY-MM billing period in Paris. */
export function monthlyPeriodStart(period: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new Error("Période mensuelle invalide");
  const [year, month] = period.split("-").map(Number);
  if (year < 2020 || year > 2100) throw new Error("Période mensuelle invalide");
  return parisMonthStart(year, month - 1);
}
