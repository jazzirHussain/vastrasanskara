import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext.js';
import { apiFetch } from '../../lib/api.js';

/** An order's costs and profit per garment (admin only: costing.view); no request without it. */
export function useOrderCosts(orderId) {
  const { can } = useAuth();
  return useQuery({
    queryKey: ['costing', 'order', orderId],
    queryFn: () => apiFetch(`/v1/costing/orders/${orderId}`),
    enabled: Boolean(orderId) && can('costing.view'),
  });
}
