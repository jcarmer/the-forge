import { useCallback, useEffect, useState } from "react";
import { UI } from "@tbe/ui";
import { Badge, Button, Choice, Dialog, Pane, Text, TextDialog, WrapRow } from "../components";
import { forgeApi } from "../hooks/forgeApi";
import { showError, showToast } from "../components/Toast";
import { Section, TextArea, TextField } from "./git/ui";

type When =
  | { kind: "daily"; time: string }
  | { kind: "weekly"; days: number[]; time: string }
  | { kind: "monthly"; day: number | "last"; time: string }
  | { kind: "everyMinutes"; minutes: number }
  | { kind: "everyHours"; hours: number }
  | { kind: "cron"; expr: string };

interface JsonSchemaProp { type?: string; description?: string; default?: unknown; items?: { type?: string } }
interface Job { id: string; title: string; description: string; paramsSchema: { properties?: Record<string, JsonSchemaProp> } }
interface Entry { id: string; jobId: string; label: string; enabled: boolean; when: When; timezone: string; params: Record<string, unknown>; cron: string; running: boolean; next: string[] }
interface Run { id: string; entryId: string; jobId: string; label: string; trigger: string; startedAt: string; finishedAt?: string; status: "running" | "ok" | "findings" | "error"; summary: string; log: string[]; details?: unknown }
interface Payload { jobs: Job[]; entries: Entry[]; runs: Run[] }

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const localTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const statusVariant = (s: Run["status"]) => (s === "ok" ? "success" : s === "findings" ? "warning" : s === "running" ? "info" : "danger");

export function describeWhen(w: When): string {
  switch (w.kind) {
    case "daily": return `every day at ${w.time}`;
    case "weekly": return `every ${w.days.map((d) => DAYS[d]).join(", ")} at ${w.time}`;
    case "monthly": return `${w.day === "last" ? "last day" : `day ${w.day}`} of every month at ${w.time}`;
    case "everyMinutes": return `every ${w.minutes} min`;
    case "everyHours": return `every ${w.hours} h`;
    case "cron": return `cron ${w.expr}`;
  }
}

/** Form text for one parameter, from its JSON-schema type. */
function toField(v: unknown, p: JsonSchemaProp): string {
  if (v === undefined) v = p.default;
  if (p.type === "array" && Array.isArray(v)) return v.join("\n");
  if (v === undefined || v === null) return "";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}
function fromField(text: string, p: JsonSchemaProp): unknown {
  if (p.type === "boolean") return text === "true";
  if (p.type === "number" || p.type === "integer") return text.trim() === "" ? undefined : Number(text);
  if (p.type === "array") return text.split("\n").map((s) => s.trim()).filter(Boolean);
  return text;
}

