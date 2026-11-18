import { useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Stack, TextInput } from '@mantine/core';
import { IconUpload } from '@tabler/icons-react';
import { addDaysYmd } from '@vs/shared/fy.js';
import { todayYmd } from '../../components/DateLabel.jsx';
import { IMPORT_MAX_BYTES, useStartImport } from './importsApi.js';

const hidden = { position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0 0 0 0)', border: 0 };

/**
 * Choosing a filled file and sending it to be checked. Opening balances first ask for the
 * cut-over date. On success the page moves to the file's preview.
 */
export function UploadStep({ kind }) {
  const navigate = useNavigate();
  const start = useStartImport();
  const inputId = useId();
  const input = useRef(null);
  const today = todayYmd();
  const [asOf, setAsOf] = useState(addDaysYmd(today, -1));
  const [problem, setProblem] = useState(null);

  function choose(event) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    setProblem(null);
    if (file.size > IMPORT_MAX_BYTES) {
      setProblem('This file is larger than 5 MB. Split it into smaller files.');
      return;
    }
    if (!/\.(xlsx|csv)$/i.test(file.name)) {
      setProblem('Save the file as Excel Workbook (.xlsx) or CSV and upload again.');
      return;
    }
    if (kind.needsAsOf && !(asOf && asOf <= today)) {
      setProblem('Choose a cut-over date that is not in the future.');
      return;
    }
    start.mutate(
      { kind: kind.kind, file, asOf: kind.needsAsOf ? asOf : undefined },
      { onSuccess: (run) => navigate(`/imports/${run.id}`) },
    );
  }

  return (
    <Stack gap="xs">
      {kind.needsAsOf && (
        <TextInput
          type="date"
          label="Cut-over date (the last day of your old records)"
          value={asOf}
          max={today}
          onChange={(e) => setAsOf(e.currentTarget.value)}
          style={{ maxWidth: 260 }}
        />
      )}
      <input id={inputId} ref={input} type="file" accept=".xlsx,.csv" aria-label="Upload filled file" style={hidden} onChange={choose} />
      <Button leftSection={<IconUpload size={18} />} loading={start.isPending} onClick={() => input.current?.click()} style={{ alignSelf: 'flex-start' }}>
        Upload filled file
      </Button>
      {(problem || start.error) && (
        <Alert color="red" role="alert">
          {problem ?? start.error.message}
        </Alert>
      )}
    </Stack>
  );
}
