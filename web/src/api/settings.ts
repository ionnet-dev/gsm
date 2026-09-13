import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  FilesSettings,
  GeneralSettings,
  HistoryRetentionSettings,
  SmtpSettings,
} from "@gsm/shared";
import { api, get, post } from "./client";

export interface RegistrySettings {
  server: string;
  username: string;
  password: string;
}

export interface AllSettings {
  general: GeneralSettings;
  history: HistoryRetentionSettings;
  files: FilesSettings;
  smtp: SmtpSettings;
  registry: RegistrySettings;
}

export const useSettings = () =>
  useQuery({ queryKey: ["settings"], queryFn: () => get<AllSettings>("/settings") });

export function useSettingsMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["settings"] });
  return {
    general: useMutation({
      mutationFn: (b: GeneralSettings) => api("/settings/general", { method: "PUT", json: b }),
      onSuccess: invalidate,
    }),
    history: useMutation({
      mutationFn: (b: HistoryRetentionSettings) =>
        api("/settings/history", { method: "PUT", json: b }),
      onSuccess: invalidate,
    }),
    files: useMutation({
      mutationFn: (b: FilesSettings) => api("/settings/files", { method: "PUT", json: b }),
      onSuccess: () => {
        invalidate();
        qc.invalidateQueries({ queryKey: ["files", "limits"] });
      },
    }),
    smtp: useMutation({
      mutationFn: (b: SmtpSettings) => api("/settings/smtp", { method: "PUT", json: b }),
      onSuccess: invalidate,
    }),
    registry: useMutation({
      mutationFn: (b: RegistrySettings) => api("/settings/registry", { method: "PUT", json: b }),
      onSuccess: invalidate,
    }),
    testSmtp: useMutation({ mutationFn: (to: string) => post("/settings/smtp/test", { to }) }),
  };
}
