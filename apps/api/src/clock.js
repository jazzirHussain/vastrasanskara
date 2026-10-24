// Single source of "now" so tests can control time with vi.spyOn(clock, 'now').
export const clock = {
  now: () => new Date(),
};
