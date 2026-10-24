import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { apiFetch } from '../../lib/api.js';

/** Open garments per working stage: in house, with vendors, late. */
export function useProductionBoard() {
  return useQuery({ queryKey: ['production', 'board'], queryFn: () => apiFetch('/v1/production/board') });
}

/** Open garments matching `filters` (stage, late, withVendor, vendorId, designerId). */
export function useProductionGarments(filters) {
  return useQuery({
    queryKey: ['production', 'garments', filters],
    queryFn: () => apiFetch('/v1/production/garments', { query: filters }),
    placeholderData: keepPreviousData,
  });
}
