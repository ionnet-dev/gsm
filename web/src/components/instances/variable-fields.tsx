import { useEffect } from "react";
import type { TemplateVariable } from "@gsm/shared";
import { validateVariable } from "@gsm/shared";
import { useVersions } from "@/api/templates";
import { Field } from "@/components/data/field";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

/**
 * Inputs for a template's variables by type. `values` holds every variable (defaults filled);
 * `editable` false renders the value read-only and hidden (`viewable` false) variables are skipped,
 * except for owners.
 */
export function VariableFields({
  variables,
  values,
  onChange,
  owner,
}: {
  variables: TemplateVariable[];
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
  /** The instance's owners (admins and node owners included) see and change every variable. */
  owner: boolean;
}) {
  const shown = variables.filter((v) => owner || v.viewable);
  if (!shown.length) {
    return <p className="text-xs text-muted-foreground">This template has no variables.</p>;
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {shown.map((v) => (
        <VariableField
          key={v.name}
          variable={v}
          value={values[v.name] ?? ""}
          values={values}
          readOnly={!owner && !v.editable}
          onChange={(val) => onChange(v.name, val)}
        />
      ))}
    </div>
  );
}

function VariableField({
  variable: v,
  value,
  values,
  readOnly,
  onChange,
}: {
  variable: TemplateVariable;
  value: string;
  values: Record<string, string>;
  readOnly: boolean;
  onChange: (value: string) => void;
}) {
  const problem = validateVariable(v, value);
  const id = `var-${v.name}`;
  const hint = [
    v.description,
    readOnly ? "Set by the template; only an owner changes it." : "",
  ]
    .filter(Boolean).join(" ");
  const wide = v.type === "text" && v.default.length > 40;
  const field = (children: React.ReactNode) => (
    <Field
      label={v.label}
      htmlFor={id}
      hint={hint || undefined}
      error={problem}
      className={wide ? "sm:col-span-2" : undefined}
    >
      {children}
    </Field>
  );
  switch (v.type) {
    case "boolean":
      return field(
        <label className="flex h-8 items-center gap-2 text-xs">
          <Switch
            id={id}
            checked={value === "true"}
            disabled={readOnly}
            onCheckedChange={(c) => onChange(c ? "true" : "false")}
          />
          {value === "true" ? "On" : "Off"}
        </label>,
      );
    case "select":
      return field(
        <Combobox
          id={id}
          value={value}
          onValueChange={onChange}
          disabled={readOnly}
          options={v.options}
        />,
      );
    case "version":
      return field(
        <VersionSelect
          id={id}
          variable={v}
          value={value}
          parent={v.dependsOn ? values[v.dependsOn] ?? "" : null}
          readOnly={readOnly}
          onChange={onChange}
        />,
      );
    case "number":
      return field(
        <Input
          id={id}
          type="number"
          value={value}
          min={v.min ?? undefined}
          max={v.max ?? undefined}
          readOnly={readOnly}
          onChange={(e) => onChange(e.target.value)}
        />,
      );
    default:
      return field(
        <Input
          id={id}
          value={value}
          readOnly={readOnly}
          className="font-mono"
          onChange={(e) => onChange(e.target.value)}
        />,
      );
  }
}

function VersionSelect({
  id,
  variable,
  value,
  parent,
  readOnly,
  onChange,
}: {
  id: string;
  variable: TemplateVariable;
  value: string;
  parent: string | null;
  readOnly: boolean;
  onChange: (v: string) => void;
}) {
  const needsParent = !!variable.dependsOn;
  const q = useVersions(variable.versionSource, parent, !needsParent || !!parent);
  const versions = q.data ?? [];
  // Pick the newest release when the value is empty or no longer offered for this parent.
  useEffect(() => {
    if (!versions.length || readOnly) return;
    if (value && versions.some((o) => o.id === value)) return;
    const pick = versions.find((o) => o.kind === "recommended" || o.kind === "release") ??
      versions[0];
    if (pick) onChange(pick.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versions, parent]);
  if (readOnly) return <Input id={id} value={value} readOnly className="font-mono" />;
  const known = versions.some((o) => o.id === value);
  return (
    <Combobox
      id={id}
      value={value}
      onValueChange={onChange}
      disabled={needsParent && !parent}
      className="font-mono"
      itemClassName="font-mono"
      searchPlaceholder="Search versions…"
      emptyText="No version matches."
      placeholder={q.isLoading
        ? "Loading versions…"
        : q.error
        ? "Couldn't load versions"
        : needsParent && !parent
        ? "Pick the parent version first"
        : "Choose a version"}
      options={[
        ...(!known && value ? [{ value }] : []),
        ...versions.map((o) => ({
          value: o.id,
          label: o.label,
          hint: o.kind && o.kind !== "release" ? o.kind : undefined,
        })),
      ]}
    />
  );
}