function Editor({ jobs, initial, onClose, onSaved }: { jobs: Job[]; initial: Entry | null; onClose: () => void; onSaved: () => void }) {
  const [jobId, setJobId] = useState(initial?.jobId ?? jobs[0]?.id ?? "");
  const [label, setLabel] = useState(initial?.label ?? "");
  const [when, setWhen] = useState<When>(initial?.when ?? { kind: "daily", time: "03:00" });
  const [tz, setTz] = useState(initial?.timezone ?? localTz());
  const job = jobs.find((j) => j.id === jobId);
  const props = job?.paramsSchema.properties ?? {};
  const [fields, setFields] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(props).map(([k, p]) => [k, toField(initial?.params[k], p)])),
  );
  const [busy, setBusy] = useState(false);

  // Switching job swaps the parameter form (its defaults fill in).
  function pickJob(id: string) {
    setJobId(id);
    const next = jobs.find((j) => j.id === id)?.paramsSchema.properties ?? {};
    setFields(Object.fromEntries(Object.entries(next).map(([k, p]) => [k, toField(undefined, p)])));
  }

  async function save() {
    setBusy(true);
    try {
      const params: Record<string, unknown> = {};
      for (const [k, p] of Object.entries(props)) {
        const v = fromField(fields[k] ?? "", p);
        if (v !== undefined && !(typeof v === "string" && v === "" && p.default === undefined)) params[k] = v;
      }
      await forgeApi("PUT", "/api/schedules", { id: initial?.id, jobId, label, enabled: initial?.enabled ?? true, when, timezone: tz, params });
      showToast("success", "Schedule saved.");
      onSaved();
      onClose();
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  }

  const time = (w: { time: string }, set: (t: string) => void) => (
    <TextField label="Time (24h, HH:MM)" value={w.time} onChange={(e) => set(e.target.value)} placeholder="03:00" />
  );

  return (
    <Dialog
      open
      title={initial ? "Edit schedule" : "Add schedule"}
      onClose={onClose}
      dismissable={!busy}
      footer={
        <WrapRow gap={8}>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={busy || !job} onClick={() => void save()}>Save</Button>
        </WrapRow>
      }
    >
      <Choice label="Function" value={jobId} options={jobs.map((j) => ({ key: j.id, label: j.title }))} onChange={pickJob} width={320} />
      {job && <Text muted>{job.description}</Text>}
      <TextField label="Label (to tell entries of the same function apart)" value={label} onChange={(e) => setLabel(e.target.value)} />

      <Choice
        label="Repeats"
        value={when.kind}
        width={220}
        options={[
          { key: "daily", label: "Daily" },
          { key: "weekly", label: "Weekly" },
          { key: "monthly", label: "Monthly" },
          { key: "everyHours", label: "Every N hours" },
          { key: "everyMinutes", label: "Every N minutes" },
          { key: "cron", label: "Cron expression" },
        ]}
        onChange={(k) => {
          const keepTime = "time" in when ? when.time : "03:00";
          setWhen(
            k === "daily" ? { kind: k, time: keepTime }
            : k === "weekly" ? { kind: k, days: [2], time: keepTime }
            : k === "monthly" ? { kind: k, day: 1, time: keepTime }
            : k === "everyHours" ? { kind: k, hours: 6 }
            : k === "everyMinutes" ? { kind: k, minutes: 30 }
            : { kind: k, expr: "0 3 * * *" },
          );
        }}
      />
      {when.kind === "daily" && time(when, (t) => setWhen({ ...when, time: t }))}
      {when.kind === "weekly" && (
        <>
          <WrapRow gap={6}>
            {DAYS.map((d, i) => (
              <Button
                key={d}
                size="sm"
                variant={when.days.includes(i) ? "primary" : "ghost"}
                onClick={() => setWhen({ ...when, days: when.days.includes(i) ? when.days.filter((x) => x !== i) : [...when.days, i] })}
              >
                {d}
              </Button>
            ))}
          </WrapRow>
          {time(when, (t) => setWhen({ ...when, time: t }))}
        </>
      )}
      {when.kind === "monthly" && (
        <>
          <TextField
            label='Day of month (1-31, or "last")'
            value={String(when.day)}
            onChange={(e) => setWhen({ ...when, day: e.target.value.trim() === "last" ? "last" : Number(e.target.value) || 1 })}
          />
          {time(when, (t) => setWhen({ ...when, time: t }))}
        </>
      )}
      {when.kind === "everyHours" && <TextField label="Hours (1-23)" value={String(when.hours)} onChange={(e) => setWhen({ ...when, hours: Number(e.target.value) || 1 })} />}
      {when.kind === "everyMinutes" && <TextField label="Minutes (1-59)" value={String(when.minutes)} onChange={(e) => setWhen({ ...when, minutes: Number(e.target.value) || 1 })} />}
      {when.kind === "cron" && <TextField label="Cron (minute hour day-of-month month weekday)" value={when.expr} onChange={(e) => setWhen({ ...when, expr: e.target.value })} />}
      <TextField label="Timezone (IANA name)" value={tz} onChange={(e) => setTz(e.target.value)} />

      {Object.keys(props).length > 0 && <Text>Parameters</Text>}
      {Object.entries(props).map(([k, p]) => {
        const label = `${k}${p.description ? ` - ${p.description}` : ""}`;
        if (p.type === "boolean")
          return (
            <Choice key={k} label={label} width={160} value={fields[k] === "true" ? "true" : "false"} options={[{ key: "true", label: "yes" }, { key: "false", label: "no" }]} onChange={(v) => setFields({ ...fields, [k]: v })} />
          );
        if (p.type === "array") return <TextArea key={k} label={`${label} (one per line)`} rows={3} value={fields[k] ?? ""} onChange={(e) => setFields({ ...fields, [k]: e.target.value })} />;
        return <TextField key={k} label={label} value={fields[k] ?? ""} onChange={(e) => setFields({ ...fields, [k]: e.target.value })} />;
      })}
    </Dialog>
  );
}

