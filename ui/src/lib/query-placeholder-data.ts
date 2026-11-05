import type { PlaceholderDataFunction, QueryKey } from "@tanstack/react-query";

export function keepPreviousDataForSameQueryTail<TQueryData, TQueryKey extends QueryKey = QueryKey>(
  tail: unknown,
): PlaceholderDataFunction<TQueryData, Error, TQueryData, TQueryKey> {
  return (previousData, previousQuery) => {
    const previousKey = Array.isArray(previousQuery?.queryKey) ? previousQuery.queryKey : [];
    return previousKey.at(-1) === tail ? previousData : undefined;
  };
}

/**
 * Keep the previous read's data visible while a refetch is in flight, but
 * only within one company — a company switch must show its own loading
 * state, never the previous company's rows. Filter keys place the company
 * at index 1 (e.g. `["usage-request-logs", companyId, filters, limit]`).
 */
export function keepPreviousDataForSameCompany<TQueryData, TQueryKey extends QueryKey = QueryKey>(
  companyId: string,
): PlaceholderDataFunction<TQueryData, Error, TQueryData, TQueryKey> {
  return (previousData, previousQuery) => {
    const previousKey = Array.isArray(previousQuery?.queryKey) ? previousQuery.queryKey : [];
    return previousKey[1] === companyId ? previousData : undefined;
  };
}
