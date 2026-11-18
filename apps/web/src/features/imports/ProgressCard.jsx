import { Paper, Progress, Stack, Text } from '@mantine/core';

/** "Adding… 120 of 480" with a bar, while an import adds its rows. */
export function ProgressCard({ run }) {
  const { done, total } = run.progress;
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <Paper radius="md" p="md" className="vs-panel" aria-live="polite">
      <Stack gap="xs">
        <Text fw={600}>
          Adding… {done} of {total}
        </Text>
        <Progress value={percent} aria-label="Adding records" color="neem" />
        <Text size="sm" c="var(--vs-muted)">
          You can leave this page; adding carries on.
        </Text>
      </Stack>
    </Paper>
  );
}
