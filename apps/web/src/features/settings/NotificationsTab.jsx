import { Group, Stack, Switch, Text, TextInput, Title } from '@mantine/core';

const CHANNELS = [
  ['email', 'Email'],
  ['whatsapp', 'WhatsApp'],
  ['sms', 'SMS'],
  ['in_app', 'In-app'],
];
const DEFAULT_WINDOW = { start: '21:00', end: '09:00' };

export function NotificationsTab({ values, set, errors }) {
  const quietHours = values.quietHours;
  const setWindow = (channel, window) => set('quietHours', { ...quietHours, [channel]: window });

  return (
    <Stack>
      <Title order={4}>Client quiet hours (IST)</Title>
      <Text size="sm" c="dimmed">
        Messages to clients during these hours wait until they end. Staff messages are never held.
      </Text>
      {CHANNELS.map(([channel, label]) => {
        const window = quietHours[channel];
        return (
          <Group key={channel} align="flex-end">
            <Switch
              label={`Quiet hours for ${label}`}
              checked={window !== null}
              onChange={(e) => setWindow(channel, e.currentTarget.checked ? DEFAULT_WINDOW : null)}
              w={220}
            />
            {window && (
              <>
                <TextInput
                  type="time"
                  label={`${label} quiet from`}
                  value={window.start}
                  onChange={(e) => setWindow(channel, { ...window, start: e.currentTarget.value })}
                  error={errors[`quietHours.${channel}.start`]}
                />
                <TextInput
                  type="time"
                  label={`${label} quiet until`}
                  value={window.end}
                  onChange={(e) => setWindow(channel, { ...window, end: e.currentTarget.value })}
                  error={errors[`quietHours.${channel}.end`]}
                />
              </>
            )}
          </Group>
        );
      })}

      <Title order={4}>Daily times (IST)</Title>
      <Group>
        <TextInput
          type="time"
          label="Daily job time"
          description="When daily reminders and digests go out"
          value={values.dailyJobTime}
          onChange={(e) => set('dailyJobTime', e.currentTarget.value)}
          error={errors.dailyJobTime}
        />
        <TextInput
          type="time"
          label="Closing time"
          value={values.closingTime}
          onChange={(e) => set('closingTime', e.currentTarget.value)}
          error={errors.closingTime}
        />
      </Group>
    </Stack>
  );
}