export function SchedulesView() {
  const [data, setData] = useState<Payload | null>(null);
  const [editing, setEditing] = useState<Entry | "new" | null>(null);
  const [runView, setRunView] = useState<Run | null>(null);

  const load = useCallback(async () => {
    try { setData(await forgeApi<Payload>("GET", "/api/schedules")); } catch (e) { showError(e); }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try { await fn(); if (ok) showToast("success", ok); await load(); } catch (e) { showError(e); }
  };

  if (!data) return <Pane padding={12}><Text>Loading schedules...</Text></Pane>;
  const lastRun = (id: string) => data.runs.find((r) => r.entryId === id);

  return (
    <UI.VStack spacing={UI.Size.px(12)} align="stretch">
      <Section title="Scheduled functions" right={<Button variant="primary" onClick={() => setEditing("new")}>Add schedule</Button>}>
        {data.entries.length === 0 && <Text muted>Nothing scheduled yet. One function can have many entries, each with its own time and parameters.</Text>}
        {data.entries.map((e) => {
          const job = data.jobs.find((j) => j.id === e.jobId);
          const last = lastRun(e.id);
          return (
            <Pane key={e.id} padding={10}>
              <UI.VStack spacing={UI.Size.px(6)} align="stretch">
                <WrapRow gap={8}>
                  <Text>{job?.title ?? e.jobId}{e.label ? ` - ${e.label}` : ""}</Text>
                  {!e.enabled && <Badge variant="default">DISABLED</Badge>}
                  {e.running && <Badge variant="info">RUNNING</Badge>}
                  {last && !e.running && <Badge variant={statusVariant(last.status)}>{last.status.toUpperCase()}</Badge>}
                </WrapRow>
                <Text muted>{describeWhen(e.when)} ({e.timezone}){e.next[0] ? ` - next: ${new Date(e.next[0]).toLocaleString()}` : ""}</Text>
                {last && <Text muted>Last: {new Date(last.startedAt).toLocaleString()} - {last.summary}</Text>}
                <WrapRow gap={6}>
                  <Button size="sm" disabled={e.running} onClick={() => void act(() => forgeApi("POST", `/api/schedules/${e.id}/run`), "Started.")}>Run now</Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(e)}>Edit</Button>
                  <Button size="sm" variant="ghost" onClick={() => void act(() => forgeApi("PUT", "/api/schedules", { ...e, enabled: !e.enabled }))}>{e.enabled ? "Disable" : "Enable"}</Button>
                  <Button size="sm" variant="danger" onClick={() => { if (window.confirm("Delete this schedule?")) void act(() => forgeApi("DELETE", `/api/schedules/${e.id}`)); }}>Delete</Button>
                </WrapRow>
              </UI.VStack>
            </Pane>
          );
        })}
      </Section>

      <Section title="Recent runs">
        {data.runs.length === 0 && <Text muted>No runs yet.</Text>}
        {data.runs.map((r) => (
          <WrapRow key={r.id} gap={8}>
            <Badge variant={statusVariant(r.status)}>{r.status.toUpperCase()}</Badge>
            <Text>{data.jobs.find((j) => j.id === r.jobId)?.title ?? r.jobId}{r.label ? ` - ${r.label}` : ""}</Text>
            <Text muted>{new Date(r.startedAt).toLocaleString()} ({r.trigger})</Text>
            <Text muted>{r.summary}</Text>
            <Button size="sm" variant="ghost" onClick={() => setRunView(r)}>Details</Button>
          </WrapRow>
        ))}
      </Section>

      {editing && (
        <Editor jobs={data.jobs} initial={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => void load()} />
      )}
      <TextDialog
        open={!!runView}
        title={runView ? `${runView.jobId} - ${runView.status}` : ""}
        content={runView ? [runView.summary, "", ...runView.log, "", JSON.stringify(runView.details ?? null, null, 2)].join("\n") : ""}
        onClose={() => setRunView(null)}
      />
    </UI.VStack>
  );
}
