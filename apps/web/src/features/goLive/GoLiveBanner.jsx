import { Link } from 'react-router-dom';
import { Anchor, Paper, Progress } from '@mantine/core';
import { useAuth } from '../../auth/AuthContext.js';
import { useGoLive } from './goLiveApi.js';

/** On Home for admins until the branch is live: how far the go-live checklist has got. */
export function GoLiveBanner() {
  const { can } = useAuth();
  const allowed = can('settings.edit');
  const { data } = useGoLive({ enabled: allowed });
  if (!allowed || !data || data.liveSince) return null;
  return (
    <Paper radius="md" p="md" mb="lg" className="vs-panel">
      <Anchor component={Link} to="/go-live" fw={600}>
        Getting ready to go live: {data.done} of {data.total} done
      </Anchor>
      <Progress value={(100 * data.done) / data.total} mt="xs" size="sm" aria-hidden="true" />
    </Paper>
  );
}
