import { useState } from 'react';
import { Button, Group, Menu } from '@mantine/core';
import { IconChevronDown } from '@tabler/icons-react';
import { useAuth } from '../../auth/AuthContext.js';
import { StageActionDialog } from './StageActionDialog.jsx';
import { actionLabel, actionsFor, primaryAction } from './stageSteps.js';

/** The garment's next production step as a button, with the other allowed steps under More. */
export function StageActions({ order, garment }) {
  const { can } = useAuth();
  const [action, setAction] = useState(null);
  const actions = actionsFor(order, garment, can);
  if (actions.length === 0) return null;
  const primary = primaryAction(actions);
  const more = actions.filter((a) => a !== primary);

  return (
    <>
      <Group gap="xs">
        {primary && (
          <Button size="xs" onClick={() => setAction(primary)}>
            {actionLabel(primary, garment)}
          </Button>
        )}
        {more.length > 0 && (
          <Menu position="bottom-start">
            <Menu.Target>
              <Button size="xs" variant="default" rightSection={<IconChevronDown size={14} aria-hidden="true" />}>
                More steps
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              {more.map((a) => (
                <Menu.Item key={a} onClick={() => setAction(a)}>
                  {actionLabel(a, garment)}
                </Menu.Item>
              ))}
            </Menu.Dropdown>
          </Menu>
        )}
      </Group>
      {action && <StageActionDialog action={action} garments={[garment]} onClose={() => setAction(null)} />}
    </>
  );
}
