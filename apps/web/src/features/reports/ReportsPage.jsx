import { useState } from 'react';
import { Button, Group, Paper, SimpleGrid, Stack, Text, TextInput } from '@mantine/core';
import { REPORTS } from '@vs/shared/reports/catalog.js';
import { PageHeader } from '../../components/PageHeader.jsx';
import { RecentFiles } from './RecentFiles.jsx';
import { ReportCard, lastMonthYm } from './ReportCard.jsx';
import { useRequestReport, withKey } from './reportsApi.js';

const GROUPS = ['GST', 'Registers', 'Ledgers', 'Business'];

/** The highlighted card: last month's GSTR-1 and GST summary with registers, in one go. */
function GstFilesCard() {
  const request = useRequestReport();
  const [month, setMonth] = useState(lastMonthYm());
  return (
    <Paper component="section" aria-label="Last month’s GST files" radius="md" p="md" mb="xl" style={{ background: 'var(--vs-indigo)', color: 'var(--vs-chalk)' }}>
      <Stack gap="xs">
        <Text fw={600} fz={18}>
          Last month’s GST files
        </Text>
        <Text size="sm">GSTR-1 and the GST summary with registers, ready for your accountant. They are also emailed to you on the 2nd.</Text>
        <Group align="flex-end">
          <TextInput label="Month" placeholder="YYYY-MM" value={month} onChange={(e) => setMonth(e.currentTarget.value)} styles={{ label: { color: 'var(--vs-chalk)' } }} />
          <Button
            size="md"
            color="haldi"
            loading={request.isPending}
            onClick={() => request.mutate(withKey({ kind: 'gst_pack', format: 'xlsx', params: { month } }))}
          >
            Get files
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}

/** Reports: GST files, registers, ledgers and business reports as Excel, CSV or PDF files. */
export function ReportsPage() {
  return (
    <Stack gap={0}>
      <PageHeader title="Reports" />
      <GstFilesCard />
      {/* Near the top, so a file asked for below is seen preparing without scrolling a long page. */}
      <RecentFiles />
      {GROUPS.map((group) => (
        <section key={group} aria-label={group} style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 18, margin: '0 0 8px' }}>{group}</h2>
          <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
            {REPORTS.filter((r) => r.group === group && r.kind !== 'gst_pack').map((r) => (
              <ReportCard key={r.kind} report={r} />
            ))}
          </SimpleGrid>
        </section>
      ))}
    </Stack>
  );
}
