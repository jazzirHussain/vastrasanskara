/** An order's costs and profit as the API answers (money: costing.view routes only). */
export function toOrderCostsJson({ order, garments }) {
  return {
    order: { ...order },
    garments: garments.map((g) => ({
      ...g,
      materials: g.materials.map((m) => ({ ...m })),
      expenses: g.expenses.map((e) => ({ ...e })),
    })),
  };
}
